import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";

import type {
  PlanActorKind,
  PlanAssignResult,
  PlanClaimPackage,
  PlanItem,
  PlanItemEvent,
  PlanItemListQuery,
  PlanPriority,
  PlanRef,
  PlanStatus,
  UpdatePlanItemInput,
} from "@nxcore/agent-contract";
import { formatPlanClaimPackage } from "@nxcore/agent-contract";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  agentSessions,
  agentWorkspaces,
  workspacePlanItemEvents,
  workspacePlanItems,
} from "../../infrastructure/database/schema.js";
import { buildClaimPackage, CLAIM_LEASE_TTL_SEC, type ClaimPackageSpace } from "./claim-package.js";
import { rankBetween } from "./rank.js";

export type PlanErrorCode =
  | "plan_item_not_found"
  | "plan_workspace_not_found"
  | "plan_version_conflict"
  | "plan_claimed_elsewhere"
  | "plan_blocked"
  | "plan_scope_mismatch"
  | "plan_dependency_cycle"
  | "plan_invalid_input"
  | "plan_result_required"
  | "plan_dispatch_unavailable";

export class PlanError extends Error {
  readonly code: PlanErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: PlanErrorCode, message?: string, details: Record<string, unknown> = {}) {
    super(message ?? code);
    this.name = "PlanError";
    this.code = code;
    this.details = details;
  }
}

/** 操作者：渲染层传 user，Agent 工具传 agent（带 sessionId / agentId）。 */
export interface PlanActor {
  kind: PlanActorKind;
  id?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
}

export const USER_ACTOR: PlanActor = { kind: "user", id: "user" };

export interface PlanDispatchInput {
  item: PlanItem;
  prompt: string;
  agentId: string | null;
}

export interface PlanDispatchResult {
  sessionId: string;
  runId: string;
}

export interface PlanServiceOptions {
  db: GatewayDatabase;
  now?: () => Date;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  /** 空间目录（未绑定返回 null）；由 create-server 注入 WorkspaceLayoutService。 */
  spaceOf?: (workspaceId: string) => ClaimPackageSpace | null;
  /** 指派即开会话；缺省表示当前进程不支持从网关起会话（工具侧只做认领）。 */
  dispatch?: (input: PlanDispatchInput) => Promise<PlanDispatchResult>;
  /** 变更广播（SSE → 桌面 → 看板）。 */
  onChange?: (workspaceId: string, item: PlanItem, event: PlanItemEvent) => void;
  /** 任务完成时的副作用（写一条记忆，让今日洞察能引用"今天推进了什么"）。 */
  onCompleted?: (item: PlanItem) => void;
  leaseTtlSec?: number;
}

const TITLE_MAX = 200;
const DETAIL_MAX = 20_000;
const RANK_REFETCH_LIMIT = 500;

type PlanItemRow = typeof workspacePlanItems.$inferSelect;
type PlanEventRow = typeof workspacePlanItemEvents.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function toItem(row: PlanItemRow): PlanItem {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    detail: row.detail ?? null,
    acceptance: row.acceptance ?? null,
    constraints: row.constraints ?? [],
    status: row.status,
    priority: row.priority,
    ownerKind: row.ownerKind,
    ownerAgentId: row.ownerAgentId ?? null,
    assigneeSessionId: row.assigneeSessionId ?? null,
    lastRunId: row.lastRunId ?? null,
    createdBy: row.createdBy,
    createdByAgentId: row.createdByAgentId ?? null,
    dueAt: iso(row.dueAt),
    rank: row.rank,
    tags: row.tags ?? [],
    checklist: row.checklist ?? [],
    refs: (row.refs ?? []) as PlanRef[],
    blockedBy: row.blockedBy ?? [],
    resultSummary: row.resultSummary ?? null,
    closeReason: row.closeReason ?? null,
    leaseOwner: row.leaseOwner ?? null,
    leaseExpiresAt: iso(row.leaseExpiresAt),
    version: row.version,
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: PlanEventRow): PlanItemEvent {
  return {
    id: row.id,
    itemId: row.itemId,
    kind: row.kind as PlanItemEvent["kind"],
    actorKind: row.actorKind,
    actorId: row.actorId ?? null,
    fromStatus: (row.fromStatus ?? null) as PlanStatus | null,
    toStatus: (row.toStatus ?? null) as PlanStatus | null,
    summary: row.summary,
    sessionId: row.sessionId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function normalizeText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function normalizeStringList(value: readonly string[] | null | undefined, max = 50): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  for (const raw of value) {
    const item = typeof raw === "string" ? raw.trim() : "";
    if (!item) continue;
    seen.add(item.length > 200 ? item.slice(0, 200) : item);
    if (seen.size >= max) break;
  }
  return [...seen];
}

function normalizeRefs(value: readonly PlanRef[] | null | undefined): PlanRef[] {
  if (!value) return [];
  const out: PlanRef[] = [];
  const seen = new Set<string>();
  for (const ref of value) {
    const id = typeof ref?.id === "string" ? ref.id.trim() : "";
    const kind = ref?.kind;
    if (!id || !kind) continue;
    if (!["file", "document", "session", "url"].includes(kind)) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id, title: normalizeText(ref.title, 200) ?? id });
    if (out.length >= 20) break;
  }
  return out;
}

/** 完成态集合：进入即写 completedAt，离开即清空。 */
function isClosedStatus(status: PlanStatus): boolean {
  return status === "done" || status === "dropped";
}

export class PlanService {
  private readonly db: GatewayDatabase;
  private readonly now: () => Date;
  private readonly logger: NonNullable<PlanServiceOptions["logger"]>;
  private readonly spaceOf?: PlanServiceOptions["spaceOf"];
  private readonly dispatch?: PlanServiceOptions["dispatch"];
  private readonly onChange?: PlanServiceOptions["onChange"];
  private readonly onCompleted?: PlanServiceOptions["onCompleted"];
  private readonly leaseTtlSec: number;

  constructor(options: PlanServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? (() => {});
    this.spaceOf = options.spaceOf;
    this.dispatch = options.dispatch;
    this.onChange = options.onChange;
    this.onCompleted = options.onCompleted;
    this.leaseTtlSec = options.leaseTtlSec ?? CLAIM_LEASE_TTL_SEC;
  }

  /* ───────── 读 ───────── */

  list(query: PlanItemListQuery): PlanItem[] {
    this.assertWorkspace(query.workspaceId);
    const limit = Math.min(Math.max(query.limit ?? RANK_REFETCH_LIMIT, 1), RANK_REFETCH_LIMIT);
    const filters = [eq(workspacePlanItems.workspaceId, query.workspaceId)];
    if (query.status) filters.push(eq(workspacePlanItems.status, query.status));
    const rows = this.db
      .select()
      .from(workspacePlanItems)
      .where(and(...filters))
      .orderBy(asc(workspacePlanItems.rank))
      .all();
    const keyword = query.q?.trim().toLowerCase();
    return rows
      .map(toItem)
      .filter((item) => {
        if (query.owner === "unassigned" && item.ownerKind !== "unassigned") return false;
        if (query.owner === "me" && item.ownerKind !== "user") return false;
        if (query.owner === "agent" && item.ownerKind !== "agent") return false;
        if (!keyword) return true;
        return (
          item.title.toLowerCase().includes(keyword)
          || (item.detail ?? "").toLowerCase().includes(keyword)
          || item.tags.some((tag) => tag.toLowerCase().includes(keyword))
        );
      })
      .slice(0, limit);
  }

  get(id: string): PlanItem {
    return toItem(this.requireRow(id));
  }

  events(itemId: string, limit = 50): PlanItemEvent[] {
    this.requireRow(itemId);
    return this.db
      .select()
      .from(workspacePlanItemEvents)
      .where(eq(workspacePlanItemEvents.itemId, itemId))
      .orderBy(desc(workspacePlanItemEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))
      .all()
      .map(toEvent)
      .reverse();
  }

  /* ───────── 写 ───────── */

  create(input: {
    workspaceId: string;
    title: string;
    detail?: string | null;
    acceptance?: string | null;
    constraints?: string[];
    status?: PlanStatus;
    priority?: PlanPriority;
    dueAt?: string | null;
    tags?: string[];
    checklist?: Array<{ id?: string; text: string; done: boolean }>;
    refs?: PlanRef[];
    blockedBy?: string[];
    createdBy?: "user" | "agent";
    createdByAgentId?: string | null;
  }, actor: PlanActor = USER_ACTOR): PlanItem {
    this.assertWorkspace(input.workspaceId);
    const title = normalizeText(input.title, TITLE_MAX);
    if (!title) throw new PlanError("plan_invalid_input", "plan_title_required");
    const status = input.status ?? "todo";
    const blockedBy = this.normalizeBlockedBy(input.blockedBy ?? [], input.workspaceId, null);
    const now = this.now();
    const id = randomUUID();
    const createdBy = input.createdBy ?? (actor.kind === "agent" ? "agent" : "user");
    const row: typeof workspacePlanItems.$inferInsert = {
      id,
      workspaceId: input.workspaceId,
      title,
      detail: normalizeText(input.detail, DETAIL_MAX),
      acceptance: normalizeText(input.acceptance, DETAIL_MAX),
      constraints: normalizeStringList(input.constraints),
      status,
      priority: input.priority ?? "normal",
      ownerKind: "unassigned",
      createdBy,
      createdByAgentId: createdBy === "agent" ? (input.createdByAgentId ?? actor.agentId ?? null) : null,
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      rank: this.rankForAppend(input.workspaceId, status, null),
      tags: normalizeStringList(input.tags, 12),
      checklist: this.normalizeChecklist(input.checklist),
      refs: normalizeRefs(input.refs),
      blockedBy,
      completedAt: isClosedStatus(status) ? now : null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(workspacePlanItems).values(row).run();
    const item = toItem(this.requireRow(id));
    this.recordEvent(item, {
      kind: "created",
      actor,
      summary: createdBy === "agent" ? `Agent 建了这条任务` : "你建了这条任务",
    });
    return item;
  }

  update(id: string, input: UpdatePlanItemInput, actor: PlanActor = USER_ACTOR): PlanItem {
    const row = this.requireRow(id);
    this.assertVersion(row, input.version);
    this.assertAgentLease(row, actor);
    const now = this.now();
    const patch: Partial<typeof workspacePlanItems.$inferInsert> = { updatedAt: now, version: row.version + 1 };

    if (input.title !== undefined) {
      const title = normalizeText(input.title, TITLE_MAX);
      if (!title) throw new PlanError("plan_invalid_input", "plan_title_required");
      patch.title = title;
    }
    if (input.detail !== undefined) patch.detail = normalizeText(input.detail, DETAIL_MAX);
    if (input.acceptance !== undefined) patch.acceptance = normalizeText(input.acceptance, DETAIL_MAX);
    if (input.constraints !== undefined) patch.constraints = normalizeStringList(input.constraints);
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.dueAt !== undefined) patch.dueAt = input.dueAt ? new Date(input.dueAt) : null;
    if (input.tags !== undefined) patch.tags = normalizeStringList(input.tags, 12);
    if (input.checklist !== undefined) patch.checklist = this.normalizeChecklist(input.checklist);
    if (input.refs !== undefined) patch.refs = normalizeRefs(input.refs);
    if (input.blockedBy !== undefined) {
      patch.blockedBy = this.normalizeBlockedBy(input.blockedBy, row.workspaceId, id);
    }
    if (input.resultSummary !== undefined) patch.resultSummary = normalizeText(input.resultSummary, DETAIL_MAX);
    if (input.closeReason !== undefined) patch.closeReason = normalizeText(input.closeReason, 2_000);
    if (input.ownerKind !== undefined) {
      patch.ownerKind = input.ownerKind;
      if (input.ownerKind !== "agent") patch.ownerAgentId = null;
      if (input.ownerKind !== "agent") {
        patch.assigneeSessionId = null;
        patch.leaseOwner = null;
        patch.leaseExpiresAt = null;
      }
    }
    if (input.ownerAgentId !== undefined) patch.ownerAgentId = input.ownerAgentId;

    // 租约持有者的每次写入都顺手续租（不额外发明心跳工具）。
    if (actor.sessionId && row.leaseOwner === actor.sessionId) {
      patch.leaseHeartbeatAt = now;
      patch.leaseExpiresAt = new Date(now.getTime() + this.leaseTtlSec * 1000);
    }

    this.db.update(workspacePlanItems).set(patch).where(eq(workspacePlanItems.id, id)).run();
    const item = toItem(this.requireRow(id));
    const changed = Object.keys(input).filter((key) => key !== "version" && key !== "note");
    this.recordEvent(item, {
      kind: "updated",
      actor,
      summary: input.note?.trim() ? input.note.trim() : `更新了 ${changed.join(" / ")}`,
      payload: { fields: changed },
      fromStatus: row.status,
    });
    return item;
  }

  /**
   * 拖拽 / 改状态 / 改排序。
   *
   * 状态与 rank 一次写完；跨列时按状态迁移补副作用（completedAt / 租约清理）。
   * 用户操作可以抢占租约（用户优先），Agent 只能动自己租的或没人租的。
   */
  move(
    id: string,
    input: {
      version: number;
      status: PlanStatus;
      beforeId?: string | null;
      afterId?: string | null;
      reason?: string | null;
      ownerKind?: PlanItem["ownerKind"];
      ownerAgentId?: string | null;
      resultSummary?: string | null;
    },
    actor: PlanActor = USER_ACTOR,
  ): PlanItem {
    const row = this.requireRow(id);
    this.assertVersion(row, input.version);
    this.assertAgentLease(row, actor);

    const fromStatus = row.status;
    const toStatus = input.status;
    const now = this.now();
    const patch: Partial<typeof workspacePlanItems.$inferInsert> = {
      status: toStatus,
      rank: this.rankForMove(row, input),
      updatedAt: now,
      version: row.version + 1,
    };

    if (input.ownerKind !== undefined) {
      patch.ownerKind = input.ownerKind;
      if (input.ownerKind !== "agent") {
        patch.ownerAgentId = null;
        patch.assigneeSessionId = null;
        patch.leaseOwner = null;
        patch.leaseExpiresAt = null;
        patch.leaseHeartbeatAt = null;
      }
    }
    if (input.ownerAgentId !== undefined) patch.ownerAgentId = input.ownerAgentId;
    if (input.reason !== undefined) patch.closeReason = normalizeText(input.reason, 2_000);
    if (input.resultSummary !== undefined) patch.resultSummary = normalizeText(input.resultSummary, DETAIL_MAX);

    if (toStatus === "done" && fromStatus !== "done") {
      const summary = (input.resultSummary ?? row.resultSummary ?? "").trim();
      if (actor.kind === "agent" && !summary) {
        throw new PlanError("plan_result_required", "plan_result_summary_required", { itemId: id });
      }
      patch.completedAt = now;
      if (!summary) patch.closeReason = null;
    }
    if (toStatus === "dropped" && fromStatus !== "dropped") patch.completedAt = now;
    if (!isClosedStatus(toStatus) && isClosedStatus(fromStatus)) {
      patch.completedAt = null;
      if (toStatus !== "dropped") patch.closeReason = null;
    }
    if (toStatus !== "doing") {
      patch.leaseOwner = null;
      patch.leaseExpiresAt = null;
      patch.leaseHeartbeatAt = null;
    }

    this.db.update(workspacePlanItems).set(patch).where(eq(workspacePlanItems.id, id)).run();
    const item = toItem(this.requireRow(id));

    const kind = toStatus === fromStatus
      ? "moved"
      : toStatus === "done"
        ? "completed"
        : toStatus === "dropped"
          ? "dropped"
          : fromStatus === "done" || fromStatus === "dropped"
            ? "reopened"
            : "moved";
    this.recordEvent(item, {
      kind,
      actor,
      fromStatus,
      toStatus,
      summary: this.moveSummary(item, fromStatus, toStatus),
      payload: { rank: item.rank, reason: input.reason ?? null },
    });
    if (kind === "completed") {
      try {
        this.onCompleted?.(item);
      } catch (error) {
        this.logger("warn", "plan.completed_hook_failed", {
          itemId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return item;
  }

  /** 用户指派：建会话 + 用认领包起一轮 run，并把会话写回任务。 */
  async assign(id: string, input: { agentId?: string | null }, actor: PlanActor = USER_ACTOR): Promise<PlanAssignResult> {
    const row = this.requireRow(id);
    if (!this.dispatch) throw new PlanError("plan_dispatch_unavailable", "plan_dispatch_unavailable");
    if (row.status === "done" || row.status === "dropped") {
      throw new PlanError("plan_invalid_input", "plan_status_closed");
    }
    const item = toItem(row);
    const pkg = this.claimPackage(id, { assignReason: "用户在看板上把这条任务交给了 Agent" });
    const prompt = formatPlanClaimPackage(pkg);
    const result = await this.dispatch({ item, prompt, agentId: input.agentId ?? null });

    const now = this.now();
    const preempted = row.leaseOwner && row.leaseOwner !== result.sessionId ? row.leaseOwner : null;
    this.db.update(workspacePlanItems)
      .set({
        status: "doing",
        ownerKind: "agent",
        ownerAgentId: input.agentId ?? "main",
        assigneeSessionId: result.sessionId,
        lastRunId: result.runId,
        leaseOwner: result.sessionId,
        leaseHeartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseTtlSec * 1000),
        completedAt: null,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(workspacePlanItems.id, id))
      .run();
    const updated = toItem(this.requireRow(id));
    if (preempted) {
      this.recordEvent(updated, {
        kind: "lease_preempted",
        actor: { kind: "user", id: "user" },
        summary: `用户指派给 Agent ${input.agentId ?? "main"}，收回原会话的认领`,
        sessionId: preempted,
        payload: { preemptedSessionId: preempted },
      });
    }
    this.recordEvent(updated, {
      kind: "assigned",
      actor,
      fromStatus: row.status,
      toStatus: "doing",
      summary: `交给 Agent ${input.agentId ?? "main"} 执行`,
      sessionId: result.sessionId,
    });
    return { item: updated, sessionId: result.sessionId, runId: result.runId };
  }

  /** Agent 认领：作用域严格限定在当前 run 的空间。 */
  claim(
    id: string,
    input: { workspaceId: string; sessionId: string; agentId: string; note?: string | null },
  ): PlanClaimPackage {
    const row = this.requireRow(id);
    if (row.workspaceId !== input.workspaceId) {
      throw new PlanError("plan_scope_mismatch", "plan_scope_mismatch", { itemWorkspaceId: row.workspaceId });
    }
    if (row.status === "done" || row.status === "dropped") {
      throw new PlanError("plan_invalid_input", "plan_status_closed", { status: row.status });
    }
    // 同一会话重复认领 = 幂等（续租 + 返回包）。
    if (row.leaseOwner === input.sessionId) {
      this.touchLease(row.id);
    } else {
      const leaseActive = row.leaseOwner !== null && row.leaseExpiresAt !== null && row.leaseExpiresAt > this.now();
      if (leaseActive && row.leaseOwner !== input.sessionId) {
        throw new PlanError("plan_claimed_elsewhere", "plan_claimed_elsewhere", {
          holderSessionId: row.leaseOwner,
          expiresAt: row.leaseExpiresAt?.toISOString() ?? null,
        });
      }
      const blocking = this.blockingDependencies(row.blockedBy ?? []);
      if (blocking.length) {
        throw new PlanError("plan_blocked", "plan_blocked", { blocking });
      }
      const now = this.now();
      this.db.update(workspacePlanItems)
        .set({
          status: "doing",
          ownerKind: "agent",
          ownerAgentId: input.agentId,
          assigneeSessionId: input.sessionId,
          leaseOwner: input.sessionId,
          leaseHeartbeatAt: now,
          leaseExpiresAt: new Date(now.getTime() + this.leaseTtlSec * 1000),
          completedAt: null,
          updatedAt: now,
          version: row.version + 1,
        })
        .where(eq(workspacePlanItems.id, id))
        .run();
      const updated = toItem(this.requireRow(id));
      this.recordEvent(updated, {
        kind: "claimed",
        actor: { kind: "agent", id: input.agentId, sessionId: input.sessionId },
        fromStatus: row.status,
        toStatus: "doing",
        summary: input.note?.trim() ? `Agent 认领：${input.note.trim()}` : `Agent ${input.agentId} 认领了这条任务`,
        sessionId: input.sessionId,
      });
    }
    return this.claimPackage(id, {});
  }

  /** 放回去：写清原因，成为下一位认领者的线索。 */
  release(id: string, input: { reason: string; sessionId?: string | null; agentId?: string | null }): PlanItem {
    const row = this.requireRow(id);
    const reason = normalizeText(input.reason, 2_000);
    if (!reason) throw new PlanError("plan_invalid_input", "plan_release_reason_required");
    if (row.leaseOwner && input.sessionId && row.leaseOwner !== input.sessionId) {
      throw new PlanError("plan_claimed_elsewhere", "plan_claimed_elsewhere", {
        holderSessionId: row.leaseOwner,
      });
    }
    const now = this.now();
    this.db.update(workspacePlanItems)
      .set({
        status: "todo",
        ownerKind: "unassigned",
        ownerAgentId: null,
        assigneeSessionId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        leaseHeartbeatAt: null,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(workspacePlanItems.id, id))
      .run();
    const item = toItem(this.requireRow(id));
    this.recordEvent(item, {
      kind: "released",
      actor: input.agentId
        ? { kind: "agent", id: input.agentId, sessionId: input.sessionId ?? null }
        : { kind: "user", id: "user" },
      fromStatus: row.status,
      toStatus: "todo",
      summary: reason,
      sessionId: input.sessionId ?? null,
      payload: { reason },
    });
    return item;
  }

  /** 删除 = 取消（可恢复）；真删只在 P3 的清理里做。 */
  remove(id: string, actor: PlanActor = USER_ACTOR): PlanItem {
    const row = this.requireRow(id);
    return this.move(id, { version: row.version, status: "dropped", reason: "已取消" }, actor);
  }

  /** 会话当前的 Agent（认领身份用；查不到按主 Agent 记）。 */
  agentIdForSession(sessionId: string): string {
    const row = this.db
      .select({ activeAgentId: agentSessions.activeAgentId })
      .from(agentSessions)
      .where(eq(agentSessions.id, sessionId))
      .get();
    return row?.activeAgentId ?? "main";
  }

  /* ───────── 认领包 ───────── */

  claimPackage(id: string, options: { assignReason?: string | null; compact?: boolean } = {}): PlanClaimPackage {
    const row = this.requireRow(id);
    const item = toItem(row);
    const events = this.db
      .select()
      .from(workspacePlanItemEvents)
      .where(eq(workspacePlanItemEvents.itemId, id))
      .orderBy(desc(workspacePlanItemEvents.createdAt))
      .limit(8)
      .all()
      .map(toEvent);
    const dependencies = (item.blockedBy.length
      ? this.db.select().from(workspacePlanItems)
        .where(inArray(workspacePlanItems.id, item.blockedBy))
        .all()
        .map(toItem)
        .map((dep) => ({ id: dep.id, title: dep.title, status: dep.status }))
      : []);
    return buildClaimPackage({
      item,
      events,
      dependencies,
      space: this.spaceOf?.(item.workspaceId) ?? null,
      assignReason: options.assignReason ?? null,
      leaseTtlSec: this.leaseTtlSec,
    });
  }

  /* ───────── 批量操作（P3） ───────── */

  /**
   * 批量移动 / 取消。
   *
   * 逐条走 `move()`（各自 CAS + 事件），单条失败记入 `failed` 而不整体回滚：
   * 看板上多选十张卡，因为其中一张被 Agent 抢先改了就让九张都不动，体验更差。
   */
  batch(
    input: { ids: string[]; action: "move" | "drop"; status?: PlanStatus },
    actor: PlanActor = USER_ACTOR,
  ): { items: PlanItem[]; failed: Array<{ id: string; code: string }> } {
    const items: PlanItem[] = [];
    const failed: Array<{ id: string; code: string }> = [];
    const target: PlanStatus = input.action === "drop" ? "dropped" : (input.status ?? "todo");
    for (const id of input.ids.slice(0, 200)) {
      try {
        const row = this.requireRow(id);
        items.push(this.move(id, {
          version: row.version,
          status: target,
          reason: input.action === "drop" ? "批量取消" : null,
        }, actor));
      } catch (error) {
        if (error instanceof PlanError) failed.push({ id, code: error.code });
        else throw error;
      }
    }
    return { items, failed };
  }

  /* ───────── 后台维护 ───────── */

  /** 回收过期租约：`doing` 且租约过期 → 回 `todo` 并记事件。返回回收条数。 */
  expireLeases(): number {
    const now = this.now();
    const expired = this.db
      .select()
      .from(workspacePlanItems)
      .where(and(
        eq(workspacePlanItems.status, "doing"),
        lt(workspacePlanItems.leaseExpiresAt, now),
      ))
      .all();
    for (const row of expired) {
      this.db.update(workspacePlanItems)
        .set({
          status: "todo",
          ownerKind: "unassigned",
          assigneeSessionId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseHeartbeatAt: null,
          updatedAt: now,
          version: row.version + 1,
        })
        .where(eq(workspacePlanItems.id, row.id))
        .run();
      const item = toItem(this.requireRow(row.id));
      this.recordEvent(item, {
        kind: "lease_expired",
        actor: { kind: "system", id: "lease-reaper" },
        fromStatus: "doing",
        toStatus: "todo",
        summary: `认领超时未续（原持有者 ${row.leaseOwner ?? "unknown"}），已放回待开始`,
        sessionId: row.leaseOwner ?? null,
      });
    }
    if (expired.length) this.logger("info", "plan.lease.expired", { count: expired.length });
    return expired.length;
  }

  /**
   * 自动认领（P3，默认关）：挑一条「待开始 + 未指派 + 高优先级 + 未过期」的任务起会话。
   *
   * 一次只认领一条——"没人叫它也能自己开工"是产品决策，所以要保守：
   * 打开了开关也只是慢慢推进，不会一口气把整个池子吃下来。
   */
  async autoClaim(options: { maxPriorityOnly?: boolean } = {}): Promise<PlanItem | null> {
    if (!this.dispatch) return null;
    const now = this.now();
    const candidates = this.db
      .select()
      .from(workspacePlanItems)
      .where(and(
        eq(workspacePlanItems.status, "todo"),
        eq(workspacePlanItems.ownerKind, "unassigned"),
      ))
      .orderBy(asc(workspacePlanItems.createdAt))
      .limit(80)
      .all()
      .map(toItem)
      .filter((item) => !item.dueAt || Date.parse(item.dueAt) >= now.getTime())
      .filter((item) => !this.blockingDependencies(item.blockedBy).length)
      .filter((item) => (options.maxPriorityOnly === false
        ? true
        : item.priority === "urgent" || item.priority === "high"));
    const priorityWeight: Record<PlanPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    candidates.sort((left, right) => priorityWeight[left.priority] - priorityWeight[right.priority]);
    const candidate = candidates[0];
    if (!candidate) return null;
    try {
      const result = await this.assign(candidate.id, { agentId: null }, { kind: "system", id: "auto-claim" });
      this.logger("info", "plan.auto_claim", { itemId: candidate.id, sessionId: result.sessionId });
      return result.item;
    } catch (error) {
      this.logger("warn", "plan.auto_claim_failed", {
        itemId: candidate.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** 清理：删掉超过 N 天的已取消任务（事件随之级联删除）。返回删除条数。 */
  cleanupDropped(retentionDays = 30): number {
    const cutoff = new Date(this.now().getTime() - retentionDays * 24 * 60 * 60_000);
    const rows = this.db
      .select({ id: workspacePlanItems.id })
      .from(workspacePlanItems)
      .where(and(
        eq(workspacePlanItems.status, "dropped"),
        lt(workspacePlanItems.completedAt, cutoff),
      ))
      .all();
    for (const row of rows) {
      this.db.delete(workspacePlanItems).where(eq(workspacePlanItems.id, row.id)).run();
    }
    if (rows.length) this.logger("info", "plan.cleanup", { removed: rows.length });
    return rows.length;
  }

  /* ───────── 内部 ───────── */

  private assertWorkspace(workspaceId: string): void {
    if (!workspaceId || typeof workspaceId !== "string") {
      throw new PlanError("plan_invalid_input", "plan_workspace_required");
    }
    const exists = this.db
      .select({ id: agentWorkspaces.id })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, workspaceId))
      .get();
    if (!exists) throw new PlanError("plan_workspace_not_found", "plan_workspace_not_found", { workspaceId });
  }

  private requireRow(id: string): PlanItemRow {
    const row = this.db
      .select()
      .from(workspacePlanItems)
      .where(eq(workspacePlanItems.id, id))
      .get();
    if (!row) throw new PlanError("plan_item_not_found", "plan_item_not_found", { itemId: id });
    return row;
  }

  private assertVersion(row: PlanItemRow, version: number): void {
    if (!Number.isInteger(version) || version !== row.version) {
      throw new PlanError("plan_version_conflict", "plan_version_conflict", {
        currentVersion: row.version,
      });
    }
  }

  /** Agent 写入别人的租约 → 拒绝；用户写入不受限（用户优先）。 */
  private assertAgentLease(row: PlanItemRow, actor: PlanActor): void {
    if (actor.kind !== "agent") return;
    if (!row.leaseOwner) return;
    if (actor.sessionId && row.leaseOwner === actor.sessionId) return;
    const active = row.leaseExpiresAt !== null && row.leaseExpiresAt > this.now();
    if (!active) return;
    throw new PlanError("plan_claimed_elsewhere", "plan_claimed_elsewhere", {
      holderSessionId: row.leaseOwner,
      expiresAt: row.leaseExpiresAt?.toISOString() ?? null,
    });
  }

  private touchLease(itemId: string): void {
    const now = this.now();
    this.db.update(workspacePlanItems)
      .set({
        leaseHeartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseTtlSec * 1000),
      })
      .where(eq(workspacePlanItems.id, itemId))
      .run();
  }

  private normalizeChecklist(
    value: ReadonlyArray<{ id?: string; text?: string; done?: boolean }> | null | undefined,
  ): Array<{ id: string; text: string; done: boolean }> {
    if (!value) return [];
    const out: Array<{ id: string; text: string; done: boolean }> = [];
    for (const entry of value.slice(0, 30)) {
      const text = normalizeText(entry?.text, 300);
      if (!text) continue;
      out.push({ id: entry?.id?.trim() || randomUUID(), text, done: entry?.done === true });
    }
    return out;
  }

  /** `blockedBy` 校验：存在、同空间、不成环（自引用也算环）。 */
  private normalizeBlockedBy(ids: readonly string[], workspaceId: string, selfId: string | null): string[] {
    const wanted = [...new Set(ids.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))];
    if (!wanted.length) return [];
    if (selfId && wanted.includes(selfId)) {
      throw new PlanError("plan_dependency_cycle", "plan_dependency_cycle", { itemId: selfId });
    }
    const rows = this.db
      .select({ id: workspacePlanItems.id, workspaceId: workspacePlanItems.workspaceId, blockedBy: workspacePlanItems.blockedBy })
      .from(workspacePlanItems)
      .where(inArray(workspacePlanItems.id, wanted))
      .all();
    const found = new Set(rows.filter((row) => row.workspaceId === workspaceId).map((row) => row.id));
    const missing = wanted.filter((id) => !found.has(id));
    if (missing.length) {
      throw new PlanError("plan_invalid_input", "plan_dependency_missing", { missing });
    }
    if (selfId) {
      // 从每个依赖出发向下走，能不能走回自己
      const graph = new Map<string, string[]>(
        rows.map((row) => [row.id, row.blockedBy ?? []]),
      );
      const stack = [...wanted];
      const seen = new Set<string>();
      while (stack.length) {
        const current = stack.pop()!;
        if (current === selfId) {
          throw new PlanError("plan_dependency_cycle", "plan_dependency_cycle", { itemId: selfId });
        }
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of graph.get(current) ?? []) stack.push(next);
      }
    }
    return wanted;
  }

  private blockingDependencies(ids: readonly string[]): Array<{ id: string; title: string; status: PlanStatus }> {
    if (!ids.length) return [];
    return this.db
      .select()
      .from(workspacePlanItems)
      .where(inArray(workspacePlanItems.id, [...ids]))
      .all()
      .map(toItem)
      .filter((item) => item.status !== "done")
      .map((item) => ({ id: item.id, title: item.title, status: item.status }));
  }

  private lastRank(workspaceId: string, status: PlanStatus, excludeId: string | null): string | null {
    const rows = this.db
      .select({ rank: workspacePlanItems.rank, id: workspacePlanItems.id })
      .from(workspacePlanItems)
      .where(and(
        eq(workspacePlanItems.workspaceId, workspaceId),
        eq(workspacePlanItems.status, status),
      ))
      .orderBy(desc(workspacePlanItems.rank))
      .limit(5)
      .all();
    const candidate = rows.find((row) => row.id !== excludeId);
    return candidate?.rank ?? null;
  }

  private rankForAppend(workspaceId: string, status: PlanStatus, excludeId: string | null): string {
    return rankBetween(this.lastRank(workspaceId, status, excludeId), null);
  }

  private rankForMove(
    row: PlanItemRow,
    input: { status: PlanStatus; beforeId?: string | null; afterId?: string | null },
    retried = false,
  ): string {
    const siblings = this.db
      .select({ id: workspacePlanItems.id, rank: workspacePlanItems.rank })
      .from(workspacePlanItems)
      .where(and(
        eq(workspacePlanItems.workspaceId, row.workspaceId),
        eq(workspacePlanItems.status, input.status),
      ))
      .orderBy(asc(workspacePlanItems.rank))
      .all()
      .filter((sibling) => sibling.id !== row.id);

    const before = input.beforeId ? siblings.find((item) => item.id === input.beforeId) : undefined;
    const after = input.afterId ? siblings.find((item) => item.id === input.afterId) : undefined;
    try {
      if (before && after) return rankBetween(before.rank, after.rank);
      if (before) {
        const index = siblings.findIndex((item) => item.id === before.id);
        const next = siblings[index + 1];
        return rankBetween(before.rank, next?.rank ?? null);
      }
      if (after) {
        const index = siblings.findIndex((item) => item.id === after.id);
        const previous = index > 0 ? siblings[index - 1] : null;
        return rankBetween(previous?.rank ?? null, after.rank);
      }
      return rankBetween(siblings.at(-1)?.rank ?? null, null);
    } catch (error) {
      if (error instanceof Error && error.message === "plan_rank_exhausted" && !retried) {
        // 脏数据（历史 rank 相邻到无空隙）：重排该列后再来一次。
        this.rebalanceRanks(row.workspaceId, input.status);
        return this.rankForMove(row, input, true);
      }
      throw error;
    }
  }

  /** 列内 rank 重排（几十行一遇）：等距重新发号。 */
  private rebalanceRanks(workspaceId: string, status: PlanStatus): void {
    const rows = this.db
      .select({ id: workspacePlanItems.id })
      .from(workspacePlanItems)
      .where(and(
        eq(workspacePlanItems.workspaceId, workspaceId),
        eq(workspacePlanItems.status, status),
      ))
      .orderBy(asc(workspacePlanItems.rank))
      .all();
    let previous: string | null = null;
    for (const row of rows) {
      const next = rankBetween(previous, null);
      this.db.update(workspacePlanItems)
        .set({ rank: next })
        .where(eq(workspacePlanItems.id, row.id))
        .run();
      previous = next;
    }
  }

  private moveSummary(item: PlanItem, from: PlanStatus, to: PlanStatus): string {
    if (from === to) return "调整了顺序";
    if (to === "done") return "标记完成";
    if (to === "dropped") return item.closeReason ? `取消：${item.closeReason}` : "取消";
    if (from === "done" || from === "dropped") return "重新打开";
    if (to === "doing") return item.ownerKind === "agent"
      ? `开始执行（Agent ${item.ownerAgentId ?? ""}）`.trim()
      : "开始执行";
    return `${from} → ${to}`;
  }

  private recordEvent(
    item: PlanItem,
    input: {
      kind: PlanItemEvent["kind"];
      actor: PlanActor;
      summary: string;
      fromStatus?: PlanStatus | null;
      toStatus?: PlanStatus | null;
      payload?: Record<string, unknown> | null;
      sessionId?: string | null;
    },
  ): PlanItemEvent {
    const row: typeof workspacePlanItemEvents.$inferInsert = {
      id: randomUUID(),
      itemId: item.id,
      kind: input.kind,
      actorKind: input.actor.kind,
      actorId: input.actor.id ?? input.actor.agentId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      summary: input.summary,
      payload: input.payload ?? null,
      sessionId: input.sessionId ?? input.actor.sessionId ?? null,
      createdAt: this.now(),
    };
    this.db.insert(workspacePlanItemEvents).values(row).run();
    const event: PlanItemEvent = {
      id: row.id,
      itemId: item.id,
      kind: input.kind,
      actorKind: input.actor.kind,
      actorId: input.actor.id ?? input.actor.agentId ?? null,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      summary: input.summary,
      sessionId: input.sessionId ?? input.actor.sessionId ?? null,
      createdAt: (row.createdAt as Date).toISOString(),
    };
    this.onChange?.(item.workspaceId, item, event);
    return event;
  }
}
