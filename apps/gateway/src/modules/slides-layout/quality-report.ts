/**
 * 质量指标报告：把"这册 deck 到底哪里不对"从观感变成数字。
 *
 * 存在的理由：改一版 prompt 或一条阈值后，"看起来好点了"不是证据。
 * 本模块给出六个数：最小字号、低于下限的文字块数、最低正文对比度、
 * 同色相并置的最小明度差、超字数预算页数、组件种类数。
 *
 * 它只读不判：**不做修复**，修复在 scene.ts / color-guard.ts / leaf-renderers.ts。
 * 这样同一套指标既能当回归断言，也能当人工验收时的报告。
 */

import { COLOR_RULES, contrastRatio, deltaLstar, hueDistance, relativeLuminance, rgbToHsl } from "./color-guard.js";
import type { ResolvedTheme } from "./theme.js";
import type { PageForm } from "../subagents/slides-page-form.js";

/** 报告用到的页面形状：只关心字数与形态，不关心几何。 */
export interface ReportPage {
  form?: PageForm | string;
  role?: string;
  density?: "sparse" | "standard" | "dense" | string;
  copy?: {
    kicker?: string;
    message?: string;
    supporting?: string[];
    facts?: ReadonlyArray<{ label?: string; value?: string; unit?: string; body?: string; note?: string }>;
    quote?: { text?: string; attribution?: string };
    source?: string;
    speakerNotes?: string;
  };
  takeaway?: string;
}

const count = (parts: ReadonlyArray<string | undefined>): number =>
  parts.filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("")
    .replace(/\s+/g, "").length;

/**
 * 叙事字数：与字数预算**同口径**（主张 + 支撑句 + 引文）。
 * 预算约束的就是这部分：页面主角文字。
 */
export function proseChars(page: ReportPage): number {
  const copy = page.copy ?? {};
  return count([copy.message, ...(copy.supporting ?? []), copy.quote?.text]);
}

/**
 * 墨量字数：这一页**总共**印了多少字（含 kicker、事实标签/数值、引文出处、来源）。
 * 「满屏无意义小字」看的是这个数，不是叙事字数——两者差得越多，说明小字越多。
 */
export function inkChars(page: ReportPage): number {
  const copy = page.copy ?? {};
  return count([
    copy.kicker,
    copy.message,
    ...(copy.supporting ?? []),
    ...(copy.facts ?? []).flatMap((fact) => [fact.label, fact.value, fact.unit, fact.body, fact.note]),
    copy.quote?.text,
    copy.quote?.attribution,
    copy.source,
  ]);
}

export interface PaletteMetrics {
  /** 正文/静音/主色/强调色 对底色 的最小对比度。 */
  minContrast: number;
  minContrastRole: string;
  /** 同色相并置（主色 vs 底色、各系列 vs 底色）的最小 ΔL*。 */
  minDeltaLstar: number;
  minDeltaRole: string;
  /** 底色饱和度（C5 的对象）。 */
  backgroundSaturation: number;
  /** 是否有角色低于阈值。 */
  passesContrast: boolean;
  passesDeltaL: boolean;
}

const saturationOfHex = (hex: string): number => rgbToHsl(hex).s;

export function paletteMetrics(colors: ResolvedTheme["colors"]): PaletteMetrics {
  const roles: Array<[string, string]> = [
    ["text", colors.text],
    ["textMuted", colors.textMuted],
    ["primary", colors.primary],
    ["accent", colors.accent],
  ];
  let minContrast = Number.POSITIVE_INFINITY;
  let minContrastRole = "";
  for (const [role, hex] of roles) {
    const ratio = contrastRatio(hex, colors.background);
    if (ratio < minContrast) {
      minContrast = ratio;
      minContrastRole = role;
    }
  }

  let minDeltaLstar = Number.POSITIVE_INFINITY;
  let minDeltaRole = "";
  const deltaCandidates: Array<[string, string]> = [
    ["primary", colors.primary],
    ...colors.chartSeries.map((hex, index) => [`chartSeries[${String(index)}]`, hex] as [string, string]),
  ];
  for (const [role, hex] of deltaCandidates) {
    // 只有同色相并用时才存在"糊在一起"的问题；跨色相靠色相就分开了。
    if (hueDistance(hex, colors.background) > 30) continue;
    const delta = deltaLstar(hex, colors.background);
    if (delta < minDeltaLstar) {
      minDeltaLstar = delta;
      minDeltaRole = role;
    }
  }
  if (!Number.isFinite(minDeltaLstar)) {
    minDeltaLstar = 100;
    minDeltaRole = "无同色相并置";
  }

  return {
    minContrast,
    minContrastRole,
    minDeltaLstar,
    minDeltaRole,
    backgroundSaturation: saturationOfHex(colors.background),
    passesContrast: colors.textMuted ? contrastRatio(colors.textMuted, colors.background) >= COLOR_RULES.graphicContrast : true,
    passesDeltaL: minDeltaLstar >= COLOR_RULES.minDeltaLstar,
  };
}

export interface DeckQualityReport {
  pageCount: number;
  /** 场景口径的最小字号（caption/body）。 */
  minFontPt: number;
  bodyFontPt: number;
  /** 超字数预算的页（0-based）+ 实际字数。 */
  overBudget: Array<{ index: number; chars: number; budget: number }>;
  /** 每页平均叙事字数（预算口径）。 */
  avgProseChars: number;
  /** 每页平均墨量字数（含小字）；与 avgProseChars 的差越大，小字越多。 */
  avgInkChars: number;
  /** 形态覆盖（去重）。 */
  forms: string[];
  palette: PaletteMetrics;
  /** 失败项（空数组=全部达标）。 */
  failures: string[];
}

export interface DeckReportInput {
  pages: ReadonlyArray<ReportPage>;
  theme: ResolvedTheme;
  /** 每页字数预算；缺省不判超预算。 */
  budgetFor?: (page: ReportPage, index: number) => number;
}

export function deckQualityReport(input: DeckReportInput): DeckQualityReport {
  const { pages, theme, budgetFor } = input;
  const palette = paletteMetrics(theme.colors);

  const overBudget: DeckQualityReport["overBudget"] = [];
  let totalChars = 0;
  let totalInk = 0;
  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index]!;
    const chars = proseChars(page);
    totalChars += chars;
    totalInk += inkChars(page);
    if (!budgetFor) continue;
    const budget = budgetFor(page, index);
    if (chars > budget) overBudget.push({ index, chars, budget });
  }

  const forms = [...new Set(pages.map((page) => page.form).filter((form): form is string => typeof form === "string"))];

  const failures: string[] = [];
  if (theme.typeScale.caption < 10) failures.push(`最小字号 ${String(theme.typeScale.caption)}pt 低于 10pt 下限`);
  if (!palette.passesContrast) failures.push(`${palette.minContrastRole} 对底色对比度 ${palette.minContrast.toFixed(2)}:1 低于 3:1`);
  if (!palette.passesDeltaL) {
    failures.push(`${palette.minDeltaRole} 与底色同色相且明度差 ${palette.minDeltaLstar.toFixed(1)} 低于 ${String(COLOR_RULES.minDeltaLstar)}`);
  }
  if (palette.backgroundSaturation > COLOR_RULES.largeAreaSaturation) {
    failures.push(`底色饱和度 ${(palette.backgroundSaturation * 100).toFixed(0)}% 超过 ${String(COLOR_RULES.largeAreaSaturation * 100)}% 上限`);
  }
  if (overBudget.length > 0) failures.push(`${String(overBudget.length)} 页超出字数预算`);

  return {
    pageCount: pages.length,
    minFontPt: theme.typeScale.caption,
    bodyFontPt: theme.typeScale.body,
    overBudget,
    avgProseChars: pages.length === 0 ? 0 : Math.round(totalChars / pages.length),
    avgInkChars: pages.length === 0 ? 0 : Math.round(totalInk / pages.length),
    forms,
    palette,
    failures,
  };
}

/** 一页里所有文字块的最小对比度（有元素清单时才能算，用于落页后抽检）。 */
export function minTextContrast(
  elements: ReadonlyArray<{ text?: { runs?: ReadonlyArray<{ color?: string }> }; fill?: string }>,
  background: string,
): { ratio: number; at: number } {
  let ratio = Number.POSITIVE_INFINITY;
  let at = -1;
  elements.forEach((element, index) => {
    const runs = element.text?.runs ?? [];
    for (const run of runs) {
      if (!run.color) continue;
      const value = contrastRatio(run.color, element.fill ?? background);
      if (value < ratio) {
        ratio = value;
        at = index;
      }
    }
  });
  return { ratio: Number.isFinite(ratio) ? ratio : Number.POSITIVE_INFINITY, at };
}

/** 深色页判定的稳定性（颜色守门在深底页翻转时的前置条件）。 */
export function isDeepBackground(background: string): boolean {
  return relativeLuminance(background) < 0.35;
}
