import { lstat, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { PiAgentRuntime, type PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { Type } from "@sinclair/typebox";
import { Ajv, type ValidateFunction } from "ajv";
import type { GatewayConfig, PiRuntimeConfig, SubagentFrameworkConfig } from "../../config.js";
import { isPiRuntimeConfigured } from "../agent/runtime-factory.js";
import type { LoadedSubagentRevision } from "./types.js";
import type { ExternalCallBudgetService } from "../external-calls/service.js";

export type SubagentResultValidator = (
  invocationInput: unknown,
  result: Record<string, unknown>,
) => void;

export function createSubagentSkillReadTool(revision: LoadedSubagentRevision): PiAgentRuntimeTool {
  const root = `${resolve(revision.agentDirectory)}${sep}`;
  return {
    name: "read",
    label: "Read skill resource",
    description: "读取当前子 Agent Revision 中的 Skill 文件。只能访问系统提示词列出的 Skill 目录。",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      offset: Type.Optional(Type.Integer({ minimum: 1 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
    }, { additionalProperties: false }),
    execute: async (_input, params) => {
      const requestedPath = resolve(String(params.path ?? ""));
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
          content: JSON.stringify({ accepted: true, invocationId: input.runId }),
          details: { accepted: true, invocationId: input.runId },
        };
      },
      classifyFailure: (error, input) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.startsWith("subagent_result_")) return null;
        const recoverable = !message.startsWith("subagent_result_invocation_mismatch")
          && !message.startsWith("subagent_result_already_submitted");
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

export class SubagentRuntimeManager {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly agentTools = new Map<string, () => PiAgentRuntimeTool[]>();
  private readonly agentResultValidators = new Map<string, SubagentResultValidator>();
  private readonly resultCollector = new SubagentResultCollector();

  constructor(
    private readonly gatewayConfig: GatewayConfig,
    private readonly config: SubagentFrameworkConfig,
    private readonly externalCalls?: ExternalCallBudgetService,
  ) {}

  acquire(revision: LoadedSubagentRevision): AgentRuntime {
    const cached = this.runtimes.get(revision.id);
    if (cached) return cached;
    const runtime = this.createRuntime(revision);
    this.runtimes.set(revision.id, runtime);
    return runtime;
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
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
    this.resultCollector.clear();
  }

  /**
   * runtime config 变更后作废缓存：下次 acquire 用新配置重建。
   * dispose 会中断进行中的子 Agent run（orchestrator 有重启恢复），
   * 配置变更是罕见手动操作，可接受。
   */
  async invalidate(): Promise<void> {
    await this.dispose();
  }

  private createRuntime(revision: LoadedSubagentRevision): AgentRuntime {
    if (this.gatewayConfig.agentRuntime === "fake") return new FakeAgentRuntime();
    const base = this.gatewayConfig.backgroundPi ?? this.gatewayConfig.pi;
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

  private buildPiConfig(base: PiRuntimeConfig, revision: LoadedSubagentRevision): PiRuntimeConfig {
    const { memory: _memory, knowledge: _knowledge, mcp: _mcp, ...model } = base;
    return {
      ...model,
      runtimeId: `pi:subagent:${revision.id}`,
      systemPrompt: revision.systemPrompt,
      runtimeRole: "internal",
      skillsEnabled: revision.manifest.skills.length > 0,
      builtinTools: [],
      includeBashTool: false,
      maxToolCallsPerRun: revision.policy.maxToolCalls,
      agentDirectory: revision.agentDirectory,
      sessionsDir: join(this.config.runtimeDir, "sessions", revision.id),
      workingDirectory: join(this.config.runtimeDir, "workspaces", revision.id),
      ...(Object.keys(revision.mcpServers).length > 0
        ? { mcp: { mcpServers: revision.mcpServers } }
        : {}),
    };
  }

}
