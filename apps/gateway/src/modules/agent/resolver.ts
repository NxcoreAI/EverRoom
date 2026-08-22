import type {
  AgentRuntime,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  RuntimeRun,
  StartRuntimeRunInput,
} from "@nxcore/agent-runtime";

export const BUILTIN_AGENT_IDS = {
  primary: "main",
  connectorSync: "connector-sync",
  transcriptionSummary: "transcription-summary",
  diary: "diary",
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
  activity: AgentRuntimeActivity;
}

export interface AgentRuntimeRunActivity {
  id: string;
  task: string;
  pageLabel: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  completedAt: string | null;
}

export interface AgentRuntimeActivity {
  activeRuns: AgentRuntimeRunActivity[];
  lastRun: AgentRuntimeRunActivity | null;
}

function terminalStatus(event: RuntimeEvent): AgentRuntimeRunActivity["status"] | null {
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.failed") return "failed";
  if (event.type === "run.cancelled") return "cancelled";
  if (event.type === "run.interrupted") return "interrupted";
  return null;
}

function trackedRuntime(runtime: AgentRuntime, activity: AgentRuntimeActivity): AgentRuntime {
  if (typeof runtime.start !== "function" || typeof runtime.resume !== "function") return runtime;
  const originalStart = runtime.start.bind(runtime);
  const originalResume = runtime.resume.bind(runtime);
  const begin = (input: StartRuntimeRunInput | ResumeRuntimeRunInput) => {
    const run: AgentRuntimeRunActivity = {
      id: input.runId,
      task: (input.originalPrompt ?? input.prompt).trim(),
      pageLabel: input.pageLabel,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    activity.activeRuns = [...activity.activeRuns.filter(({ id }) => id !== run.id), run];
    activity.lastRun = run;
    return run;
  };
  const finish = (run: AgentRuntimeRunActivity, status: AgentRuntimeRunActivity["status"]) => {
    const completed = { ...run, status, completedAt: new Date().toISOString() };
    activity.activeRuns = activity.activeRuns.filter(({ id }) => id !== run.id);
    activity.lastRun = completed;
  };
  const observe = (source: AsyncIterable<RuntimeEvent>, run: AgentRuntimeRunActivity): AsyncIterable<RuntimeEvent> => ({
    async *[Symbol.asyncIterator]() {
      let finished = false;
      try {
        for await (const event of source) {
          const status = terminalStatus(event);
          if (status) {
            finished = true;
            finish(run, status);
          }
          yield event;
        }
      } catch (error) {
        if (!finished) finish(run, "failed");
        throw error;
      } finally {
        if (!finished && activity.activeRuns.some(({ id }) => id === run.id)) finish(run, "interrupted");
      }
    },
  });
  const start = async (input: StartRuntimeRunInput): Promise<RuntimeRun> => {
    const activityRun = begin(input);
    try {
      const runtimeRun = await originalStart(input);
      return { ...runtimeRun, events: observe(runtimeRun.events, activityRun) };
    } catch (error) {
      finish(activityRun, "failed");
      throw error;
    }
  };
  const resume = async (input: ResumeRuntimeRunInput): Promise<RuntimeRun> => {
    const activityRun = begin(input);
    try {
      const runtimeRun = await originalResume(input);
      return { ...runtimeRun, events: observe(runtimeRun.events, activityRun) };
    } catch (error) {
      finish(activityRun, "failed");
      throw error;
    }
  };
  const target = runtime as AgentRuntime & {
    start: typeof runtime.start;
    resume: typeof runtime.resume;
  };
  target.start = start;
  target.resume = resume;
  return target;
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
      activity: { activeRuns: [], lastRun: null },
    });
  }

  has(agentId: string): boolean {
    return this.registrations.has(agentId);
  }

  resolve(agentId: string): AgentRuntime {
    const registration = this.registrations.get(agentId);
    if (!registration) throw new Error(`Agent is not registered: ${agentId}`);
    registration.runtime ??= trackedRuntime(registration.createRuntime(), registration.activity);
    return registration.runtime;
  }

  reload(agentId: string): { previous: AgentRuntime | null; current: AgentRuntime } {
    const registration = this.registrations.get(agentId);
    if (!registration) throw new Error(`Agent is not registered: ${agentId}`);
    const previous = registration.runtime;
    registration.runtime = trackedRuntime(registration.createRuntime(), registration.activity);
    return { previous, current: registration.runtime };
  }

  getDefinition(agentId: string): AgentDefinition {
    const definition = this.registrations.get(agentId)?.definition;
    if (!definition) throw new Error(`Agent is not registered: ${agentId}`);
    return definition;
  }

  list(): AgentDefinition[] {
    return [...this.registrations.values()].map(({ definition }) => definition);
  }

  getActivity(agentId: string): AgentRuntimeActivity {
    const activity = this.registrations.get(agentId)?.activity;
    if (!activity) throw new Error(`Agent is not registered: ${agentId}`);
    return {
      activeRuns: activity.activeRuns.map((run) => ({ ...run })),
      lastRun: activity.lastRun ? { ...activity.lastRun } : null,
    };
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
