import type {
  AgentWorkspaceRunSummary,
  AgentWorkspaceStatus,
  RuntimeCapabilities,
} from "@nxcore/agent-contract";
import type {
  AgentRuntime,
  AgentRuntimeDescription,
  AgentRuntimeLimitsDescription,
  AgentRuntimeModelDescription,
} from "@nxcore/agent-runtime";
import { bundledAgentDefinitionsDir, type GatewayConfig, type PiRuntimeConfig } from "../../config.js";
import { loadBuiltinAgentBundle, type BuiltinAgentBundle } from "../agent/builtin-bundles.js";
import {
  BUILTIN_AGENT_IDS,
  type AgentDefinition,
  type AgentResolver,
  type BuiltinAgentId,
} from "../agent/resolver.js";
import type { AgentStatusService } from "../agent/status-service.js";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import type { SubagentRegistry } from "../subagents/registry.js";
import type { LoadedSubagentDefinition, LoadedSubagentRevision } from "../subagents/types.js";
import { toActivityStatus, type AgentDebugUsageStore } from "./usage-store.js";
import type {
  AgentDebugActivityItem,
  AgentDebugAgentDetail,
  AgentDebugAgentResponse,
  AgentDebugAgentSummary,
  AgentDebugAgentsResponse,
  AgentDebugLimits,
  AgentDebugModelInfo,
  AgentDebugPolicy,
  AgentDebugSkillInfo,
  AgentDebugSubagentInfo,
  AgentDebugToolInfo,
  AgentDebugUsageResponse,
  AgentDebugUsageTotals,
} from "./types.js";

/**
 * Agent 调试面板的只读数据源（GET /v1/agent-debug/*）。
 *
 * 关键取舍：能力字段一律优先取 `runtime.describe()`——即网关实际装配的
 * systemPrompt/工具/模型参数；`agents/<id>/agent.yaml` 里声明但未进入装配的
 * tools/capabilities 不作为「实际能力」返回。只有 runtime 不支持 describe
 * （fake/未配置占位）时，才回退到 bundle 的静态文案与配置档位，用于面板空态展示。
 */

export interface AgentDebugServiceDependencies {
  /**
   * 模型档位配置：仅当 runtime 不提供 describe（fake / 未配置占位）时作为
   * 展示回退，与设计文档的档位映射保持一致（main→pi、main-lite→litePi 等）。
   */
  config: Pick<GatewayConfig, "pi" | "litePi" | "cursorCompletionPi" | "backgroundPi" | "webSearch">;
  resolver: Pick<AgentResolver, "list" | "getDefinition" | "resolve">;
  statuses: Pick<AgentStatusService, "snapshot">;
  subagents: Pick<SubagentRegistry, "get">;
  invocations: Pick<SubagentOrchestrator, "listInvocations">;
  /** 使用记录查询（agent_runs / subagent_invocations + 事件聚合）；测试可 stub。 */
  usage: Pick<AgentDebugUsageStore, "listRuns" | "listInvocations">;
  /** builtin bundle 读取入口（测试可注入；缺省读发行包 agents/ 目录）。 */
  loadBundle?: (id: BuiltinAgentId) => BuiltinAgentBundle;
}

interface RuntimeInspection {
  description: AgentRuntimeDescription | null;
  capabilities: RuntimeCapabilities | null;
  /** runtime 实例 id（pi runtime 恒为 "pi"，用于判定运行时类型）。 */
  runtimeId: string | null;
}

interface SummaryInput {
  definition: AgentDefinition;
  status: AgentWorkspaceStatus | undefined;
  bundle: BuiltinAgentBundle | null;
  subagentDefinition: LoadedSubagentDefinition | null;
  inspection: RuntimeInspection;
  modelInfo: AgentDebugModelInfo | null;
}

const KIND_ORDER: Record<AgentDefinition["kind"], number> = { builtin: 0, developer: 1 };

function compareDefinitions(left: AgentDefinition, right: AgentDefinition): number {
  const byKind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  return byKind !== 0 ? byKind : left.id.localeCompare(right.id);
}

/** usage limit 在服务层再夹一次：即使绕过路由 schema 直接调用也不返回超量数据。 */
const DEFAULT_USAGE_LIMIT = 20;
const MAX_USAGE_LIMIT = 100;

function clampUsageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_USAGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_USAGE_LIMIT);
}

/** 当前运行的展示映射（AgentStatusService 已把子 Agent invocation 折成同一形状）。 */
function currentRunFrom(status: AgentWorkspaceStatus | undefined): AgentDebugActivityItem | null {
  const run = status?.currentRun ?? null;
  if (!run) return null;
  return {
    id: run.id,
    task: run.task,
    status: toActivityStatus(run.status),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    pageLabel: run.pageLabel ?? null,
    // snapshot 只回传展示字段，不携带调用来源；子 Agent 的来源见 usage 记录。
    source: null,
  };
}

function modelInfoFromDescription(model: AgentRuntimeModelDescription): AgentDebugModelInfo {
  return {
    provider: model.provider,
    model: model.model,
    baseUrl: model.baseUrl,
    api: model.api,
    reasoning: model.reasoning,
    temperature: model.temperature,
    maxTokens: model.maxTokens,
    contextWindow: model.contextWindow,
  };
}

function modelInfoFromPi(pi: PiRuntimeConfig | null | undefined): AgentDebugModelInfo | null {
  if (!pi) return null;
  return {
    provider: pi.provider || null,
    model: pi.model || null,
    baseUrl: pi.baseUrl || null,
    api: pi.api,
    reasoning: pi.reasoning,
    temperature: pi.temperature,
    maxTokens: pi.maxTokens,
    contextWindow: pi.contextWindow,
  };
}

function formatModel(model: AgentDebugModelInfo): string | null {
  if (model.provider && model.model) return `${model.provider}/${model.model}`;
  return model.model ?? model.provider;
}

/** Skill 路径的显示名：取最后一段目录名（如 `./skills/draft-create` → `draft-create`）。 */
function skillNameFromPath(path: string): string {
  const segments = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/** bundle 的 skill 名 → 相对路径（loadBuiltinAgentBundle 按 manifest 顺序填充 skillPrompts）。 */
function builtinSkillPaths(bundle: BuiltinAgentBundle | null): Map<string, string> {
  const paths = new Map<string, string>();
  if (!bundle) return paths;
  const names = Object.keys(bundle.skillPrompts);
  bundle.skills.forEach((path, index) => {
    const name = names[index];
    if (name) paths.set(name, path);
  });
  return paths;
}

function policyFromRevision(revision: LoadedSubagentRevision): AgentDebugPolicy {
  return {
    allowedCallers: [...revision.policy.allowedCallers],
    maxConcurrency: revision.policy.maxConcurrency,
    timeoutMs: revision.policy.timeoutMs,
    maxToolCalls: revision.policy.maxToolCalls ?? Number.MAX_SAFE_INTEGER,
    model: revision.policy.model ?? null,
  };
}

function subagentInfoFromRevision(revision: LoadedSubagentRevision): AgentDebugSubagentInfo {
  return {
    revisionId: revision.id,
    version: revision.version,
    digest: revision.digest,
    agentDirectory: revision.agentDirectory,
    manifest: revision.manifest as unknown as Record<string, unknown>,
    skills: [...revision.manifest.skills],
    // 只暴露绑定关系（server + 工具白名单）；MCP headers/token 永远不出网关。
    mcp: revision.manifest.mcp.map((binding) => ({
      server: binding.server,
      includeTools: binding.includeTools ?? null,
      excludeTools: binding.excludeTools ?? null,
    })),
    inputSchema: revision.inputSchema,
    outputSchema: revision.outputSchema,
  };
}

export class AgentDebugService {
  private readonly config: AgentDebugServiceDependencies["config"];
  private readonly loadBundle: (id: BuiltinAgentId) => BuiltinAgentBundle;

  constructor(private readonly dependencies: AgentDebugServiceDependencies) {
    this.config = dependencies.config;
    this.loadBundle = dependencies.loadBundle
      ?? ((id) => loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), id));
  }

  async listAgents(): Promise<AgentDebugAgentsResponse> {
    const generatedAt = new Date().toISOString();
    const statuses = this.statusesById();
    const definitions = [...this.dependencies.resolver.list()].sort(compareDefinitions);
    const agents = await Promise.all(definitions.map(async (definition) => {
      const bundle = this.bundleFor(definition);
      const subagentDefinition = this.subagentDefinitionFor(definition);
      const inspection = await this.inspect(definition.id);
      const modelInfo = this.modelInfoFor(definition, inspection, subagentDefinition);
      return this.summaryFor({
        definition,
        status: statuses.get(definition.id),
        bundle,
        subagentDefinition,
        inspection,
        modelInfo,
      });
    }));
    return { agents, generatedAt };
  }

  /** 未知 agentId 返回 null（路由转 404）。 */
  async getAgent(agentId: string): Promise<AgentDebugAgentResponse | null> {
    let definition: AgentDefinition;
    try {
      definition = this.dependencies.resolver.getDefinition(agentId);
    } catch {
      return null;
    }
    const generatedAt = new Date().toISOString();
    const bundle = this.bundleFor(definition);
    const subagentDefinition = this.subagentDefinitionFor(definition);
    const revision = subagentDefinition?.revision ?? null;
    const inspection = await this.inspect(agentId);
    const description = inspection.description;
    const modelInfo = this.modelInfoFor(definition, inspection, subagentDefinition);
    const status = this.statusesById().get(agentId);
    const summary = this.summaryFor({
      definition,
      status,
      bundle,
      subagentDefinition,
      inspection,
      modelInfo,
    });
    const detail: AgentDebugAgentDetail = {
      ...summary,
      // describe 的 systemPrompt 才是实际拼装输入；bundle/revision 只在 runtime 无法自述时兜底。
      systemPrompt: description?.systemPrompt ?? revision?.systemPrompt ?? bundle?.systemPrompt ?? "",
      skills: this.skillsFor(inspection, bundle, revision),
      tools: this.toolsFor(description),
      mcpServers: description?.mcpServers
        ?? (revision ? Object.keys(revision.mcpServers) : this.builtinMcpServers()),
      promptGuidelines: description ? [...description.promptGuidelines] : [],
      modelInfo,
      capabilities: inspection.capabilities,
      limits: limitsFor(description?.limits ?? null, revision),
      policy: revision ? policyFromRevision(revision) : null,
      subagent: revision ? subagentInfoFromRevision(revision) : null,
      recentActivity: this.recentActivityFor(definition, status, agentId),
    };
    return { agent: detail, generatedAt };
  }

  /**
   * 某个 Agent 的使用记录（内置 = agent_runs，子 Agent = subagent_invocations）。
   * 未知 agentId 返回 null（路由转 404）；limit 缺省 20、上限 100。
   */
  async usage(agentId: string, limit: number): Promise<AgentDebugUsageResponse | null> {
    let definition: AgentDefinition;
    try {
      definition = this.dependencies.resolver.getDefinition(agentId);
    } catch {
      return null;
    }
    const capped = clampUsageLimit(limit);
    const records = definition.kind === "developer"
      ? this.dependencies.usage.listInvocations(agentId, capped)
      : this.dependencies.usage.listRuns(agentId, capped);
    const totals = records.reduce<AgentDebugUsageTotals>((accumulator, record) => ({
      runs: accumulator.runs + 1,
      inputTokens: accumulator.inputTokens + (record.inputTokens ?? 0),
      outputTokens: accumulator.outputTokens + (record.outputTokens ?? 0),
    }), { runs: 0, inputTokens: 0, outputTokens: 0 });
    return { agentId, records, totals, generatedAt: new Date().toISOString() };
  }

  private statusesById(): Map<string, AgentWorkspaceStatus> {
    return new Map(
      this.dependencies.statuses.snapshot().agents.map((status) => [status.agentId, status]),
    );
  }

  private bundleFor(definition: AgentDefinition): BuiltinAgentBundle | null {
    if (definition.kind !== "builtin") return null;
    try {
      return this.loadBundle(definition.id as BuiltinAgentId);
    } catch {
      return null;
    }
  }

  private subagentDefinitionFor(definition: AgentDefinition): LoadedSubagentDefinition | null {
    return definition.kind === "developer" ? this.dependencies.subagents.get(definition.id) : null;
  }

  /**
   * 惰性构造 runtime 并询问其实际装配。resolve 可能抛（未配置/热重启中），
   * describe 也可能缺失（旧实现/fake/占位）——两者都降级为 null，绝不让面板 500。
   */
  private async inspect(agentId: string): Promise<RuntimeInspection> {
    let runtime: AgentRuntime;
    try {
      runtime = this.dependencies.resolver.resolve(agentId);
    } catch {
      return { description: null, capabilities: null, runtimeId: null };
    }
    const runtimeId: string | null = runtime.id ?? null;
    let description: AgentRuntimeDescription | null = null;
    try {
      description = (await runtime.describe?.()) ?? null;
    } catch {
      description = null;
    }
    let capabilities = description?.capabilities ?? null;
    if (!capabilities) {
      try {
        capabilities = await runtime.getCapabilities();
      } catch {
        capabilities = null;
      }
    }
    return { description, capabilities, runtimeId };
  }

  private summaryFor(input: SummaryInput): AgentDebugAgentSummary {
    const { definition, status, bundle, subagentDefinition, inspection, modelInfo } = input;
    const revision = subagentDefinition?.revision ?? null;
    return {
      id: definition.id,
      kind: definition.kind === "developer" ? "subagent" : "builtin",
      // 名字/描述用 registration：档位后缀（如「（轻量）」）只在注册信息里，bundle 没有。
      name: definition.name,
      description: definition.description,
      runtime: runtimeKind(inspection, bundle, definition.kind),
      runtimeRole: inspection.description?.role ?? null,
      model: modelInfo ? formatModel(modelInfo) : null,
      state: status?.state ?? "unknown",
      activeRunCount: status?.activeRunCount ?? 0,
      currentRun: currentRunFrom(status),
      toolCount: (inspection.description?.tools.length ?? 0)
        + (inspection.description?.builtinTools.length ?? 0),
      skillCount: this.skillsFor(inspection, bundle, revision).length,
      revisionId: subagentDefinition?.currentRevisionId ?? status?.workspace.revisionId ?? null,
      updatedAt: status?.updatedAt ?? subagentDefinition?.updatedAt ?? "",
    };
  }

  private skillsFor(
    inspection: RuntimeInspection,
    bundle: BuiltinAgentBundle | null,
    revision: LoadedSubagentRevision | null,
  ): AgentDebugSkillInfo[] {
    // 子 Agent 的 Skill 走 read 工具发现：只给相对路径，不内联正文。
    if (revision) {
      return revision.manifest.skills.map((path) => ({
        name: skillNameFromPath(path),
        path,
        prompt: null,
      }));
    }
    const paths = builtinSkillPaths(bundle);
    const described = inspection.description?.skills;
    if (described) {
      // describe 存在时以它为准（可能为空——例如 web-search 未内联任何 Skill）。
      return described.map(({ name, prompt }) => ({ name, path: paths.get(name) ?? null, prompt }));
    }
    if (bundle) {
      return Object.entries(bundle.skillPrompts).map(([name, prompt]) => ({
        name,
        path: paths.get(name) ?? null,
        prompt,
      }));
    }
    return [];
  }

  private toolsFor(description: AgentRuntimeDescription | null): AgentDebugToolInfo[] {
    if (!description) return [];
    return [
      ...description.tools.map((tool) => ({
        name: tool.name,
        label: tool.label ?? null,
        description: tool.description ?? null,
        source: "custom" as const,
      })),
      ...description.builtinTools.map((name) => ({
        name,
        label: null,
        description: null,
        source: "builtin" as const,
      })),
    ];
  }

  private modelInfoFor(
    definition: AgentDefinition,
    inspection: RuntimeInspection,
    subagentDefinition: LoadedSubagentDefinition | null,
  ): AgentDebugModelInfo | null {
    const described = inspection.description?.model;
    if (described) return modelInfoFromDescription(described);
    if (subagentDefinition) return this.subagentModelFallback(subagentDefinition.revision);
    return definition.kind === "builtin" ? this.builtinModelFallback(definition.id) : null;
  }

  /** 子 Agent 回退：backgroundPi 档 + revision.policy.model 覆盖（同 runtime-manager 口径）。 */
  private subagentModelFallback(revision: LoadedSubagentRevision): AgentDebugModelInfo | null {
    const base = modelInfoFromPi(this.config.backgroundPi ?? this.config.pi);
    if (!base) return null;
    const override = revision.policy.model;
    return {
      ...base,
      reasoning: override?.reasoning ?? base.reasoning,
      maxTokens: override?.maxTokens ?? base.maxTokens,
      contextWindow: override?.contextWindow ?? base.contextWindow,
    };
  }

  private builtinModelFallback(agentId: string): AgentDebugModelInfo | null {
    if (agentId === BUILTIN_AGENT_IDS.webSearch) {
      const webSearch = this.config.webSearch;
      if (!webSearch) return null;
      return {
        provider: null,
        model: webSearch.model || null,
        baseUrl: webSearch.baseUrl || null,
        api: "openai-completions",
        reasoning: null,
        temperature: null,
        maxTokens: null,
        contextWindow: null,
      };
    }
    if (agentId === BUILTIN_AGENT_IDS.lite) return modelInfoFromPi(this.config.litePi);
    if (agentId === BUILTIN_AGENT_IDS.cursorCompletion) {
      return modelInfoFromPi(this.config.cursorCompletionPi);
    }
    return modelInfoFromPi(this.config.pi);
  }

  /** runtime 无法自述时回退配置（仅用于 panel 展示，不代表已装配）。 */
  private builtinMcpServers(): string[] {
    return Object.keys(this.config.pi?.mcp?.mcpServers ?? {});
  }

  private recentActivityFor(
    definition: AgentDefinition,
    status: AgentWorkspaceStatus | undefined,
    agentId: string,
  ): AgentDebugActivityItem[] {
    if (definition.kind === "developer") {
      return this.dependencies.invocations.listInvocations(200)
        .filter((invocation) => invocation.agentDefinitionId === agentId)
        .slice(0, 5)
        .map((invocation) => ({
          id: invocation.id,
          task: invocation.task,
          status: toActivityStatus(invocation.status),
          startedAt: invocation.startedAt,
          completedAt: invocation.completedAt,
          pageLabel: null,
          source: invocation.source,
        }));
    }
    if (!status) return [];
    const runs: AgentWorkspaceRunSummary[] = [];
    for (const run of [status.currentRun, status.lastRun]) {
      if (run && !runs.some(({ id }) => id === run.id)) runs.push(run);
    }
    return runs.slice(0, 5).map((run) => ({
      id: run.id,
      task: run.task,
      status: toActivityStatus(run.status),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      pageLabel: run.pageLabel,
      source: null,
    }));
  }
}

function runtimeKind(
  inspection: RuntimeInspection,
  bundle: BuiltinAgentBundle | null,
  definitionKind: AgentDefinition["kind"],
): string | null {
  if (inspection.description) {
    // PiAgentRuntime.id 恒为 "pi"；其它有 describe 的实现（OpenAI 兼容）按 api 判定。
    if (inspection.runtimeId === "pi") return "pi";
    return inspection.description.model?.api === "openai-completions" ? "openai-completions" : null;
  }
  // fake/未配置占位不提供 describe：内置 Agent 回退发行包声明的 runtime，
  // 子 Agent 由 runtime-manager 固定用 pi 档。
  if (definitionKind === "builtin") return bundle?.runtime ?? null;
  return inspection.runtimeId === "pi" ? "pi" : null;
}

function limitsFor(
  limits: AgentRuntimeLimitsDescription | null,
  revision: LoadedSubagentRevision | null,
): AgentDebugLimits | null {
  if (limits) return { ...limits, runContextGuard: limits.runContextGuard ? { ...limits.runContextGuard } : null };
  if (revision) {
    return {
      maxToolCallsPerRun: revision.policy.maxToolCalls ?? null,
      maxToolResultChars: null,
      runContextGuard: null,
    };
  }
  return null;
}