import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime, type PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { bundledAgentDefinitionsDir, type GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";
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

export interface AgentRuntimeIntegrationOptions {
  tools?: readonly PiAgentRuntimeTool[];
  agentResolver?: AgentResolver;
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

function builtinSkillPaths(bundle: ReturnType<typeof builtin>): string[] {
  return bundle.skills
    .map((skill) => join(bundle.directory, skill))
    .filter((path) => existsSync(path));
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
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.primary, config.pi),
    runtimeRole: "user-facing",
    skillsEnabled: true,
    additionalSkillPaths: builtinSkillPaths(bundle),
    systemPrompt: bundle.systemPrompt,
  }, {
    tools: [
      ...(knowledge?.tools ?? []),
      ...createDocumentPiTools(mcpHost),
      ...(config.cliConnectorAgentMode === "local" && connectorSync
        ? createConnectorDataPiTools(connectorSync, config.cliConnectorSyncOwnerId ?? "local-user")
        : config.cliConnector ? createOpenConnectorPiTools(config.cliConnector) : []),
      ...(nango ? createNangoPiTools(nango.manager, nango.executor) : []),
      ...(config.webSearch && knowledge?.agentResolver
        ? createWebSearchPiTools(knowledge.agentResolver)
        : []),
    ],
    promptGuidelines: mcpHost.capabilities.promptGuidelines(),
    ...(knowledge?.resolveKnowledgeWikiIds
      ? { resolveKnowledgeWikiIds: knowledge.resolveKnowledgeWikiIds }
      : {}),
    onRunFinished: (input, outcome) => mcpHost.finishAgentRun(input.sessionId, outcome, input.runId),
  });
}

export function createConnectorSyncAgentRuntime(
  config: GatewayConfig,
  connectorSync: ConnectorSyncService,
): AgentRuntime | null {
  const bundle = builtin(BUILTIN_AGENT_IDS.connectorSync);
  if (config.agentRuntime === "fake" || !config.backgroundPi || !config.cliConnector) return null;
  const { memory: _memory, ...pi } = config.backgroundPi;
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.connectorSync, {
      ...pi,
      includeBashTool: false,
      maxToolCallsPerRun: 128,
      runtimeRole: "internal",
      skillsEnabled: true,
      additionalSkillPaths: builtinSkillPaths(bundle),
    }),
    systemPrompt: bundle.systemPrompt,
  }, {
    tools: createConnectorSyncAgentTools(config.cliConnector, connectorSync),
  });
}

export function createBackgroundAgentRuntime(config: GatewayConfig): AgentRuntime {
  const bundle = builtin(BUILTIN_AGENT_IDS.transcriptionSummary);
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.backgroundPi) throw new Error("Background Pi runtime configuration is missing");
  const { memory: _memory, ...pi } = config.backgroundPi;
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.transcriptionSummary, pi),
    runtimeRole: "internal",
    skillsEnabled: true,
    additionalSkillPaths: builtinSkillPaths(bundle),
    systemPrompt: bundle.systemPrompt,
  });
}

export function createContextRoomAgentRuntime(config: GatewayConfig): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !config.backgroundPi?.memory) return null;
  const { knowledge: _knowledge, mcp: _mcp, ...pi } = config.backgroundPi;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    builtinTools: [],
    maxToolCallsPerRun: 8,
    sessionsDir: join(config.backgroundPi.sessionsDir, "context-room-create"),
    workingDirectory: join(config.backgroundPi.workingDirectory, "context-room-create"),
    agentDirectory: join(config.backgroundPi.agentDirectory, "context-room-create"),
  });
}

/** 日记使用隔离的 Pi Runtime，只暴露来源清单读取工具。 */
export function createDiaryAgentRuntime(
  config: GatewayConfig,
  generator: DiaryAgentGenerator,
): AgentRuntime | null {
  if (config.agentRuntime === "fake" || !config.backgroundPi) return null;
  const { memory: _memory, knowledge: _knowledge, ...pi } = config.backgroundPi;
  return new PiAgentRuntime({
    ...pi,
    maxTokens: config.diaryMaxTokens ?? Math.max(pi.maxTokens, 16_384),
    includeBashTool: false,
    maxToolCallsPerRun: 128,
    sessionsDir: join(config.backgroundPi.sessionsDir, "diary"),
    workingDirectory: join(config.backgroundPi.workingDirectory, "diary"),
    agentDirectory: join(config.backgroundPi.agentDirectory, "diary"),
  }, { tools: generator.tools() });
}

export function createCursorCompletionRuntime(config: GatewayConfig): AgentRuntime {
  const bundle = builtin(BUILTIN_AGENT_IDS.cursorCompletion);
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.cursorCompletionPi) {
    throw new Error("Cursor completion Pi runtime configuration is missing");
  }
  return new PiAgentRuntime({
    ...withAgentDirectories(config, BUILTIN_AGENT_IDS.cursorCompletion, config.cursorCompletionPi),
    runtimeRole: "internal",
    skillsEnabled: true,
    additionalSkillPaths: builtinSkillPaths(bundle),
    systemPrompt: bundle.systemPrompt,
  });
}

export function createAgentResolver(config: GatewayConfig): AgentResolver {
  const resolver = new AgentResolver();
  const knowledgeLlm = config.knowledge?.llm;
  if (knowledgeLlm) {
    const id = BUILTIN_AGENT_IDS.knowledge;
    const bundle = builtin(id);
    const directories = agentDirectories(config, id);
    resolver.register(definition(config, {
      id,
      name: bundle.name,
      description: bundle.description,
    }), () => new OpenAiCompletionAgentRuntime({
      runtimeId: id,
      ...knowledgeLlm,
      systemPrompt: bundle.systemPrompt,
      skillPrompts: bundle.skillPrompts,
      temperature: 0.1,
      maxTokens: 4_096,
      timeoutMs: 60_000,
      ...directories,
    }));
  }
  if (config.webSearch) {
    const bundle = builtin(BUILTIN_AGENT_IDS.webSearch);
    const directories = agentDirectories(config, BUILTIN_AGENT_IDS.webSearch);
    resolver.register(definition(config, {
      id: BUILTIN_AGENT_IDS.webSearch,
      name: bundle.name,
      description: bundle.description,
    }), () => new OpenAiCompletionAgentRuntime({
      runtimeId: BUILTIN_AGENT_IDS.webSearch,
      ...config.webSearch!,
      systemPrompt: bundle.systemPrompt,
      requestOptions: { enable_search: true },
      ...directories,
    }));
  }
  return resolver;
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
  }), () => createConnectorSyncAgentRuntime(config, connectorSync) ?? new FakeAgentRuntime());
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
