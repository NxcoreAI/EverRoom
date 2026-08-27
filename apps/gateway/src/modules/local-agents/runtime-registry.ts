import type { AgentCard } from "@a2a-js/sdk";
import type { LocalAgentInvocationTarget } from "@nxcore/agent-contract";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { resolve } from "node:path";
import { A2ALocalAgentRuntime } from "./a2a-runtime.js";
import { LocalA2AHost } from "./a2a-host.js";
import { ClaudeCliAgentRuntime } from "./cli-runtime.js";

export class LocalAgentRuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  resolve(target: LocalAgentInvocationTarget): AgentRuntime {
    const runtimeKey = `${target.id}\0${resolve(target.workingDirectory)}`;
    const cached = this.runtimes.get(runtimeKey);
    if (cached) return cached;
    if (target.provider !== "codex" && target.provider !== "claude") {
      throw new Error("local_agent_provider_not_supported");
    }
    this.assertCard(target.card);
    const runtime = target.provider === "codex"
      ? new A2ALocalAgentRuntime(
          new LocalA2AHost(target.executablePath, target.workingDirectory, target.id),
          target.id,
        )
      : new ClaudeCliAgentRuntime(
          target.executablePath,
          target.workingDirectory,
          target.id,
        );
    this.runtimes.set(runtimeKey, runtime);
    return runtime;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
  }

  private assertCard(card: LocalAgentInvocationTarget["card"]): void {
    // Keep the generated card aligned with the official A2A SDK contract at the host boundary.
    const a2aView: Pick<AgentCard, "name" | "description" | "version" | "defaultInputModes" | "defaultOutputModes"> = card;
    if (!a2aView.name || !a2aView.version || !a2aView.defaultInputModes.length) {
      throw new Error("local_agent_card_invalid");
    }
  }
}
