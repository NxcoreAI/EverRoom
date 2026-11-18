/**
 * 风格卡 → 组件 的逐字段验收：改一个 StyleParams 字段，组件产物必须变化。
 * 这是「风格卡拿到的东西都在组件里用上」的可执行清单。
 */

import { describe, expect, it } from "vitest";
import { normalizeTree } from "../schema.js";
import { compileTree } from "../compile.js";
import { contractFromStyleParams } from "../layout-contract.js";
import type { StyleParamsInput } from "../../theme.js";
import type { SpecElement } from "../../elements.js";

const BASE: StyleParamsInput = {
  palette: {
    background: "#fafaf8",
    surface: "#f1f1ed",
    primary: "#2447b0",
    accent: "#c9a063",
    text: "#16181d",
    textMuted: "#63676f",
    onDarkText: "#fafaf8",
    chartSeries: ["#2447b0", "#16181d", "#8a94a8", "#c9a063"],
  },
  typography: {
    fontHeading: "Songti SC",
    fontBody: "PingFang SC",
    sizes: { body: 16, caption: 11, kpi: 64, subtitle: 20, coverTitle: 64, sectionTitle: 44, pageTitle: 32, table: 14 },
    headingBold: true,
  },
  spacing: { margin: 64, gutter: 24, cardPadding: 16, cornerRadius: 12 },
  decoration: { cardStroke: "#112233", cardStrokeWidthPt: 1.25, cardShadow: "soft", divider: "line", imageFit: "cover" },
  composition: "editorial",
  motif: { kind: "none", spec: {} },
  darkCover: true,
};

const STATS = {
  type: "component", name: "stats",
  items: [{ value: "2.83", unit: "万亿", label: "2020 GDP" }, { value: "3.87", unit: "万亿", label: "2025 GDP" }],
};

function compile(node: Record<string, unknown>, overrides: StyleParamsInput = {}, role = "content"): SpecElement[] {
  const styleParams = { ...BASE, ...overrides };
  const tree = normalizeTree({
    role,
    ...(role === "cover" ? {} : { title: "页标题" }),
    direction: "column",
    children: [node],
  });
  return compileTree(tree, contractFromStyleParams(styleParams as never)).spec.elements;
}

function json(els: SpecElement[]): string {
  return JSON.stringify(els);
}

function shapes(els: SpecElement[]): Extract<SpecElement, { type: "shape" }>[] {
  return els.filter((el): el is Extract<SpecElement, { type: "shape" }> => el.type === "shape");
}

function texts(els: SpecElement[]): Extract<SpecElement, { type: "text" }>[] {
  return els.filter((el): el is Extract<SpecElement, { type: "text" }> => el.type === "text");
}

describe("StyleParams → component elements", () => {
  it("palette.surface + decoration.cardStroke/width/shadow + spacing.cornerRadius → card ground", () => {
    const out = compile({ ...STATS, style: { surface: "card" } });
    const card = shapes(out).find((el) => el.shape === "roundRect" && el.stroke?.color === "#112233");
    expect(card).toBeDefined();
    expect(card).toMatchObject({
      fill: "#f1f1ed",
      stroke: { color: "#112233", widthPt: 1.25 },
      shadow: "soft",
    });
    expect(card?.adj ?? 0).toBeGreaterThan(0);
    // 改 surface 色，卡面跟着变。
    expect(json(compile({ ...STATS, style: { surface: "card" } }, { palette: { ...BASE.palette, surface: "#e8e4da" } })))
      .toContain("#e8e4da");
  });

  it("palette.accent → single emphasis slot (数值强调); accent=primary makes it primary", () => {
    const PROGRESS = { type: "component", name: "progress", items: [{ label: "营收目标", value: 72 }, { label: "新客获取", value: 45 }] };
    const accent = json(compile(PROGRESS));
    expect(accent).toContain("#c9a063");
    const primary = json(compile({ ...PROGRESS, style: { accent: "primary" } }));
    expect(primary).toContain("#2447b0");
    expect(primary).not.toContain("#c9a063");
  });

  it("palette.primary / text / textMuted → structural marks and text runs", () => {
    const POINTS = {
      type: "component", name: "pointList", numbered: true,
      items: [{ label: "品类聚焦", body: "只做冷萃" }, { label: "渠道直连", body: "去掉中间商" }],
    };
    const out = compile({ ...POINTS, style: { accent: "primary" } });
    expect(json(out)).toContain("#2447b0"); // 序号强调位
    expect(json(out)).toContain("#16181d"); // 标签正文色
    expect(json(out)).toContain("#63676f"); // 正文静音色
  });

  it("decoration.divider none → no hairline separators anywhere in the component", () => {
    const items = { type: "component", name: "pointList", items: [{ label: "A", body: "甲" }, { label: "B", body: "乙" }] };
    const line = shapes(compile(items)).filter((el) => el.fill === "#63676f" || el.h === 1);
    const none = shapes(compile(items, { decoration: { ...BASE.decoration, divider: "none" } }));
    expect(line.length).toBeGreaterThan(0);
    expect(none.filter((el) => el.h === 1).length).toBe(0);
  });

  it("component type roles 固定在设计基准，风格卡的 typeScale 不参与、框高不缩放", () => {
    const out = texts(compile({ ...STATS }));
    const runs = out.flatMap((el) => el.paragraphs).flatMap((p) => p.runs);
    const valueRun = runs.find((run) => run.text === "2.83");
    const labelRun = runs.find((run) => run.text === "2020 GDP");
    // 核心数据 56–80pt 按数字长度适配；标签固定 14pt。
    expect(valueRun?.sizePt).toBeLessThanOrEqual(80);
    expect(valueRun?.sizePt).toBeGreaterThanOrEqual(56);
    expect(labelRun?.sizePt).toBe(14);
    // 同一份风格卡改 typeScale：产物不变（字号不吃风格卡）。
    const bigger = texts(compile({ ...STATS }, { typography: { ...BASE.typography, typeScale: { hero: 56 } } }));
    expect(bigger.flatMap((el) => el.paragraphs).flatMap((p) => p.runs).find((run) => run.text === "2.83")?.sizePt)
      .toBe(valueRun?.sizePt);
  });

  it("typography.fontHeading/fontBody + numeral variant → numeral font", () => {
    const serif = texts(compile({ ...STATS, style: { numeral: "serif" } }));
    expect(serif.flatMap((el) => el.paragraphs).flatMap((p) => p.runs).find((run) => run.text === "2.83")?.font).toBe("Songti SC");
    const sans = texts(compile({ ...STATS, style: { numeral: "sans" } }));
    expect(sans.flatMap((el) => el.paragraphs).flatMap((p) => p.runs).find((run) => run.text === "2.83")?.font).toBe("PingFang SC");
  });

  it("typography.headingBold → heading runs", () => {
    const cards = (headingBold: boolean) => compile(
      { type: "component", name: "featureCards", items: [{ title: "甲" }, { title: "乙" }] },
      { typography: { ...BASE.typography, headingBold } },
    );
    const boldRun = texts(cards(true)).flatMap((el) => el.paragraphs).flatMap((p) => p.runs).find((run) => run.text === "甲");
    const plainRun = texts(cards(false)).flatMap((el) => el.paragraphs).flatMap((p) => p.runs).find((run) => run.text === "甲");
    expect(boldRun?.bold).toBe(true);
    expect(plainRun?.bold).toBeUndefined();
  });

  it("spacing.cardPadding → card content inset", () => {
    const cardX = (cardPadding: number) => {
      const out = compile({ ...STATS, style: { surface: "card" } }, { spacing: { ...BASE.spacing, cardPadding } });
      const card = shapes(out).find((el) => el.shape === "roundRect" && el.stroke?.color === "#112233")!;
      const value = texts(out).find((el) => el.paragraphs.some((p) => p.runs.some((r) => r.text === "2.83")))!;
      return value.x - card.x;
    };
    expect(cardX(30)).toBeGreaterThan(cardX(8));
  });

  it("spacing.gutter → inter-item gap", () => {
    const three = {
      type: "component", name: "stats",
      items: [
        { value: "1.1", label: "A" }, { value: "2.2", label: "B" }, { value: "3.3", label: "C" },
      ],
    };
    const dividerX = (gutter: number) => {
      const out = compile(three, { spacing: { ...BASE.spacing, gutter } });
      const divider = shapes(out).find((el) => el.w === 1 && el.h > 10)!;
      return divider.x;
    };
    expect(dividerX(40)).not.toBe(dividerX(8));
    // 槽宽 = (总宽 − 间隙×2)/3，分隔线落在中缝：间隙越大，中缝越靠左。
    expect(dividerX(40)).toBeLessThan(dividerX(8));
  });

  it("decoration.imageFit → component image fit", () => {
    const node = { type: "component", name: "featureCards", items: [{ title: "A", image: "everroom-material://" + "a".repeat(64) }, { title: "B" }] };
    const cover = compile(node).find((el) => el.type === "image");
    const contain = compile(node, { decoration: { ...BASE.decoration, imageFit: "contain" } }).find((el) => el.type === "image");
    expect(cover).toMatchObject({ fit: "cover" });
    expect(contain).toMatchObject({ fit: "contain" });
  });

  it("motif.kind → component-level motif shapes; motif none adds none", () => {
    const page = { motif: { kind: "color-band" as const, spec: {} } };
    const inherit = shapes(compile({ ...STATS, style: { surface: "card" } }, page)).length;
    const off = shapes(compile({ ...STATS, style: { surface: "card", motif: "none" } }, page)).length;
    expect(inherit).toBeGreaterThan(off);
    expect(shapes(compile({ ...STATS, style: { surface: "card" } }, page)).some((el) => el.shape === "rect" && el.h <= 8 && el.w > 100)).toBe(true);
  });

  it("composition → default density (swiss tight vs poster airy)", () => {
    const three = {
      type: "component", name: "stats",
      items: [
        { value: "1.1", label: "A" }, { value: "2.2", label: "B" }, { value: "3.3", label: "C" },
      ],
    };
    const dividerX = (composition: "swiss" | "poster") => {
      const out = compile(three, { composition });
      const divider = shapes(out).find((el) => el.w === 1 && el.h > 10)!;
      return divider.x;
    };
    expect(dividerX("swiss")).not.toBe(dividerX("poster"));
  });

  it("darkCover + role cover → dark page background (style card actually lands)", () => {
    const styleParams = { ...BASE, darkCover: true };
    const darkTree = normalizeTree({ role: "cover", direction: "column", children: [STATS] });
    const dark = compileTree(darkTree, contractFromStyleParams(styleParams as never)).spec.background;
    const lightTree = normalizeTree({ role: "cover", direction: "column", children: [STATS] });
    const light = compileTree(lightTree, contractFromStyleParams({ ...BASE, darkCover: false } as never)).spec.background;
    expect(dark).not.toBe(light);
  });

  it("palette.onDarkText → text color on dark component surfaces", () => {
    const ink = compile(
      { ...STATS, style: { surface: "ink" } },
      { palette: { ...BASE.palette, text: "#101418", onDarkText: "#f7f2e8" } },
    );
    const run = texts(ink).flatMap((el) => el.paragraphs).flatMap((p) => p.runs).find((r) => r.text === "2.83");
    // ink 底上的数字用反白档。
    expect(run?.color).toBe("#f7f2e8");
  });
});
