import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { contextRooms, rooms } from "../src/infrastructure/database/schema.js";
import { FaArchiveService } from "../src/modules/fa-archive/service.js";
import { FaFeedbackService } from "../src/modules/fa-archive/feedback.js";
import { screenInstitutions } from "../src/modules/fa-archive/matching.js";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-match-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;

  db.insert(rooms).values([
    { id: "inst-good", title: "活跃机构", kind: "机构", origin: "user" },
    { id: "inst-expired", title: "过投资期机构", kind: "机构", origin: "user" },
    { id: "inst-conflict", title: "组合冲突机构", kind: "机构", origin: "user" },
    { id: "inst-rejected", title: "已拒绝机构", kind: "机构", origin: "user" },
    { id: "person-ic", title: "李合伙人", kind: "人物", origin: "user" },
  ]).onConflictDoNothing().run();
  db.insert(contextRooms).values({ id: "ctx-proj", title: "某AI项目", data: {} }).onConflictDoNothing().run();

  const archive = new FaArchiveService(db);
  const feedback = new FaFeedbackService(db);
  const year = new Date().getFullYear();

  // 活跃机构：在投基金 + 近期 A 轮 + 投委会联系人 + 可比公司（认知）
  archive.upsertFund({ institutionRoomId: "inst-good", name: "一期基金", status: "active", investmentPeriodEnd: year + 2 });
  archive.upsertInvestment({ institutionRoomId: "inst-good", portfolioCompany: "可比AI公司", round: "A", investedOn: `${year}-05`, role: "lead", relationToPortfolio: "synergy" });
  archive.upsertPosition({ personRoomId: "person-ic", institutionRoomId: "inst-good", title: "合伙人", icMember: true, canLead: true, sectors: ["AI应用"] });

  // 过投资期：基金 investmentPeriodEnd 已过
  archive.upsertFund({ institutionRoomId: "inst-expired", name: "老基金", status: "active", investmentPeriodEnd: year - 1 });

  // 组合冲突：投了冲突标记的可比公司
  archive.upsertFund({ institutionRoomId: "inst-conflict", name: "二期", status: "active", investmentPeriodEnd: year + 3 });
  archive.upsertInvestment({ institutionRoomId: "inst-conflict", portfolioCompany: "冲突公司", round: "A", investedOn: `${year - 1}-05`, relationToPortfolio: "conflict" });

  // 已拒绝且无可重启条件
  archive.upsertFund({ institutionRoomId: "inst-rejected", name: "基金", status: "active", investmentPeriodEnd: year + 3 });
  const passDraft = feedback.createDraft({
    roomId: "ctx-proj",
    institutionRoomId: "inst-rejected",
    disposition: "pass",
    passReasons: ["stage_mismatch"],
  });
  feedback.confirm(passDraft.id, "tester", { applyScopes: ["project"], createFollowUpTask: false });
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

describe("FA 投资人匹配（fa-industry-iteration 工作项五）", () => {
  it("硬筛：过投资期/组合冲突/已拒绝出局且带理由；活跃机构通过", () => {
    const results = screenInstitutions(db, {
      projectRoomId: "ctx-proj",
      round: "A",
      comparableCompanies: ["可比AI公司", "冲突公司"],
    });
    const byId = Object.fromEntries(results.map((r) => [r.institutionRoomId, r]));

    expect(byId["inst-good"]?.passed).toBe(true);
    expect(byId["inst-good"]?.fitScore).toBeGreaterThanOrEqual(50);
    // 得分依据齐全：赛道认知 + 阶段匹配 + 决策可达 + 数据完整度
    const factors = byId["inst-good"]?.scoreBreakdown.map((b) => b.factor);
    expect(factors).toContain("赛道认知");
    expect(factors).toContain("阶段匹配");
    expect(factors).toContain("决策可达");

    expect(byId["inst-expired"]?.passed).toBe(false);
    expect(byId["inst-expired"]?.reasons[0]).toContain("过投资期");

    expect(byId["inst-conflict"]?.passed).toBe(false);
    expect(byId["inst-conflict"]?.reasons[0]).toContain("组合冲突");

    expect(byId["inst-rejected"]?.passed).toBe(false);
    expect(byId["inst-rejected"]?.reasons[0]).toContain("明确拒绝");

    // 排序：通过者在前
    expect(results[0]?.institutionRoomId).toBe("inst-good");
  });

  it("无基金档案标 unknown，不判死（数据缺失 ≠ 机构没投能力）", () => {
    const results = screenInstitutions(db, { projectRoomId: "ctx-proj" });
    // 本测试库里所有机构都有基金，此项验证分支存在：加一个无基金机构
    db.insert(rooms).values({ id: "inst-nofund", title: "无档案机构", kind: "机构", origin: "user" }).onConflictDoNothing().run();
    const rerun = screenInstitutions(db, { projectRoomId: "ctx-proj" });
    const nofund = rerun.find((r) => r.institutionRoomId === "inst-nofund");
    expect(nofund?.unknowns.some((u) => u.includes("无基金档案"))).toBe(true);
    // 不因缺数据出局（除非别的硬条件）
    expect(nofund?.reasons).toHaveLength(0);
    expect(nofund?.passed).toBe(true);
  });

  it("认知/冲突双解释：投过可比公司的机构带 portfolioNotes", () => {
    const results = screenInstitutions(db, {
      projectRoomId: "ctx-proj",
      comparableCompanies: ["可比AI公司", "冲突公司"],
    });
    const good = results.find((r) => r.institutionRoomId === "inst-good");
    expect(good?.portfolioNotes).toEqual([{ company: "可比AI公司", interpretation: "synergy" }]);
    const conflict = results.find((r) => r.institutionRoomId === "inst-conflict");
    expect(conflict?.portfolioNotes.some((p) => p.interpretation === "conflict")).toBe(true);
  });
});
