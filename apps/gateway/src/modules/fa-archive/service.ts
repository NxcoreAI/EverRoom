/**
 * FA 机构档案服务（fa-industry-iteration 工作项一）。
 *
 * 三张结构化表（fa_funds / fa_investments / fa_positions）挂在机构 Room 与
 * 人物 Room 之下：展示与匹配计算直接读库，不经模型生成。写入走确认制——
 * 导入/登记先进未确认态，人工确认（confirm 动作）后才是权威档案。
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  faFunds,
  faInvestments,
  faPositions,
  rooms,
} from "../../infrastructure/database/schema.js";
import { randomUUID } from "node:crypto";

export type FaFundStatus = "active" | "inactive" | "unknown";
export type FaInvestmentRole = "lead" | "follow" | "unknown";

export interface FaFundInput {
  institutionRoomId: string;
  name: string;
  sequence?: string;
  currency?: string;
  vintageYear?: number;
  targetSize?: number;
  sizeUnit?: string;
  investmentPeriodEnd?: number;
  constraints?: string[];
  status?: FaFundStatus;
  sourceKind?: string;
  sourceId?: string;
  note?: string;
}

export interface FaInvestmentInput {
  institutionRoomId: string;
  fundId?: string;
  portfolioCompany: string;
  projectRoomId?: string;
  round?: string;
  investedOn?: string;
  role?: FaInvestmentRole;
  ticketSize?: number;
  ticketCurrency?: string;
  relationToPortfolio?: "synergy" | "conflict" | "neutral" | "unknown";
  sourceKind?: string;
  sourceId?: string;
  sourceUrl?: string;
  note?: string;
}

export interface FaPositionInput {
  personRoomId: string;
  institutionRoomId: string;
  title?: string;
  fromYear?: number;
  toYear?: number;
  icMember?: boolean;
  canLead?: boolean;
  sectors?: string[];
  sourceKind?: string;
  sourceId?: string;
  note?: string;
}

export class FaArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaArchiveError";
  }
}

const now = () => new Date();

export class FaArchiveService {
  constructor(private readonly db: GatewayDatabase) {}

  /** 校验 Room 存在且 kind 符合（机构/人物），未删除。 */
  private requireRoom(roomId: string, kind: "机构" | "人物"): void {
    const room = this.db
      .select({ id: rooms.id, kind: rooms.kind, deletedAt: rooms.deletedAt })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .get();
    if (!room || room.deletedAt) throw new FaArchiveError(`room_not_found:${roomId}`);
    if (room.kind !== kind) throw new FaArchiveError(`room_kind_mismatch:${roomId}:${room.kind}!=${kind}`);
  }

  // ── 基金 ──

  listFunds(institutionRoomId: string) {
    return this.db
      .select()
      .from(faFunds)
      .where(and(eq(faFunds.institutionRoomId, institutionRoomId), isNull(faFunds.deletedAt)))
      .orderBy(desc(faFunds.createdAt))
      .all();
  }

  upsertFund(input: FaFundInput) {
    this.requireRoom(input.institutionRoomId, "机构");
    const existing = this.db
      .select()
      .from(faFunds)
      .where(and(eq(faFunds.institutionRoomId, input.institutionRoomId), eq(faFunds.name, input.name), isNull(faFunds.deletedAt)))
      .get();
    const values = {
      name: input.name.trim().slice(0, 200),
      sequence: input.sequence?.slice(0, 40),
      currency: input.currency?.slice(0, 8),
      vintageYear: input.vintageYear,
      targetSize: input.targetSize,
      sizeUnit: input.sizeUnit?.slice(0, 16),
      investmentPeriodEnd: input.investmentPeriodEnd,
      constraints: input.constraints?.map((c) => c.slice(0, 300)).slice(0, 20),
      status: input.status ?? "unknown",
      sourceKind: input.sourceKind?.slice(0, 40),
      sourceId: input.sourceId?.slice(0, 128),
      note: input.note?.slice(0, 2000),
      updatedAt: now(),
    };
    if (existing) {
      this.db.update(faFunds).set(values).where(eq(faFunds.id, existing.id)).run();
      return this.db.select().from(faFunds).where(eq(faFunds.id, existing.id)).get()!;
    }
    const id = randomUUID();
    this.db.insert(faFunds).values({
      id,
      institutionRoomId: input.institutionRoomId,
      ...values,
    }).run();
    return this.db.select().from(faFunds).where(eq(faFunds.id, id)).get()!;
  }

  confirmFund(id: string, confirmedBy: string) {
    const result = this.db
      .update(faFunds)
      .set({ confirmedBy: confirmedBy.slice(0, 120), confirmedAt: now(), updatedAt: now() })
      .where(and(eq(faFunds.id, id), isNull(faFunds.deletedAt)))
      .run();
    if (!result.changes) throw new FaArchiveError(`fund_not_found:${id}`);
    return this.db.select().from(faFunds).where(eq(faFunds.id, id)).get()!;
  }

  deleteFund(id: string) {
    const result = this.db
      .update(faFunds)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(and(eq(faFunds.id, id), isNull(faFunds.deletedAt)))
      .run();
    if (!result.changes) throw new FaArchiveError(`fund_not_found:${id}`);
  }

  // ── 投资记录 ──

  listInvestments(institutionRoomId: string) {
    return this.db
      .select()
      .from(faInvestments)
      .where(and(eq(faInvestments.institutionRoomId, institutionRoomId), isNull(faInvestments.deletedAt)))
      .orderBy(desc(faInvestments.investedOn))
      .all();
  }

  /** 按被投公司反查（项目 Room 视角：谁投过我/同类公司）。 */
  investmentsInCompany(portfolioCompany: string) {
    return this.db
      .select()
      .from(faInvestments)
      .where(and(eq(faInvestments.portfolioCompany, portfolioCompany), isNull(faInvestments.deletedAt)))
      .all();
  }

  upsertInvestment(input: FaInvestmentInput) {
    this.requireRoom(input.institutionRoomId, "机构");
    const company = input.portfolioCompany.trim().slice(0, 200);
    // 去重键：机构 + 公司 + 轮次 + 日期；任一字段为空的记录不去重（直接插入）。
    const dedupRound = input.round?.slice(0, 40) ?? null;
    const dedupOn = input.investedOn?.slice(0, 10) ?? null;
    const existing = dedupRound && dedupOn
      ? this.db
          .select()
          .from(faInvestments)
          .where(and(
            eq(faInvestments.institutionRoomId, input.institutionRoomId),
            eq(faInvestments.portfolioCompany, company),
            eq(faInvestments.round, dedupRound),
            eq(faInvestments.investedOn, dedupOn),
            isNull(faInvestments.deletedAt),
          ))
          .get()
      : undefined;
    const values = {
      fundId: input.fundId?.slice(0, 128),
      portfolioCompany: company,
      projectRoomId: input.projectRoomId?.slice(0, 128),
      round: input.round?.slice(0, 40),
      investedOn: input.investedOn?.slice(0, 10),
      role: input.role ?? "unknown",
      ticketSize: input.ticketSize,
      ticketCurrency: input.ticketCurrency?.slice(0, 8),
      relationToPortfolio: input.relationToPortfolio ?? "unknown",
      sourceKind: input.sourceKind?.slice(0, 40),
      sourceId: input.sourceId?.slice(0, 128),
      sourceUrl: input.sourceUrl?.slice(0, 1000),
      note: input.note?.slice(0, 2000),
      updatedAt: now(),
    };
    if (existing) {
      // 去重命中：投资事件是不可变事实，直接返回既有行——修正走删除后重录，
      // 避免后续导入把已确认的领投/票面悄悄改掉。
      return existing;
    }
    const id = randomUUID();
    this.db.insert(faInvestments).values({
      id,
      institutionRoomId: input.institutionRoomId,
      ...values,
    }).run();
    return this.db.select().from(faInvestments).where(eq(faInvestments.id, id)).get()!;
  }

  confirmInvestment(id: string, confirmedBy: string) {
    const result = this.db
      .update(faInvestments)
      .set({ confirmedBy: confirmedBy.slice(0, 120), confirmedAt: now(), updatedAt: now() })
      .where(and(eq(faInvestments.id, id), isNull(faInvestments.deletedAt)))
      .run();
    if (!result.changes) throw new FaArchiveError(`investment_not_found:${id}`);
    return this.db.select().from(faInvestments).where(eq(faInvestments.id, id)).get()!;
  }

  deleteInvestment(id: string) {
    const result = this.db
      .update(faInvestments)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(and(eq(faInvestments.id, id), isNull(faInvestments.deletedAt)))
      .run();
    if (!result.changes) throw new FaArchiveError(`investment_not_found:${id}`);
  }

  // ── 任职 ──

  listPositionsByInstitution(institutionRoomId: string) {
    return this.db
      .select()
      .from(faPositions)
      .where(and(eq(faPositions.institutionRoomId, institutionRoomId), isNull(faPositions.deletedAt)))
      .all();
  }

  listPositionsByPerson(personRoomId: string) {
    return this.db
      .select()
      .from(faPositions)
      .where(and(eq(faPositions.personRoomId, personRoomId), isNull(faPositions.deletedAt)))
      .all();
  }

  upsertPosition(input: FaPositionInput) {
    this.requireRoom(input.personRoomId, "人物");
    this.requireRoom(input.institutionRoomId, "机构");
    const title = input.title?.trim().slice(0, 120) ?? "";
    const existing = this.db
      .select()
      .from(faPositions)
      .where(and(
        eq(faPositions.personRoomId, input.personRoomId),
        eq(faPositions.institutionRoomId, input.institutionRoomId),
        eq(faPositions.title, title),
        isNull(faPositions.deletedAt),
      ))
      .get();
    const values = {
      title,
      fromYear: input.fromYear,
      toYear: input.toYear,
      icMember: input.icMember,
      canLead: input.canLead,
      sectors: input.sectors?.map((s) => s.slice(0, 60)).slice(0, 12),
      sourceKind: input.sourceKind?.slice(0, 40),
      sourceId: input.sourceId?.slice(0, 128),
      note: input.note?.slice(0, 2000),
      updatedAt: now(),
    };
    if (existing) {
      this.db.update(faPositions).set(values).where(eq(faPositions.id, existing.id)).run();
      return this.db.select().from(faPositions).where(eq(faPositions.id, existing.id)).get()!;
    }
    const id = randomUUID();
    this.db.insert(faPositions).values({
      id,
      personRoomId: input.personRoomId,
      institutionRoomId: input.institutionRoomId,
      ...values,
    }).run();
    return this.db.select().from(faPositions).where(eq(faPositions.id, id)).get()!;
  }

  confirmPosition(id: string, confirmedBy: string) {
    const result = this.db
      .update(faPositions)
      .set({ confirmedBy: confirmedBy.slice(0, 120), confirmedAt: now(), updatedAt: now() })
      .where(and(eq(faPositions.id, id), isNull(faPositions.deletedAt)))
      .run();
    if (!result.changes) throw new FaArchiveError(`position_not_found:${id}`);
    return this.db.select().from(faPositions).where(eq(faPositions.id, id)).get()!;
  }

  deletePosition(id: string) {
    const result = this.db
      .update(faPositions)
      .set({ deletedAt: now(), updatedAt: now() })
      .where(and(eq(faPositions.id, id), isNull(faPositions.deletedAt)))
      .run();
    if (!result.changes) throw new FaArchiveError(`position_not_found:${id}`);
  }
}
