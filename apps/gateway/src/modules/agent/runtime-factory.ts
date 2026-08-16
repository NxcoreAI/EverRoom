import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";
import { RemoteHttpAgentRuntime } from "./remote-http-runtime.js";

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
  if (config.agentRuntime === "remote-http") {
    if (!config.remoteAgent) throw new Error("Remote HTTP runtime configuration is missing");
    return new RemoteHttpAgentRuntime(config.remoteAgent, mcpHost);
  }
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime(config.pi, {
    tools: createDocumentPiTools(mcpHost),
    ...(knowledge?.resolveKnowledgeWikiIds
      ? { resolveKnowledgeWikiIds: knowledge.resolveKnowledgeWikiIds }
      : {}),
    onRunFinished: (input, outcome) => mcpHost.abortAgentSession(
      input.sessionId,
      `pi-agent-run-${outcome}`,
    ),
  });
}
