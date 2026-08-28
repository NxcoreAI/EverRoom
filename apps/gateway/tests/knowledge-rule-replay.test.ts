import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { roomSourceMemberships, routeDecisions, routingRules, rooms } from "../src/infrastructure/database/schema.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** nango 直传的 sourceId 形态：connector:<provider>:<connectionId>:<kind>:<documentId>。 */
const schoolEvent = (id: string) => `connector:google-calendar:conn-1:calendar-event:${id}`;

function seedDecision(
  db: ReturnType<typeof createDatabase>["db"],
  input: {
    id: string;
    sourceId: string;
    title: string;
    markdown?: string;
    primaryRoomId?: string | null;
    at: Date;
  },
) {
  db.insert(routeDecisions).values({
    id: input.id,
    sourceKind: "calendar-event",
    sourceId: input.sourceId,
    sourceVersion: 1,
    sourceTitle: input.title,
    sourceMarkdown: input.markdown ?? "",
    // linked 出口：只挂弱实体，primaryRoomId 为空 → 无 room membership（回填的靶子）。
    primaryRoomId: input.primaryRoomId ?? null,
    confidence: 0.6,
    status: input.primaryRoomId ? "auto" : "linked",
    createdAt: input.at,
    updatedAt: input.at,
  }).run();
}

async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-rule-replay-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new KnowledgeService(db, {
    baseUrl: "http://127.0.0.1:9",
    serviceId: "everroom",
    teamId: "everroom",
    dataDir,
    roomWikisEnabled: true,
    ingestDebounceMs: 600_000,
    routerEnabled: true,
    entityPromoteScore: 2,
    entityPromoteSources: 2,
    mergeAutoDice: 0.75,
    mergeJudgeDice: 0.6,
    llm: null,
    embeddingLlm: null,
    embeddingModel: "",
  }, { info: () => {}, warn: () => {}, error: () => {} });

  db.insert(rooms).values({ id: "room-school", title: "College Life", kind: "生活" }).run();

  return { service, db, sqlite };
}

describe("replayRoutingRule（规则层存量回填）", () => {
  it("把 linked 的连接器来源按 sourceTag 规则回填进目标 Room，幂等且投影 membership", async () => {
    const { service, db, sqlite } = await serviceForTest();
    const rule = service.createRule({
      matcher: { sourceTag: "connector:google-calendar:conn-1" },
      targetRoomId: "room-school",
    });
    expect(rule).toEqual({ ok: true, id: expect.any(String) });
    const ruleId = rule.ok ? rule.id : "";

    const at = new Date();
    seedDecision(db, { id: "rd-ev-1", sourceId: schoolEvent("ev-1"), title: "高等数学课", at });
    seedDecision(db, { id: "rd-ev-2", sourceId: schoolEvent("ev-2"), title: "小组讨论", at });
    // 不同连接（sourceTag 不匹配）：不应被回填。
    seedDecision(db, {
      id: "rd-ev-other",
      sourceId: "connector:google-calendar:conn-2:calendar-event:ev-3",
      title: "其他日历事件",
      at,
    });
    // 最新决策已归房：幂等跳过。
    seedDecision(db, {
      id: "rd-ev-done",
      sourceId: schoolEvent("ev-done"),
      title: "已归房事件",
      primaryRoomId: "room-school",
      at,
    });

    service.start();

    const first = service.replayRoutingRule(ruleId);
    expect(first).toEqual({ ok: true, matched: 2, replayed: 2 });

    // 命中的来源落 rule/execute 决策（decidedBy=rule、primaryRoomId=目标房）。
    for (const id of ["ev-1", "ev-2"]) {
      const latest = db.select().from(routeDecisions)
        .where(eq(routeDecisions.sourceId, schoolEvent(id)))
        .all()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;
      expect(latest.decidedBy).toBe("rule");
      expect(latest.primaryRoomId).toBe("room-school");
      expect(latest.status).toBe("auto");
    }

    // 排队 relation-index job → worker 消费后写 room membership（Room 投影的数据源）。
    // ev-done 是预置的 execute 决策，start() 的存量对账也会补投影，一并入列。
    await vi.waitFor(() => {
      const memberships = db.select().from(roomSourceMemberships)
        .where(eq(roomSourceMemberships.roomId, "room-school")).all();
      expect(memberships.map((row) => row.sourceId).sort()).toEqual([
        schoolEvent("ev-1"),
        schoolEvent("ev-2"),
        schoolEvent("ev-done"),
      ]);
    });

    // 幂等：重跑只看最新决策，已归房的来源不再命中。
    const second = service.replayRoutingRule(ruleId);
    expect(second).toEqual({ ok: true, matched: 0, replayed: 0 });
    expect(db.select().from(routeDecisions).where(eq(routeDecisions.sourceId, schoolEvent("ev-1"))).all())
      .toHaveLength(2);

    service.dispose();
    sqlite.close();
  });

  it("规则不存在 / 禁用 / 匹配器不可重放时返回错误", async () => {
    const { service, db, sqlite } = await serviceForTest();

    expect(service.replayRoutingRule("nope")).toEqual({ ok: false, error: "rule_not_found" });

    const replayable = service.createRule({ matcher: { threadId: "thread-1" }, targetRoomId: "room-school" });
    expect(replayable).toEqual({ ok: true, id: expect.any(String) });
    expect(service.replayRoutingRule(replayable.ok ? replayable.id : ""))
      .toEqual({ ok: false, error: "matcher_not_replayable" });

    const disabled = service.createRule({ matcher: { sourceTag: "connector:x:y" }, targetRoomId: "room-school" });
    const disabledId = disabled.ok ? disabled.id : "";
    db.update(routingRules).set({ enabled: false }).where(eq(routingRules.id, disabledId)).run();
    expect(service.replayRoutingRule(disabledId)).toEqual({ ok: false, error: "rule_disabled" });

    service.dispose();
    sqlite.close();
  });

  it("titleKeyword 匹配器按决策快照标题过滤回填范围", async () => {
    const { service, db, sqlite } = await serviceForTest();
    const rule = service.createRule({
      matcher: { sourceTag: "connector:google-calendar:conn-1", titleKeyword: "讨论" },
      targetRoomId: "room-school",
    });
    const ruleId = rule.ok ? rule.id : "";
    const at = new Date();
    seedDecision(db, { id: "rd-hit", sourceId: schoolEvent("ev-hit"), title: "小组讨论会", at });
    seedDecision(db, { id: "rd-miss", sourceId: schoolEvent("ev-miss"), title: "高等数学课", at });

    const result = service.replayRoutingRule(ruleId);
    expect(result).toEqual({ ok: true, matched: 1, replayed: 1 });

    const hit = db.select().from(routeDecisions)
      .where(eq(routeDecisions.sourceId, schoolEvent("ev-hit"))).all();
    expect(hit).toHaveLength(2);
    const miss = db.select().from(routeDecisions)
      .where(eq(routeDecisions.sourceId, schoolEvent("ev-miss"))).all();
    expect(miss).toHaveLength(1);

    service.dispose();
    sqlite.close();
  });

  it("calendarId 匹配器从决策快照组织者行做日历级回填：同连接只归因目标日历", async () => {
    const { service, db, sqlite } = await serviceForTest();
    const rule = service.createRule({
      matcher: { sourceTag: "connector:google-calendar:conn-1", calendarId: "danielfbaby@yahoo.com" },
      targetRoomId: "room-school",
    });
    const ruleId = rule.ok ? rule.id : "";
    const at = new Date();
    // 个人日历事件（组织者 = 日历 id）：命中。
    seedDecision(db, {
      id: "rd-personal",
      sourceId: schoolEvent("ev-personal"),
      title: "学校开学",
      markdown: "# 学校开学\n\n组织者：Daniel <danielfbaby@yahoo.com>\n\n地点：教学楼",
      at,
    });
    // 同一条连接上 Google 自动订阅的假日日历（组织者 = 假日日历地址）：不命中。
    seedDecision(db, {
      id: "rd-holiday",
      sourceId: schoolEvent("ev-holiday"),
      title: "New Year's Day",
      markdown: "# New Year's Day\n\n组织者：美国节假日 <zh-cn.usa.official#holiday@group.v.calendar.google.com>",
      at,
    });
    // 无组织者行的旧快照：日历未知，保守不命中。
    seedDecision(db, { id: "rd-bare", sourceId: schoolEvent("ev-bare"), title: "旧事件", at });

    const result = service.replayRoutingRule(ruleId);
    expect(result).toEqual({ ok: true, matched: 1, replayed: 1 });

    expect(db.select().from(routeDecisions)
      .where(eq(routeDecisions.sourceId, schoolEvent("ev-personal"))).all()).toHaveLength(2);
    expect(db.select().from(routeDecisions)
      .where(eq(routeDecisions.sourceId, schoolEvent("ev-holiday"))).all()).toHaveLength(1);
    expect(db.select().from(routeDecisions)
      .where(eq(routeDecisions.sourceId, schoolEvent("ev-bare"))).all()).toHaveLength(1);

    service.dispose();
    sqlite.close();
  });
});
