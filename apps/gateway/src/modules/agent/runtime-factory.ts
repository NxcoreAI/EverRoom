import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime, type PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import { UnconfiguredAgentRuntime, type AgentRuntime } from "@nxcore/agent-runtime";
import { bundledAgentDefinitionsDir, type GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiToolsWithRoomBindings } from "../documents/pi-tools.js";
import { createOpenConnectorPiTools } from "./open-connector-tools.js";
import { createConnectorDataPiTools } from "../connectors/pi-tools.js";
import { createNangoPiTools } from "../connectors/nango-agent-tools.js";
import { createConnectorSyncAgentTools } from "../connectors/agent-tools.js";
import type { ConnectorSyncService } from "../connectors/service.js";
import type { ConnectorManager } from "../connectors/manager.js";
import type { NangoExecutor } from "../connectors/nango-executor.js";
import type { DiaryAgentGenerator } from "../diary/agent-generator.js";
import { createWebSearchPiTools } from "./web-search-tools.js";
import { OpenAiCompletionAgentRuntime } from "./openai-completion-runtime.js";
import { AgentResolver, BUILTIN_AGENT_IDS, type AgentDefinition } from "./resolver.js";
import { loadBuiltinAgentBundle } from "./builtin-bundles.js";
import type { ExternalCallBudgetService } from "../external-calls/service.js";

export interface AgentRuntimeIntegrationOptions {
  tools?: readonly PiAgentRuntimeTool[];
  agentResolver?: AgentResolver;
  externalCalls?: ExternalCallBudgetService;
  /** 会话级 Room wiki 解析（plan §6.1 resolveKnowledge），knowledge 模块注入。 */
  resolveKnowledgeWikiIds?: (input: {
    runId: string;
    sessionId: string;
    runtimeSessionRef: string | null;
    prompt: string;
    pageLabel: string;
    roomId: string | null;
  }) => Promise<string[]>;
}

function agentDirectories(config: GatewayConfig, agentId: string) {
  const root = join(config.dataDir, "agent", "runtimes", agentId);
  return {
    root,
    sessionsDir: join(root, "sessions"),
    workingDirectory: join(root, "workspace"),
    agentDirectory: join(root, "config"),
  };
}

function definition(config: GatewayConfig, input: Omit<AgentDefinition, "configDirectory" | "kind">): AgentDefinition {
  return {
    ...input,
    configDirectory: agentDirectories(config, input.id).agentDirectory,
    kind: "builtin",
  };
}

function builtin(id: (typeof BUILTIN_AGENT_IDS)[keyof typeof BUILTIN_AGENT_IDS]) {
  return loadBuiltinAgentBundle(bundledAgentDefinitionsDir(), id);
}

/**
 * pi 配置四要素齐全才算可用（与 runtime-config 的 isPrimaryConfigured 同判据）。
 * 未配置（pi 模式 + env 全空 + runtime config 尚未保存）返回占位 runtime，
 * 见各工厂的降级分支。
 */
export function isPiRuntimeConfigured(
  pi: { provider: string; model: string; baseUrl: string; apiKey: string } | null | undefined,
): boolean {
  return Boolean(pi && pi.provider && pi.model && pi.baseUrl && pi.apiKey);
}

function withAgentDirectories(
  config: GatewayConfig,
  agentId: string,
  pi: NonNullable<GatewayConfig["pi"]>,
): NonNullable<GatewayConfig["pi"]> {
  const directories = agentDirectories(config, agentId);
  return {
    ...pi,
    runtimeId: `pi:${agentId}`,
    sessionsDir: directories.sessionsDir,
    workingDirectory: directories.workingDirectory,
    agentDirectory: directories.agentDirectory,
  };
}

export function createAgentRuntime(
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  knowledge?: AgentRuntimeIntegrationOptions,
  connectorSync?: ConnectorSyncService,
  nango?: { manager: ConnectorManager; executor: NangoExecutor } | null,
): AgentRuntime {
  const bundle = builtin(BUILTIN_AGENT_IDS.primary);
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  // 降级启动：AI 未配置时返回占位 runtime（run 立即 runtime_config_not_ready），
  // 等 runtime config 保存后 AgentResolver.reload 换成真实 Pi runtime。
  if (!config.pi || !isPiRuntimeConfigured(config.pi)) return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.primary);
  const routedRoomByRun = new Map<string, string>();
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.primary, config.pi),
    bashSandbox: {
      allowedRoots: [agentDirectories(config, BUILTIN_AGENT_IDS.primary).workingDirectory],
      timeoutMs: 30_000,
    },
    runtimeRole: "user-facing",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
  }, {
    tools: [
      ...(knowledge?.tools ?? []),
      ...createDocumentPiToolsWithRoomBindings(mcpHost, routedRoomByRun),
      ...(config.cliConnectorAgentMode === "local" && connectorSync
        ? createConnectorDataPiTools(connectorSync, config.cliConnectorSyncOwnerId ?? "local-user")
        : config.cliConnector ? createOpenConnectorPiTools(config.cliConnector, undefined, knowledge?.externalCalls) : []),
      ...(nango ? createNangoPiTools(nango.manager, nango.executor, knowledge?.externalCalls) : []),
      ...(config.webSearch && knowledge?.agentResolver
        ? createWebSearchPiTools(knowledge.agentResolver, knowledge.externalCalls)
        : []),
    ],
    promptGuidelines: mcpHost.capabilities.promptGuidelines(),
    ...(knowledge?.resolveKnowledgeWikiIds
      ? { resolveKnowledgeWikiIds: knowledge.resolveKnowledgeWikiIds }
      : {}),
    onRunFinished: async (input, outcome) => {
      routedRoomByRun.delete(input.runId);
      await mcpHost.finishAgentRun(input.sessionId, outcome, input.runId);
    },
    ...(knowledge?.externalCalls
      ? {
          executeMcpCall: (input, tool, invoke) => knowledge.externalCalls!.execute("MCP", tool, {
            source: "agent",
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

export function createConnectorSyncAgentRuntime(
  config: GatewayConfig,
  connectorSync: ConnectorSyncService,
): AgentRuntime | null {
  const bundle = builtin(BUILTIN_AGENT_IDS.connectorSync);
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi) || !config.cliConnector) return null;
  const { memory: _memory, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.connectorSync, {
      ...pi,
      includeBashTool: false,
      maxToolCallsPerRun: 128,
      runtimeRole: "internal",
      skillsEnabled: true,
      skillPrompts: bundle.skillPrompts,
    }),
    systemPrompt: bundle.systemPrompt,
  }, {
    tools: createConnectorSyncAgentTools(config.cliConnector, connectorSync),
  });
}

export function createBackgroundAgentRuntime(config: GatewayConfig): AgentRuntime {
  const bundle = builtin(BUILTIN_AGENT_IDS.transcriptionSummary);
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!isPiRuntimeConfigured(config.backgroundPi)) {
    return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.transcriptionSummary);
  }
  const { memory: _memory, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.transcriptionSummary, pi),
    runtimeRole: "internal",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
  });
}

/**
 * ingest 过滤器专用 Runtime（ingest-filter-agent-plan §4.2）：
 * 独立目录（ingest-filter 子目录），memory + knowledge 集成但**只读工具**——
 * memory_search / wiki_search / wiki_read，无任何写路径，无 bash，无内置工具。
 *
 * 记忆隔离（§4.1）由装配与 run 侧共同保证：这里不给 mcp、不给写工具；
 * filter-agent.ts 的 run 显式传 captureMemory/recallMemory 双 false。
 * 与 background runtime（显式剥 memory）不同：过滤器需要只读记忆检索。
 */
export function createIngestFilterAgentRuntime(
  config: GatewayConfig,
  resolveWikiIds?: (input: { roomId: string | null }) => Promise<string[]>,
): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const bundle = builtin(BUILTIN_AGENT_IDS.ingestFilter);
  const { mcp: _mcp, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: config.ingestFilter.maxToolCalls,
    runtimeRole: "internal",
    // 过滤器输出是给程序 JSON.parse 的：必须挂机器对机器的 bundle 人设，
    // 否则落到默认聊天人设（"最终答复要总结"），模型会在数组前后加说明文字
    skillsEnabled: false,
    systemPrompt: bundle.systemPrompt,
    sessionsDir: join(pi.sessionsDir, "ingest-filter"),
    workingDirectory: join(pi.workingDirectory, "ingest-filter"),
    agentDirectory: join(pi.agentDirectory, "ingest-filter"),
  }, resolveWikiIds ? { resolveKnowledgeWikiIds: resolveWikiIds } : {});
}

/** 日记使用隔离的 Pi Runtime，只暴露来源清单读取工具。 */
export function createDiaryAgentRuntime(
  config: GatewayConfig,
  generator: DiaryAgentGenerator,
): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !isPiRuntimeConfigured(config.backgroundPi)) return null;
  const bundle = builtin(BUILTIN_AGENT_IDS.diary);
  const { memory: _memory, knowledge: _knowledge, ...pi } = config.backgroundPi!;
  return new PiAgentRuntime({
    ...pi,
    runtimeId: `pi:${BUILTIN_AGENT_IDS.diary}`,
    maxTokens: config.diaryMaxTokens ?? Math.max(pi.maxTokens, 16_384),
    includeBashTool: false,
    maxToolCallsPerRun: 128,
    runtimeRole: "internal",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
    sessionsDir: join(pi.sessionsDir, "diary"),
    workingDirectory: join(pi.workingDirectory, "diary"),
    agentDirectory: join(pi.agentDirectory, "diary"),
  }, { tools: generator.tools() });
}

export function registerDiaryAgent(
  resolver: AgentResolver,
  config: GatewayConfig,
  generator: DiaryAgentGenerator,
): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.diary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.diary,
    name: bundle.name,
    description: bundle.description,
  }), () => createDiaryAgentRuntime(config, generator)
    ?? new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.diary));
}

export function createCursorCompletionRuntime(config: GatewayConfig): AgentRuntime {
  const bundle = builtin(BUILTIN_AGENT_IDS.cursorCompletion);
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!isPiRuntimeConfigured(config.cursorCompletionPi)) {
    return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.cursorCompletion);
  }
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.cursorCompletion, config.cursorCompletionPi!),
    runtimeRole: "internal",
    skillsEnabled: true,
    skillPrompts: bundle.skillPrompts,
    systemPrompt: bundle.systemPrompt,
  });
}

export function createAgentResolver(config: GatewayConfig): AgentResolver {
  const resolver = new AgentResolver();
  // 工厂闭包读「活」config（applyRuntimeConfig 原地 patch 的同一对象），
  // 而不是捕获启动时快照——AgentResolver.reload 重跑工厂时才能拿到
  // runtime config 热应用后的 knowledge.llm / webSearch。
  const knowledgeLlm = config.knowledge?.llm;
  if (knowledgeLlm) {
    const id = BUILTIN_AGENT_IDS.knowledge;
    const bundle = builtin(id);
    const directories = agentDirectories(config, id);
    resolver.register(definition(config, {
      id,
      name: bundle.name,
      description: bundle.description,
    }), () => {
      const llm = config.knowledge?.llm;
      if (!llm) return new UnconfiguredAgentRuntime(id);
      return new OpenAiCompletionAgentRuntime({
      runtimeId: id,
      ...llm,
      systemPrompt: bundle.systemPrompt,
      skillPrompts: bundle.skillPrompts,
      temperature: 0.1,
      maxTokens: 4_096,
      timeoutMs: 60_000,
      ...directories,
    });
    });
  }
  if (config.webSearch) {
    const bundle = builtin(BUILTIN_AGENT_IDS.webSearch);
    const directories = agentDirectories(config, BUILTIN_AGENT_IDS.webSearch);
    resolver.register(definition(config, {
      id: BUILTIN_AGENT_IDS.webSearch,
      name: bundle.name,
      description: bundle.description,
    }), () => {
      const webSearch = config.webSearch;
      if (!webSearch) return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.webSearch);
      return new OpenAiCompletionAgentRuntime({
        runtimeId: BUILTIN_AGENT_IDS.webSearch,
        ...webSearch,
        systemPrompt: bundle.systemPrompt,
        requestOptions: { enable_search: true },
        includeProviderErrorBody: false,
        ...directories,
      });
    });
  }
  return resolver;
}

/**
 * 动态注册 webSearch agent（boot 时 env 未配、runtime config 保存后才生效）。
 * 与 createAgentResolver 的注册体一致；已注册时跳过。
 */
export function registerWebSearchAgentIfMissing(resolver: AgentResolver, config: GatewayConfig): boolean {
  if (!config.webSearch || resolver.has(BUILTIN_AGENT_IDS.webSearch)) return false;
  const bundle = builtin(BUILTIN_AGENT_IDS.webSearch);
  const directories = agentDirectories(config, BUILTIN_AGENT_IDS.webSearch);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.webSearch,
    name: bundle.name,
    description: bundle.description,
  }), () => {
    const webSearch = config.webSearch;
    if (!webSearch) return new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.webSearch);
    return new OpenAiCompletionAgentRuntime({
      runtimeId: BUILTIN_AGENT_IDS.webSearch,
      ...webSearch,
      systemPrompt: bundle.systemPrompt,
      requestOptions: { enable_search: true },
      includeProviderErrorBody: false,
      ...directories,
    });
  });
  return true;
}

export function registerPrimaryAgent(
  resolver: AgentResolver,
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  integrations: AgentRuntimeIntegrationOptions,
  connectorSync?: ConnectorSyncService,
  nango?: { manager: ConnectorManager; executor: NangoExecutor } | null,
): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.primary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.primary,
    name: bundle.name,
    description: bundle.description,
  }), () => createAgentRuntime(
    config,
    mcpHost,
    { ...integrations, agentResolver: resolver },
    connectorSync,
    nango,
  ));
}

export function registerConnectorSyncAgent(
  resolver: AgentResolver,
  config: GatewayConfig,
  connectorSync: ConnectorSyncService,
): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.connectorSync);
  if (config.agentRuntime !== "fake" && (!config.backgroundPi || !config.cliConnector)) return;
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.connectorSync,
    name: bundle.name,
    description: bundle.description,
  }), () => createConnectorSyncAgentRuntime(config, connectorSync)
    // 降级占位：注册守卫放行了但工厂因 AI 未配置返回 null（fake 模式除外），
    // 同步请求得到 runtime_config_not_ready 而不是假成功。
    ?? new UnconfiguredAgentRuntime(BUILTIN_AGENT_IDS.connectorSync));
}

export function registerTranscriptionSummaryAgent(resolver: AgentResolver, config: GatewayConfig): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.transcriptionSummary);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.transcriptionSummary,
    name: bundle.name,
    description: bundle.description,
  }), () => createBackgroundAgentRuntime(config));
}

export function registerCursorCompletionAgent(resolver: AgentResolver, config: GatewayConfig): void {
  const bundle = builtin(BUILTIN_AGENT_IDS.cursorCompletion);
  resolver.register(definition(config, {
    id: BUILTIN_AGENT_IDS.cursorCompletion,
    name: bundle.name,
    description: bundle.description,
  }), () => createCursorCompletionRuntime(config));
}
