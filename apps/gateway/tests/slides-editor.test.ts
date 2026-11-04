import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  buildShadowReport,
  checkStoryboard,
  buildEditorRepairInput,
  editorPagesFromPlan,
  mergeRepairedPages,
  mergeStoryboardIntoPlan,
  normalizeStoryboard,
  scrubPageCopy,
  type EditorStoryboard,
  type EditorDraftPage,
} from "../src/modules/subagents/slides-editor.js";
import { SlidesStoryboardStore } from "../src/modules/subagents/slides-storyboards-store.js";
import { semanticCases } from "./fixtures/slides-semantic.js";
import { checkSemanticStoryboard } from "../src/modules/subagents/slides-semantic-contract.js";

const drafts = [
  {
    title: "封面",
    points: [
      "深圳城市专题：从 1979 年建市与 1980 年设经济特区讲起，讲到今天的产业底盘与城市生活。",
      "全篇只保留少数最能说明问题的数据，并标注口径：1980 年为期初口径，2025 年为初步统计数。",
    ],
  },
  {
    title: "45 年：从 2.7 亿元到 3.87 万亿元",
    points: [
      "1980 年深圳地区生产总值约 2.7 亿元，这是特区建立初期的期初口径。",
      "2025 年深圳地区生产总值 38731.80 亿元，比上年增长 5.5%，这是初步统计数。",
      "两个数字口径不同，不可直接比较，只用于说明量级变化。",
    ],
    data: "bar | categories: 2020 年, 2025 年 | 地区生产总值(万亿元): 2.83, 3.87",
  },
  {
    title: "蛇口建港填海",
    points: [
      "蛇口原是一个不足千人的滨海村镇，它开始建港填海。",
      "1979 年 4 月，广东省委提出兴办对外加工贸易区的建议；邓小平同志提出「就叫特区」。",
    ],
  },
];

function fixture(): EditorStoryboard {
  return {
    schemaVersion: "storyboard/v2",
    deck: { title: "深圳：一座仍在生长的城市", spine: "城市不是自然生长出来的。", visualThesis: "极简人文" },
    pages: [
      {
        id: "page-01",
        role: "cover",
        density: "sparse",
        form: "light-page",
        units: 1,
        weight: "heavy",
        emphasis: "title",
        intent: "先给城市定性：不是自然生长出来的。",
        takeaway: "四十五年，一座城仍在生长。",
        copy: {
          kicker: "深圳专题 · 2026",
          message: "深圳：一座仍在生长的城市",
          supporting: ["从 1979 到 2025，四十五年造出一座城"],
          facts: [],
          source: "数据口径：1980 年期初 · 2025 年初步统计",
          speakerNotes: "开场先不报数据。用这张照片让听众先看到尺度，停顿两秒再报标题。全片只讲一条主线：城市是被设计出来的。".repeat(2).slice(0, 100),
        },
        dropped: [{ from: "draft-page-01", text: "主要数据来源", reason: "进讲稿", movedToNotes: true }],
      },
      {
        id: "page-02",
        role: "data",
        density: "dense",
        form: "single-fact",
        units: 1,
        weight: "medium",
        emphasis: "number",
        intent: "用一个量级跨越建立规模的事实底座。",
        takeaway: "四十五年，经济量级已完全不同。",
        copy: {
          kicker: "45 年 · 经济总量",
          message: "从 2.7 亿到 3.87 万亿元",
          supporting: [],
          facts: [
            { label: "1980 年 GDP", value: "2.7", unit: "亿元", note: "期初口径" },
            { label: "2025 年 GDP", value: "3.87", unit: "万亿元", note: "初步统计" },
          ],
          source: "数据来源：深圳市 2025 年统计公报。口径不同，只列绝对数。",
          speakerNotes: "这一页只让听众记住两个量级，不展开讲增速。右上角小图只作为证据，不逐条念数字。口径差异要主动说明，避免被追问。四十五年的跨度用两个数字就够，不要把它讲成一串增长率。",
        },
        dropped: [{ from: "draft-page-05", text: "增速居一线城市首位", reason: "进讲稿", movedToNotes: true }],
      },
      {
        id: "page-03",
        role: "content",
        density: "standard",
        form: "breakdown",
        units: 3,
        weight: "medium",
        emphasis: "quote",
        intent: "把制度起点落到一个具体动作上：蛇口填海。",
        takeaway: "蛇口的一声炮响，拉开了特区建设的帷幕。",
        copy: {
          kicker: "1979 · 蛇口",
          message: "蛇口，拉开特区建设的帷幕",
          supporting: [],
          facts: [
            { label: "起点规模", body: "不足千人的滨海村镇" },
            { label: "起点动作", body: "建港填海" },
            { label: "时间区间", body: "1979—1980 年" },
          ],
          quote: { text: "就叫特区", attribution: "——邓小平同志" },
          source: "资料：招商局史、深圳市志",
          speakerNotes: "讲蛇口不要铺陈背景，只讲一个动作：填海。就叫特区这句话放在页面中部，是全片的情绪锚点。三组事实留给听众自己扫读，讲的时候只展开不足千人和 1979 到 1980 两个数字。",
        },
        dropped: [{ from: "draft-page-03", text: "深圳承载着改革试验田的功能", reason: "进讲稿", movedToNotes: true }],
      },
    ],
    warnings: [],
  };
}

describe("slides-editor shadow checks", () => {
  it("缺 form/units/weight 时归一阶段就报错，不给默认版式兜底", () => {
    const raw = fixture() as unknown as Record<string, unknown>;
    const pages = raw.pages as Array<Record<string, unknown>>;
    delete pages[0]!.form;
    delete pages[1]!.units;
    delete pages[2]!.weight;
    const normalized = normalizeStoryboard(raw);
    expect(normalized.errors.some((error) => error.includes("form"))).toBe(true);
    expect(normalized.errors.some((error) => error.includes("units"))).toBe(true);
    expect(normalized.errors.some((error) => error.includes("weight"))).toBe(true);
    expect(normalized.storyboard).not.toBeNull();
  });

  it("units 超出形态范围时报形态缺陷（供网关返工）", () => {
    const board = fixture();
    board.pages[1]!.units = 3; // single-fact 只允许 1
    const check = checkStoryboard(board, drafts);
    const hit = check.errors.find((error) => error.startsWith("形态"));
    expect(hit).toBeDefined();
    expect(hit).toContain("units");
  });

  it("声明义务：图为主视觉必须有图、对照表必须真给表", () => {
    const board = fixture();
    board.pages[0]!.form = "image-led";
    board.pages[0]!.emphasis = "image";
    board.pages[1]!.form = "table";
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("图为主视觉") && error.includes("没有配图"))).toBe(true);
    expect(check.errors.some((error) => error.includes("对照表") && error.includes("不足 3 行"))).toBe(true);
  });

  it("图的来源不参与形态判定：素材和生成图一视同仁", () => {
    const board = fixture();
    board.pages[0]!.form = "image-led";
    board.pages[0]!.emphasis = "image";
    board.pages[0]!.visual = { kind: "generated" };
    board.pages[1]!.form = "image-led";
    board.pages[1]!.emphasis = "image";
    board.pages[1]!.visual = { kind: "material" };
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("图为主视觉"))).toBe(false);
  });

  it("并列拆解超过一半页时报错，防止它变成新的安全牌", () => {
    const board = fixture();
    for (const page of board.pages) {
      page.form = "breakdown";
      page.units = 3;
    }
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("并列拆解"))).toBe(true);
  });

  it("连续三页轻分量时报错", () => {
    const board = fixture();
    for (const page of board.pages) page.weight = "light";
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("连续三页都是轻分量"))).toBe(true);
  });

  it("passes a valid 3-page storyboard and reports prose reduction", () => {
    const report = buildShadowReport(fixture(), drafts);
    expect(report.errors).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.pageCount).toBe(3);
    expect(report.draftPageCount).toBe(3);
    expect(report.forms).toEqual(["light-page", "single-fact", "breakdown"]);
    expect(report.reductionPct).not.toBeNull();
    expect(report.pages[1]?.proseChars).toBeLessThan(40);
  });

  it("rejects message over 24 chars and notes outside 60~260", () => {
    const board = fixture();
    board.pages[0]!.copy.message = "这是一句远远超过二十四字预算的页面主张文案，必须被拒收";
    board.pages[1]!.copy.speakerNotes = "太短";
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("message"))).toBe(true);
    expect(check.errors.some((error) => error.includes("speakerNotes"))).toBe(true);
  });

  it("rejects metadata on slide and supporting overflow", () => {
    const board = fixture();
    board.pages[0]!.copy.message = "全篇 12 页，约 15 分钟";
    board.pages[0]!.copy.supporting = ["一行", "两行"];
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("制作元数据"))).toBe(true);
    expect(check.errors.some((error) => error.includes("supporting"))).toBe(true);
  });

  it("rejects page count mismatch", () => {
    const board = fixture();
    board.pages.pop();
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("页数"))).toBe(true);
  });

  it("内容页里轻页超过 15% 时报错", () => {
    const board = fixture();
    // 三页都是内容页，全部标成轻页 → 100% > 15%
    board.pages[0]!.role = "content";
    board.pages[1]!.role = "content";
    board.pages[2]!.role = "content";
    for (const page of board.pages) {
      page.form = "light-page";
      page.units = 1;
      page.emphasis = "title";
      page.copy.facts = [];
    }
    board.pages[2]!.weight = "heavy";
    const check = checkStoryboard(board, drafts);
    expect(check.errors.some((error) => error.includes("「轻页」"))).toBe(true);
  });

  it("normalizes missing ids and filters malformed dropped entries", () => {
    const raw = fixture() as unknown as Record<string, unknown>;
    const pages = raw.pages as Array<Record<string, unknown>>;
    delete pages[0]!.id;
    pages[0]!.dropped = [{ from: "draft", reason: "缺 text" }, { from: "draft", text: "x", reason: "ok" }];
    const normalized = normalizeStoryboard(raw);
    expect(normalized.storyboard?.pages[0]?.id).toBe("page-01");
    expect(normalized.storyboard?.pages[0]?.dropped).toEqual([{ from: "draft", text: "x", reason: "ok" }]);
  });
});

describe("copy scrub", () => {
  it("removes caveat clauses and ellipses from page copy, keeps source name", () => {
    const copy = scrubPageCopy({
      kicker: "市场基础",
      message: "需求同源于户外……",
      supporting: ["飞行俱乐部 1500+", "口径待核实"],
      facts: [
        { label: "机场", value: "20061", note: "待核实" },
        { label: "来源", value: "BP", note: "2024 年" },
      ],
      source: "数据来源：Nexwing BP；口径待核实；统计口径不完全对应",
      speakerNotes: "讲稿保留全部口径与待核实说明。",
    });
    expect(copy.message).toBe("需求同源于户外");
    expect(copy.supporting).toEqual(["飞行俱乐部 1500+"]);
    expect(copy.facts).toHaveLength(2);
    expect(copy.facts[0]).not.toHaveProperty("note");
    expect(copy.facts[1]?.note).toBe("2024 年");
    expect(copy.source).toBe("数据来源：Nexwing BP");
    expect(copy.speakerNotes).toContain("口径");
  });
});

describe("storyboard plan merge", () => {
  it("keeps planner materials/points and derives composition from form", () => {
    const plan = {
      title: "深圳",
      pages: [
        { title: "封面", role: "cover", density: "sparse", points: ["a"], materials: [{ url: "everroom-material://x" }] },
        { title: "数据", role: "data", density: "dense", points: ["b"], data: "bar | categories: 1, 2 | x: 1, 2" },
        { title: "叙事", role: "content", density: "standard", points: ["c"] },
      ],
    };
    const merged = mergeStoryboardIntoPlan(plan, fixture());
    expect(merged).not.toBeNull();
    const pages = (merged as any).pages as Array<Record<string, any>>;
    expect(pages[0]!.layoutVersion).toBe(2);
    expect(pages[0]!.materials).toEqual([{ url: "everroom-material://x" }]);
    expect(pages[0]!.points).toEqual(["a"]);
    expect(pages[0]!.copy.message).toBe("深圳：一座仍在生长的城市");
    expect(pages[1]!.form).toBe("single-fact");
    // 版式由内容形态推导：single-fact → hero-data
    expect(pages[1]!.composition).toBe("hero-data");
    expect(pages[1]!.skeleton).toContain("单一事实");
    expect(pages[1]!.neighbors).toHaveLength(2);
    expect(pages[1]!.neighbors[0].form).toBe("light-page");
    expect(pages[1]!.budget.prose).toBe(48);
  });

  it("returns null when page counts differ", () => {
    const plan = { title: "x", pages: [{ title: "only one" }] };
    expect(mergeStoryboardIntoPlan(plan, fixture())).toBeNull();
  });

  it("whitelists plan pages for editor input", () => {
    const pages = editorPagesFromPlan({
      pages: [{ title: "x", points: ["p"], data: "d", materials: [{ url: "u" }], notes: "n", imagePrompt: "i" }],
    });
    expect(pages[0]).toMatchObject({ title: "x", points: ["p"], data: "d", notes: "n" });
    expect(pages[0]).not.toHaveProperty("materials");
    expect(pages[0]).not.toHaveProperty("imagePrompt");
  });
});


describe("SlidesStoryboardStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the migration table and upserts by draft hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "nxcore-slides-storyboard-"));
    dirs.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const store = new SlidesStoryboardStore(database.db);
    const board = fixture();
    const report = buildShadowReport(board, drafts);
    store.save({ roomId: "room-1", draftDocumentId: "doc-1", draftHash: "hash-1", storyboard: board, report });
    const found = store.byDraft("room-1", "doc-1");
    expect(found?.draftHash).toBe("hash-1");
    expect(found?.report.pageCount).toBe(3);
    store.save({ roomId: "room-1", draftDocumentId: "doc-1", draftHash: "hash-1", storyboard: board, report });
    expect(store.byDraftHash("room-1", "doc-1", "hash-1")?.draftHash).toBe("hash-1");
    expect(store.byDraft("room-1", "doc-1")?.report.pageCount).toBe(3);
  });
  it("persists semantic and legacy experiments separately without migrating existing records", () => {
    const dir = mkdtempSync(join(tmpdir(), "nxcore-slides-storyboard-")); dirs.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    const store = new SlidesStoryboardStore(database.db);
    const legacy = fixture();
    store.save({ roomId: "r", draftDocumentId: "d", draftHash: "same-source", storyboard: legacy, report: buildShadowReport(legacy, drafts) });
    const { page, sources } = semanticCases[0]!;
    const storyboard = { schemaVersion: "storyboard/v3" as const, title: "Deck", pages: [page], sources };
    const report = checkSemanticStoryboard([page], sources);
    expect(() => store.save({ roomId: "r", draftDocumentId: "d", draftHash: "same-source", storyboard, report })).toThrow("key_required");
    const first = store.save({ roomId: "r", draftDocumentId: "d", draftHash: "semantic-v3:style-a", storyboard, report });
    const second = store.save({ roomId: "r", draftDocumentId: "d", draftHash: "semantic-v3:style-b", storyboard, report });
    expect(first.id).not.toBe(second.id);
    expect(store.byDraftHash("r", "d", "same-source")?.storyboard.schemaVersion).toBe("storyboard/v2");
    expect(store.byDraftHash("r", "d", "semantic-v3:style-a")?.storyboard).toEqual(storyboard);
  });
});

describe("页级修复的边界（只收被点名的页）", () => {
  const base: EditorStoryboard = {
    schemaVersion: "storyboard/v2",
    deck: { title: "季度汇报", spine: "从业绩到计划" },
    pages: [
      { id: "page-01", role: "cover", density: "sparse", form: "light-page", units: 1, weight: "light", emphasis: "title", intent: "开场定调，交代这次汇报要解决什么", takeaway: "季度汇报", copy: { message: "季度汇报", supporting: [], facts: [], speakerNotes: "开场先讲结论。".repeat(8) }, dropped: [] },
      { id: "page-02", role: "data", density: "dense", form: "single-fact", units: 1, weight: "heavy", emphasis: "number", intent: "用一个数字说明本季度业绩成色", takeaway: "营收涨两成", copy: { message: "营收涨两成", supporting: [], facts: [{ label: "营收", value: "1.5", unit: "亿" }], speakerNotes: "这一页只讲营收。".repeat(8) }, dropped: [] },
    ],
    warnings: [],
  };

  const repairedPage = { ...base.pages[1]!, copy: { ...base.pages[1]!.copy, message: "营收涨了两成" } };

  it("被点名的页采纳修复结果", () => {
    const merged = mergeRepairedPages(base, { ...base, pages: [base.pages[0]!, repairedPage] }, ["page-02"]);
    expect(merged.storyboard.pages[1]!.copy.message).toBe("营收涨了两成");
    expect(merged.rejected).toEqual([]);
  });

  it("顺手改到的其它页一律丢弃，并留下 rejected 记录", () => {
    const sneaky = { ...base.pages[0]!, copy: { ...base.pages[0]!.copy, message: "被顺手改掉的封面" } };
    const merged = mergeRepairedPages(base, { ...base, pages: [sneaky, repairedPage] }, ["page-02"]);
    expect(merged.storyboard.pages[0]!.copy.message).toBe("季度汇报");
    expect(merged.rejected.join(" ")).toContain("page-01");
  });

  it("页数变了也照样只并同名页", () => {
    const merged = mergeRepairedPages(base, { ...base, pages: [repairedPage] }, ["page-02"]);
    expect(merged.storyboard.pages).toHaveLength(2);
    expect(merged.rejected.length).toBeGreaterThan(0);
  });

  it("修复输入只带被打回的页与缺陷清单（不把整册再发一遍）", () => {
    const input = buildEditorRepairInput({
      instruction: "复盘",
      roomId: "room-1",
      title: "季度汇报",
      draftPages: [{ title: "封面", points: [] }, { title: "业绩", points: ["营收涨两成"] }],
      priorStoryboard: base,
      repairPageIds: ["page-02"],
      defects: ["形态：第 2 页 声明了对照表但行数不足"],
    });
    expect((input.draftPages as unknown[]).length).toBe(1);
    expect((input.priorStoryboard as { pages: unknown[] }).pages.length).toBe(1);
    expect(input.repairPageIds).toEqual(["page-02"]);
    expect((input.defects as string[])[0]).toContain("形态");
  });
});
