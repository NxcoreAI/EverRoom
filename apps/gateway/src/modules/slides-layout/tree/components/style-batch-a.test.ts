/**
 * 组件样式层（batch A）单测：surface/separator/accent/density 与各组件结构变体。
 * 只走公开入口（normalizeComponentLeaf / expandComponent），断言产物结构而非视觉。
 */

import { describe, expect, it } from "vitest";
import type { Frame } from "../../grid.js";
import { mixHex, resolveTheme, type ResolvedTheme, type StyleParamsInput } from "../../theme.js";
import type { ShapeElement, SpecElement } from "../../elements.js";
import { expandComponent, normalizeComponentLeaf } from "./index.js";

const FRAME: Frame = { x: 100, y: 100, w: 800, h: 540 };

const AGENDA = ["市场判断", "品类策略", "供应链设计", "渠道打法", "组织与节奏", "财务测算"];
const TIMELINE = [
  { label: "2026", text: "品类验证" },
  { label: "2027", text: "渠道扩张" },
  { label: "2028", text: "品牌溢价" },
];
const STEPS = [
  { title: "选品", text: "锁定品类" },
  { title: "定标", text: "双标准" },
  { title: "上架", text: "先电商" },
];
const CHEVRON = [{ title: "选品" }, { title: "定标", text: "双标准" }, { title: "代工" }, { title: "上架" }];
const PYRAMID = [{ title: "品牌" }, { title: "渠道", text: "融合" }, { title: "供应链" }, { title: "产品" }];
const FUNNEL = [
  { stage: "曝光", value: "120 万" },
  { stage: "进店", value: "18 万" },
  { stage: "加购", value: "4.2 万" },
  { stage: "成交", value: "9 千" },
];
const CYCLE = [{ title: "引流" }, { title: "转化" }, { title: "复购" }, { title: "推荐" }];
const PROGRESS = [
  { label: "营收目标", value: 72 },
  { label: "新客获取", value: 45 },
  { label: "履约时效", value: 90 },
];

const CARD_DECORATION = {
  cardStroke: "#112233",
  cardStrokeWidthPt: 1,
  cardShadow: "soft" as const,
};

function theme(overrides: StyleParamsInput = {}): ResolvedTheme {
  return resolveTheme(overrides);
}

/** 断言辅助：已知主题 + frame 展开一个组件节点。 */
function expand(
  node: Record<string, unknown>,
  styleParams?: StyleParamsInput,
  frame: Frame = FRAME,
): { elements: SpecElement[]; theme: ResolvedTheme } {
  const t = theme(styleParams);
  const leaf = normalizeComponentLeaf({ type: "component", ...node }, "root");
  return { elements: expandComponent(leaf, frame, t, "root"), theme: t };
}

function shapes(elements: SpecElement[]): ShapeElement[] {
  return elements.filter((el): el is ShapeElement => el.type === "shape");
}

function dividers(elements: SpecElement[]): ShapeElement[] {
  return shapes(elements).filter((el) => (el.h === 1 || el.w === 1) && typeof el.fill === "string");
}

/** 第一个文字元素的第一个 run 颜色（结构变体的正/反白断言用）。 */
function firstTextColor(elements: SpecElement[]): string | undefined {
  const text = elements.find((el) => el.type === "text");
  return text && text.type === "text" ? text.paragraphs[0]?.runs[0]?.color : undefined;
}

describe("component style normalization", () => {
  it("rejects unknown style keys and out-of-enum values", () => {
    expect(() => expand({ name: "agenda", items: AGENDA, style: { shadow: "soft" } }))
      .toThrow(/LAYOUT_TREE_INVALID/);
    expect(() => expand({ name: "agenda", items: AGENDA, style: { surface: "glass" } }))
      .toThrow(/LAYOUT_TREE_INVALID/);
    expect(() => expand({ name: "agenda", items: AGENDA, style: { density: "huge" } }))
      .toThrow(/LAYOUT_TREE_INVALID/);
  });
});

describe("surface", () => {
  it("card paints a stroked + shadowed roundRect with radius", () => {
    const { elements, theme: t } = expand(
      { name: "agenda", items: AGENDA, style: { surface: "card" } },
      { decoration: CARD_DECORATION, spacing: { cornerRadius: 8 } },
    );
    const ground = shapes(elements).find((el) => el.shape === "roundRect");
    expect(ground).toBeDefined();
    expect(ground!.fill).toBe(t.colors.cardSurface);
    expect(ground!.stroke).toEqual({ color: "#112233", widthPt: 1 });
    expect(ground!.shadow).toBe("soft");
    expect(ground!.adj).toBeGreaterThan(0);
  });

  it("tint paints a flat fill distinct from card; none paints no ground", () => {
    const card = expand({ name: "agenda", items: AGENDA, style: { surface: "card" } }, {
      decoration: CARD_DECORATION,
      spacing: { cornerRadius: 8 },
    });
    const cardFill = shapes(card.elements).find((el) => el.shape === "roundRect")!.fill;

    const tint = expand({ name: "agenda", items: AGENDA, style: { surface: "tint" } });
    const tintGround = shapes(tint.elements).find((el) => el.shape === "roundRect");
    expect(tintGround).toBeDefined();
    expect(tintGround!.fill).not.toBe(cardFill);
    expect(tintGround!.fill).toBe(mixHex(tint.theme.colors.primary, tint.theme.colors.background, 0.93));
    expect(tintGround!.stroke).toBeUndefined();

    const none = expand({ name: "agenda", items: AGENDA, style: { surface: "none" } });
    expect(shapes(none.elements).filter((el) => el.shape === "roundRect")).toEqual([]);
    // 缺省（风格卡 surface none）同样不铺底。
    expect(shapes(expand({ name: "agenda", items: AGENDA }).elements).filter((el) => el.shape === "roundRect"))
      .toEqual([]);
  });
});

describe("separator", () => {
  it("separator none removes agenda row hairlines and prosCons middle rule", () => {
    const t = theme();
    const agendaLine = dividers(expand({ name: "agenda", items: AGENDA }).elements);
    expect(agendaLine.length).toBeGreaterThan(0);
    expect(agendaLine.every((el) => el.fill === t.colors.divider)).toBe(true);
    const agendaNone = dividers(expand({ name: "agenda", items: AGENDA, style: { separator: "none" } }).elements);
    expect(agendaNone).toEqual([]);

    const prosCons = { name: "prosCons", pros: ["供应链自主", "毛利健康"], cons: ["投入重", "能力要求高"] };
    const prosLine = dividers(expand(prosCons).elements);
    expect(prosLine.some((el) => el.w === 1 && el.fill === t.colors.divider)).toBe(true);
    expect(dividers(expand({ ...prosCons, style: { separator: "none" } }).elements)).toEqual([]);
  });

  it("decoration.divider none turns the default separator into gap", () => {
    const t = theme({ decoration: { divider: "none" } });
    const { elements } = expand({ name: "agenda", items: AGENDA }, { decoration: { divider: "none" } });
    expect(dividers(elements).filter((el) => el.fill === t.colors.divider)).toEqual([]);
  });
});

describe("accent", () => {
  it("accent accent / primary drives emphasis marks", () => {
    const params = { palette: { primary: "#2447B0", accent: "#C9A063" } };
    const accentTheme = theme(params);
    const accent = shapes(expand({ name: "steps", items: STEPS, style: { accent: "accent" } }, params).elements);
    const accentDots = accent.filter((el) => el.shape === "ellipse");
    expect(accentDots.length).toBeGreaterThan(0);
    expect(accentDots.every((el) => el.fill === accentTheme.colors.accent)).toBe(true);

    const primary = shapes(expand({ name: "steps", items: STEPS, style: { accent: "primary" } }, params).elements);
    expect(primary.filter((el) => el.shape === "ellipse").every((el) => el.fill === accentTheme.colors.primary)).toBe(true);
  });
});

describe("density", () => {
  it("tight vs airy changes gaps and card padding", () => {
    const tight = expand({ name: "timeline", items: TIMELINE, style: { density: "tight" } });
    const airy = expand({ name: "timeline", items: TIMELINE, style: { density: "airy" } });
    const textXs = (els: SpecElement[]) => els.filter((el) => el.type === "text").map((el) => el.x);
    expect(textXs(tight.elements)).not.toEqual(textXs(airy.elements));

    const cardTight = expand(
      { name: "steps", items: STEPS, style: { surface: "card", density: "tight" } },
      { decoration: CARD_DECORATION },
    );
    const cardAiry = expand(
      { name: "steps", items: STEPS, style: { surface: "card", density: "airy" } },
      { decoration: CARD_DECORATION },
    );
    expect(textXs(cardTight.elements)[0]).not.toBe(textXs(cardAiry.elements)[0]);
    expect(textXs(cardAiry.elements)[0]).toBeGreaterThan(textXs(cardTight.elements)[0]!);
  });
});

describe("variants", () => {
  it("timeline axis line | dots | none", () => {
    const line = shapes(expand({ name: "timeline", items: TIMELINE }).elements);
    expect(line.some((el) => el.shape === "rect" && el.h === 2 && el.w > FRAME.w * 0.6)).toBe(true);
    expect(line.filter((el) => el.shape === "ellipse")).toHaveLength(TIMELINE.length);

    const dots = shapes(expand({ name: "timeline", items: TIMELINE, axis: "dots" }).elements);
    expect(dots.some((el) => el.shape === "rect" && el.h === 2 && el.w > FRAME.w * 0.6)).toBe(false);
    expect(dots.filter((el) => el.shape === "ellipse").length).toBeGreaterThanOrEqual(TIMELINE.length);

    // axis:none 只去掉轴线，节点仍是内容锚点。
    const none = shapes(expand({ name: "timeline", items: TIMELINE, axis: "none" }).elements);
    expect(none.some((el) => el.shape === "rect" && el.h === 2 && el.w > FRAME.w * 0.6)).toBe(false);
    expect(none.filter((el) => el.shape === "ellipse")).toHaveLength(TIMELINE.length);
  });

  it("steps connector line | gap | none", () => {
    const line = shapes(expand({ name: "steps", items: STEPS }).elements);
    // 轨道是 2px 强调色横线 + 落点圆点（每处连接一个）。
    expect(line.filter((el) => el.shape === "rect" && el.h === 2)).toHaveLength(STEPS.length - 1);
    expect(line.filter((el) => el.shape === "ellipse")).toHaveLength(STEPS.length - 1);
    // 刻标规则仍在；连接件（轨道线 + 落点）随 connector 消失。
    const gap = shapes(expand({ name: "steps", items: STEPS, connector: "gap" }).elements);
    expect(gap.filter((el) => el.shape === "ellipse" || el.h === 2)).toEqual([]);
    const none = shapes(expand({ name: "steps", items: STEPS, connector: "none" }).elements);
    expect(none.filter((el) => el.shape === "ellipse" || el.h === 2)).toEqual([]);
  });

  it("chevron / pyramid form outline | filled | tint", () => {
    const t = theme();
    // chevron：实心箭头链，outline 空心墨描边、filled 主色实填、tint 浅档。
    const chevronOutline = shapes(expand({ name: "chevron", items: CHEVRON, form: "outline" }).elements);
    expect(chevronOutline.length).toBe(CHEVRON.length);
    expect(chevronOutline.every((el) => el.fill === "#00000000" && el.stroke?.color === t.colors.text)).toBe(true);

    const chevronFilled = shapes(expand({ name: "chevron", items: CHEVRON, form: "filled" }).elements);
    expect(chevronFilled.length).toBe(CHEVRON.length);
    expect(chevronFilled.every((el) => el.fill === t.colors.primary && el.stroke === undefined)).toBe(true);
    expect(firstTextColor(expand({ name: "chevron", items: CHEVRON, form: "filled" }).elements))
      .toBe(t.colors.onDarkText);

    const soft = mixHex(t.colors.primary, t.colors.background, 0.88);
    const chevronTint = shapes(expand({ name: "chevron", items: CHEVRON, form: "tint" }).elements);
    expect(chevronTint.every((el) => el.fill === soft)).toBe(true);

    // pyramid：默认实心切片——每层一块 path，填充明度渐变，层宽递增到底边满宽。
    const filled = expand({ name: "pyramid", items: PYRAMID, form: "filled" }).elements;
    const tiers = filled.filter((el) => el.type === "path");
    expect(tiers).toHaveLength(PYRAMID.length);
    const rampFill = (i: number) =>
      mixHex(t.colors.primary, t.colors.background, 0.05 + 0.37 * (i / (PYRAMID.length - 1)));
    tiers.forEach((el, i) => expect((el as { fill?: string }).fill).toBe(rampFill(i)));
    expect(firstTextColor(filled)).toBe(t.colors.onDarkText);
    const widths = tiers.map((el) => (el as { w: number }).w);
    expect(widths[widths.length - 1]).toBe(FRAME.w);
    expect(widths.every((w, i) => i === 0 || w > widths[i - 1]!)).toBe(true);

    const pyramidTint = expand({ name: "pyramid", items: PYRAMID, form: "tint" }).elements
      .filter((el) => el.type === "path");
    expect(pyramidTint.every((el) => (el as { fill?: string }).fill === soft)).toBe(true);

    const pyramidOutline = expand({ name: "pyramid", items: PYRAMID, form: "outline" }).elements
      .filter((el) => el.type === "path") as { fill?: string; stroke?: { color: string } }[];
    expect(pyramidOutline).toHaveLength(PYRAMID.length);
    expect(pyramidOutline.every((el) => el.fill === "#00000000" && el.stroke?.color === t.colors.text)).toBe(true);
  });

  it("funnel defaults to a filled luminance ramp and honors filled | tint | outline", () => {
    const t = theme();
    const rampFill = (i: number) =>
      mixHex(t.colors.primary, t.colors.background, 0.04 + 0.33 * (i / (FUNNEL.length - 1)));
    const filled = shapes(expand({ name: "funnel", items: FUNNEL }).elements);
    expect(filled).toHaveLength(FUNNEL.length);
    filled.forEach((el, i) => expect(el.fill).toBe(rampFill(i)));
    // 缺省即 filled：显式 filled 产物一致。
    const explicit = shapes(expand({ name: "funnel", items: FUNNEL, form: "filled" }).elements);
    expect(explicit.map((el) => el.fill)).toEqual(filled.map((el) => el.fill));
    // 逐级收窄。
    expect(filled[0]!.w).toBeGreaterThan(filled[FUNNEL.length - 1]!.w);

    const tint = shapes(expand({ name: "funnel", items: FUNNEL, form: "tint" }).elements);
    expect(tint.every((el) => el.fill === mixHex(t.colors.primary, t.colors.background, 0.88))).toBe(true);
    const outline = shapes(expand({ name: "funnel", items: FUNNEL, form: "outline" }).elements);
    expect(outline.every((el) => el.fill === "#00000000" && el.stroke?.color === t.colors.text)).toBe(true);
  });

  it("calloutBox form bar | panel | tint", () => {
    const t = theme();
    const bar = shapes(expand({ name: "calloutBox", text: "冷萃是三年内唯一兼具增速与毛利的赛道。" }).elements);
    expect(bar.some((el) => el.shape === "rect" && el.w === 6 && el.fill === t.colors.primary)).toBe(true);

    const cardTheme = { decoration: { cardShadow: "soft" as const } };
    const panel = expand({ name: "calloutBox", text: "冷萃是三年内唯一兼具增速与毛利的赛道。", form: "panel" }, cardTheme);
    const panelGround = shapes(panel.elements).find((el) => el.shape === "roundRect");
    expect(panelGround?.fill).toBe(panel.theme.colors.cardSurface);
    expect(shapes(panel.elements).some((el) => el.shape === "rect" && el.w === 4)).toBe(false);

    const tint = shapes(expand({ name: "calloutBox", text: "冷萃是三年内唯一兼具增速与毛利的赛道。", form: "tint" }).elements);
    const soft = mixHex(t.colors.primary, t.colors.background, 0.88);
    expect(tint.some((el) => el.shape === "roundRect" && el.fill === soft)).toBe(true);
  });

  it("cycle marker number（缺省） | dot", () => {
    const t = theme();
    // 缺省即编号节点：强调色圆底 + 反白衬线数字。
    const numbered = shapes(expand({ name: "cycle", items: CYCLE }).elements);
    const badges = numbered.filter((el) => Array.isArray(el.paragraphs));
    expect(badges).toHaveLength(CYCLE.length);
    expect(badges.every((el) => el.fill === t.colors.primary)).toBe(true);
    expect(badges[0]!.paragraphs![0]!.runs[0]!.text).toBe("1");
    // dot 变体：环 + 每节点一个实心点。
    const dot = shapes(expand({ name: "cycle", items: CYCLE, marker: "dot" }).elements);
    const markers = dot.filter((el) => el.shape === "ellipse" && !el.paragraphs);
    expect(markers).toHaveLength(CYCLE.length + 1); // 环 + 每节点点
    expect(markers.filter((el) => el.fill === t.colors.primary)).toHaveLength(CYCLE.length);
  });

  it("progress fill ink | primary", () => {
    const t = theme();
    const bars = (els: SpecElement[]) => shapes(els).filter((el) => el.shape === "roundRect" && el.h >= 8);
    const ink = bars(expand({ name: "progress", items: PROGRESS }).elements);
    expect(ink).toHaveLength(PROGRESS.length * 2); // 轨道 + 前景交替
    expect(ink[1]!.fill).toBe(t.colors.text);
    const primary = bars(expand({ name: "progress", items: PROGRESS, fill: "primary" }).elements);
    expect(primary[1]!.fill).toBe(t.colors.primary);
  });
});
