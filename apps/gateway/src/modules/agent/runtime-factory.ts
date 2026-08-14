import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../../config.js";

export function createAgentRuntime(config: GatewayConfig): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime(config.pi);
}
