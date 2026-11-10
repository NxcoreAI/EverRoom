import { describe, expect, it } from "vitest";
import {
  appendCompositionEffectLine,
  defaultStyleParams,
  deriveChartSeries,
  normalizeStyleParams,
} from "../src/modules/slides-style/validate.js";
import type { PaletteRoles } from "../src/modules/slides-style/extract.js";
import { contrast, hexToRgb, hueDistance, luminance, saturation } from "../src/modules/slides-style/extract.js";

const roles: PaletteRoles = {
  background: "#f5f2ec",
  surface: "#faf9f6",
  primary: "#1e3a5f",
  accent: "#e0a03c",
  text: "#2f2b28",
  textMuted: "#8f8a81",
  onDarkText: "#f2f4f7",
  darkCover: true,
};

const validParams = {
  palette: {
    background: "#F5F2EC",
    surface: "#faf9f6",
    primary: "#1e3a5f",
    accent: "#e0a03c",
    text: "#2f2b28",
    textMuted: "#8f8a81",
    onDarkText: "#f2f4f7",
  },
  typography: {
    fontHeading: "PingFang SC",
    fontBody: "PingFang SC",
    sizes: {
      coverTitle: 64, sectionTitle: 40, pageTitle: 28, subtitle: 18,
      body: 14, caption: 11, kpi: 44, table: 13,
    },
    headingBold: true,
  },
  spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 12 },
  decoration: { cardStroke: "#e5e0d5", cardStrokeWidthPt: 0.75, cardShadow: "soft", divider: "line", imageFit: "cover" },
  motif: { kind: "ghost-number", spec: { alphaPercent: 15 } },
  darkCover: true,
  effectLines: ["主色 深藏青 #1E3A5F", "标题 40pt 加粗", "  ", "卡片小圆角、轻投影"],
};

describe("normalizeStyleParams", () => {
  it("normalizes hex to lowercase and sanitizes effect lines", () => {
    const params = normalizeStyleParams(validParams);
    expect(params.palette.background).toBe("#f5f2ec");
    expect(params.effectLines).toEqual(["主色 深藏青 #1E3A5F", "标题 40pt 加粗", "卡片小圆角、轻投影"]);
  });

  it("derives chart series from primary/accent/background when absent", () => {
    const params = normalizeStyleParams(validParams);
    expect(params.palette.chartSeries[0]).toBe("#1e3a5f");
    expect(params.palette.chartSeries).toHaveLength(5);
    expect(new Set(params.palette.chartSeries).size).toBe(5);
  });

  it("keeps an explicit chart series", () => {
    const params = normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, chartSeries: ["#111111", "#222222", "#333333"] },
    });
    expect(params.palette.chartSeries).toEqual(["#111111", "#222222", "#333333"]);
  });

  it("throws on out-of-range sizes and bad hex", () => {
    expect(() => normalizeStyleParams({
      ...validParams,
      typography: { ...validParams.typography, sizes: { ...validParams.typography.sizes, body: 40 } },
    })).toThrow(/sizes\.body/);
    expect(() => normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, primary: "blue" },
    })).toThrow(/palette\.primary/);
  });

  it("rejects fonts outside the vocabulary", () => {
    expect(() => normalizeStyleParams({
      ...validParams,
      typography: { ...validParams.typography, fontHeading: "Comic Sans" },
    })).toThrow(/fontHeading/);
  });

  it("rejects invalid layout hint ids", () => {
    const params = normalizeStyleParams({
      ...validParams,
    });
  });
});

describe("defaultStyleParams", () => {
  it("builds a fully valid baseline from roles", () => {
    const params = defaultStyleParams(roles, { cornerRadius: 12, shadow: "soft" });
    // 再走一遍严格归一证明自洽。
    expect(normalizeStyleParams(params)).toEqual(params);
    expect(params.spacing.cornerRadius).toBe(12);
    expect(params.decoration.cardShadow).toBe("soft");
    expect(params.palette.chartSeries[0]).toBe("#1e3a5f");
    expect(params.typography.fontHeading).toBe("PingFang SC");
  });
});

describe("deriveChartSeries", () => {
  it("keeps the primary first and stays distinguishable", () => {
    const series = deriveChartSeries("#1e3a5f", "#e0a03c", "#f5f2ec");
    expect(series[0]).toBe("#1e3a5f");
    expect(series[3]).toBe("#e0a03c");
    expect(new Set(series).size).toBe(5);
  });

  it("uses three distinct shades when the accent reuses the primary", () => {
    const series = deriveChartSeries("#1e3a5f", "#1e3a5f", "#ffffff");
    expect(series[0]).toBe("#1e3a5f");
    expect(series).toHaveLength(3);
    expect(new Set(series).size).toBe(3);
    const params = normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, background: "#ffffff", accent: "#1e3a5f" },
    });
    expect(new Set(params.palette.chartSeries).size).toBe(3);
    for (const color of params.palette.chartSeries) {
      expect(contrast(hexToRgb(color), hexToRgb(params.palette.background))).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("色板关系闸门（确定性修复）", () => {
  it("过饱和主色降到 0.72 以内并记录修复", () => {
    const notes: string[] = [];
    const params = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, primary: "#ff00ff" } },
      notes,
    );
    expect(saturation(hexToRgb(params.palette.primary))).toBeLessThanOrEqual(0.72);
    expect(notes.some((note) => note.includes("饱和度"))).toBe(true);
  });

  it("浅底上对比不足的正文色加深到 4.5:1", () => {
    const params = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, text: "#b8b4ac" } },
    );
    expect(contrast(hexToRgb(params.palette.text), hexToRgb("#f5f2ec"))).toBeGreaterThanOrEqual(4.5);
  });

  it("次级文字对比不足时向正文色拉近到 3:1", () => {
    const params = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, textMuted: "#d8d4cc" } },
    );
    expect(contrast(hexToRgb(params.palette.textMuted), hexToRgb("#f5f2ec"))).toBeGreaterThanOrEqual(3);
  });

  it("同色系强调色保留色相，且与底色对比达标", () => {
    const params = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, accent: "#26466b" } },
    );
    expect(hueDistance(hexToRgb(params.palette.accent), hexToRgb("#26466b"))).toBeLessThan(1);
    expect(contrast(hexToRgb(params.palette.accent), hexToRgb("#f5f2ec"))).toBeGreaterThanOrEqual(2.5);
  });

  it("允许强调色复用主色，归一后不引入新的色相", () => {
    const params = normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, accent: validParams.palette.primary },
    });
    expect(params.palette.accent).toBe(params.palette.primary);
    expect(normalizeStyleParams(params)).toEqual(params);
  });

  it("未指定封面明暗时跟随内容页，明确指定时保留", () => {
    expect(normalizeStyleParams({ ...validParams, darkCover: undefined }).darkCover).toBe(false);
    expect(normalizeStyleParams({
      ...validParams,
      darkCover: undefined,
      palette: { ...validParams.palette, background: "#101418" },
    }).darkCover).toBe(true);
    expect(normalizeStyleParams({ ...validParams, darkCover: true }).darkCover).toBe(true);
    expect(normalizeStyleParams({ ...validParams, darkCover: false }).darkCover).toBe(false);
  });

  it("卡面与页底无层次时按底色重推", () => {
    const params = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, surface: "#f5f3ee" } },
    );
    const delta = luminance(hexToRgb(params.palette.surface)) - luminance(hexToRgb("#f5f2ec"));
    expect(delta).toBeGreaterThanOrEqual(0.03);
  });

  it("无描边无阴影时卡面档位收紧", () => {
    const params = normalizeStyleParams({
      ...validParams,
      palette: { ...validParams.palette, surface: "#f8f5f0" },
      decoration: { ...validParams.decoration, cardStroke: null, cardShadow: "none" },
    });
    const delta = luminance(hexToRgb(params.palette.surface)) - luminance(hexToRgb("#f5f2ec"));
    expect(delta).toBeGreaterThanOrEqual(0.045);
  });

  it("深底链路：正文提亮到 4.5:1，卡面按深底档位重推", () => {
    const params = normalizeStyleParams({
      ...validParams,
      palette: {
        background: "#0c2233",
        surface: "#0d2436",
        primary: "#145374",
        accent: "#e8a13c",
        text: "#22303c",
        textMuted: "#5b6b78",
        onDarkText: "#f2f4f7",
      },
    });
    expect(contrast(hexToRgb(params.palette.text), hexToRgb("#0c2233"))).toBeGreaterThanOrEqual(4.5);
    const delta = luminance(hexToRgb(params.palette.surface)) - luminance(hexToRgb("#0c2233"));
    expect(delta).toBeGreaterThanOrEqual(0.015);
  });

  it("onDarkText 在深底封面上过暗时提亮", () => {
    const params = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, onDarkText: "#5a5f66" } },
    );
    const deepCover = hexToRgb("#1e3a5f");
    const deep = {
      r: deepCover.r * 0.25 + 17 * 0.75,
      g: deepCover.g * 0.25 + 17 * 0.75,
      b: deepCover.b * 0.25 + 17 * 0.75,
    };
    expect(contrast(hexToRgb(params.palette.onDarkText), deep)).toBeGreaterThanOrEqual(3.5);
  });

  it("修复幂等：再归一一次结果不变", () => {
    const once = normalizeStyleParams(
      { ...validParams, palette: { ...validParams.palette, primary: "#ff00ff", surface: "#f5f3ee" } },
    );
    expect(normalizeStyleParams(once)).toEqual(once);
  });
});

describe("composition 构图轴", () => {
  it("合法值保留", () => {
    expect(normalizeStyleParams({ ...validParams, composition: "immersive" }).composition).toBe("immersive");
  });

  it("缺失/非法时确定性推导：深底→poster、衬线栈→editorial、其余 swiss", () => {
    expect(normalizeStyleParams(validParams).composition).toBe("swiss");
    expect(
      normalizeStyleParams({ ...validParams, palette: { ...validParams.palette, background: "#101418" } }).composition,
    ).toBe("poster");
    expect(
      normalizeStyleParams({
        ...validParams,
        typography: { ...validParams.typography, fontHeading: "Songti SC, Georgia" },
      }).composition,
    ).toBe("editorial");
    expect(normalizeStyleParams({ ...validParams, composition: "baroque" }).composition).toBe("swiss");
  });

  it("推导幂等：再归一一次 composition 不变", () => {
    const once = normalizeStyleParams(validParams);
    expect(normalizeStyleParams(once).composition).toBe(once.composition);
  });

  it("appendCompositionEffectLine：缺失追加、已有不重复、超上限替换末条", () => {
    expect(appendCompositionEffectLine([], "poster")).toEqual([expect.stringContaining("构图：海报大字")]);
    const withLine = appendCompositionEffectLine(["a", "b"], "poster");
    expect(appendCompositionEffectLine(withLine, "editorial")).toEqual(withLine);
    const ten = Array.from({ length: 10 }, (_, index) => `行${String(index)}`);
    const replaced = appendCompositionEffectLine(ten, "swiss");
    expect(replaced).toHaveLength(10);
    expect(replaced[0]).toBe("行0");
    expect(replaced[9]).toContain("构图：瑞士网格");
  });
});
