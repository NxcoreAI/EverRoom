import { join } from "node:path";
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
    promptGuidelines: mcpHost.capabilities.promptGuidelines(),
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
