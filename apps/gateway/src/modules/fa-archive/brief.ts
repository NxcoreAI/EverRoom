/**
 * FA 会前简报（fa-industry-iteration 工作项四）：聚合机构档案 + 人物信号 +
 * 历史反馈 + 已核事实，产出会前 Brief。纯读聚合，供主 Agent 或 REST 消费。
 *
 * 聚合内容对齐蓝图 A3（Meeting Brief）：为什么匹配、已投案例、决策链、历史
 * 互动、未兑现承诺、常问问题、本次强调点、披露边界。
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  faFunds,
  faInvestments,
  faPositions,
  faMeetingFeedbacks,
  roomEntityFacts,
  rooms,
} from "../../infrastructure/database/schema.js";

export interface FaMeetingBriefInput {
  /** 项目 Room（被路演的项目）。 */
  projectRoomId: string;
  /** 参会机构 Room。 */
  institutionRoomId: string;
  /** 主要参会人 Room（可选：只出此人视角时）。 */
  personRoomId?: string;
}

export interface FaMeetingBrief {
  institution: { id: string; title: string };
  funds: Array<{ name: string; currency: string | null; status: string; investmentPeriodEnd: number | null }>;
  positions: Array<{ personRoomId: string; title: string | null; icMember: boolean | null; canLead: boolean | null; sectors: string[] | null }>;
  relevantInvestments: Array<{ portfolioCompany: string; round: string | null; investedOn: string | null; role: string; relationToPortfolio: string }>;
  /** 本项目房的全部投资人反馈（时间倒序，含未确认 draft 供会前知悉）。 */
  pastFeedbacks: Array<{
    meetingAt: string | null; disposition: string; passReasons: string[] | null;
    reopenConditions: string | null; status: string;
  }>;
  /** 机构房的信号类事实（会议信号/偏好，grade=fact 倒序）。 */
  institutionSignals: string[];
  /** 人物房信号（传 personRoomId 时）。 */
  personSignals: string[];
  /** 未兑现的跟进任务线索：来自已确认反馈的重新联系条件（满足条件前不该打扰）。 */
  pendingReopenConditions: string[];
  /** 项目房的已核事实（grade=fact，路演素材底稿；≤20 条）。 */
  verifiedProjectFacts: string[];
}

export function buildMeetingBrief(db: GatewayDatabase, input: FaMeetingBriefInput): FaMeetingBrief {
  const { projectRoomId, institutionRoomId } = input;

  const institution = db.select({ id: rooms.id, title: rooms.title })
    .from(rooms).where(and(eq(rooms.id, institutionRoomId), isNull(rooms.deletedAt))).get();

  const funds = db.select({
    name: faFunds.name, currency: faFunds.currency,
    status: faFunds.status, investmentPeriodEnd: faFunds.investmentPeriodEnd,
  }).from(faFunds)
    .where(and(eq(faFunds.institutionRoomId, institutionRoomId), isNull(faFunds.deletedAt)))
    .limit(20).all();

  const positions = db.select({
    personRoomId: faPositions.personRoomId, title: faPositions.title,
    icMember: faPositions.icMember, canLead: faPositions.canLead, sectors: faPositions.sectors,
  }).from(faPositions)
    .where(and(eq(faPositions.institutionRoomId, institutionRoomId), isNull(faPositions.deletedAt)))
    .limit(20).all();

  const relevantInvestments = db.select({
    portfolioCompany: faInvestments.portfolioCompany, round: faInvestments.round,
    investedOn: faInvestments.investedOn, role: faInvestments.role,
    relationToPortfolio: faInvestments.relationToPortfolio,
  }).from(faInvestments)
    .where(and(eq(faInvestments.institutionRoomId, institutionRoomId), isNull(faInvestments.deletedAt)))
    .orderBy(desc(faInvestments.investedOn)).limit(30).all();

  const pastFeedbacks = db.select({
    meetingAt: faMeetingFeedbacks.meetingAt, disposition: faMeetingFeedbacks.disposition,
    passReasons: faMeetingFeedbacks.passReasons, reopenConditions: faMeetingFeedbacks.reopenConditions,
    status: faMeetingFeedbacks.status,
  }).from(faMeetingFeedbacks)
    .where(and(eq(faMeetingFeedbacks.roomId, projectRoomId), isNull(faMeetingFeedbacks.deletedAt)))
    .orderBy(desc(faMeetingFeedbacks.createdAt)).limit(20).all();

  const institutionSignals = db.select({ content: roomEntityFacts.content })
    .from(roomEntityFacts)
    .where(and(eq(roomEntityFacts.roomId, institutionRoomId), eq(roomEntityFacts.grade, "fact")))
    .orderBy(desc(roomEntityFacts.createdAt)).limit(15).all()
    .map((r) => r.content);

  const personSignals = input.personRoomId
    ? db.select({ content: roomEntityFacts.content })
        .from(roomEntityFacts)
        .where(and(eq(roomEntityFacts.roomId, input.personRoomId), eq(roomEntityFacts.grade, "fact")))
        .orderBy(desc(roomEntityFacts.createdAt)).limit(10).all()
        .map((r) => r.content)
    : [];

  const pendingReopenConditions = pastFeedbacks
    .filter((f) => f.status === "confirmed" && f.reopenConditions && f.disposition !== "strong_interest")
    .map((f) => f.reopenConditions!)
    .slice(0, 5);

  const verifiedProjectFacts = db.select({ content: roomEntityFacts.content })
    .from(roomEntityFacts)
    .where(and(eq(roomEntityFacts.roomId, projectRoomId), eq(roomEntityFacts.grade, "fact")))
    .orderBy(desc(roomEntityFacts.createdAt)).limit(20).all()
    .map((r) => r.content);

  return {
    institution: institution ?? { id: institutionRoomId, title: "" },
    funds,
    positions,
    relevantInvestments,
    pastFeedbacks,
    institutionSignals,
    personSignals,
    pendingReopenConditions,
    verifiedProjectFacts,
  };
}
