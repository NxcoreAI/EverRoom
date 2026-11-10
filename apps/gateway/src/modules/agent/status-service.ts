import type {
  AgentStatusSnapshot,
  AgentWorkspaceRunSummary,
  AgentWorkspaceState,
  AgentWorkspaceStatus,
  SubagentInvocation,
} from "@nxcore/agent-contract";
import type { SubagentOrchestrator } from "../subagents/orchestrator.js";
import { bundledAgentDefinitionsDir } from "../../config.js";
import { loadBuiltinAgentBundle } from "./builtin-bundles.js";
import type { AgentResolver, AgentRuntimeRunActivity, BuiltinAgentId } from "./resolver.js";

/** Agent 本体（人格）快照：内置 Agent 读 bundle 的 SYSTEM.md，开发者 Agent 只有清单字段。 */
export interface AgentPersonaSnapshot {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills: string[];
  capabilities: string[];
}

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

/**
 * 运行一结束就回海：办公室只区分「运行中」和「待命」。
 * 失败的运行已经落进「最近活动」（lastRun.status 仍是 failed），
 * 不能再把 Agent 长期挂在 error 上、让鹈鹕一直停在路肩。
 */
function state(activeRunCount: number): AgentWorkspaceState {
  if (activeRunCount > 0) return "running";
  return "idle";
}

function runTimestamp(run: AgentWorkspaceRunSummary | null): string | null {
  return run?.completedAt ?? run?.startedAt ?? null;
}

export class AgentStatusService {
  constructor(
    private readonly resolver: AgentResolver,
    private readonly subagents: SubagentOrchestrator,
  ) {}

  /** 单个 Agent 的人格定义（「智能体」页人格段的数据源）。 */
  persona(agentId: string): AgentPersonaSnapshot | null {
    const definition = this.resolver.list().find((candidate) => candidate.id === agentId);
    if (!definition) return null;
    if (definition.kind === "builtin") {
      try {
        const bundle = loadBuiltinAgentBundle(
          bundledAgentDefinitionsDir(),
          definition.id as BuiltinAgentId,
        );
        return {
          id: definition.id,
          name: bundle.name,
          description: bundle.description,
          systemPrompt: bundle.systemPrompt,
          skills: bundle.skills,
          capabilities: bundle.capabilities,
        };
      } catch {
        // bundle 读不到（缺 SYSTEM.md / 清单损坏）时退回清单字段，不让接口整体失败。
      }
    }
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      systemPrompt: "",
      skills: [],
      capabilities: [],
    };
  }

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
          state: state(activeInvocations.length),
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
        state: state(activity.activeRuns.length),
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
