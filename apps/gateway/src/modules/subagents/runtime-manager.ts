import { lstat, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { PiAgentRuntime, type PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { Type } from "@sinclair/typebox";
import { Ajv, type ValidateFunction } from "ajv";
import type { GatewayConfig, PiRuntimeConfig, SubagentFrameworkConfig } from "../../config.js";
import { isPiRuntimeConfigured } from "../agent/runtime-factory.js";
import { traceRuntime } from "../agent-debug/instrument.js";
import type { AgentDebugTraceStore } from "../agent-debug/trace-store.js";
import type { LoadedSubagentRevision } from "./types.js";
import type { ExternalCallBudgetService } from "../external-calls/service.js";

export type SubagentResultValidator = (
  invocationInput: unknown,
  result: Record<string, unknown>,
) => void;

/** 子 Agent 单条工具结果进入上下文的字符上限（JSON 感知截断）。 */
const SUBAGENT_TOOL_RESULT_MAX_CHARS = 24_000;
/** run 内轮次级裁剪的触发比例（占 contextWindow）与保留轮数。 */
const SUBAGENT_CONTEXT_GUARD_TRIGGER_RATIO = 0.5;
// 2026-10-23 实测：planner 每轮工具结果约 12k 真实 token，保留 6 轮就占掉 72k，
// 加上 system/tools 后即使触发裁剪也降不下来；保留 3 轮给「当前工作证据 + 一步回退」。
const SUBAGENT_CONTEXT_GUARD_KEEP_TURNS = 3;

export function createSubagentSkillReadTool(revision: LoadedSubagentRevision): PiAgentRuntimeTool {
  const root = `${resolve(revision.agentDirectory)}${sep}`;
  return {
    name: "read",
    label: "Read skill resource",
    description: "读取当前子 Agent Revision 中的 Skill 文件。path 用相对本 Skill 根目录的相对路径（如 skills/<name>/SKILL.md）或绝对路径。",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }, { additionalProperties: false }),
    execute: async (_input, params) => {
      // 相对路径以 revision 根解析：SYSTEM.md 无法预知运行期绝对路径。
      const requestedPath = resolve(root, String(params.path ?? ""));
      if (!requestedPath.startsWith(root)) throw new Error("subagent_skill_path_not_allowed");
      const stats = await lstat(requestedPath);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("subagent_skill_file_not_readable");
      if (stats.size > 256 * 1024) throw new Error("subagent_skill_file_too_large");
      const lines = (await readFile(requestedPath, "utf8")).split("\n");
      const offset = Number(params.offset ?? 1);
      const limit = Number(params.limit ?? 2_000);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      return {
        content: selected.map((line, index) => `${offset + index}: ${line}`).join("\n"),
        details: { path: requestedPath, offset, lines: selected.length },
      };
    },
  };
}

export class SubagentResultCollector {
  private readonly submissions = new Map<string, { revisionId: string; value: unknown }>();
  private readonly invocations = new Map<string, { revisionId: string; input: unknown }>();
  private readonly validators = new WeakMap<Record<string, unknown>, ValidateFunction>();
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  createTool(
    revision: LoadedSubagentRevision,
    validateResult?: SubagentResultValidator,
  ): PiAgentRuntimeTool | null {
    const schema = revision.outputSchema;
    if (!schema) return null;
    return {
      name: "subagent_submit_result",
      label: "Submit result",
      description: "提交本次子 Agent 调用的正式结构化结果。参数必须完整符合输出 Schema；校验失败时修正后重试。",
      parameters: schema,
      executionMode: "sequential",
      execute: async (input, params) => {
        const invocation = this.invocations.get(input.runId);
        if (!invocation || invocation.revisionId !== revision.id) {
          throw new Error("subagent_result_invocation_mismatch");
        }
        if (this.submissions.has(input.runId)) {
          throw new Error("subagent_result_already_submitted");
        }
        const validator = this.validatorFor(schema);
        if (!validator(params)) {
          throw new Error(`subagent_result_schema_invalid: ${this.ajv.errorsText(validator.errors)}`);
        }
        validateResult?.(invocation.input, params);
        this.submissions.set(input.runId, {
          revisionId: revision.id,
          value: structuredClone(params),
        });
        return {
          content: JSON.stringify({
            accepted: true,
            invocationId: input.runId,
            note: "结果已接收，任务完成。不要再调用任何工具，也不要输出总结，直接以单个字「好」结束本轮。",
          }),
          details: { accepted: true, invocationId: input.runId },
        };
      },
      classifyFailure: (error, input) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith("subagent_result_")) return null;
        const recoverable = !message.startsWith("subagent_result_invocation_mismatch")
          && !message.startsWith("subagent_result_already_submitted")
          // 内容契约连续失败后的收口：不再引导重交 done，模型应改走 blocked 分支。
          && !message.startsWith("subagent_result_content_unrecoverable");
        return {
          category: message.split(":", 1)[0]!,
          recoverable,
          ...(recoverable ? { recommendedTool: "subagent_submit_result" } : {}),
          instruction: recoverable
            ? `正式结果未被接收：${message}。请根据输出 Schema 和已读取证据修正全部参数，然后重试一次。`
            : `正式结果无法再次提交：${message}。`,
          retryKey: input.runId,
          maxAttempts: recoverable ? 1 : 0,
        };
      },
    };
  }

  prepare(revisionId: string, runId: string, input: unknown): void {
    this.submissions.delete(runId);
    this.invocations.set(runId, { revisionId, input: structuredClone(input) });
  }

  take(revisionId: string, runId: string): unknown | null {
    const submitted = this.submissions.get(runId);
    this.submissions.delete(runId);
    this.invocations.delete(runId);
    return submitted?.revisionId === revisionId ? submitted.value : null;
  }

  discard(runId: string): void {
    this.submissions.delete(runId);
    this.invocations.delete(runId);
  }

  clear(): void {
    this.submissions.clear();
    this.invocations.clear();
  }

  private validatorFor(schema: Record<string, unknown>): ValidateFunction {
    const existing = this.validators.get(schema);
    if (existing) return existing;
    const validator = this.ajv.compile(schema);
    this.validators.set(schema, validator);
    return validator;
  }
}

/**
 * 单页推理档位的解算顺序（纯函数，便于单测）：
 * 1. bundle 的 `policy.model.reasoning` —— agent 自己说了算；
 * 2. `NXCORE_SUBAGENT_SLIDES_REASONING` —— 只作用于 `slides-*` 子代理；
 * 3. 全局缺省档位。
 *
 * 为什么需要第 2 层：实测单页 165s 里 **98% 是模型推理**（工具只占 4s），
 * 想继续压只能动推理量。用 env 而不是逐个改 agent.yaml，是为了能对同一份资料
 * 快速做「medium vs low」的 A/B——改完重启网关即可，不动仓库里的 bundle。
 * 缺省不设＝行为与改造前完全一致。
 */
export function resolveSubagentReasoning(input: {
  policyReasoning?: PiRuntimeConfig["reasoning"] | undefined;
  agentId: string;
  slidesOverride?: PiRuntimeConfig["reasoning"] | undefined;
  fallback?: PiRuntimeConfig["reasoning"] | undefined;
}): PiRuntimeConfig["reasoning"] | undefined {
  if (input.policyReasoning !== undefined) return input.policyReasoning;
  if (input.slidesOverride !== undefined && input.agentId.startsWith("slides-")) {
    return input.slidesOverride;
  }
  return input.fallback;
}

/**
 * 子代理用哪个模型底座。
 *
 * 布局代理跑主模型：主模型（deepseek 系）已具备视觉能力，布局自审直接看渲染图，
 * 不再单独下发 vlm 槽模型——避免布局与主 Agent 两套模型、两套生成参数口径。
 * 其余子代理仍走 background（成本档），缺失时回退主模型。
 */
export function resolveSubagentRuntimeBase(input: {
  agentId: string;
  backgroundPi?: PiRuntimeConfig | null | undefined;
  pi?: PiRuntimeConfig | null | undefined;
}): PiRuntimeConfig | null {
  // 布局代理与主 Agent 同底座；backgroundPi 是成本档，只在主模型缺失时兜底。
  if (input.agentId === "slides-layouter") return input.pi ?? input.backgroundPi ?? null;
  return input.backgroundPi ?? input.pi ?? null;
}

export class SubagentRuntimeManager {
  private readonly runtimes = new Map<string, AgentRuntime>();
  /** revisionId → 正在跑的调用数（invalidate 据此判断能否立即回收）。 */
  private readonly users = new Map<string, number>();
  /** 已移出缓存但仍有调用在跑的 runtime：跑完即 dispose。 */
  private readonly retiring = new Map<string, AgentRuntime>();
  private readonly agentTools = new Map<string, () => PiAgentRuntimeTool[]>();
  private readonly agentResultValidators = new Map<string, SubagentResultValidator>();
  private readonly resultCollector = new SubagentResultCollector();

  constructor(
    private readonly gatewayConfig: GatewayConfig,
    private readonly config: SubagentFrameworkConfig,
    private readonly externalCalls?: ExternalCallBudgetService,
    private readonly agentDebugStore?: AgentDebugTraceStore,
  ) {}

  acquire(revision: LoadedSubagentRevision): AgentRuntime {
    this.users.set(revision.id, (this.users.get(revision.id) ?? 0) + 1);
    const cached = this.runtimes.get(revision.id);
    if (cached) return cached;
    const runtime = this.trace(this.createRuntime(revision), revision);
    this.runtimes.set(revision.id, runtime);
    return runtime;
  }

  /**
   * dispatch-only 子 Agent 的 trace 接入点（agentKind=developer）。
   * 其 runtime 也可能被 AgentResolver 以 developer 定义注册，那边跳过 trace
   * 避免同一 run 双记，所以埋点必须在这里完成。
   */
  private trace(runtime: AgentRuntime, revision: LoadedSubagentRevision): AgentRuntime {
    if (!this.agentDebugStore) return runtime;
    return traceRuntime(runtime, this.agentDebugStore, {
      agentId: revision.manifest.id,
      agentName: revision.manifest.name,
      agentKind: "developer",
      description: revision.manifest.description,
    });
  }

  /** Register Gateway-owned tools for one dispatch-only Agent identity. */
  registerAgentTools(agentId: string, factory: () => PiAgentRuntimeTool[]): void {
    if (this.runtimes.size > 0) {
      throw new Error("subagent_tools_must_be_registered_before_runtime_acquire");
    }
    this.agentTools.set(agentId, factory);
  }

  registerAgentResultValidator(agentId: string, validator: SubagentResultValidator): void {
    if (this.runtimes.size > 0) {
      throw new Error("subagent_result_validator_must_be_registered_before_runtime_acquire");
    }
    this.agentResultValidators.set(agentId, validator);
  }

  takeSubmittedResult(revisionId: string, runId: string): unknown | null {
    return this.resultCollector.take(revisionId, runId);
  }

  prepareSubmittedResult(revisionId: string, runId: string, input: unknown): void {
    this.resultCollector.prepare(revisionId, runId, input);
  }

  async dispose(): Promise<void> {
    await Promise.all([
      ...[...this.runtimes.values()].map((runtime) => runtime.dispose()),
      ...[...this.retiring.values()].map((runtime) => runtime.dispose()),
    ]);
    this.runtimes.clear();
    this.retiring.clear();
    this.users.clear();
    this.resultCollector.clear();
  }

  /**
   * runtime config 变更后作废缓存：下次 acquire 用新配置重建。
   *
   * **在跑的调用不能被中断**：runtime config 会被周期性重推（桌面端同步、中转
   * 会话刷新、连接器会话变更都触发），早期实现直接 dispose 全部缓存 runtime，
   * 等于每隔几分钟腰斩一次长任务——论文模版解析（约 6 分钟）实测每次跑到一半就
   * 变 cancelled（2026-10-27 定位）。现在把仍有调用在跑的 runtime 标记为「待回收」，
   * 等它跑完再 dispose；缓存条目本身立即移出，新调用照常拿新配置。
   */
  async invalidate(): Promise<void> {
    for (const [revisionId, runtime] of [...this.runtimes]) {
      this.runtimes.delete(revisionId);
      if ((this.users.get(revisionId) ?? 0) > 0) {
        this.retiring.set(revisionId, runtime);
        continue;
      }
      await runtime.dispose().catch(() => undefined);
    }
    if (this.retiring.size === 0) this.resultCollector.clear();
  }

  /** 调用结束归还配额：延迟回收的 runtime 在这里才真正 dispose。 */
  release(revisionId: string): void {
    const count = (this.users.get(revisionId) ?? 1) - 1;
    if (count > 0) {
      this.users.set(revisionId, count);
      return;
    }
    this.users.delete(revisionId);
    const retired = this.retiring.get(revisionId);
    if (!retired) return;
    this.retiring.delete(revisionId);
    void retired.dispose().catch(() => undefined).then(() => {
      if (this.retiring.size === 0 && this.runtimes.size === 0) this.resultCollector.clear();
    });
  }

  private createRuntime(revision: LoadedSubagentRevision): AgentRuntime {
    if (this.gatewayConfig.agentRuntime === "fake") return new FakeAgentRuntime();
    const base = resolveSubagentRuntimeBase({
      agentId: revision.manifest.id,
      backgroundPi: this.gatewayConfig.backgroundPi,
      pi: this.gatewayConfig.pi,
    });
    if (!base) throw new Error("subagent_pi_runtime_not_configured");
    // 降级启动：空字段 PiAgentRuntime 会在 pi SDK 深处炸出晦涩错误，
    // 换成类型化占位（runtime_config_not_ready）。
    if (!isPiRuntimeConfigured(base)) {
      return new UnconfiguredAgentRuntime(`subagent:${revision.id}`);
    }
    const config = this.buildPiConfig(base, revision);
    const tools = [
      ...(revision.manifest.skills.length > 0 ? [createSubagentSkillReadTool(revision)] : []),
      ...(this.agentTools.get(revision.manifest.id)?.() ?? []),
      ...(() => {
        const submitResult = this.resultCollector.createTool(
          revision,
          this.agentResultValidators.get(revision.manifest.id),
        );
        return submitResult ? [submitResult] : [];
      })(),
    ];
    return new PiAgentRuntime(config, {
      tools,
      ...(this.externalCalls
        ? {
            executeMcpCall: (input, tool, invoke) => this.externalCalls!.execute("MCP", tool, {
              source: "subagent",
              runId: input.runId,
              correlationId: input.sessionId,
            }, async (markDispatched) => {
              markDispatched();
              return invoke();
            }),
          }
        : {}),
    });
  }

  private resolveReasoning(
    revision: LoadedSubagentRevision,
    model: PiRuntimeConfig,
  ): { reasoning?: PiRuntimeConfig["reasoning"] } {
    const resolved = resolveSubagentReasoning({
      policyReasoning: revision.policy.model?.reasoning,
      agentId: revision.manifest.id,
      slidesOverride: this.config.slidesReasoning,
      fallback: model.reasoning,
    });
    return resolved === undefined ? {} : { reasoning: resolved };
  }

  private buildPiConfig(base: PiRuntimeConfig, revision: LoadedSubagentRevision): PiRuntimeConfig {
    const { mcp: _mcp, ...model } = base;
    const overrides = revision.policy.model;
    const contextWindow = overrides?.contextWindow ?? model.contextWindow;
    // 子 Agent 上下文预算（2026-10 实测：planner 单条 room_context_get 171KB、
    // builder 自身工具参数 49.6k token，均把 128k 窗口顶穿）：
    // - 单条工具结果超 24k 字符按 JSON 感知规则截断；
    // - run 内真实 usage 过半窗口后，旧工具结果/参数替换为占位符（轮次级裁剪）。
    // pi 的自动压缩只在整轮 run 结束后生效，子 Agent 一次 prompt 里几十个工具轮
    // 等不到它，必须由 runtime 侧补一道。
    return {
      ...model,
      runtimeId: `pi:subagent:${revision.id}`,
      systemPrompt: revision.systemPrompt,
      runtimeRole: "internal",
      skillsEnabled: revision.manifest.skills.length > 0,
      builtinTools: [],
      includeBashTool: false,
      // 不声明工具预算＝不注入上限：布局类长链路由 timeoutMs / 输出预算兜底。
      ...(revision.policy.maxToolCalls === undefined
        ? {}
        : { maxToolCallsPerRun: revision.policy.maxToolCalls }),
      maxToolResultChars: SUBAGENT_TOOL_RESULT_MAX_CHARS,
      runContextGuard: {
        triggerTokens: Math.max(8_000, Math.floor(contextWindow * SUBAGENT_CONTEXT_GUARD_TRIGGER_RATIO)),
        keepRecentTurns: SUBAGENT_CONTEXT_GUARD_KEEP_TURNS,
      },
      ...(contextWindow !== model.contextWindow ? { contextWindow } : {}),
      ...(overrides?.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
      ...this.resolveReasoning(revision, model),
      agentDirectory: revision.agentDirectory,
      sessionsDir: join(this.config.runtimeDir, "sessions", revision.id),
      workingDirectory: join(this.config.runtimeDir, "workspaces", revision.id),
      ...(Object.keys(revision.mcpServers).length > 0
        ? { mcp: { mcpServers: revision.mcpServers } }
        : {}),
    };
  }

}
