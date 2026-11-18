/**
 * FA 投资人筛选与匹配（fa-industry-iteration 工作项五，蓝图 §17 两阶段算法）。
 *
 * 第一阶段硬筛（任一不满足出局，出局必须给理由；信息不足标 unknown 由人决定）：
 * 基金不活跃/过投资期、轮次不符、票面不符、明确拒绝未满足重启条件。
 * 第二阶段适配排序：赛道匹配、阶段匹配、历史投资相关性（同时给出认知/冲突
 * 双解释）、当前反馈状态、决策可达性加权——每项带得分依据，最终名单由人定。
 */
import { and, eq, isNull, ne } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  faFunds,
  faInvestments,
  faMeetingFeedbacks,
  faPositions,
  rooms,
} from "../../infrastructure/database/schema.js";

export interface FaMatchInput {
  /** 项目 Room。 */
  projectRoomId: string;
  /** 项目侧条件（来自事实库或人工填写）。 */
  round?: string;
  askAmount?: number;
  askCurrency?: string;
  sectors?: string[];
  /** 组合冲突判断的项目名集合（同赛道可比公司名单）。 */
  comparableCompanies?: string[];
  /** 已明确拒绝且重启条件未发生的机构不进名单。 */
  includeRejectedWithUnmetConditions?: boolean;
}

export interface FaHardScreenResult {
  institutionRoomId: string;
  institutionTitle: string;
  passed: boolean;
  /** 出局理由（passed=false 时必有一条）；unknown 项单独列出。 */
  reasons: string[];
  unknowns: string[];
}

export interface FaMatchCandidate extends FaHardScreenResult {
  /** 适配评分 0-100（仅硬筛通过者有意义）。 */
  fitScore: number;
  scoreBreakdown: Array<{ factor: string; points: number; basis: string }>;
  /** 投过可比公司的双解释（蓝图 §12.4：认知 or 冲突）。 */
  portfolioNotes: Array<{ company: string; interpretation: "synergy" | "conflict" }>;
  positions: Array<{ personRoomId: string; title: string | null; icMember: boolean | null; canLead: boolean | null }>;
  /** 与本项目的最新反馈状态。 */
  latestDisposition: string | null;
}

export function screenInstitutions(db: GatewayDatabase, input: FaMatchInput): FaMatchCandidate[] {
  const institutions = db.select({ id: rooms.id, title: rooms.title })
    .from(rooms)
    .where(and(eq(rooms.kind, "机构"), isNull(rooms.deletedAt)))
    .all();

  const results: FaMatchCandidate[] = [];

  for (const inst of institutions) {
    const reasons: string[] = [];
    const unknowns: string[] = [];

    // ── 基金状态：无基金 = unknown（数据缺失不判死）；有基金但全过投资期 = 出局 ──
    const funds = db.select().from(faFunds)
      .where(and(eq(faFunds.institutionRoomId, inst.id), isNull(faFunds.deletedAt))).all();
    if (funds.length === 0) {
      unknowns.push("无基金档案（数据缺失，不能判定为没有投资能力）");
    } else {
      const active = funds.filter((f) => f.status === "active"
        && (f.investmentPeriodEnd === null || f.investmentPeriodEnd >= new Date().getFullYear()));
      if (active.length === 0) reasons.push("全部基金已过投资期或标记不活跃");
    }

    // ── 投资记录相关性 ──
    const investments = db.select().from(faInvestments)
      .where(and(eq(faInvestments.institutionRoomId, inst.id), isNull(faInvestments.deletedAt))).all();
    const comparableSet = new Set((input.comparableCompanies ?? []).map((c) => c.trim()).filter(Boolean));
    const portfolioNotes: FaMatchCandidate["portfolioNotes"] = [];
    let sameSectorInvestments = 0;
    for (const inv of investments) {
      if (comparableSet.has(inv.portfolioCompany)) {
        portfolioNotes.push({
          company: inv.portfolioCompany,
          interpretation: inv.relationToPortfolio === "conflict" ? "conflict" : "synergy",
        });
      }
      if ((input.sectors ?? []).some((s) => (inv.round ?? "").includes(s) || inv.portfolioCompany.includes(s))) {
        sameSectorInvestments += 1;
      }
    }
    const hardConflicts = portfolioNotes.filter((p) => p.interpretation === "conflict");
    if (hardConflicts.length > 0) {
      reasons.push(`组合冲突：已投 ${hardConflicts.map((p) => p.company).join("、")}`);
    }

    // ── 明确拒绝且重启条件未发生 ──
    if (!input.includeRejectedWithUnmetConditions) {
      const lastPass = db.select().from(faMeetingFeedbacks)
        .where(and(
          eq(faMeetingFeedbacks.roomId, input.projectRoomId),
          eq(faMeetingFeedbacks.institutionRoomId, inst.id),
          eq(faMeetingFeedbacks.disposition, "pass"),
          isNull(faMeetingFeedbacks.deletedAt),
        ))
        .orderBy(faMeetingFeedbacks.createdAt)
        .get();
      if (lastPass && !lastPass.reopenConditions) {
        reasons.push("已明确拒绝且无可重启条件");
      }
    }

    const passed = reasons.length === 0;

    // ── 第二阶段：适配评分（仅通过者有意义，但一并算供参考）──
    const positions = db.select({
      personRoomId: faPositions.personRoomId, title: faPositions.title,
      icMember: faPositions.icMember, canLead: faPositions.canLead,
    }).from(faPositions)
      .where(and(eq(faPositions.institutionRoomId, inst.id), isNull(faPositions.deletedAt))).all();

    const latestFeedback = db.select().from(faMeetingFeedbacks)
      .where(and(
        eq(faMeetingFeedbacks.roomId, input.projectRoomId),
        eq(faMeetingFeedbacks.institutionRoomId, inst.id),
        isNull(faMeetingFeedbacks.deletedAt),
      ))
      .orderBy(faMeetingFeedbacks.createdAt)
      .get();

    const breakdown: FaMatchCandidate["scoreBreakdown"] = [];
    let score = 0;
    // 赛道匹配（30）：投过可比/同赛道 = 认知（冲突已在硬筛出局）
    const synergyCount = portfolioNotes.filter((p) => p.interpretation === "synergy").length;
    if (synergyCount > 0) { score += 20; breakdown.push({ factor: "赛道认知", points: 20, basis: `投过 ${synergyCount} 家可比公司（认知解释）` }); }
    else if (sameSectorInvestments > 0) { score += 12; breakdown.push({ factor: "相邻投资", points: 12, basis: `${sameSectorInvestments} 笔相关轮次/名称匹配` }); }
    else unknowns.push("未发现同赛道投资记录（可能数据不全）");
    // 阶段匹配（20）：近 24 个月投过同轮次
    const recentSameRound = investments.filter((inv) => inv.round === input.round
      && inv.investedOn && Number(inv.investedOn.slice(0, 4)) >= new Date().getFullYear() - 2);
    if (input.round && recentSameRound.length > 0) { score += 20; breakdown.push({ factor: "阶段匹配", points: 20, basis: `近两年投过 ${recentSameRound.length} 个 ${input.round} 轮` }); }
    else if (input.round) unknowns.push(`未发现近两年 ${input.round} 轮投资（可能数据不全）`);
    // 决策可达性（25）：有投委会成员/可领投者档案
    const icOrLead = positions.filter((p) => p.icMember === true || p.canLead === true);
    if (icOrLead.length > 0) { score += Math.min(25, 15 + icOrLead.length * 5); breakdown.push({ factor: "决策可达", points: Math.min(25, 15 + icOrLead.length * 5), basis: `${icOrLead.length} 名投委会/可领投联系人` }); }
    else unknowns.push("无投委会/领投联系人档案");
    // 当前姿态（15）：最新反馈
    if (latestFeedback?.disposition === "strong_interest" || latestFeedback?.disposition === "interest") {
      score += 15; breakdown.push({ factor: "当前姿态", points: 15, basis: `最新反馈：${latestFeedback.disposition}` });
    } else if (latestFeedback?.disposition === "watch") {
      score += 8; breakdown.push({ factor: "当前姿态", points: 8, basis: "最新反馈：观察中" });
    }
    // 数据完整度（10）：确认过的记录占比加分
    const confirmedCount = [...funds, ...investments].filter((r) => "confirmedAt" in r && r.confirmedAt).length;
    const totalCount = funds.length + investments.length;
    if (totalCount > 0) {
      const completeness = Math.round((confirmedCount / totalCount) * 10);
      score += completeness;
      breakdown.push({ factor: "数据完整度", points: completeness, basis: `${confirmedCount}/${totalCount} 条已确认` });
    }

    results.push({
      institutionRoomId: inst.id,
      institutionTitle: inst.title,
      passed,
      reasons,
      unknowns,
      fitScore: Math.min(100, score),
      scoreBreakdown: breakdown,
      portfolioNotes,
      positions,
      latestDisposition: latestFeedback?.disposition ?? null,
    });
  }

  // 通过者按分数降序在前，出局者保持稳定排序
  return results.sort((a, b) => Number(b.passed) - Number(a.passed) || b.fitScore - a.fitScore);
}
