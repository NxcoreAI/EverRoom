import { join } from "node:path";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { PiAgentRuntime } from "@nxcore/agent-runtime-pi";
import type { GatewayConfig, PiRuntimeConfig, SubagentFrameworkConfig } from "../../config.js";
import type { LoadedSubagentRevision } from "./types.js";

export class SubagentRuntimeManager {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(
    private readonly gatewayConfig: GatewayConfig,
    private readonly config: SubagentFrameworkConfig,
  ) {}

  acquire(revision: LoadedSubagentRevision): AgentRuntime {
    const cached = this.runtimes.get(revision.id);
    if (cached) return cached;
    const runtime = this.createRuntime(revision);
    this.runtimes.set(revision.id, runtime);
    return runtime;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
  }

  private createRuntime(revision: LoadedSubagentRevision): AgentRuntime {
    if (this.gatewayConfig.agentRuntime === "fake") return new FakeAgentRuntime();
    const base = this.gatewayConfig.backgroundPi ?? this.gatewayConfig.pi;
    if (!base) throw new Error("subagent_pi_runtime_not_configured");
    const config = this.buildPiConfig(base, revision);
    return new PiAgentRuntime(config);
  }

  private buildPiConfig(base: PiRuntimeConfig, revision: LoadedSubagentRevision): PiRuntimeConfig {
    const { memory: _memory, knowledge: _knowledge, mcp: _mcp, ...model } = base;
    return {
      ...model,
      runtimeId: `pi:subagent:${revision.id}`,
      systemPrompt: revision.systemPrompt,
      skillsEnabled: revision.manifest.skills.length > 0,
      builtinTools: [],
      includeBashTool: false,
      maxToolCallsPerRun: revision.policy.maxToolCalls,
      agentDirectory: revision.agentDirectory,
      sessionsDir: join(this.config.runtimeDir, "sessions", revision.id),
      workingDirectory: join(this.config.runtimeDir, "workspaces", revision.id),
      ...(Object.keys(revision.mcpServers).length > 0
        ? { mcp: { mcpServers: revision.mcpServers } }
        : {}),
    };
  }
}
