import type { AgentRuntime } from "@nxcore/agent-runtime";

export const BUILTIN_AGENT_IDS = {
  primary: "main",
  connectorSync: "connector-sync",
  transcriptionSummary: "transcription-summary",
  cursorCompletion: "cursor-completion",
  knowledge: "knowledge",
  webSearch: "web-search",
} as const;

export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[keyof typeof BUILTIN_AGENT_IDS];

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  configDirectory: string;
  kind: "builtin" | "developer";
}

interface AgentRegistration {
  definition: AgentDefinition;
  createRuntime: () => AgentRuntime;
  runtime: AgentRuntime | null;
  disposeRuntime: boolean;
}

/** The only runtime selection boundary used by Gateway business modules. */
export class AgentResolver {
  private readonly registrations = new Map<string, AgentRegistration>();

  register(
    definition: AgentDefinition,
    createRuntime: () => AgentRuntime,
    options: { disposeRuntime?: boolean } = {},
  ): void {
    if (this.registrations.has(definition.id)) {
      throw new Error(`Agent is already registered: ${definition.id}`);
    }
    this.registrations.set(definition.id, {
      definition,
      createRuntime,
      runtime: null,
      disposeRuntime: options.disposeRuntime ?? true,
    });
  }

  has(agentId: string): boolean {
    return this.registrations.has(agentId);
  }

  resolve(agentId: string): AgentRuntime {
    const registration = this.registrations.get(agentId);
    if (!registration) throw new Error(`Agent is not registered: ${agentId}`);
    registration.runtime ??= registration.createRuntime();
    return registration.runtime;
  }

  getDefinition(agentId: string): AgentDefinition {
    const definition = this.registrations.get(agentId)?.definition;
    if (!definition) throw new Error(`Agent is not registered: ${agentId}`);
    return definition;
  }

  list(): AgentDefinition[] {
    return [...this.registrations.values()].map(({ definition }) => definition);
  }

  async dispose(): Promise<void> {
    const runtimes = new Set(
      [...this.registrations.values()].flatMap(({ runtime, disposeRuntime }) => (
        runtime && disposeRuntime ? [runtime] : []
      )),
    );
    await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
    for (const registration of this.registrations.values()) registration.runtime = null;
  }
}
