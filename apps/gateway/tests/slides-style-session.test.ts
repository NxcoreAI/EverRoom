import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WORKSPACE_DOCUMENT_CHANNEL } from "@nxcore/agent-contract";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { slidesStyleSessions } from "../src/infrastructure/database/schema.js";
import { SlidesStyleSessionStore } from "../src/modules/slides-style/style-session.js";
import type { StyleParams } from "../src/modules/slides-style/types.js";

const databases: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];

async function setup(): Promise<{ store: SlidesStyleSessionStore; database: DatabaseClient }> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-slides-style-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return { store: new SlidesStyleSessionStore(database.db), database };
}
afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const params: StyleParams = {
  palette: {
    background: "#f7f5f0", surface: "#ffffff", primary: "#1e3a5f", accent: "#e8a33d",
    text: "#333333", textMuted: "#8a8a8a", onDarkText: "#f7f5f0",
    chartSeries: ["#1e3a5f", "#3d5f82", "#7c93ad"],
  },
  typography: {
    fontHeading: "PingFang SC", fontBody: "PingFang SC",
    sizes: { coverTitle: 64, sectionTitle: 40, pageTitle: 28, subtitle: 18, body: 14, caption: 11, kpi: 44, table: 13 },
    headingBold: true,
  },
  spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 8 },
  decoration: { cardStroke: "#e5e5e5", cardStrokeWidthPt: 0.75, cardShadow: "soft", divider: "line", imageFit: "cover" },
  motif: { kind: "ghost-number", spec: { alphaPercent: 15 } },
  darkCover: true,
  effectLines: ["主色 深藏青 #1E3A5F", "标题加粗黑体系"],
};

describe("SlidesStyleSessionStore（单工作区语义）", () => {
  it("creates, patches and round-trips a style session through the 0071 migration", async () => {
    const { store } = await setup();
    const created = store.create({ draftDocumentId: "doc-1", instruction: "商务科技风" });
    expect(created.stage).toBe("extracting");
    expect(created.generation).toBe(1);
    // 去 Room：会话 DTO 不再带 roomId 身份维度。
    expect(created).not.toHaveProperty("roomId");

    store.patch(created.id, {
      overviewImages: [{ contentHash: "h1", label: "冷静商务", composition: "swiss", generation: 1 }],
      stage: "images_ready",
    });
    const loaded = store.byId(created.id);
    expect(loaded?.overviewImages).toEqual([{ contentHash: "h1", label: "冷静商务", composition: "swiss", generation: 1 }]);
    expect(loaded?.stage).toBe("images_ready");
    expect(loaded).not.toHaveProperty("roomId");
  });

  it("finds the globally latest active session and hides confirmed ones", async () => {
    const { store } = await setup();
    const first = store.create({ draftDocumentId: null, instruction: "" });
    store.patch(first.id, { stage: "confirmed" });
    expect(store.findActive()).toBeNull();

    const second = store.create({ draftDocumentId: null, instruction: "" });
    store.patch(second.id, { stage: "card_ready", styleParams: params });
    const active = store.findActive();
    expect(active?.id).toBe(second.id);
    expect(active?.styleParams?.palette.primary).toBe("#1e3a5f");

    // 单工作区：活跃会话就是全局最新一条，不再按 Room 分区。
    const third = store.create({ draftDocumentId: "doc-3", instruction: "再换一版" });
    store.patch(third.id, { stage: "images_ready" });
    expect(store.findActive()?.id).toBe(third.id);
  });

  it("byDraftId 不按 Room 过滤：旧库带真实 room_id 的行照样命中（续跑不丢）", async () => {
    const { store, database } = await setup();
    const legacyUpdatedAt = new Date(Date.now() - 60_000);
    // 旧库形态：冻结列 room_id 写的是真实 roomId（非工作区频道）。
    database.db.insert(slidesStyleSessions).values({
      id: "legacy-style-session",
      roomId: "legacy-room",
      draftDocumentId: "doc-legacy",
      instruction: "旧库会话",
      stage: "images_ready",
      createdAt: legacyUpdatedAt,
      updatedAt: legacyUpdatedAt,
    }).run();

    // 读路径只按 draftId 寻址，不带 room 条件。
    expect(store.byDraftId("doc-legacy")?.id).toBe("legacy-style-session");
    expect(store.findActive()?.id).toBe("legacy-style-session");

    // 新写入行：冻结列统一填工作区频道。
    const created = store.create({ draftDocumentId: "doc-new", instruction: "新会话" });
    const row = database.db.select().from(slidesStyleSessions)
      .where(eq(slidesStyleSessions.id, created.id)).get();
    expect(row?.roomId).toBe(WORKSPACE_DOCUMENT_CHANNEL);
  });
});
