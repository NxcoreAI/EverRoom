import type { LocalAgentInvocationTarget } from "@nxcore/agent-contract";
import type { AgentRuntime, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { McpServer } from "@zed-industries/agent-client-protocol";
import { resolve } from "node:path";
import { traceRuntime } from "../agent-debug/instrument.js";
import type { AgentDebugTraceStore } from "../agent-debug/trace-store.js";
import { AcpAgentRuntime, acpAdapterCommand, type LocalAcpProvider } from "./acp-runtime.js";

const ACP_PROVIDERS = new Set<LocalAcpProvider>(["codex", "claude", "openclaw"]);

export type LocalAgentMcpServersForRun = (input: StartRuntimeRunInput) => McpServer[] | Promise<McpServer[]>;
export type LocalAgentHumanApprovalForRun = (input: StartRuntimeRunInput) => boolean | Promise<boolean>;

export class LocalAgentRuntimeRegistry {
  private readonly runtimes = new Map<string, AgentRuntime>();

  constructor(
    private readonly mcpServersForRun?: LocalAgentMcpServersForRun,
    private readonly humanApprovalForRun?: LocalAgentHumanApprovalForRun,
    private readonly agentDebugStore?: AgentDebugTraceStore,
  ) {}

  resolve(target: LocalAgentInvocationTarget): AgentRuntime {
    const runtimeKey = `${target.id}\0${resolve(target.workingDirectory)}`;
    const cached = this.runtimes.get(runtimeKey);
    if (cached) return cached;
    if (!ACP_PROVIDERS.has(target.provider as LocalAcpProvider)) {
      throw new Error("local_agent_provider_not_supported");
    }
    this.assertCard(target.card);
    const runtime = new AcpAgentRuntime(
      acpAdapterCommand(target.provider as LocalAcpProvider, target.executablePath, target.acpAdapter),
      target.workingDirectory,
      target.id,
      this.mcpServersForRun,
      this.humanApprovalForRun,
      target.provider as LocalAcpProvider,
    );
    const traced = this.trace(runtime, target);
    this.runtimes.set(runtimeKey, traced);
    return traced;
  }

  /** 本机 CLI Agent（ACP）的 trace 接入点（agentKind=local）。 */
  private trace(runtime: AgentRuntime, target: LocalAgentInvocationTarget): AgentRuntime {
    if (!this.agentDebugStore) return runtime;
    return traceRuntime(runtime, this.agentDebugStore, {
      agentId: target.id,
      agentName: target.displayName ?? target.card.name,
      agentKind: "local",
      description: target.card.description,
    });
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
