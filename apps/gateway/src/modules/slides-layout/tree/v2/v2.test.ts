import { describe, expect, it } from "vitest";
import { normalizeTree } from "../schema.js";
import { compileTree } from "../compile.js";
import { measureDefects } from "../measure.js";
import { treeSignature } from "../similarity.js";
import { contractFromStyleParams } from "../layout-contract.js";

const STYLE = {
  spacing: { margin: 64, gutter: 24, cardPadding: 16, cornerRadius: 6 },
  typography: {
    typeScale: {
      display: 56, hero: 72, h1: 40, h2: 32, h3: 26, lead: 20, body: 16, label: 13, kicker: 12, caption: 10,
    },
  },
};
const CONTRACT = contractFromStyleParams(STYLE);

const COVER = {
  version: 2,
  role: "cover",
  composition: "immersive",
  nodes: [
    { type: "image", url: "everroom-material://" + "a".repeat(64), fit: "cover", focus: { x: 50, y: 55 }, bleed: true, slot: { col: [1, 12], row: [1, 8] } },
    {
      type: "shape", shape: "rect",
      gradient: { stops: [{ pos: 0, color: "#0e0d0c00" }, { pos: 1, color: "#0e0d0cf2" }], angle: 90 },
      bleed: true, slot: { col: [1, 12], row: [1, 8] },
    },
    { type: "text", token: "display", text: "深圳：一座仍在生长的城市", tone: "inverse", slot: { col: [1, 11], row: [6, 7] } },
    { type: "text", token: "lead", text: "从 1979 年建市到 2025 年，四十五年造出一座城", tone: "inverseMuted", slot: { col: [1, 9], row: [8, 8] } },
  ],
  footer: { tone: "inverse", left: "数据口径：1980 年期初 · 2025 年初步统计", pageNumbers: false },
};

const DATA = {
  version: 2,
  role: "data",
  composition: "hero-data",
  footer: { pageNumbers: true },
  nodes: [
    { type: "text", token: "kicker", text: "45 年 · 经济总量", tone: "primary", slot: { col: [1, 6], row: [1, 1] } },
    { type: "text", token: "h1", text: "从 2.7 亿到 3.87 万亿元", slot: { col: [1, 8], row: [2, 3] } },
    {
      type: "text", token: "hero",
      paragraphs: [
        { runs: [{ text: "2.7", token: "hero", bold: true, tone: "primary" }, { text: " 亿元", token: "lead", bold: true, tone: "muted" }] },
        { spaceBeforePt: 10, runs: [{ text: "1980 年地区生产总值（期初口径）", token: "label", tone: "muted", bold: false }] },
      ],
      slot: { col: [1, 4], row: [4, 6] },
    },
    {
      type: "text", token: "hero",
      paragraphs: [
        { runs: [{ text: "3.87", token: "hero", bold: true, tone: "primary" }, { text: " 万亿元", token: "lead", bold: true, tone: "muted" }] },
        { spaceBeforePt: 10, runs: [{ text: "2025 年地区生产总值（初步统计）", token: "label", tone: "muted", bold: false }] },
      ],
      slot: { col: [5, 8], row: [4, 6] },
    },
    {
      type: "stats",
      items: [
        { value: "2.83", unit: "万亿元", label: "2020 年 GDP" },
        { value: "21.38", unit: "万元", label: "2025 年人均 GDP" },
        { value: "5.5", unit: "%", label: "“十四五”年均增速" },
      ],
      slot: { col: [9, 12], row: [2, 8] },
    },
    // 单网格行 = 60px：投影档正文 20pt 一行只放得下约 16 个汉字，超出会溢出（由闸门拦住）。
    { type: "text", token: "body", text: "增速 5.5%，居一线城市首位", slot: { col: [1, 8], row: [7, 7] } },
    { type: "text", token: "caption", text: "数据来源：深圳市 2025 年统计公报。", tone: "muted", valign: "bottom", slot: { col: [1, 8], row: [8, 8] } },
  ],
};

const EDITORIAL = {
  version: 2,
  role: "content",
  composition: "editorial",
  footer: { left: "资料：招商局史、深圳市志", pageNumbers: true },
  nodes: [
    { type: "image", url: "everroom-material://" + "b".repeat(64), fit: "cover", focus: { x: 38, y: 55 }, caption: "蛇口 · 1979", bleed: ["right"], slot: { col: [8, 12], row: [2, 8] } },
    { type: "text", token: "kicker", text: "1979 · 蛇口", tone: "primary", slot: { col: [1, 6], row: [1, 1] } },
    { type: "text", token: "h1", text: "蛇口，拉开特区建设的帷幕", slot: { col: [1, 7], row: [2, 3] } },
    {
      type: "text", token: "h2",
      paragraphs: [
        { runs: [{ text: "就叫特区", token: "h2", font: "serif", bold: false, tone: "text" }] },
        { spaceBeforePt: 12, runs: [{ text: "——邓小平同志", token: "label", tone: "muted", bold: false }] },
      ],
      slot: { col: [1, 7], row: [4, 5] },
    },
    { type: "text", token: "body", runs: [{ text: "起点规模", token: "label", bold: true, tone: "primary" }, { text: "　不足千人的滨海村镇", token: "body" }], slot: { col: [1, 7], row: [6, 6] } },
    { type: "text", token: "body", runs: [{ text: "起点动作", token: "label", bold: true, tone: "primary" }, { text: "　建港填海", token: "body" }], slot: { col: [1, 7], row: [7, 7] } },
    { type: "text", token: "body", runs: [{ text: "时间区间", token: "label", bold: true, tone: "primary" }, { text: "　1979—1980 年", token: "body" }], slot: { col: [1, 7], row: [8, 8] } },
  ],
};

function compile(raw: unknown) {
  const tree = normalizeTree(raw);
  const result = compileTree(tree, CONTRACT, undefined, { pageIndex: 1, pageCount: 3 });
  const defects = measureDefects(result, CONTRACT, {});
  return { tree, result, defects };
}

describe("layout tree v2", () => {
  it("normalizes version 2 and keeps v1 trees working", () => {
    const v2 = normalizeTree(COVER);
    expect(v2.version).toBe(2);
    expect(v2.v2?.composition).toBe("immersive");
    const v1 = normalizeTree({ role: "content", direction: "column", children: [{ type: "text", variant: "body", text: "hello" }] });
    expect(v1.version).toBeUndefined();
    expect(v1.v2).toBeUndefined();
  });

  it("compiles the immersive cover with full-bleed image and footer", () => {
    const { result, defects } = compile(COVER);
    expect(defects).toEqual([]);
    const image = result.spec.elements.find((element) => element.type === "image")!;
    expect(image).toMatchObject({ x: 0, y: 0, w: 1280, h: 720 });
    // 字号不再写死：断言封面标题用的是契约里的 display 档（场景决定，风格卡不参与）
    const display = result.spec.elements.find(
      (element) => element.type === "text" && element.paragraphs?.[0]?.runs[0]?.sizePt === CONTRACT.theme.typeScale.display,
    )!;
    expect(display).toBeTruthy();
    expect(result.stats.images).toBe(1);
  });

  it("compiles a hero-data page with typeScale and stats", () => {
    const { result, defects } = compile(DATA);
    expect(defects).toEqual([]);
    const hero = result.spec.elements.find((element) => element.type === "text" && element.paragraphs?.[0]?.runs[0]?.text === "2.7")!;
    expect(hero.type === "text" && hero.paragraphs?.[0]?.runs[0]?.sizePt).toBe(CONTRACT.theme.typeScale.hero);
    const statsValues = result.spec.elements
      .filter((element) => element.type === "text")
      .flatMap((element) => element.type === "text" ? element.paragraphs ?? [] : [])
      .flatMap((paragraph) => paragraph.runs)
      .map((run) => run.text);
    expect(statsValues).toContain("2.83");
    expect(statsValues).toContain("21.38");
    expect(defects.some((defect) => defect.type === "element_cap")).toBe(false);
  });

  it("compiles an editorial page with side-bleed image and serif quote", () => {
    const { result, defects } = compile(EDITORIAL);
    expect(defects).toEqual([]);
    const image = result.spec.elements.find((element) => element.type === "image")!;
    expect(image.type === "image" && image.x + image.w).toBe(1280);
    const serif = result.spec.elements.find((element) =>
      element.type === "text" && element.paragraphs?.some((paragraph) => paragraph.runs.some((run) => run.font === "Songti SC, Georgia")));
    expect(serif).toBeTruthy();
  });

  it("compiles a native v2 group inside a v2 slot", () => {
    const tree = normalizeTree({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{
        type: "group",
        slot: { col: [1, 6], row: [2, 6] },
        panel: "tint",
        direction: "row",
        weights: [1, 1],
        gapScale: 1,
        children: [
          { type: "text", token: "h3", text: "左栏" },
          { type: "icon", name: "bolt" },
        ],
      }],
    });
    const result = compileTree(tree, CONTRACT);
    expect(result.spec.elements.some((element) => element.type === "shape")).toBe(true);
    expect(result.spec.elements.some((element) => element.type === "text")).toBe(true);
    expect(result.spec.elements.some((element) => element.type === "icon")).toBe(true);
  });

  it("compiles a connector with an arrowhead", () => {
    const tree = normalizeTree({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [
        { type: "text", token: "body", text: "A", slot: { col: [1, 2], row: [2, 2] } },
        { type: "text", token: "body", text: "B", slot: { col: [11, 12], row: [6, 6] } },
        { type: "connector", from: { x: 10, y: 20 }, to: { x: 85, y: 70 }, tone: "primary" },
      ],
    });
    const result = compileTree(tree, CONTRACT);
    const paths = result.spec.elements.filter((element) => element.type === "path");
    expect(paths.length).toBe(2);
    expect(paths.some((path) => path.type === "path" && path.fill !== undefined)).toBe(true);
  });

  it("compiles icon and SVG path nodes for information graphics", () => {
    const tree = normalizeTree({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [
        { type: "icon", name: "bolt", tone: "primary", slot: { col: [1, 2], row: [1, 2] } },
        { type: "path", d: "M0 0 H160", stroke: { color: "tone:primary", widthPt: 2 }, slot: { col: [3, 6], row: [1, 1] } },
        { type: "text", token: "body", text: "图形", slot: { col: [1, 6], row: [3, 4] } },
      ],
    });
    const result = compileTree(tree, CONTRACT);
    expect(result.spec.elements.some((element) => element.type === "icon" && element.icon === "bolt")).toBe(true);
    expect(result.spec.elements.some((element) => element.type === "path" && element.d === "M0 0 H160")).toBe(true);
  });

  it.each([
    { col: [1, 12], row: [1, 1] },
    { col: [1, 1], row: [1, 8] },
  ])("contains icons without stretching in rectangular slots: %j", (slot) => {
    const { result } = compile({
      version: 2, role: "content", composition: "swiss",
      nodes: [
        { type: "shape", shape: "rect", tone: "surface", slot },
        { type: "icon", name: "bolt", slot },
      ],
    });
    const icon = result.spec.elements.find(e => e.type === "icon")!;
    const frame = result.spec.elements.find(e => e.type === "shape")!;
    expect(icon.w).toBe(icon.h);
    expect(icon.w).toBe(Math.round(Math.min(frame.w, frame.h)));
    expect(Math.abs(icon.x + icon.w / 2 - frame.x - frame.w / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(icon.y + icon.h / 2 - frame.y - frame.h / 2)).toBeLessThanOrEqual(1);
    expect(result.placements.find(p => p.kind === "icon")?.frame).toEqual({ x: icon.x, y: icon.y, w: icon.w, h: icon.h });
  });

  it("rejects an icon outside the engine set", () => {
    expect(() => normalizeTree({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{ type: "icon", name: "not-a-real-icon", slot: { col: [1, 2], row: [1, 2] } }],
    })).toThrow(/图标集/);
  });

  it("compiles a native table with a primary header row", () => {
    const tree = normalizeTree({
      version: 2,
      role: "table",
      composition: "swiss",
      nodes: [{
        type: "table",
        colWidths: [1.6, 1, 1, 1.4],
        rows: [
          ["厂商", "构型", "单价", "市场情况"],
          ["Jetson ONE", "多旋翼", "约 12 万美元", "订单排到 2027 年"],
          ["小鹏汇天", "汽车+飞行器", "约 200 万元", "待核实"],
        ],
        slot: { col: [1, 8], row: [3, 7] },
      }],
    });
    const result = compileTree(tree, CONTRACT);
    const table = result.spec.elements.find((element) => element.type === "table")!;
    expect(table.type).toBe("table");
    if (table.type !== "table") throw new Error("expected table");
    expect(table.rows).toHaveLength(3);
    const headerCell = table.rows[0]![0]!;
    expect(headerCell).toMatchObject({ text: "厂商", bold: true });
    expect(typeof headerCell === "object" ? headerCell.fill : undefined).toBe(CONTRACT.theme.colors.primary);
    expect(table.horizontalBordersOnly).toBe(true);
  });

  it("lays out four stats as a 2×2 grid in a wide short slot instead of overlapping rows", () => {
    const tree = normalizeTree({
      version: 2,
      role: "table",
      composition: "swiss",
      nodes: [{
        type: "stats",
        items: [
          { value: "115", unit: "kg", label: "整机重量" },
          { value: "100", unit: "kg", label: "最大载重" },
          { value: "100", unit: "km/h", label: "最高速度" },
          { value: ">20", unit: "min", label: "满载续航" },
        ],
        slot: { col: [1, 7], row: [5, 8] },
      }],
    });
    const result = compileTree(tree, CONTRACT);
    const texts = result.spec.elements.filter((element) => element.type === "text");
    expect(texts).toHaveLength(4);
    const xs = new Set(texts.map((text) => text.x));
    const ys = new Set(texts.map((text) => text.y));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(2);
    for (const text of texts) expect(text.h).toBeGreaterThan(40);
  });

  it("honors a page-level grid override", () => {
    const tree = normalizeTree({
      version: 2,
      role: "content",
      composition: "swiss",
      grid: { cols: 10, rows: 8, margin: 40, gutter: 20, rowGutter: 10 },
      nodes: [{ type: "text", token: "body", text: "网格", slot: { col: [1, 5], row: [1, 2] } }],
    });
    expect(tree.v2?.grid).toMatchObject({ cols: 10, margin: 40, gutter: 20, rowGutter: 10 });
    const result = compileTree(tree, CONTRACT);
    const text = result.spec.elements.find((element) => element.type === "text")!;
    expect(text.x).toBeGreaterThanOrEqual(40);
    expect(text.x).toBeLessThan(200);
  });

  it("passes chart axis theme tokens into the spec", () => {
    const chartPage = {
      version: 2,
      role: "data",
      composition: "hero-data",
      nodes: [{
        type: "chart", kind: "bar", categories: ["2024", "2025"],
        series: [{ name: "占比", values: [38, 43] }], dataLabels: true,
        slot: { col: [1, 8], row: [1, 6] },
      }],
    };
    const tree = normalizeTree(chartPage);
    const result = compileTree(tree, CONTRACT);
    const chart = result.spec.elements.find((element) => element.type === "chart")!;
    expect(chart.type).toBe("chart");
    expect(chart.type === "chart" && chart.axis?.labelSizePt).toBe(CONTRACT.theme.typeScale.caption);
    expect(chart.type === "chart" && chart.axis?.labelColor).toBe(CONTRACT.theme.colors.textMuted);
    expect(chart.type === "chart" && chart.axis?.gridColor).toBe(CONTRACT.theme.colors.divider);
  });

  it("rejects a composition that misses its hard requirement", () => {
    const broken = { ...COVER, nodes: COVER.nodes.filter((node) => node.type !== "image") };
    expect(() => normalizeTree(broken)).toThrow(/V2_INVALID: composition immersive/);
  });

  it("rejects out-of-range slots and unknown type tokens", () => {
    expect(() => normalizeTree({ ...COVER, nodes: [{ type: "text", token: "body", text: "x", slot: { col: [0, 2], row: [1, 1] } }] })).toThrow(/V2_INVALID/);
    expect(() => normalizeTree({ ...COVER, nodes: [{ type: "text", token: "body", text: "x", slot: { col: [1, 2], row: [1, 1] } }].map((node) => ({ ...node, token: "xxl" })) })).toThrow(/V2_INVALID/);
  });

  it("风格卡的字号覆盖被忽略：字号只由场景决定", () => {
    // 同一份风格卡里塞不同字号，编译结果必须一致——否则同一场景下每份 deck 字号各漂各的。
    const withOverride = contractFromStyleParams({ ...STYLE, typography: { typeScale: { ...STYLE.typography.typeScale, body: 18 } } });
    const plain = contractFromStyleParams(STYLE);
    const tree = normalizeTree({
      version: 2,
      role: "content",
      composition: "swiss",
      nodes: [{ type: "text", token: "body", text: "正文", slot: { col: [1, 4], row: [1, 2] } }],
    });
    const sizeOf = (contract: typeof plain) => {
      const text = compileTree(tree, contract).spec.elements.find((element) => element.type === "text")!;
      return text.type === "text" ? text.paragraphs?.[0]?.runs[0]?.sizePt : undefined;
    };
    expect(sizeOf(withOverride)).toBe(sizeOf(plain));
    expect(sizeOf(plain)).not.toBe(18);
  });

  it("produces a stable v2 signature for similarity audit", () => {
    const a = normalizeTree(DATA);
    const b = normalizeTree(DATA);
    expect(treeSignature(a)).toBe(treeSignature(b));
    expect(treeSignature(a)).toContain("v2:hero-data");
  });
});
