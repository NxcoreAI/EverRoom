import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { contextRooms, roomEntityFacts, rooms } from "../src/infrastructure/database/schema.js";
import { FaArchiveService } from "../src/modules/fa-archive/service.js";
import { FaFeedbackService } from "../src/modules/fa-archive/feedback.js";
import { buildMeetingBrief } from "../src/modules/fa-archive/brief.js";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

const fingerprint = (content: string) => createHash("sha256").update(content.trim()).digest("hex").slice(0, 20);

function insertFact(roomId: string, content: string, grade = "fact") {
  db.insert(roomEntityFacts).values({
    id: randomUUID(),
    roomId,
    factId: fingerprint(content),
    content,
    type: "属性",
    grade: grade as never,
    sourceKind: "reality-event",
    sourceId: randomUUID(),
    sourceVersion: 1,
    evidenceGroupKey: "g",
  }).onConflictDoNothing().run();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-brief-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;

  // rooms（机构/人物）+ contextRooms（项目，反馈任务挂它）
  db.insert(rooms).values([
    { id: "inst-1", title: "某机构", kind: "机构", origin: "user" },
    { id: "person-1", title: "王合伙人", kind: "人物", origin: "user" },
  ]).onConflictDoNothing().run();
  db.insert(contextRooms).values({ id: "ctx-proj", title: "某AI项目", data: {} }).onConflictDoNothing().run();

  // 机构档案：基金 + 投资记录 + 任职
  const archive = new FaArchiveService(db);
  archive.upsertFund({ institutionRoomId: "inst-1", name: "三期人民币基金", currency: "CNY", status: "active", investmentPeriodEnd: 2028 });
  archive.upsertInvestment({ institutionRoomId: "inst-1", portfolioCompany: "同赛道A公司", round: "A", investedOn: "2025-03", role: "lead", relationToPortfolio: "conflict" });
  archive.upsertPosition({ personRoomId: "person-1", institutionRoomId: "inst-1", title: "合伙人", icMember: true, canLead: true, sectors: ["AI应用"] });

  // 信号事实
  insertFact("inst-1", "会议信号（2026-10）：本期基金优先看企业服务");
  insertFact("person-1", "会议观察（2026-10）：偏好简短数据表");
  insertFact("ctx-proj", "2025H1 营收 1.2 亿元（经审计）");
  insertFact("ctx-proj", "这是推测不是事实", "opinion");

  // 历史反馈：一次 watch 带重启条件（已确认）
  const feedback = new FaFeedbackService(db);
  const draft = feedback.createDraft({
    roomId: "ctx-proj",
    institutionRoomId: "inst-1",
    personRoomId: "person-1",
    meetingAt: "2026-10-20",
    disposition: "watch",
    passReasons: ["traction_weak"],
    reopenConditions: "客户续费数据出来再聊",
    projectUpdates: "先把客户结构补齐",
  });
  feedback.confirm(draft.id, "李展萍", { applyScopes: ["project"] });
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

describe("FA 会前简报（fa-industry-iteration 工作项四）", () => {
  it("聚合机构档案/信号/历史反馈/已核事实", () => {
    const brief = buildMeetingBrief(db, {
      projectRoomId: "ctx-proj",
      institutionRoomId: "inst-1",
      personRoomId: "person-1",
    });
    expect(brief.institution.title).toBe("某机构");
    expect(brief.funds).toHaveLength(1);
    expect(brief.funds[0]?.investmentPeriodEnd).toBe(2028);
    expect(brief.positions).toHaveLength(1);
    expect(brief.positions[0]?.icMember).toBe(true);
    expect(brief.relevantInvestments).toHaveLength(1);
    expect(brief.relevantInvestments[0]?.relationToPortfolio).toBe("conflict"); // 组合冲突提示输入
    expect(brief.institutionSignals.some((s) => s.includes("企业服务"))).toBe(true);
    expect(brief.personSignals.some((s) => s.includes("偏好"))).toBe(true);
    expect(brief.verifiedProjectFacts.some((s) => s.includes("1.2 亿"))).toBe(true);
    expect(brief.verifiedProjectFacts.some((s) => s.includes("推测"))).toBe(false); // 只取 fact
    expect(brief.pastFeedbacks).toHaveLength(1);
    expect(brief.pendingReopenConditions).toEqual(["客户续费数据出来再聊"]); // 未满足的重启条件
  });

  it("不传 personRoomId 时人物信号为空数组", () => {
    const brief = buildMeetingBrief(db, { projectRoomId: "ctx-proj", institutionRoomId: "inst-1" });
    expect(brief.personSignals).toEqual([]);
  });
});
