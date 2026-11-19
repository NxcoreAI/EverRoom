/**
 * FA 会后反馈闭环（fa-industry-iteration 工作项三）。
 *
 * 流程：会议结束 → createDraft（AI 整理或人工登记，三路变更建议）→ 负责人
 * 确认 → applyConfirm 回写（项目侧进事实库 grade=fact、人物/机构侧信号进
 * 事实库挂对应 Room）→ 跟进任务（roomLocalActions）。未确认只停在 draft，
 * 不写任何档案——"AI 只产建议，人确认才回写"。
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  contextRooms,
  faMeetingFeedbacks,
  roomEntityFacts,
  roomLocalActions,
} from "../../infrastructure/database/schema.js";

export const FA_PASS_REASONS = [
  "stage_mismatch", // 阶段不符
  "ticket_mismatch", // 票面不符
  "sector_no_thesis", // 赛道无主题
  "portfolio_conflict", // 组合冲突
  "geography_mismatch", // 地域不符
  "valuation_high", // 估值偏高
  "traction_weak", // 验证不足
  "no_dry_powder", // 额度用尽
  "timing", // 时机不对
  "other",
] as const;

export type FaFeedbackDisposition = "strong_interest" | "interest" | "watch" | "pass" | "unknown";

export interface FaFeedbackDraftInput {
  roomId: string;
  sourceKind?: string;
  sourceId?: string;
  institutionRoomId?: string;
  personRoomId?: string;
  meetingAt?: string;
  disposition: FaFeedbackDisposition;
  passReasons?: string[];
  reopenConditions?: string;
  projectUpdates?: string;
  personSignals?: string;
  institutionSignals?: string;
  meetingNotes?: string;
  /** 跟进任务建议（确认后落 roomLocalActions）。 */
  followUp?: { title: string; dueAt?: string; assignee?: string } | null;
}

export class FaFeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaFeedbackError";
  }
}

const factFingerprint = (content: string) =>
  createHash("sha256").update(content.trim()).digest("hex").slice(0, 20);

const now = () => new Date();

export class FaFeedbackService {
  constructor(private readonly db: GatewayDatabase) {}

  list(roomId?: string, status?: "draft" | "confirmed" | "dismissed") {
    const conditions = [isNull(faMeetingFeedbacks.deletedAt)];
    if (roomId) conditions.push(eq(faMeetingFeedbacks.roomId, roomId));
    if (status) conditions.push(eq(faMeetingFeedbacks.status, status));
    return this.db
      .select()
      .from(faMeetingFeedbacks)
      .where(and(...conditions))
      .orderBy(desc(faMeetingFeedbacks.createdAt))
      .limit(200)
      .all();
  }

  get(id: string) {
    const row = this.db
      .select()
      .from(faMeetingFeedbacks)
      .where(and(eq(faMeetingFeedbacks.id, id), isNull(faMeetingFeedbacks.deletedAt)))
      .get();
    if (!row) throw new FaFeedbackError(`feedback_not_found:${id}`);
    return row;
  }

  createDraft(input: FaFeedbackDraftInput) {
    if (!input.roomId?.trim()) throw new FaFeedbackError("room_required");
    const reasons = (input.passReasons ?? [])
      .filter((r) => (FA_PASS_REASONS as readonly string[]).includes(r))
      .slice(0, 5);
    if ((input.disposition === "pass" || input.disposition === "watch") && reasons.length === 0) {
      throw new FaFeedbackError("pass_reason_required:拒绝/观察必须带标准原因");
    }
    const id = randomUUID();
    this.db.insert(faMeetingFeedbacks).values({
      id,
      roomId: input.roomId.trim().slice(0, 128),
      sourceKind: input.sourceKind?.slice(0, 40),
      sourceId: input.sourceId?.slice(0, 128),
      institutionRoomId: input.institutionRoomId?.slice(0, 128) || null,
      personRoomId: input.personRoomId?.slice(0, 128) || null,
      meetingAt: input.meetingAt?.slice(0, 20),
      disposition: input.disposition,
      passReasons: reasons.length > 0 ? reasons : null,
      reopenConditions: input.reopenConditions?.slice(0, 1000) || null,
      projectUpdates: input.projectUpdates?.slice(0, 4000) || null,
      personSignals: input.personSignals?.slice(0, 4000) || null,
      institutionSignals: input.institutionSignals?.slice(0, 4000) || null,
      meetingNotes: input.meetingNotes?.slice(0, 8000) || null,
      status: "draft",
    }).run();
    return this.get(id);
  }

  /**
   * 确认回写：三路信号各自落对应 Room 的事实库（grade=fact——既经负责人确认），
   * 跟进建议落 roomLocalActions 任务。幂等：重复 confirm 抛错。
   */
  confirm(id: string, confirmedBy: string, options?: {
    /** 确认时可修订三路信号（负责人改 AI 建议后的最终口径）。 */
    edits?: {
      projectUpdates?: string;
      personSignals?: string;
      institutionSignals?: string;
      reopenConditions?: string;
      followUpTitle?: string;
      followUpDueAt?: string;
    };
    /** 部分确认：只回写指定路（project/person/institution）；缺省全部。 */
    applyScopes?: Array<"project" | "person" | "institution">;
    createFollowUpTask?: boolean;
  }) {
    const row = this.get(id);
    if (row.status !== "draft") throw new FaFeedbackError(`feedback_not_draft:${id}:${row.status}`);

    const edits = options?.edits ?? {};
    const scopes = options?.applyScopes ?? ["project", "person", "institution"];
    const projectUpdates = edits.projectUpdates ?? row.projectUpdates ?? "";
    const personSignals = edits.personSignals ?? row.personSignals ?? "";
    const institutionSignals = edits.institutionSignals ?? row.institutionSignals ?? "";
    const reopenConditions = edits.reopenConditions ?? row.reopenConditions ?? "";

    const writtenFacts: string[] = [];
    const ts = now();
    const writeFact = (roomId: string, content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;
      this.db.insert(roomEntityFacts).values({
        id: randomUUID(),
        roomId,
        factId: factFingerprint(trimmed),
        content: trimmed.slice(0, 300),
        type: "属性",
        grade: "fact", // 负责人确认后的反馈 = 事实
        sourceKind: "reality-event",
        sourceId: id,
        sourceVersion: 1,
        evidenceGroupKey: `fa-feedback:${id}`,
        createdAt: ts,
        updatedAt: ts,
      }).onConflictDoNothing().run();
      writtenFacts.push(trimmed.slice(0, 60));
    };

    // 项目侧：反馈结论 + 更新 + 重启条件挂项目 Room
    if (scopes.includes("project")) {
      writeFact(row.roomId, `会议反馈（${row.disposition}）：${projectUpdates || "见会议记录"}`);
      if (reopenConditions) writeFact(row.roomId, `重新联系条件：${reopenConditions}`);
    }
    // 人物侧：关注点与偏好挂人物 Room（个人观点不上升机构策略的结构保障）
    if (scopes.includes("person") && row.personRoomId) {
      writeFact(row.personRoomId, `会议观察（${row.meetingAt ?? ""}）：${personSignals}`);
    }
    // 机构侧：策略信号挂机构 Room
    if (scopes.includes("institution") && row.institutionRoomId) {
      writeFact(row.institutionRoomId, `会议信号（${row.meetingAt ?? ""}）：${institutionSignals}`);
    }

    // 跟进任务：默认从建议生成；confirm 时可改标题/期限
    let taskId: string | null = null;
    if (options?.createFollowUpTask !== false) {
      const title = edits.followUpTitle
        ?? (row.disposition === "strong_interest" ? "发送定制材料并确认对方下一步"
          : row.disposition === "interest" ? "组织证据闭环会后问题"
          : row.disposition === "watch" ? `记录重启条件待验证：${reopenConditions.slice(0, 40) || "—"}`
          : null);
      if (title) {
        taskId = randomUUID();
        const dueAt = edits.followUpDueAt
          ? new Date(edits.followUpDueAt)
          : new Date(ts.getTime() + (row.disposition === "strong_interest" ? 24 : 48) * 3600_000);
        this.db.insert(roomLocalActions).values({
          id: taskId,
          roomId: row.roomId,
          kind: "task",
          title: `会后跟进（${row.disposition}）：${title}`.slice(0, 200),
          notes: `来源：会后反馈 ${id}${reopenConditions ? `；重启条件：${reopenConditions.slice(0, 200)}` : ""}`,
          status: "needsAction",
          priority: row.disposition === "strong_interest" ? "high" : "normal",
          dueAt: Number.isFinite(dueAt.getTime()) ? dueAt : null,
          createdBy: "agent",
          createdAt: ts,
          updatedAt: ts,
        }).onConflictDoNothing().run();
      }
    }

    const applyResult = { writtenFacts, taskId, scopes };
    this.db.update(faMeetingFeedbacks).set({
      status: "confirmed",
      confirmedBy: confirmedBy.slice(0, 120),
      confirmedAt: ts,
      applyResult,
      projectUpdates: projectUpdates || row.projectUpdates,
      personSignals: personSignals || row.personSignals,
      institutionSignals: institutionSignals || row.institutionSignals,
      reopenConditions: reopenConditions || row.reopenConditions,
      updatedAt: ts,
    }).where(eq(faMeetingFeedbacks.id, id)).run();
    return { ...this.get(id), applyResult };
  }

  dismiss(id: string) {
    const row = this.get(id);
    if (row.status === "confirmed") throw new FaFeedbackError(`feedback_already_confirmed:${id}`);
    this.db.update(faMeetingFeedbacks).set({ status: "dismissed", updatedAt: now() })
      .where(eq(faMeetingFeedbacks.id, id)).run();
    return this.get(id);
  }
}
