import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";

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
): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime(config.pi, {
    tools: createDocumentPiTools(mcpHost),
    promptGuidelines: mcpHost.capabilities.promptGuidelines(),
    ...(knowledge?.resolveKnowledgeWikiIds
      ? { resolveKnowledgeWikiIds: knowledge.resolveKnowledgeWikiIds }
      : {}),
    onRunFinished: (input, outcome) => mcpHost.finishAgentRun(input.sessionId, outcome, input.runId),
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

export function createCursorCompletionRuntime(config: GatewayConfig): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.pi) throw new Error("Cursor completion Pi runtime configuration is missing");
  const { memory: _memory, ...pi } = config.pi;
  return new PiAgentRuntime(pi);
}
