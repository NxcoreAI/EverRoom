import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { roomSourceMemberships, routeDecisions } from "../src/infrastructure/database/schema.js";
import type { KnowledgeLlm, RoomContextResult } from "../src/modules/knowledge/llm.js";
import { KnowledgeService } from "../src/modules/knowledge/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

/** 真实 sqlite（临时目录）+ summarizeRoom 桩：只验证生成输入/输出装配，不触达外部 LLM。 */
async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-room-context-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new KnowledgeService(
    db,
    {
      baseUrl: "http://127.0.0.1:9",
      serviceId: "everroom",
      teamId: "everroom",
      dataDir,
      roomWikisEnabled: false,
      ingestDebounceMs: 600_000,
      routerEnabled: true,
      entityPromoteScore: 2.0,
      entityPromoteSources: 2,
      mergeAutoDice: 0.75,
      mergeJudgeDice: 0.6,
      llm: null,
      embeddingLlm: null,
      embeddingModel: "",
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
  const calls: Array<{ roomTitle: string; documents: Array<{ title: string; markdown: string; label?: string }> }> = [];
  let response: RoomContextResult = {
    overview: "概览",
    status: "状态",
    nextSteps: [],
    entities: [],
    actionItems: [],
    meetings: [],
  };
  const llm = {
    summarizeRoom: async (roomTitle: string, documents: Array<{ title: string; markdown: string; label?: string }>) => {
      calls.push({ roomTitle, documents });
      return response;
    },
  } as unknown as KnowledgeLlm;
  (service as unknown as { llm: KnowledgeLlm | null }).llm = llm;
  return {
    service, db, sqlite, calls,
    respond(next: RoomContextResult) { response = next; },
  };
}

function seedMembership(
  db: ReturnType<typeof createDatabase>["db"],
  input: { roomId: string; kind: "mail" | "calendar-event" | "cloud-doc" | "todo"; sourceId: string; version?: number },
) {
  db.insert(roomSourceMemberships).values({
    id: `mem-${input.sourceId}`,
    roomId: input.roomId,
    sourceKind: input.kind,
    sourceId: input.sourceId,
    sourceVersion: input.version ?? 1,
    evidenceGroupKey: `eg-${input.sourceId}`,
    role: "primary",
    effectiveWeight: 1,
    qualityLevel: "normal",
    trusted: true,
  }).run();
}

function seedDecision(
  db: ReturnType<typeof createDatabase>["db"],
  input: {
    kind: "mail" | "calendar-event" | "cloud-doc" | "todo";
    sourceId: string;
    version: number;
    title: string;
    markdown: string;
    at: Date;
  },
) {
  db.insert(routeDecisions).values({
    id: `rd-${input.sourceId}-v${input.version}`,
    sourceKind: input.kind,
    sourceId: input.sourceId,
    sourceVersion: input.version,
    sourceTitle: input.title,
    sourceMarkdown: input.markdown,
    confidence: 0.9,
    status: "auto",
    createdAt: input.at,
    updatedAt: input.at,
  }).run();
}

describe("roomContext 生成纳入已路由的连接器来源（邮件/日历）", () => {
  it("来源正文与标签进入生成输入；日程/待办按 sourceTitle 过滤后保留；响应带 sourceConnectors", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-x", title: "卫星项目" });
    const early = new Date(Date.now() - 60_000);
    seedMembership(test.db, { roomId: "room-x", kind: "calendar-event", sourceId: "ev-1", version: 2 });
    seedMembership(test.db, { roomId: "room-x", kind: "mail", sourceId: "m-1", version: 2 });
    seedMembership(test.db, { roomId: "room-x", kind: "cloud-doc", sourceId: "cd-1" });
    seedDecision(test.db, { kind: "calendar-event", sourceId: "ev-1", version: 1, title: "评审会(旧)", markdown: "# 旧版正文", at: early });
    seedDecision(test.db, { kind: "calendar-event", sourceId: "ev-1", version: 2, title: "评审会", markdown: "# 评审会 v2\n\n时间：明天 10:00", at: new Date() });
    seedDecision(test.db, { kind: "mail", sourceId: "m-1", version: 2, title: "评审意见邮件", markdown: "# 请回复评审意见", at: early });
    seedDecision(test.db, { kind: "cloud-doc", sourceId: "cd-1", version: 1, title: "外部文档", markdown: "# 不参与", at: early });
    test.respond({
      overview: "概览", status: "状态", nextSteps: [],
      entities: [],
      actionItems: [
        { title: "回复评审意见", owner: null, dueDate: null, sourceTitle: "评审意见邮件" },
        { title: "幽灵条目", owner: null, dueDate: null, sourceTitle: "不存在的来源" },
      ],
      meetings: [{ title: "评审会", when: "明天 10:00", participants: ["张三"], sourceTitle: "评审会" }],
    });

    const context = await test.service.roomContext("room-x");
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]!.roomTitle).toBe("卫星项目");
    expect(test.calls[0]!.documents).toEqual([
      { title: "评审会", markdown: "# 评审会 v2\n\n时间：明天 10:00", label: "日历事件" },
      { title: "评审意见邮件", markdown: "# 请回复评审意见", label: "邮件" },
    ]);
    expect(context.actionItems).toEqual([
      { title: "回复评审意见", owner: null, dueDate: null, sourceTitle: "评审意见邮件" },
    ]);
    expect(context.meetings).toEqual([
      { title: "评审会", when: "明天 10:00", participants: ["张三"], sourceTitle: "评审会" },
    ]);
    expect(context.sourceConnectors).toEqual([
      { sourceKind: "calendar-event", sourceId: "ev-1", version: 2, title: "评审会" },
      { sourceKind: "mail", sourceId: "m-1", version: 2, title: "评审意见邮件" },
    ]);
    test.sqlite.close();
  });

  it("待办（kind todo）同样进入生成输入（标签「待办」）与 sourceConnectors", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-x", title: "卫星项目" });
    seedMembership(test.db, { roomId: "room-x", kind: "todo", sourceId: "td-1", version: 1 });
    seedDecision(test.db, {
      kind: "todo", sourceId: "td-1", version: 1, title: "补充天线参数",
      markdown: "# 补充天线参数\n\n## 待办信息\n\n- 状态：needsAction\n- 截止：2026-09-01", at: new Date(),
    });

    const context = await test.service.roomContext("room-x");
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]!.documents).toEqual([
      { title: "补充天线参数", markdown: expect.stringContaining("待办信息"), label: "待办" },
    ]);
    expect(context.sourceConnectors).toEqual([
      { sourceKind: "todo", sourceId: "td-1", version: 1, title: "补充天线参数" },
    ]);
    test.sqlite.close();
  });

  it("缓存键纳入连接器来源版本：未变化不重调，决策出新版后重生成", async () => {
    const test = await serviceForTest();
    test.service.upsertRoom({ id: "room-x", title: "卫星项目" });
    const early = new Date(Date.now() - 60_000);
    seedMembership(test.db, { roomId: "room-x", kind: "calendar-event", sourceId: "ev-1", version: 1 });
    seedDecision(test.db, { kind: "calendar-event", sourceId: "ev-1", version: 1, title: "评审会", markdown: "# v1", at: early });

    await test.service.roomContext("room-x");
    await test.service.roomContext("room-x");
    expect(test.calls).toHaveLength(1);
    expect(test.calls[0]!.documents[0]!.markdown).toBe("# v1");

    seedDecision(test.db, { kind: "calendar-event", sourceId: "ev-1", version: 2, title: "评审会", markdown: "# v2", at: new Date() });
    const refreshed = await test.service.roomContext("room-x");
    expect(test.calls).toHaveLength(2);
    expect(test.calls[1]!.documents[0]!.markdown).toBe("# v2");
    expect(refreshed.sourceConnectors[0]).toMatchObject({ version: 2 });
    test.sqlite.close();
  });

  it("无 LLM 时不生成但仍列出连接器来源（前端可见计数）", async () => {
    const test = await serviceForTest();
    (test.service as unknown as { llm: KnowledgeLlm | null }).llm = null;
    test.service.upsertRoom({ id: "room-x", title: "卫星项目" });
    seedMembership(test.db, { roomId: "room-x", kind: "mail", sourceId: "m-1" });
    seedDecision(test.db, { kind: "mail", sourceId: "m-1", version: 1, title: "评审意见邮件", markdown: "# 正文", at: new Date() });

    const context = await test.service.roomContext("room-x");
    expect(test.calls).toHaveLength(0);
    expect(context.meetings).toEqual([]);
    expect(context.sourceConnectors).toEqual([
      { sourceKind: "mail", sourceId: "m-1", version: 1, title: "评审意见邮件" },
    ]);
    test.sqlite.close();
  });
});
