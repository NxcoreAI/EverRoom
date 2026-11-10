import { describe, expect, it } from "vitest";
import {
  COLOR_RULES,
  apcaLc,
  capSaturation,
  contrastRatio,
  deltaLstar,
  ensureSeriesVisible,
  guardPalette,
  guardToneOn,
  hueDistance,
  lstar,
  relativeLuminance,
  rgbToHsl,
} from "../src/modules/slides-layout/color-guard.js";

/**
 * 回归样本取自真实产物截图（screenshots/ppt-audit/）：
 * - 01-red-theme-data-page.png：满屏高饱和深红底 + 同色系暗红柱 + 系列色数据标签压在同色柱上
 * - 02-latest-deck-data-page.png：浅底克制版（应全部通过）
 */
const RED_WALL = {
  background: "#8e0e12",
  surface: "#a5151a",
  primary: "#6e1114",
  accent: "#e8d5a3",
  text: "#f2e7ce",
  textMuted: "#c98f7e",
  onDarkText: "#fafaf8",
};

const LIGHT_PAGE = {
  background: "#fafaf8",
  surface: "#f1f1ed",
  primary: "#3a3a3c",
  accent: "#8a7b5c",
  text: "#1f1f21",
  textMuted: "#6b6b6f",
  onDarkText: "#fafaf8",
};

describe("颜色计算基础", () => {
  it("对比度与感知明度符合 WCAG 口径", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 3);
    expect(lstar("#ffffff")).toBeCloseTo(100, 0);
    expect(lstar("#000000")).toBeCloseTo(0, 0);
  });

  it("APCA 区分正负极性（只作预警，不参与判定）", () => {
    expect(apcaLc("#000000", "#ffffff")).toBeGreaterThan(90);
    expect(apcaLc("#ffffff", "#ffffff")).toBeCloseTo(0, 1);
    // 深底浅字的极性为负，绝对值仍应够大
    expect(Math.abs(apcaLc("#ffffff", "#000000"))).toBeGreaterThan(90);
  });
});

describe("C5 大面积饱和度（图 01 的「满屏饱和深红」）", () => {
  it("底色饱和度被压到上限，色相保持不变", () => {
    const hueBefore = rgbToHsl(RED_WALL.background).h;
    const capped = capSaturation(RED_WALL.background, COLOR_RULES.largeAreaSaturation);
    const hsl = rgbToHsl(capped);
    expect(hsl.s).toBeLessThanOrEqual(COLOR_RULES.largeAreaSaturation + 1e-6);
    expect(Math.abs(hsl.h - hueBefore)).toBeLessThan(1);
  });

  it("guardPalette 对红墙色板判出 C5，并保住色相", () => {
    const result = guardPalette(RED_WALL);
    const hsl = rgbToHsl(result.palette.background);
    expect(hsl.s).toBeLessThanOrEqual(COLOR_RULES.largeAreaSaturation + 1e-6);
    // 色相没变：仍然是"同一族红"，只是不再是墙
    expect(hueDistance(result.palette.background, RED_WALL.background)).toBeLessThan(2);
    expect(result.violations.some((v) => v.rule === "C5" && v.role === "background")).toBe(true);
  });
});

describe("C1/C2 对比度（正文与图元必须在其底色上可读）", () => {
  it("正文与静音字都达到阈值", () => {
    const { palette } = guardPalette(RED_WALL);
    expect(contrastRatio(palette.text, palette.background)).toBeGreaterThanOrEqual(COLOR_RULES.bodyContrast);
    expect(contrastRatio(palette.textMuted, palette.background)).toBeGreaterThanOrEqual(COLOR_RULES.graphicContrast);
  });

  it("主色与强调色作为图元达到 3:1", () => {
    const { palette } = guardPalette(RED_WALL);
    expect(contrastRatio(palette.primary, palette.background)).toBeGreaterThanOrEqual(COLOR_RULES.graphicContrast);
    expect(contrastRatio(palette.accent, palette.background)).toBeGreaterThanOrEqual(COLOR_RULES.graphicContrast);
  });

  it("浅底克制色板不产生任何违规（避免误伤好产物）", () => {
    const result = guardPalette(LIGHT_PAGE);
    expect(result.violations).toEqual([]);
    expect(result.palette).toEqual(LIGHT_PAGE);
  });
});

describe("C4 同色相并置明度差（暗红柱压深红底）", () => {
  it("主色与底色同色相且明度太近时被拉开", () => {
    const { palette } = guardPalette(RED_WALL);
    const sameFamily = hueDistance(palette.primary, palette.background) <= 30;
    if (sameFamily) {
      expect(deltaLstar(palette.primary, palette.background)).toBeGreaterThanOrEqual(COLOR_RULES.minDeltaLstar - 1e-6);
    }
  });

  it("系列色逐条在底色上可辨，且不再有等于底色的系列", () => {
    const series = ["#6e1114", "#8e0e12", "#a5151a", "#7a1013"];
    const { series: fixed, notes } = ensureSeriesVisible(series, RED_WALL.background);
    for (const hex of fixed) {
      expect(contrastRatio(hex, capSaturation(RED_WALL.background, COLOR_RULES.largeAreaSaturation)))
        .toBeGreaterThanOrEqual(COLOR_RULES.graphicContrast - 0.05);
      expect(deltaLstar(hex, capSaturation(RED_WALL.background, COLOR_RULES.largeAreaSaturation)))
        .toBeGreaterThanOrEqual(COLOR_RULES.minDeltaLstar - 0.5);
    }
    expect(notes.length).toBeGreaterThan(0);
  });
});

describe("守门的确定性", () => {
  it("同一输入两次守门结果一致（可复现，不含随机）", () => {
    const a = guardPalette(RED_WALL).palette;
    const b = guardPalette(RED_WALL).palette;
    expect(a).toEqual(b);
  });

  it("已经达标的色板再守一次不再变化（幂等）", () => {
    const once = guardPalette(RED_WALL).palette;
    const twice = guardPalette(once).palette;
    expect(twice).toEqual(once);
  });
});

describe("节点级守门（第二册接线用，先就位）", () => {
  it("主色压在浅色 tint 板上会被替换成可读色", () => {
    const tint = "#e6e4dd";
    const primary = "#8a8f7a";
    expect(contrastRatio(primary, tint)).toBeLessThan(COLOR_RULES.bodyContrast);
    const fixed = guardToneOn(primary, tint);
    expect(contrastRatio(fixed, tint)).toBeGreaterThanOrEqual(COLOR_RULES.bodyContrast);
  });

  it("已经达标的组合原样返回", () => {
    expect(guardToneOn("#1f1f21", "#fafaf8")).toBe("#1f1f21");
  });
});

describe("亮度工具", () => {
  it("相对亮度随明度单调", () => {
    expect(relativeLuminance("#000000")).toBeLessThan(relativeLuminance("#808080"));
    expect(relativeLuminance("#808080")).toBeLessThan(relativeLuminance("#ffffff"));
  });
});
