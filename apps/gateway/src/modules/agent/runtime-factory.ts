import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";

export function createAgentRuntime(config: GatewayConfig, mcpHost: DocumentMcpHost): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime(config.pi, {
    tools: createDocumentPiTools(mcpHost),
    onRunFinished: (input, outcome) => mcpHost.abortAgentSession(
      input.sessionId,
      `pi-agent-run-${outcome}`,
    ),
  });
}
