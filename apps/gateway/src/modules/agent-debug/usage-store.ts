import type {
  AgentRunStatus,
  SubagentInvocationStatus,
} from "@nxcore/agent-contract";
import { desc, eq, inArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentEvents,
  agentRuns,
  agentSessions,
  subagentInvocationEvents,
  subagentInvocations,
} from "../../infrastructure/database/schema.js";
import type { AgentDebugActivityStatus, AgentDebugUsageRecord } from "./types.js";

/**
 * Agent 调试面板的「使用记录」查询层：内置 Agent 读 agent_runs（+ agent_events），
 * 子 Agent 读 subagent_invocations（+ subagent_invocation_events）。
 *
 * 只读、按 agent 维度批量取数：先取一批运行/调用，再用一次 `IN (...)` 查询
 * 聚合 token 与工具次数，避免 N+1。构造收 GatewayDatabase，测试可用内存库或 stub。
 */

/** 子 Agent 调用状态比 DTO 多 accepted/timed_out，折叠到展示状态。 */
export function toActivityStatus(
  status: AgentRunStatus | SubagentInvocationStatus,
): AgentDebugActivityStatus {
  if (status === "accepted") return "running";
  if (status === "timed_out") return "failed";
  return status;
}

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
}

interface EventAggregate {
  toolCalls: number;
  /** 该运行是否有可用的 token usage（没有 message.completed.usage 时为 null）。 */
  usage: TokenUsage | null;
}

interface EventRow {
  parentId: string;
  type: string;
  payload: unknown;
}

const MAX_LIMIT = 500;

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

/** payload.usage 形状与 pi runtime 的 message.completed 一致（单次 run 只发一条，累计值）。 */
function usageFromPayload(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== "object") return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  return {
    input: typeof record.input === "number" ? record.input : 0,
    output: typeof record.output === "number" ? record.output : 0,
    cacheRead: typeof record.cacheRead === "number" ? record.cacheRead : 0,
  };
}

function aggregateEvents(rows: EventRow[]): Map<string, EventAggregate> {
  const aggregates = new Map<string, EventAggregate>();
  for (const row of rows) {
    if (row.type !== "tool.started" && row.type !== "message.completed") continue;
    const aggregate = aggregates.get(row.parentId) ?? { toolCalls: 0, usage: null };
    if (row.type === "tool.started") {
      aggregate.toolCalls += 1;
    } else {
      const usage = usageFromPayload(row.payload);
      if (usage) {
        aggregate.usage = aggregate.usage
          ? {
              input: aggregate.usage.input + usage.input,
              output: aggregate.usage.output + usage.output,
              cacheRead: aggregate.usage.cacheRead + usage.cacheRead,
            }
          : usage;
      }
    }
    aggregates.set(row.parentId, aggregate);
  }
  return aggregates;
}

/** 运行中（无 completedAt）按 now 计；缺 startedAt 时为 null。 */
function durationBetween(startedAt: Date | null, completedAt: Date | null, now: number): number | null {
  if (!startedAt) return null;
  return Math.max(0, (completedAt?.getTime() ?? now) - startedAt.getTime());
}

export class AgentDebugUsageStore {
  constructor(private readonly db: GatewayDatabase) {}

  listRuns(agentId: string, limit: number): AgentDebugUsageRecord[] {
    const rows = this.db
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.sessionId,
        task: agentRuns.prompt,
        status: agentRuns.status,
        roomId: agentRuns.roomId,
        error: agentRuns.error,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        sessionTitle: agentSessions.title,
        pageLabel: agentSessions.pageLabel,
      })
      .from(agentRuns)
      .leftJoin(agentSessions, eq(agentSessions.id, agentRuns.sessionId))
      .where(eq(agentRuns.agentId, agentId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(clampLimit(limit))
      .all();
    const aggregates = aggregateEvents(this.runEvents(rows.map(({ id }) => id)));
    const now = Date.now();
    return rows.map((row) => {
      const aggregate = aggregates.get(row.id);
      return {
        id: row.id,
        kind: "run",
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle ?? null,
        // prompt 在写库前已脱敏（AgentService），直接展示。
        task: row.task,
        status: toActivityStatus(row.status),
        roomId: row.roomId ?? null,
        // 会话页签可能已被删除（left join 未命中），此时为 null。
        pageLabel: row.pageLabel ?? null,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        durationMs: durationBetween(row.startedAt, row.completedAt, now),
        toolCalls: aggregate?.toolCalls ?? 0,
        inputTokens: aggregate?.usage?.input ?? null,
        outputTokens: aggregate?.usage?.output ?? null,
        cacheReadTokens: aggregate?.usage?.cacheRead ?? null,
        error: row.error ?? null,
        source: null,
        revisionId: null,
      };
    });
  }

  listInvocations(agentId: string, limit: number): AgentDebugUsageRecord[] {
    const rows = this.db
      .select({
        id: subagentInvocations.id,
        sessionId: subagentInvocations.parentSessionId,
        task: subagentInvocations.task,
        status: subagentInvocations.status,
        source: subagentInvocations.source,
        revisionId: subagentInvocations.agentRevisionId,
        error: subagentInvocations.errorMessage,
        startedAt: subagentInvocations.startedAt,
        completedAt: subagentInvocations.completedAt,
        sessionTitle: agentSessions.title,
      })
      .from(subagentInvocations)
      .leftJoin(agentSessions, eq(agentSessions.id, subagentInvocations.parentSessionId))
      .where(eq(subagentInvocations.agentDefinitionId, agentId))
      .orderBy(desc(subagentInvocations.createdAt))
      .limit(clampLimit(limit))
      .all();
    const aggregates = aggregateEvents(this.invocationEvents(rows.map(({ id }) => id)));
    const now = Date.now();
    return rows.map((row) => {
      const aggregate = aggregates.get(row.id);
      return {
        id: row.id,
        kind: "invocation",
        sessionId: row.sessionId ?? null,
        sessionTitle: row.sessionTitle ?? null,
        task: row.task,
        status: toActivityStatus(row.status),
        // 子 Agent 调用没有 Room/页签归属（由父 run 决定），固定 null。
        roomId: null,
        pageLabel: null,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        durationMs: durationBetween(row.startedAt, row.completedAt, now),
        toolCalls: aggregate?.toolCalls ?? 0,
        inputTokens: aggregate?.usage?.input ?? null,
        outputTokens: aggregate?.usage?.output ?? null,
        cacheReadTokens: aggregate?.usage?.cacheRead ?? null,
        error: row.error ?? null,
        source: row.source,
        revisionId: row.revisionId,
      };
    });
  }

  /** 批量取一次运行的事件（避免 N+1；无 id 时不发查询）。 */
  private runEvents(runIds: string[]): EventRow[] {
    if (runIds.length === 0) return [];
    return this.db
      .select({ parentId: agentEvents.runId, type: agentEvents.type, payload: agentEvents.payload })
      .from(agentEvents)
      .where(inArray(agentEvents.runId, runIds))
      .all();
  }

  private invocationEvents(invocationIds: string[]): EventRow[] {
    if (invocationIds.length === 0) return [];
    return this.db
      .select({
        parentId: subagentInvocationEvents.invocationId,
        type: subagentInvocationEvents.type,
        payload: subagentInvocationEvents.payload,
      })
      .from(subagentInvocationEvents)
      .where(inArray(subagentInvocationEvents.invocationId, invocationIds))
      .all();
  }
}