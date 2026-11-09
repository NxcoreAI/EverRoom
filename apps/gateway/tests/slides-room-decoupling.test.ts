import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import { Ajv } from "ajv";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  slidesPageImageSessions,
  slidesStoryboards,
  slidesStyleSessions,
} from "../src/infrastructure/database/schema.js";
import { SlidesStyleSessionStore } from "../src/modules/slides-style/style-session.js";
import type { EditorShadowReport, EditorStoryboard } from "../src/modules/subagents/slides-editor.js";
import { SlidesPageImageSessionStore } from "../src/modules/subagents/slides-page-images-store.js";
import { SlidesStoryboardStore } from "../src/modules/subagents/slides-storyboards-store.js";

/**
 * PPT（slides）链路去 Room 的回归钉子。
 *
 * 背景：桌面渲染层已无 Room（run.roomId 恒为 null），slides 子代理 input schema 也不再
 * 要求 roomId。三张会话表（slides_style_sessions / slides_page_image_sessions /
 * slides_storyboards）的 room_id 是 NOT NULL 历史列，本阶段不改 schema：写入统一填
 * WORKSPACE_DOCUMENT_CHANNEL（"__workspace__"），读路径只按 draftDocumentId / 会话 id 寻址。
 * 这里钉住两件事：
 * 1. 旧库里带真实 roomId 的行仍能被新 store 读到（升级后续跑不丢）；
 * 2. slides 三个子代理的 input schema 不再要求（也不接受）roomId。
 */

const databases: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];

async function setupDatabase(): Promise<DatabaseClient> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-slides-room-decoupling-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return database;
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const legacyStoryboard: EditorStoryboard = {
  schemaVersion: "storyboard/v2",
  deck: { title: "旧库 deck", spine: "从业绩到计划" },
  pages: [],
  warnings: [],
};

const legacyReport: EditorShadowReport = {
  draftHash: "legacy-hash",
  pageCount: 0,
  draftPageCount: 0,
  forms: [],
  proseChars: 0,
  copyChars: 0,
  draftPointsChars: 0,
  reductionPct: null,
  dropped: 0,
  passed: true,
  errors: [],
  warnings: [],
  pages: [],
};

describe("旧库兼容：三张 slides 会话表的冻结 room_id 列（单工作区读路径）", () => {
  it("带 room_id=legacy-room 的旧行仍能被新 store 读到；新写入行统一填工作区频道", async () => {
    const database = await setupDatabase();
    const legacyAt = new Date(Date.now() - 60_000);

    // ① 直接按旧库形态插入三张表的行（room_id 是真实房间 id，不是工作区频道）。
    database.db.insert(slidesStyleSessions).values({
      id: "legacy-style-session",
      roomId: "legacy-room",
      draftDocumentId: "legacy-draft",
      instruction: "旧库风格会话",
      stage: "images_ready",
      createdAt: legacyAt,
      updatedAt: legacyAt,
    }).run();
    database.db.insert(slidesStoryboards).values({
      id: "legacy-storyboard",
      roomId: "legacy-room",
      draftDocumentId: "legacy-draft",
      draftHash: "legacy-hash",
      storyboard: legacyStoryboard as unknown as Record<string, unknown>,
      report: legacyReport as unknown as Record<string, unknown>,
      createdAt: legacyAt,
      updatedAt: legacyAt,
    }).run();
    database.db.insert(slidesPageImageSessions).values({
      id: "legacy-page-images",
      roomId: "legacy-room",
      draftDocumentId: "legacy-draft",
      styleSessionId: "legacy-style-session",
      stage: "confirm",
      plan: { title: "旧库 deck", pages: [] },
      pages: [],
      stylePalette: null,
      createdAt: legacyAt,
      updatedAt: legacyAt,
    }).run();

    // ② 新 store 的读路径不按 room 过滤：按 draftDocumentId / 会话 id 寻址即可命中。
    const styleSessions = new SlidesStyleSessionStore(database.db);
    expect(styleSessions.byId("legacy-style-session")?.draftDocumentId).toBe("legacy-draft");
    expect(styleSessions.byDraftId("legacy-draft")?.id).toBe("legacy-style-session");
    expect(styleSessions.findActive()?.id).toBe("legacy-style-session");

    const storyboards = new SlidesStoryboardStore(database.db);
    expect(storyboards.byDraft("legacy-draft")?.id).toBe("legacy-storyboard");
    expect(storyboards.byDraftHash("legacy-draft", "legacy-hash")?.id).toBe("legacy-storyboard");

    const pageImages = new SlidesPageImageSessionStore(database.db);
    expect(pageImages.byDraftId("legacy-draft")?.id).toBe("legacy-page-images");

    // ③ 新写入行：三张表的 room_id 一律填 WORKSPACE_DOCUMENT_CHANNEL。
    const createdStyle = styleSessions.create({ draftDocumentId: "new-draft", instruction: "新会话" });
    const createdPageImages = pageImages.upsertForDraft({
      draftDocumentId: "new-draft",
      styleSessionId: createdStyle.id,
      plan: { title: "新 deck", pages: [] },
      pages: [],
      stylePalette: null,
    });
    const createdStoryboard = storyboards.save({
      draftDocumentId: "new-draft",
      draftHash: "new-hash",
      storyboard: legacyStoryboard,
      report: legacyReport,
    });

    const newStyleRow = database.db.select().from(slidesStyleSessions)
      .where(eq(slidesStyleSessions.id, createdStyle.id)).get();
    const newPageImagesRow = database.db.select().from(slidesPageImageSessions)
      .where(eq(slidesPageImageSessions.id, createdPageImages.id)).get();
    const newStoryboardRow = database.db.select().from(slidesStoryboards)
      .where(eq(slidesStoryboards.id, createdStoryboard.id)).get();
    expect(newStyleRow?.roomId).toBe(WORKSPACE_DOCUMENT_CHANNEL);
    expect(newPageImagesRow?.roomId).toBe(WORKSPACE_DOCUMENT_CHANNEL);
    expect(newStoryboardRow?.roomId).toBe(WORKSPACE_DOCUMENT_CHANNEL);
  });
});

describe("slides 子代理 input schema 不再要求 roomId", () => {
  const schemaOf = (agent: string): Record<string, unknown> =>
    JSON.parse(readFileSync(resolve("../../agents", agent, "schemas/input.schema.json"), "utf8")) as Record<string, unknown>;

  const ajv = new Ajv({ strict: false, allErrors: true });
  const compile = (agent: string) => ajv.compile(schemaOf(agent));

  const editorMinimal = {
    instruction: "修复第 2 页",
    draftPages: [],
    contentMode: "semantic-v3",
    sources: [{ id: "src-1", pageId: "page-1", kind: "title", value: "封面", mustShow: true }],
    priorStoryboard: {},
    repairPageIds: [],
    defects: [],
  };

  it("不含 roomId 的最小输入可通过 planner / builder / editor 的 input schema", () => {
    const planner = compile("slides-planner");
    expect(planner({ instruction: "做一份 3 页季度汇报" }), JSON.stringify(planner.errors)).toBe(true);
    expect(planner({ instruction: "做一份 3 页季度汇报", phase: "draft" }), JSON.stringify(planner.errors)).toBe(true);

    const builder = compile("slides-builder");
    expect(builder({ task: "edit", instruction: "字号调大" }), JSON.stringify(builder.errors)).toBe(true);

    const editor = compile("slides-editor");
    expect(editor(editorMinimal), JSON.stringify(editor.errors)).toBe(true);
    expect(editorMinimal).not.toHaveProperty("roomId");
  });

  it("历史 roomId 不再是合法字段（additionalProperties:false 直接拒收），证明 schema 已去 Room", () => {
    const planner = compile("slides-planner");
    expect(planner({ instruction: "做一份 3 页季度汇报", roomId: "room-1" })).toBe(false);

    const builder = compile("slides-builder");
    expect(builder({ task: "edit", instruction: "字号调大", roomId: "room-1" })).toBe(false);

    const editor = compile("slides-editor");
    expect(editor({ ...editorMinimal, roomId: "room-1" })).toBe(false);
  });
});
