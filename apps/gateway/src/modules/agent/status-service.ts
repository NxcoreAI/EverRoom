import type {
  AgentStatusSnapshot,
  AgentWorkspaceRunStatus,
  AgentWorkspaceRunSummary,
  AgentWorkspaceState,
  AgentWorkspaceStatus,
  SubagentInvocation,
} from "@nxcore/agent-contract";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import type { AgentResolver, AgentRuntimeRunActivity } from "./resolver.js";

const TERMINAL_ERRORS = new Set<AgentWorkspaceRunStatus>(["failed", "interrupted", "timed_out"]);

function runtimeRun(run: AgentRuntimeRunActivity | null): AgentWorkspaceRunSummary | null {
  if (!run) return null;
  return {
    id: run.id,
    task: run.task,
    pageLabel: run.pageLabel,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function invocationRun(invocation: SubagentInvocation | null): AgentWorkspaceRunSummary | null {
  if (!invocation) return null;
  return {
    id: invocation.id,
    task: invocation.task,
    pageLabel: null,
    status: invocation.status,
    startedAt: invocation.startedAt,
    completedAt: invocation.completedAt,
  };
}

function state(activeRunCount: number, lastStatus: AgentWorkspaceRunStatus | null): AgentWorkspaceState {
  if (activeRunCount > 0) return "running";
  return lastStatus && TERMINAL_ERRORS.has(lastStatus) ? "error" : "idle";
}

function runTimestamp(run: AgentWorkspaceRunSummary | null): string | null {
  return run?.completedAt ?? run?.startedAt ?? null;
}

export class AgentStatusService {
  constructor(
    private readonly resolver: AgentResolver,
    private readonly subagents: SubagentOrchestrator,
  ) {}

  snapshot(): AgentStatusSnapshot {
    const invocations = this.subagents.listInvocations(500);
    const revisions = new Map(
      this.subagents.listDefinitions().map((definition) => [definition.id, definition.currentRevisionId]),
    );
    const agents = this.resolver.list().map((definition): AgentWorkspaceStatus => {
      if (definition.kind === "developer") {
        const ownInvocations = invocations.filter(({ agentDefinitionId }) => agentDefinitionId === definition.id);
        const activeInvocations = ownInvocations.filter(({ status }) => status === "accepted" || status === "running");
        const currentRun = invocationRun(activeInvocations[0] ?? null);
        const lastRun = invocationRun(ownInvocations[0] ?? null);
        const revisionId = revisions.get(definition.id) ?? ownInvocations[0]?.agentRevisionId ?? null;
        return {
          agentId: definition.id,
          name: definition.name,
          description: definition.description,
          kind: definition.kind,
          state: state(activeInvocations.length, lastRun?.status ?? null),
          activeRunCount: activeInvocations.length,
          workspace: {
            id: `agent://${definition.id}`,
            isolation: "dedicated",
            revisionId,
          },
          currentRun,
          lastRun,
          updatedAt: runTimestamp(lastRun),
        };
      }

      const activity = this.resolver.getActivity(definition.id);
      const currentRun = runtimeRun(activity.activeRuns[0] ?? null);
      const lastRun = runtimeRun(activity.lastRun);
      return {
        agentId: definition.id,
        name: definition.name,
        description: definition.description,
        kind: definition.kind,
        state: state(activity.activeRuns.length, lastRun?.status ?? null),
        activeRunCount: activity.activeRuns.length,
        workspace: {
          id: `agent://${definition.id}`,
          isolation: "dedicated",
          revisionId: null,
        },
        currentRun,
        lastRun,
        updatedAt: runTimestamp(lastRun),
      };
    }).sort((left, right) => {
      if (left.agentId === "main") return -1;
      if (right.agentId === "main") return 1;
      if (left.state !== right.state) return left.state === "running" ? -1 : right.state === "running" ? 1 : 0;
      return left.name.localeCompare(right.name, "zh-CN");
    });

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        total: agents.length,
        running: agents.filter(({ state: value }) => value === "running").length,
        idle: agents.filter(({ state: value }) => value === "idle").length,
        error: agents.filter(({ state: value }) => value === "error").length,
      },
      agents,
    };
  }
}
