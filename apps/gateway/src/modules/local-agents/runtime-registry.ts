import type { LocalAgentInvocationTarget } from "@nxcore/agent-contract";
import type { AgentRuntime } from "@nxcore/agent-runtime";
import { resolve } from "node:path";
import { AcpAgentRuntime, acpAdapterCommand, type LocalAcpProvider } from "./acp-runtime.js";

const ACP_PROVIDERS = new Set<LocalAcpProvider>(["codex", "claude", "openclaw"]);

export class LocalAgentRuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  resolve(target: LocalAgentInvocationTarget): AgentRuntime {
    const runtimeKey = `${target.id}\0${resolve(target.workingDirectory)}`;
    const cached = this.runtimes.get(runtimeKey);
    if (cached) return cached;
    if (!ACP_PROVIDERS.has(target.provider as LocalAcpProvider)) {
      throw new Error("local_agent_provider_not_supported");
    }
    this.assertCard(target.card);
    const runtime = new AcpAgentRuntime(
      acpAdapterCommand(target.provider as LocalAcpProvider, target.executablePath),
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
    if (!card?.name || !card.version || !card.defaultInputModes.length) {
      throw new Error("local_agent_card_invalid");
    }
  }
}
