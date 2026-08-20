import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";
import { createNangoPiTools } from "../connectors/nango-agent-tools.js";
import { createConnectorSyncAgentTools } from "../connectors/agent-tools.js";
import type { ConnectorSyncService } from "../connectors/service.js";
import type { ConnectorManager } from "../connectors/manager.js";
import type { NangoExecutor } from "../connectors/nango-executor.js";
import type { DiaryAgentGenerator } from "../diary/agent-generator.js";
import { createWebSearchPiTools } from "./web-search-tools.js";

export interface AgentRuntimeIntegrationOptions {
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

export function createAgentRuntime(
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  knowledge?: AgentRuntimeIntegrationOptions,
  connectorSync?: ConnectorSyncService,
  nango?: { manager: ConnectorManager; executor: NangoExecutor } | null,
): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime(config.pi, {
    tools: [
      ...createDocumentPiTools(mcpHost),
      ...(nango ? createNangoPiTools(nango.manager, nango.executor) : []),
      ...(config.webSearch ? createWebSearchPiTools(config.webSearch) : []),
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
  if (config.agentRuntime === "fake" || !config.backgroundPi || !config.openConnector) return null;
  const { memory: _memory, ...pi } = config.backgroundPi;
  return new PiAgentRuntime({
    ...pi,
    includeBashTool: false,
    maxToolCallsPerRun: 128,
    sessionsDir: join(config.backgroundPi.sessionsDir, "connector-sync"),
    workingDirectory: join(config.backgroundPi.workingDirectory, "connector-sync"),
    agentDirectory: join(config.backgroundPi.agentDirectory, "connector-sync"),
  }, {
    tools: createConnectorSyncAgentTools(config.openConnector, connectorSync),
  });
}

export function createBackgroundAgentRuntime(config: GatewayConfig): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.backgroundPi) throw new Error("Background Pi runtime configuration is missing");
  const { memory: _memory, ...pi } = config.backgroundPi;
  return new PiAgentRuntime({
    ...pi,
    sessionsDir: join(config.backgroundPi.sessionsDir, "background"),
    workingDirectory: join(config.backgroundPi.workingDirectory, "background"),
    agentDirectory: join(config.backgroundPi.agentDirectory, "background"),
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
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.cursorCompletionPi) {
    throw new Error("Cursor completion Pi runtime configuration is missing");
  }
  return new PiAgentRuntime(config.cursorCompletionPi);
}
