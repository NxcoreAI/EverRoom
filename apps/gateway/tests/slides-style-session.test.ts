import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { SlidesStyleSessionStore } from "../src/modules/slides-style/style-session.js";
import type { StyleParams } from "../src/modules/slides-style/types.js";

const databases: DatabaseClient[] = [];
const temporaryDirectories: string[] = [];

async function setup(): Promise<SlidesStyleSessionStore> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-slides-style-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return new SlidesStyleSessionStore(database.db);
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

describe("SlidesStyleSessionStore", () => {
  it("creates, patches and round-trips a style session through the 0071 migration", async () => {
    const store = await setup();
    const created = store.create({ roomId: "room-1", draftDocumentId: "doc-1", instruction: "商务科技风" });
    expect(created.stage).toBe("extracting");
    expect(created.generation).toBe(1);

    store.patch(created.id, {
      overviewImages: [{ contentHash: "h1", label: "冷静商务", composition: "swiss", generation: 1 }],
      stage: "images_ready",
    });
    const loaded = store.byId(created.id);
    expect(loaded?.overviewImages).toEqual([{ contentHash: "h1", label: "冷静商务", composition: "swiss", generation: 1 }]);
    expect(loaded?.stage).toBe("images_ready");
  });

  it("finds the latest active session per room and hides confirmed ones", async () => {
    const store = await setup();
    const first = store.create({ roomId: "room-1", draftDocumentId: null, instruction: "" });
    store.patch(first.id, { stage: "confirmed" });
    expect(store.findActive("room-1")).toBeNull();

    const second = store.create({ roomId: "room-1", draftDocumentId: null, instruction: "" });
    store.patch(second.id, { stage: "card_ready", styleParams: params });
    const active = store.findActive("room-1");
    expect(active?.id).toBe(second.id);
    expect(active?.styleParams?.palette.primary).toBe("#1e3a5f");
  });

  it("keeps rooms isolated", async () => {
    const store = await setup();
    const a = store.create({ roomId: "room-a", draftDocumentId: null, instruction: "" });
    store.patch(a.id, { stage: "images_ready" });
    expect(store.findActive("room-b")).toBeNull();
  });
});
