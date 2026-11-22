import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { rooms } from "../src/infrastructure/database/schema.js";
import { FaArchiveError, FaArchiveService } from "../src/modules/fa-archive/service.js";
import { eq } from "drizzle-orm";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-archive-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

function seedRoom(id: string, title: string, kind: string) {
  db.insert(rooms).values({ id, title, kind, origin: "user" }).onConflictDoNothing().run();
}

describe("FA 机构档案（fa-industry-iteration 工作项一）", () => {
  const service = () => new FaArchiveService(db);

  it("机构 kind 已入 Room 枚举并可建机构房", () => {
    seedRoom("inst-1", "红杉中国", "机构");
    seedRoom("person-1", "张三", "人物");
    seedRoom("proj-1", "某AI项目", "项目");
    const inst = db.select().from(rooms).where(eq(rooms.id, "inst-1")).get();
    expect(inst?.kind).toBe("机构");
  });

  it("基金：upsert 幂等、confirm 置确认态、list 过滤软删", () => {
    const svc = service();
    const fund = svc.upsertFund({
      institutionRoomId: "inst-1",
      name: "红杉五期人民币基金",
      currency: "CNY",
      vintageYear: 2023,
      targetSize: 18,
      sizeUnit: "亿元",
      investmentPeriodEnd: 2028,
      constraints: ["不投白酒", "LP 要求境内退出"],
      status: "active",
    });
    expect(fund.status).toBe("active");
    // 同名 upsert = 更新而非重复插入
    const again = svc.upsertFund({ institutionRoomId: "inst-1", name: "红杉五期人民币基金", status: "inactive" });
    expect(again.id).toBe(fund.id);
    expect(again.status).toBe("inactive");
    expect(svc.listFunds("inst-1")).toHaveLength(1);

    const confirmed = svc.confirmFund(fund.id, "李展萍");
    expect(confirmed.confirmedBy).toBe("李展萍");
    expect(confirmed.confirmedAt).toBeTruthy();

    svc.deleteFund(fund.id);
    expect(svc.listFunds("inst-1")).toHaveLength(0);
    expect(() => svc.confirmFund(fund.id, "x")).toThrow(FaArchiveError);
  });

  it("基金写入校验机构 kind：人物房拒绝", () => {
    expect(() => service().upsertFund({ institutionRoomId: "person-1", name: "f" })).toThrow(/room_kind_mismatch/);
    expect(() => service().upsertFund({ institutionRoomId: "missing", name: "f" })).toThrow(/room_not_found/);
  });

  it("投资记录：同机构+公司+轮次+日期去重；未公开票面存 null", () => {
    const svc = service();
    const a = svc.upsertInvestment({
      institutionRoomId: "inst-1",
      portfolioCompany: "某AI项目",
      round: "A",
      investedOn: "2025-06",
      role: "lead",
      ticketSize: 3000,
      ticketCurrency: "CNY",
      relationToPortfolio: "synergy",
      projectRoomId: "proj-1",
    });
    const b = svc.upsertInvestment({
      institutionRoomId: "inst-1",
      portfolioCompany: "某AI项目",
      round: "A",
      investedOn: "2025-06",
    });
    expect(b.id).toBe(a.id);
    expect(b.role).toBe("lead"); // 去重命中保留原值

    const undisclosed = svc.upsertInvestment({
      institutionRoomId: "inst-1",
      portfolioCompany: "某公司",
      round: "B",
    });
    expect(undisclosed.ticketSize).toBeNull();
    expect(undisclosed.role).toBe("unknown");

    expect(svc.listInvestments("inst-1")).toHaveLength(2);
    expect(svc.investmentsInCompany("某AI项目")).toHaveLength(1);
  });

  it("任职：kind 双向校验、icMember/canLead 落库、按机构/人物双侧查询", () => {
    const svc = service();
    const pos = svc.upsertPosition({
      personRoomId: "person-1",
      institutionRoomId: "inst-1",
      title: "合伙人",
      fromYear: 2018,
      icMember: true,
      canLead: true,
      sectors: ["AI应用", "企业软件"],
    });
    expect(pos.icMember).toBe(true);
    expect(pos.sectors).toEqual(["AI应用", "企业软件"]);

    // 同人物+机构+职位幂等
    const again = svc.upsertPosition({ personRoomId: "person-1", institutionRoomId: "inst-1", title: "合伙人", toYear: 2024 });
    expect(again.id).toBe(pos.id);
    expect(again.toYear).toBe(2024);

    expect(svc.listPositionsByInstitution("inst-1")).toHaveLength(1);
    expect(svc.listPositionsByPerson("person-1")).toHaveLength(1);

    // 项目房不能当任职方
    expect(() => service().upsertPosition({ personRoomId: "person-1", institutionRoomId: "proj-1", title: "x" }))
      .toThrow(/room_kind_mismatch/);
  });
});
