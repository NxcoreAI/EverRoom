import type {
  WorkspaceActivity,
  WorkspaceActivityPage,
  WorkspaceActivityQuery,
  WorkspaceActivitySegment,
} from "@nxcore/agent-contract";
import { and, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentEvents,
  agentRuns,
  agentSessions,
  agentWorkspaces,
  fileEntries,
  workspacePlanItemEvents,
  workspacePlanItems,
} from "../../infrastructure/database/schema.js";

/**
 * 工作空间「概览 · 动态」的派生读模型。
 *
 * 为什么是派生而不是一张 feed 表（`docs/design/product-data-map.zh-CN.md` §9、
 * `docs/workspace-overview-activity-plan.zh-CN.md` §5.1）：历史本来就在库里——
 * `agent_runs`（开始/结束时刻）、`file_entries`（产物与材料）、
 * `workspace_plan_item_events`（计划事件流，见 `schema.ts` 里那张表的注释）。
 * 再存一份 feed 必然与真实状态漂移，且改名/删除要双写。
 *
 * 契约（`WorkspaceActivity`）里文案是**分段**的：引用段只带 id，名字由渲染层实时解析，
 * 所以工作/文件改名后历史动态自动跟随。中文动词在服务层拼（渲染层只渲染）。
 */

export type WorkspaceActivityErrorCode = "workspace_not_found";

export class WorkspaceActivityError extends Error {
  readonly code: WorkspaceActivityErrorCode;

  constructor(code: WorkspaceActivityErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WorkspaceActivityError";
    this.code = code;
  }
}

export interface WorkspaceActivityServiceOptions {
  db: GatewayDatabase;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** 每个来源单次最多扫这么多行（runs 一次出两条事件，所以给 3 倍余量）。 */
const SCAN_FACTOR = 3;
const MAX_SCAN = 200;

/** 产物口径：与桌面 `artifactKind.ts`、产物页保持一致（agent-generated / artifact-imported）。 */
const ARTIFACT_SOURCE_KINDS = new Set(["agent-generated", "artifact-imported"]);

interface Candidate {
  activity: WorkspaceActivity;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** 时间倒序；同一毫秒按 id 倒序，保证游标稳定（不会漏也不会重）。 */
function compareDesc(left: Candidate, right: Candidate): number {
  const a = left.activity;
  const b = right.activity;
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** 游标语义：严格早于 (beforeAt, beforeId)；beforeId 缺省时退化为纯时间比较。 */
function isStrictlyBefore(activity: WorkspaceActivity, beforeAt: string, beforeId: string | null): boolean {
  if (activity.at !== beforeAt) return activity.at < beforeAt;
  return beforeId !== null && activity.id < beforeId;
}

/**
 * 同 id 只留一条：取 `at` 最新的那条（同 `at` 时保留先出现的，结果确定）。
 * 事件 id 是稳定语义键，同一条语义可以有多个物理事件（审批卡重发等）。
 */
function dedupeLatestById(candidates: Candidate[]): Candidate[] {
  const latest = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const existing = latest.get(candidate.activity.id);
    if (!existing || candidate.activity.at > existing.activity.at) {
      latest.set(candidate.activity.id, candidate);
    }
  }
  return [...latest.values()];
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

function workSegment(sessionId: string, text: string): WorkspaceActivitySegment[] {
  return [{ text }, { sessionId }];
}

export class WorkspaceActivityService {
  private readonly db: GatewayDatabase;

  constructor(options: WorkspaceActivityServiceOptions) {
    this.db = options.db;
  }

  list(workspaceId: string, query: WorkspaceActivityQuery = {}): WorkspaceActivityPage {
    this.assertWorkspace(workspaceId);

    const limit = clamp(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const scanLimit = Math.min(Math.max(limit * SCAN_FACTOR, 60), MAX_SCAN);
    const beforeAt = query.beforeAt?.trim() ? query.beforeAt.trim() : null;
    const beforeId = query.beforeId?.trim() ? query.beforeId.trim() : null;
    const parsedBefore = beforeAt ? new Date(beforeAt) : null;
    // 游标时间解析不了就只靠内存里的字符串比较（ISO 串可直接比），绝不因此丢整页。
    const beforeDate = parsedBefore && Number.isFinite(parsedBefore.getTime()) ? parsedBefore : null;

    const candidates = dedupeLatestById([
      ...this.runActivities(workspaceId, beforeDate, scanLimit),
      ...this.sessionActivities(workspaceId, beforeDate, scanLimit),
      ...this.fileActivities(workspaceId, beforeDate, scanLimit),
      ...this.planActivities(workspaceId, beforeDate, scanLimit),
      ...this.approvalActivities(workspaceId, beforeDate, scanLimit),
    ].filter((item) => (!beforeAt || isStrictlyBefore(item.activity, beforeAt, beforeId))))
      .sort(compareDesc);

    const items = candidates.slice(0, limit).map((item) => item.activity);
    const hasMore = candidates.length > items.length;
    const last = items[items.length - 1];
    return {
      items,
      // 有下一页才给游标：让前端不必判断「最后一页拿到的游标其实没数据」。
      nextBeforeAt: hasMore && last ? last.at : null,
      nextBeforeId: hasMore && last ? last.id : null,
    };
  }

  private assertWorkspace(workspaceId: string): void {
    const found = this.db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, workspaceId))
      .all();
    if (found.length === 0) throw new WorkspaceActivityError("workspace_not_found");
  }

  /**
   * run 的开始 / 结束各算一条事件。
   *
   * 这正是「动态能表达历史」的关键：会话只存当前状态，`agent_runs` 才有开始/结束时刻，
   * 所以同一次工作可以出现「开始了工作」和「结束了工作」两行（原型 task/done 的语义）。
   */
  private runActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [eq(agentSessions.workspaceId, workspaceId)];
    if (before) {
      // 用 <= 而不是 <：同一毫秒里可能有好几条，精确的「严格更早」由游标在内存里做。
      filters.push(or(
        lte(agentRuns.startedAt, before),
        lte(agentRuns.completedAt, before),
      )!);
    }

    const rows = this.db
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        sessionId: agentRuns.sessionId,
      })
      .from(agentRuns)
      .innerJoin(agentSessions, eq(agentRuns.sessionId, agentSessions.id))
      .where(and(...filters))
      .orderBy(desc(sql`coalesce(${agentRuns.completedAt}, ${agentRuns.startedAt}, ${agentRuns.createdAt})`))
      .limit(scanLimit)
      .all();

    const out: Candidate[] = [];
    for (const row of rows) {
      const startedAt = toIso(row.startedAt);
      if (startedAt) {
        out.push({
          activity: {
            id: `run:${row.id}:start`,
            kind: "work-run",
            actor: "agent",
            at: startedAt,
            segments: workSegment(row.sessionId, "开始了工作 "),
            source: { table: "agent_runs", rowId: row.id },
          },
        });
      }
      const completedAt = toIso(row.completedAt);
      if (completedAt) {
        const failed = row.status === "failed";
        out.push({
          activity: {
            id: `run:${row.id}:end`,
            kind: "work-done",
            actor: "agent",
            at: completedAt,
            segments: workSegment(row.sessionId, failed ? "执行失败 " : "结束了工作 "),
            source: { table: "agent_runs", rowId: row.id },
          },
        });
      }
    }
    return out;
  }

  /** 从没跑过 run 的会话 = 「新建了工作」（跑过的会话已被上面两行覆盖，不重复出）。 */
  private sessionActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [
      eq(agentSessions.workspaceId, workspaceId),
      sql`not exists (select 1 from ${agentRuns} where ${agentRuns.sessionId} = ${agentSessions.id})`,
    ];
    if (before) filters.push(lte(agentSessions.createdAt, before));

    const rows = this.db
      .select({ id: agentSessions.id, createdAt: agentSessions.createdAt })
      .from(agentSessions)
      .where(and(...filters))
      .orderBy(desc(agentSessions.createdAt))
      .limit(scanLimit)
      .all();

    return rows.map((row) => ({
      activity: {
        id: `session:${row.id}`,
        kind: "work-created" as const,
        actor: "user" as const,
        at: row.createdAt.toISOString(),
        segments: workSegment(row.id, "新建了工作 "),
        source: { table: "agent_sessions" as const, rowId: row.id },
      },
    }));
  }

  /** 文件库条目：产物 → output，其余 → material（与产物页同一口径）。 */
  private fileActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [
      eq(fileEntries.workspaceId, workspaceId),
      isNull(fileEntries.deletedAt),
      ne(fileEntries.state, "deleted"),
    ];
    if (before) filters.push(lte(fileEntries.updatedAt, before));

    const rows = this.db
      .select({
        id: fileEntries.id,
        sourceKind: fileEntries.sourceKind,
        updatedAt: fileEntries.updatedAt,
      })
      .from(fileEntries)
      .where(and(...filters))
      .orderBy(desc(fileEntries.updatedAt))
      .limit(scanLimit)
      .all();

    return rows.map((row) => {
      const artifact = ARTIFACT_SOURCE_KINDS.has(row.sourceKind);
      return {
        activity: {
          id: `file:${row.id}`,
          kind: (artifact ? "output" : "material") as WorkspaceActivity["kind"],
          actor: (artifact ? "agent" : "user") as WorkspaceActivity["actor"],
          at: row.updatedAt.toISOString(),
          segments: [
            { text: artifact ? "生成了 " : "添加了材料 " },
            { fileId: row.id },
          ],
          source: { table: "file_entries" as const, rowId: row.id },
        },
      };
    });
  }

  /** 计划事件流：摘要由 plan 模块写就，这里只补上「哪条任务」的引用段。 */
  private planActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [eq(workspacePlanItems.workspaceId, workspaceId)];
    if (before) filters.push(lte(workspacePlanItemEvents.createdAt, before));

    const rows = this.db
      .select({
        id: workspacePlanItemEvents.id,
        summary: workspacePlanItemEvents.summary,
        actorKind: workspacePlanItemEvents.actorKind,
        itemId: workspacePlanItemEvents.itemId,
        createdAt: workspacePlanItemEvents.createdAt,
      })
      .from(workspacePlanItemEvents)
      .innerJoin(workspacePlanItems, eq(workspacePlanItemEvents.itemId, workspacePlanItems.id))
      .where(and(...filters))
      .orderBy(desc(workspacePlanItemEvents.createdAt))
      .limit(scanLimit)
      .all();

    return rows.map((row) => ({
      activity: {
        id: `plan:${row.id}`,
        kind: "plan" as const,
        actor: row.actorKind,
        at: row.createdAt.toISOString(),
        segments: [{ planItemId: row.itemId }, { text: ` ${row.summary}` }],
        source: { table: "workspace_plan_item_events" as const, rowId: row.id },
      },
    }));
  }

  /**
   * 「等你确认」＝ 活状态，不是历史：本空间**仍在跑的 run** 里，有 `approval.requested`
   * 但还没有对应 `approval.resolved` 的那些审批卡（对话里那张等你点的卡片）。
   *
   * 所以这条不进任何 feed 表：卡片一被处理，`approval.resolved` 落地，行自动消失；
   * 点击引用回到该会话（卡片就在对话里）。id 用 `approval.<approvalId>`：同一张卡
   * 反复请求也只出一行。
   */
  private approvalActivities(workspaceId: string, before: Date | null, scanLimit: number): Candidate[] {
    const filters = [
      eq(agentSessions.workspaceId, workspaceId),
      inArray(agentEvents.type, ["approval.requested", "approval.resolved"]),
      // run 结束（完成/失败/取消/中断）后卡片就不再有效，历史里不留「等你确认」。
      inArray(agentRuns.status, ["accepted", "running"]),
    ];
    if (before) filters.push(lte(agentEvents.createdAt, before));

    const rows = this.db
      .select({
        id: agentEvents.id,
        sessionId: agentEvents.sessionId,
        runId: agentEvents.runId,
        type: agentEvents.type,
        payload: agentEvents.payload,
        createdAt: agentEvents.createdAt,
      })
      .from(agentEvents)
      .innerJoin(agentRuns, eq(agentEvents.runId, agentRuns.id))
      .innerJoin(agentSessions, eq(agentEvents.sessionId, agentSessions.id))
      .where(and(...filters))
      .orderBy(desc(agentEvents.createdAt))
      .limit(scanLimit)
      .all();

    const resolved = new Set<string>();
    for (const row of rows) {
      if (row.type !== "approval.resolved") continue;
      const approvalId = readPayloadString(row.payload, "approvalId");
      if (approvalId) resolved.add(`${row.runId}:${approvalId}`);
    }

    const out: Candidate[] = [];
    for (const row of rows) {
      if (row.type !== "approval.requested") continue;
      const approvalId = readPayloadString(row.payload, "approvalId");
      if (!approvalId || resolved.has(`${row.runId}:${approvalId}`)) continue;
      const toolName = readPayloadString(row.payload, "toolName");
      out.push({
        activity: {
          // 同一张卡多次请求（重试）只出一行，位置按最新一次请求算。
          id: `approval:${row.runId}:${approvalId}`,
          kind: "work-review",
          actor: "agent",
          at: row.createdAt.toISOString(),
          segments: [
            { text: "等你确认 " },
            { sessionId: row.sessionId },
            ...(toolName ? [{ text: ` · ${toolName}` }] : []),
          ],
          source: { table: "agent_events", rowId: row.id },
        },
      });
    }
    return out;
  }

}
