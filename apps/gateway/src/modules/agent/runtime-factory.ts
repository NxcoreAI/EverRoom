import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import type { GatewayConfig } from "../../config.js";
import type { DocumentMcpHost } from "../documents/mcp-host.js";
import { createDocumentPiTools } from "../documents/pi-tools.js";
import { createOpenConnectorPiTools } from './open-connector-tools.js';
import { createConnectorDataPiTools } from "../connectors/pi-tools.js";
import { createConnectorSyncAgentTools } from "../connectors/agent-tools.js";
import type { ConnectorSyncService } from "../connectors/service.js";

export function createAgentRuntime(
  config: GatewayConfig,
  mcpHost: DocumentMcpHost,
  connectorSync?: ConnectorSyncService,
): AgentRuntime {
  if (config.agentRuntime === "fake") return new FakeAgentRuntime();
  if (!config.pi) throw new Error("Pi runtime configuration is missing");
  return new PiAgentRuntime(config.pi, {
    tools: [
      ...createDocumentPiTools(mcpHost),
      ...(config.connectorAgentMode === "local" && connectorSync
        ? createConnectorDataPiTools(connectorSync, config.connectorSyncOwnerId ?? "local-user")
        : config.openConnector ? createOpenConnectorPiTools(config.openConnector) : []),
    ],
    onRunFinished: (input, outcome) => mcpHost.abortAgentSession(
      input.sessionId,
      `pi-agent-run-${outcome}`,
    ),
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
