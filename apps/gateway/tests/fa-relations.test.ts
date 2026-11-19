/**
 * FA 实体级语义关系（fa-industry-iteration 工作项一：语义关系自动抽取）。
 * 覆盖：llm.ts 关系解析（方向/类别校验、去重、上限）→ store 候选落库与
 * 指纹跳过 → 确认投影房边 → 实体合并迁移 → 晋升回填。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  entities,
  faRelations,
  roomRelations,
  rooms,
} from "../src/infrastructure/database/schema.js";
import { FaRelationStore } from "../src/modules/knowledge/fa-relations.js";
import { parseExtractionResponse } from "../src/modules/knowledge/llm.js";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";

let root: string;
let db: GatewayDatabase;
let sqlite: ReturnType<typeof createDatabase>["sqlite"];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fa-relations-test-"));
  const created = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  db = created.db;
  sqlite = created.sqlite;
});

afterAll(async () => {
  sqlite.close();
  await rm(root, { recursive: true, force: true });
});

const silentLogger = { info: () => {}, warn: () => {} };
const store = () => new FaRelationStore(db, silentLogger);

function seedEntity(id: string, name: string, kind: typeof entities.$inferInsert["kind"], roomId?: string) {
  const values: typeof entities.$inferInsert = {
    id, name, kind, status: roomId ? "room" : "weak", ...(roomId ? { roomId } : {}),
  };
  db.insert(entities).values(values).onConflictDoNothing().run();
}

function seedRoom(id: string, title: string, kind: string) {
  db.insert(rooms).values({ id, title, kind, origin: "user" }).onConflictDoNothing().run();
}

describe("parseExtractionResponse：FA 关系段", () => {
  const base = JSON.stringify({
    summary: "测试资料",
    entities: [
      { name: "沈屿", kind: "人物", salience: 0.9, evidence: "创始人沈屿" },
      { name: "星析科技", kind: "项目", salience: 1.0, evidence: "本项目围绕星析科技" },
      { name: "峰瑞远帆", kind: "机构", salience: 0.8, evidence: "峰瑞远帆领投" },
    ],
    facts: [],
  });

  it("解析合法关系：founder_of 带头衔与年份", () => {
    const result = parseExtractionResponse(`${base.slice(0, -1)},"relations":[
      {"type":"founder_of","subject":"沈屿","object":"星析科技","title":"CEO","from":2019,
       "evidence":"沈屿于2019年创立星析科技"}
    ]}`);
    expect(result.relations).toHaveLength(1);
    expect(result.relations[0]).toMatchObject({
      type: "founder_of", subject: "沈屿", object: "星析科技",
      title: "CEO", from: 2019,
    });
  });

  it("方向反了丢弃：项目 founder_of 人物（subject 应为人物）", () => {
    const result = parseExtractionResponse(`${base.slice(0, -1)},"relations":[
      {"type":"founder_of","subject":"星析科技","object":"沈屿","evidence":"星析科技由沈屿创立"}
    ]}`);
    expect(result.relations).toHaveLength(0);
  });

  it("类别不符丢弃：机构 employed_by 机构（subject 应为人物）", () => {
    const result = parseExtractionResponse(`${base.slice(0, -1)},"relations":[
      {"type":"employed_by","subject":"峰瑞远帆","object":"星析科技","evidence":"无效组合"}
    ]}`);
    expect(result.relations).toHaveLength(0);
  });

  it("端点不在 entities 里丢弃：subject 未注册", () => {
    const result = parseExtractionResponse(`${base.slice(0, -1)},"relations":[
      {"type":"invested_in","subject":"峰瑞远帆","object":"棱镜检测","evidence":"不在实体表"}
    ]}`);
    expect(result.relations).toHaveLength(0);
  });

  it("同三元组去重；缺 evidence 丢弃；无 relations 段给空数组", () => {
    const dup = parseExtractionResponse(`${base.slice(0, -1)},"relations":[
      {"type":"employed_by","subject":"沈屿","object":"峰瑞远帆","evidence":"第一条"},
      {"type":"employed_by","subject":"沈屿","object":"峰瑞远帆","evidence":"重复"},
      {"type":"partner_of","subject":"沈屿","object":"星析科技","evidence":""}
    ]}`);
    expect(dup.relations).toHaveLength(1);
    expect(dup.relations[0]!.evidence).toBe("第一条");

    const none = parseExtractionResponse(base);
    expect(none.relations).toEqual([]);
  });
});

describe("FaRelationStore：候选 → 确认 → 投影", () => {
  it("候选落库与指纹跳过", () => {
    seedEntity("ent-shen", "沈屿", "人物");
    seedEntity("ent-xingxi", "星析科技", "项目");
    const s = store();
    const inserted = s.ingestCandidates([
      { type: "founder_of", subjectEntityId: "ent-shen", objectEntityId: "ent-xingxi", title: "CEO", fromYear: 2019,
        sourceKind: "file", sourceId: "src-1", evidence: "沈屿于2019年创立星析科技" },
    ]);
    expect(inserted).toBe(1);
    // 同三元组重放：跳过
    const again = s.ingestCandidates([
      { type: "founder_of", subjectEntityId: "ent-shen", objectEntityId: "ent-xingxi", evidence: "重复陈述" },
    ]);
    expect(again).toBe(0);
    const pending = s.list("pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.subjectName).toBe("沈屿");
    expect(pending[0]!.objectName).toBe("星析科技");
  });

  it("确认：两端未晋升 → 只确认不投影房边", () => {
    const s = store();
    const row = s.list("pending")[0]!;
    const confirmed = s.confirm(row.id, "tester");
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.roomRelationId).toBeNull();
  });

  it("晋升回填后确认：两端齐 → 投影类型化房边（manualType=founder_of）", () => {
    seedRoom("room-shen", "沈屿", "人物");
    seedRoom("room-xingxi", "星析科技", "项目");
    db.update(entities).set({ status: "room", roomId: "room-shen" }).where(eq(entities.id, "ent-shen")).run();
    db.update(entities).set({ status: "room", roomId: "room-xingxi" }).where(eq(entities.id, "ent-xingxi")).run();
    const s = store();
    s.backfillRoomIds("ent-shen", "room-shen");
    s.backfillRoomIds("ent-xingxi", "room-xingxi");

    // 新候选走完整链路：入职关系（峰瑞→星析 invested_in）
    seedEntity("ent-fengrui", "峰瑞远帆", "机构", "room-fengrui");
    seedRoom("room-fengrui", "峰瑞远帆", "机构");
    s.backfillRoomIds("ent-fengrui", "room-fengrui");
    const inserted = s.ingestCandidates([
      { type: "invested_in", subjectEntityId: "ent-fengrui", objectEntityId: "ent-xingxi",
        round: "B轮", role: "lead", evidence: "峰瑞远帆领投星析科技B轮" },
    ]);
    expect(inserted).toBe(1);
    const row = s.list("pending").find((item) => item.type === "invested_in")!;
    const confirmed = s.confirm(row.id, "tester");
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.roomRelationId).toBeTruthy();

    const edge = db.select().from(roomRelations)
      .where(eq(roomRelations.id, confirmed!.roomRelationId!)).get();
    expect(edge?.manualType).toBe("invested_in");
    // 方向：manualFrom（投资方）→ manualTo（项目）
    expect(edge?.manualFromRoomId).toBe("room-fengrui");
    expect(edge?.manualToRoomId).toBe("room-xingxi");
  });

  it("dismiss：pending → dismissed，不再可确认", () => {
    seedEntity("ent-wang", "王铭", "人物");
    const s = store();
    s.ingestCandidates([
      { type: "introduced_by", subjectEntityId: "ent-xingxi", objectEntityId: "ent-wang",
        evidence: "王铭引荐了星析项目" },
    ]);
    const row = s.list("pending").find((item) => item.type === "introduced_by")!;
    const dismissed = s.dismiss(row.id);
    expect(dismissed?.status).toBe("dismissed");
    // 再确认幂等返回 dismissed 态
    const again = s.confirm(row.id, "tester");
    expect(again?.status).toBe("dismissed");
  });

  it("rewriteEntity：实体合并迁移行，撞唯一索引删除", () => {
    seedEntity("ent-shen-dup", "沈屿（重复）", "人物");
    const s = store();
    s.ingestCandidates([
      { type: "introduced_by", subjectEntityId: "ent-xingxi", objectEntityId: "ent-shen-dup",
        evidence: "重复实体上的介绍关系" },
    ]);
    // 合并 dup → 正身：该行应改指 ent-shen，与既有 introduced_by(xingxi→shen) 撞索引 → 删除
    s.rewriteEntity("ent-shen-dup", "ent-shen");
    const rows = db.select().from(faRelations)
      .where(eq(faRelations.objectEntityId, "ent-shen-dup")).all();
    expect(rows).toHaveLength(0);
    // 正身行仍在（此前 dismissed 的那条）
    const kept = db.select().from(faRelations)
      .where(and(
        eq(faRelations.type, "introduced_by"),
        eq(faRelations.objectEntityId, "ent-shen"),
      )).all();
    expect(kept).toHaveLength(1);
  });
});
