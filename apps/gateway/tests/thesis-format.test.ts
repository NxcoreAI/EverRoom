import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { ThesisFormatCardStore } from "../src/modules/thesis-format/card-store.js";
import { validateThesisFormatCard } from "../src/modules/thesis-format/validate.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const logger = { info: () => undefined, warn: () => undefined };

/** 仓库 agents/ 目录的 thesis-formatter 包必须能被注册器完整加载（守卫 agent.yaml/schema 改坏）。 */
describe("thesis-formatter agent bundle", () => {
  it("loads from the repository agents directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-agents-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const registry = new SubagentRegistry(database.db, {
        enabled: true,
        definitionsDir: resolve(join(process.cwd(), "..", "..", "agents")),
        runtimeDir: join(root, "runtime"),
        defaultTimeoutMs: 30_000,
        maxConcurrent: 4,
      }, { search: { url: "https://mcp.example.test", headers: { Authorization: "test-secret" } } }, logger);
      await registry.initialize();
      const definition = registry.get("thesis-formatter");
      expect(definition).toBeTruthy();
      expect(definition?.revision.inputSchema).toBeTruthy();
      expect(definition?.revision.outputSchema).toBeTruthy();
      expect(definition?.revision.policy.allowedCallers).toContain("internal-workflow");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("ThesisFormatCardStore (multi-card)", () => {
  it("upserts per (room, sourceName), lists, resolves by id and removes", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-thesis-cards-"));
    try {
      const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
      const store = new ThesisFormatCardStore(database.db);
      const card = () => validateThesisFormatCard({}, "模版.zip");
      const a1 = store.upsert({ roomId: "r1", card: card(), sourceFileEntryId: null, sourceName: "A.docx" });
      const b1 = store.upsert({ roomId: "r1", card: card(), sourceFileEntryId: null, sourceName: "B.docx" });
      const a2 = store.upsert({ roomId: "r1", card: card(), sourceFileEntryId: "entry-1", sourceName: "A.docx" });
      expect(a2.id).toBe(a1.id);
      expect(store.list("r1")).toHaveLength(2);
      expect(store.latest("r1")?.id).toBe(a2.id);
      expect(store.byId("r1", b1.id)?.sourceName).toBe("B.docx");
      expect(store.remove("r1", b1.id)).toBe(true);
      expect(store.remove("r1", b1.id)).toBe(false);
      expect(store.list("r1")).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("validateThesisFormatCard", () => {
  it("fills Chinese thesis defaults for an empty card", () => {
    const card = validateThesisFormatCard({}, "模版.zip");
    expect(card.page.marginTopMm).toBe(25);
    expect(card.base.font.eastAsia).toBe("宋体");
    expect(card.base.font.size).toBe(12);
    expect(card.base.paragraph.lineSpacingMultiple).toBe(1.25);
    expect(card.footer.frontMatterFormat).toBe("roman");
    expect(card.parts.map((part) => part.type)).toEqual([
      "cover", "commitment", "abstract_zh", "abstract_en", "toc",
      "chapter", "appendix", "references", "acknowledgement", "achievements",
    ]);
  });

  it("resolves Chinese size names to pt and keeps explicit values", () => {
    const card = validateThesisFormatCard({
      headings: [{ level: 1, font: { eastAsia: "黑体", ascii: "Times New Roman", size: "小二", bold: true } }],
      page: { marginTopMm: 30 },
    }, "模版.docx");
    expect(card.headings[0]?.font.size).toBe(18);
    expect(card.page.marginTopMm).toBe(30);
  });

  it("rejects invalid size values", () => {
    expect(() => validateThesisFormatCard({ base: { font: { size: "十七号" } } }, "模版.docx"))
      .toThrow(/字号非法/);
  });
});
