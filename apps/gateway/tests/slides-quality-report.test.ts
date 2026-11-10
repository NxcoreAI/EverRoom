import { describe, expect, it } from "vitest";
import {
  deckQualityReport,
  inkChars,
  minTextContrast,
  paletteMetrics,
  proseChars,
  type ReportPage,
} from "../src/modules/slides-layout/quality-report.js";
import { resolveTheme } from "../src/modules/slides-layout/theme.js";
import { COLOR_RULES } from "../src/modules/slides-layout/color-guard.js";

const theme = resolveTheme({}, "internal-review");

const pages: ReportPage[] = [
  {
    form: "single-fact",
    role: "data",
    copy: { message: "从 2.7 亿到 3.87 万亿", facts: [{ label: "1980 年", value: "2.7", unit: "亿元" }], source: "统计公报" },
  },
  {
    form: "breakdown",
    role: "content",
    copy: { message: "蛇口拉开帷幕", supporting: ["不足千人的村镇", "建港填海", "1979—1980"], source: "深圳市志" },
  },
];

describe("字数统计口径", () => {
  it("叙事字数与预算同口径：只数主张/支撑句/引文，不算空格", () => {
    expect(proseChars({ copy: { message: "一二 三" } })).toBe(3);
    expect(proseChars({ copy: { source: "统计公报" } })).toBe(0);
    expect(proseChars({ copy: { message: "主张", supporting: ["支撑一句"] } })).toBe(6);
    expect(proseChars({})).toBe(0);
  });

  it("墨量字数含 kicker/事实/来源/引文出处（小字都算进来）", () => {
    expect(inkChars({ copy: { source: "统计公报" } })).toBe(4);
    expect(inkChars({ copy: { kicker: "45 年", facts: [{ label: "1980 年 GDP", value: "2.7", unit: "亿元" }] } }))
      .toBe(2 + 9 + 3 + 2);
  });

  it("两者之差就是小字量", () => {
    const page: ReportPage = {
      copy: {
        kicker: "45 年 · 经济总量",
        message: "从 2.7 亿到 3.87 万亿元",
        source: "数据来源：2025 年统计公报。",
      },
    };
    expect(inkChars(page) - proseChars(page)).toBe(inkChars(page) - 13);
  });
});

describe("色板指标", () => {
  it("好色板全部达标", () => {
    const metrics = paletteMetrics(theme.colors);
    expect(metrics.minContrast).toBeGreaterThanOrEqual(COLOR_RULES.graphicContrast);
    expect(metrics.backgroundSaturation).toBeLessThanOrEqual(COLOR_RULES.largeAreaSaturation);
    expect(metrics.passesContrast).toBe(true);
  });

  it("红墙色板会同时踩中对比度与饱和度", () => {
    const metrics = paletteMetrics({
      ...theme.colors,
      background: "#8e0e12",
      text: "#c98f7e",
      textMuted: "#a5151a",
    });
    expect(metrics.passesContrast).toBe(false);
    expect(metrics.backgroundSaturation).toBeGreaterThan(COLOR_RULES.largeAreaSaturation);
  });
});

describe("整册报告", () => {
  it("按场景给出字号基准与平均字数", () => {
    const report = deckQualityReport({ pages, theme });
    expect(report.pageCount).toBe(2);
    expect(report.minFontPt).toBe(theme.typeScale.caption);
    expect(report.bodyFontPt).toBe(theme.typeScale.body);
    expect(report.forms).toEqual(["single-fact", "breakdown"]);
    expect(report.avgProseChars).toBeGreaterThan(5);
    expect(report.failures).toEqual([]);
  });

  it("超预算页被点名（含实际字数与预算）", () => {
    const report = deckQualityReport({ pages, theme, budgetFor: () => 5 });
    expect(report.overBudget).toHaveLength(2);
    expect(report.overBudget[0]!.budget).toBe(5);
    expect(report.failures.some((line) => line.includes("超出字数预算"))).toBe(true);
  });

  it("投影档与研读档给出不同字号基准（同一份风格卡）", () => {
    const far = deckQualityReport({ pages, theme: resolveTheme({}, "keynote") });
    const near = deckQualityReport({ pages, theme: resolveTheme({}, "reading") });
    expect(far.minFontPt).toBeGreaterThan(near.minFontPt);
    expect(far.bodyFontPt).toBeGreaterThan(near.bodyFontPt);
  });
});

describe("落页后抽检", () => {
  it("找出最不可读的文字块", () => {
    const result = minTextContrast(
      [
        { text: { runs: [{ color: "#1f1f21" }] } },
        { text: { runs: [{ color: "#8a8a8a" }, { color: "#333333" }] }, fill: "#ffffff" },
      ],
      "#ffffff",
    );
    // 最不可读的是第二个元素里的 #8a8a8a（约 3.5:1），不是第一个 #1f1f21
    expect(result.at).toBe(1);
    expect(result.ratio).toBeGreaterThan(3);
    expect(result.ratio).toBeLessThan(4.5);
  });

  it("压在同色底上的文字被算出低对比", () => {
    const result = minTextContrast([{ text: { runs: [{ color: "#6e1114" }] }, fill: "#8e0e12" }], "#ffffff");
    expect(result.ratio).toBeLessThan(2);
  });
});
