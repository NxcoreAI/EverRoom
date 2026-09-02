import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  contextRooms,
  documents,
  entities,
  roomContextCorrections,
  roomDocumentLinks,
  roomEntityFacts,
  roomEntityMentions,
  roomLocalActions,
  roomSourceMemberships,
} from "../src/infrastructure/database/schema.js";
import { createContextRoomAgentTools } from "../src/modules/context-rooms/room-agent-tools.js";
import {
  MAX_DOCUMENTS,
  PER_DOCUMENT_MARKDOWN_LIMIT,
  TOTAL_MARKDOWN_LIMIT,
  buildRoomContextDigest,
  formatRoomContextDigest,
} from "../src/modules/context-rooms/room-context-digest.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];

async function setup(): Promise<DatabaseClient> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-room-context-digest-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return database;
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    try {
      database.sqlite.close();
    } catch {
      // already closed
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
});

function documentContent(text: string) {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function seedDocument(
  database: DatabaseClient,
  id: string,
  roomId: string,
  title: string,
  text: string,
  updatedAt: Date,
): void {
  const contentJson = documentContent(text);
  database.db.insert(documents).values({
    id,
    title,
    contentJson,
    contentSchemaVersion: 3,
    version: 1,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
  }).run();
  database.db.insert(roomDocumentLinks).values({ roomId, documentId: id, linkedAt: updatedAt }).run();
}

/** 房间头 + 两篇文档（其一超单篇预算）+ 事实（联 sourceTitle）+ 实体 + 已应用纠正 + 本地待办。 */
function seedRoom(database: DatabaseClient): void {
  const now = new Date();
  database.db.insert(contextRooms).values({
    id: "room-1",
    title: "示例项目 Room",
    kind: "项目",
    data: {
      brief: { background: "项目已启动", goal: "完成一期交付" },
      timeline: [{ text: "项目启动", at: "2026-08-01" }],
    },
    createdAt: now,
    updatedAt: now,
  }).run();
  seedDocument(database, "doc-1", "room-1", "活动登记表", "社团已登记，负责人已确认场地。", new Date("2026-08-20T00:00:00Z"));
  seedDocument(
    database,
    "doc-2",
    "room-1",
    "超长会议纪要",
    "长".repeat(PER_DOCUMENT_MARKDOWN_LIMIT + 500),
    new Date("2026-08-21T00:00:00Z"),
  );
  database.db.insert(roomSourceMemberships).values({
    id: "membership-1",
    roomId: "room-1",
    sourceKind: "everroom-doc",
    sourceId: "doc-1",
    sourceVersion: 1,
    sourceTitle: "活动登记表",
    evidenceGroupKey: "eg-doc-1",
    role: "primary",
  }).run();
  database.db.insert(roomEntityFacts).values({
    id: "fact-row-1",
    roomId: "room-1",
    factId: "fact-1",
    content: "社团已登记",
    sourceKind: "everroom-doc",
    sourceId: "doc-1",
    sourceVersion: 1,
  }).run();
  database.db.insert(entities).values({ id: "entity-1", name: "示例社团", kind: "主题" }).run();
  database.db.insert(roomEntityMentions).values({
    id: "mention-1",
    roomId: "room-1",
    entityId: "entity-1",
    sourceKind: "everroom-doc",
    sourceId: "doc-1",
    sourceVersion: 1,
    evidenceGroupKey: "eg-doc-1",
    evidence: "社团已登记",
  }).run();
  database.db.insert(roomContextCorrections).values({
    id: "correction-1",
    roomId: "room-1",
    operation: "fact_correct",
    section: "overview",
    originalText: "社团未登记",
    replacementText: "社团已登记",
    rationale: "以活动登记表为准",
    status: "applied",
    entryPoint: "agent",
  }).run();
  database.db.insert(roomLocalActions).values({
    id: "action-1",
    roomId: "room-1",
    kind: "task",
    title: "确认场地",
    createdBy: "agent",
  }).run();
}

describe("buildRoomContextDigest 共享投影", () => {
  it("预算常量与原 room_context_get 实现一致", () => {
    expect(PER_DOCUMENT_MARKDOWN_LIMIT).toBe(12_000);
    expect(TOTAL_MARKDOWN_LIMIT).toBe(80_000);
    expect(MAX_DOCUMENTS).toBe(30);
  });

  it("覆盖房间头、文档（单篇预算截断）、事实（联 sourceTitle）、纠正与本地待办", async () => {
    const database = await setup();
    seedRoom(database);
    const digest = buildRoomContextDigest(database.db, "room-1");

    expect(digest.roomId).toBe("room-1");
    expect(digest.room).toMatchObject({
      title: "示例项目 Room",
      kind: "项目",
      brief: { background: "项目已启动", goal: "完成一期交付" },
      timeline: [{ text: "项目启动", at: "2026-08-01" }],
    });
    expect(digest.documentCount).toBe(2);
    // 按 updatedAt 倒序：超长文档在前，单篇预算截断。
    expect(digest.documents[0]).toMatchObject({ documentId: "doc-2", title: "超长会议纪要", truncated: true });
    expect(digest.documents[0]!.markdown).toContain("…（已截断）");
    expect(digest.documents[0]!.markdown.length).toBeLessThanOrEqual(PER_DOCUMENT_MARKDOWN_LIMIT + 20);
    expect(digest.documents[1]).toMatchObject({
      documentId: "doc-1",
      title: "活动登记表",
      markdown: expect.stringContaining("社团已登记，负责人已确认场地。"),
      truncated: false,
    });
    expect(digest.truncatedDocuments).toBe(1);
    expect(digest.facts).toHaveLength(1);
    expect(digest.facts[0]).toMatchObject({
      factId: "fact-1",
      content: "社团已登记",
      sourceKind: "everroom-doc",
      sourceId: "doc-1",
      sourceTitle: "活动登记表",
    });
    expect(typeof digest.facts[0]!.updatedAt).toBe("string");
    expect(digest.entities).toHaveLength(1);
    expect(digest.entities[0]).toMatchObject({ id: "entity-1", name: "示例社团", evidence: "社团已登记" });
    expect(digest.appliedCorrections).toHaveLength(1);
    expect(digest.appliedCorrections[0]).toMatchObject({
      operation: "fact_correct",
      section: "overview",
      originalText: "社团未登记",
      replacementText: "社团已登记",
      rationale: "以活动登记表为准",
    });
    expect(digest.localActions).toHaveLength(1);
    expect(digest.localActions[0]).toMatchObject({ id: "action-1", kind: "task", title: "确认场地" });
  });

  it("总量预算生效：多篇超长文档合计不超过 TOTAL_MARKDOWN_LIMIT", async () => {
    const database = await setup();
    const now = new Date();
    database.db.insert(contextRooms).values({
      id: "room-2",
      title: "预算 Room",
      kind: "主题",
      data: {},
      createdAt: now,
      updatedAt: now,
    }).run();
    for (let index = 0; index < 7; index += 1) {
      seedDocument(
        database,
        `doc-long-${index}`,
        "room-2",
        `文档 ${index}`,
        "料".repeat(PER_DOCUMENT_MARKDOWN_LIMIT + 500),
        new Date(2026, 0, index + 1),
      );
    }
    const digest = buildRoomContextDigest(database.db, "room-2");
    expect(digest.documentCount).toBe(7);
    expect(digest.truncatedDocuments).toBe(7);
    const total = digest.documents.reduce((sum, document) => sum + document.markdown.length, 0);
    expect(total).toBeLessThanOrEqual(TOTAL_MARKDOWN_LIMIT + 7 * 20);
    expect(digest.documents.at(-1)!.markdown.length).toBeLessThan(PER_DOCUMENT_MARKDOWN_LIMIT);
  });

  it("房间缺失或 roomId 为空时抛对应错误", async () => {
    const database = await setup();
    expect(() => buildRoomContextDigest(database.db, "missing-room")).toThrow("context_room_not_found");
    expect(() => buildRoomContextDigest(database.db, "   ")).toThrow("room_context_room_id_required");
  });
});

describe("room_context_get 工具经共享投影后返回结构不变", () => {
  it("content 与 buildRoomContextDigest 同构，details 保留 roomId/count", async () => {
    const database = await setup();
    seedRoom(database);
    const tools = createContextRoomAgentTools({
      db: database.db,
      memory: null,
      overview: null as never,
    });
    const roomContextGet = tools.find((tool) => tool.name === "room_context_get")!;
    const result = await roomContextGet.execute({} as never, { roomId: "room-1" } as never);
    const digest = buildRoomContextDigest(database.db, "room-1");
    expect(JSON.parse((result as { content: string }).content)).toEqual(digest);
    expect((result as { details: Record<string, unknown> }).details).toEqual({
      roomId: "room-1",
      count: 2,
      isRecord: true,
    });
    await expect(
      roomContextGet.execute({} as never, { roomId: "missing-room" } as never),
    ).rejects.toThrow("context_room_not_found");
  });
});

describe("formatRoomContextDigest 投喂文本组装", () => {
  it("包含房间头、文档 markdown（标注截断）与事实清单逐条", async () => {
    const database = await setup();
    seedRoom(database);
    const text = formatRoomContextDigest(buildRoomContextDigest(database.db, "room-1"));
    expect(text).toContain("【Room】示例项目 Room");
    expect(text).toContain("类型：项目");
    expect(text).toContain("- background：项目已启动");
    expect(text).toContain("- goal：完成一期交付");
    expect(text).toContain("- {\"text\":\"项目启动\",\"at\":\"2026-08-01\"}");
    expect(text).toContain("【文档】共 2 篇（其中 1 篇因预算截断）");
    expect(text).toContain("### 活动登记表（版本 v1");
    expect(text).toContain("社团已登记，负责人已确认场地。");
    expect(text).toContain("### 超长会议纪要（版本 v1");
    expect(text).toContain("已截断");
    expect(text).toContain("【结构化事实】");
    expect(text).toContain("- 社团已登记（来源：活动登记表）");
    expect(text).toContain("【实体】");
    expect(text).toContain("【已应用纠正】");
    expect(text).toContain("fact_correct/overview：「社团未登记」→「社团已登记」");
    expect(text).toContain("【本地待办/日程】");
    expect(text).toContain("- [task] 确认场地");
  });
});

describe("context-room input schema 不再接受 material-analysis", () => {
  const schema = JSON.parse(readFileSync(
    resolve("..", "..", "agents", "context-room", "schemas", "input.schema.json"),
    "utf8",
  )) as { properties: { task: { enum: string[] } } };

  it("task 枚举已移除 material-analysis，保留其余四类", () => {
    expect(schema.properties.task.enum).not.toContain("material-analysis");
    expect(schema.properties.task.enum).toEqual(["room-enrich", "room-overview", "brief-refresh", "selection-rewrite"]);
  });

  it("material-analysis 校验失败，既有任务通过", () => {
    const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
    expect(validate({ task: "material-analysis", roomId: "room-1" })).toBe(false);
    expect(validate({ task: "room-overview", roomId: "room-1" })).toBe(true);
    expect(validate({ task: "selection-rewrite", selectedText: "原文" })).toBe(true);
  });
});
