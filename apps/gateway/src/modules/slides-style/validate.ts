/**
 * StyleParams 的校验、钳制与缺省合成。
 *
 * styler 子代理的输出只信一半：结构对、值域对才收，色值归一小写、
 * 字号钳进引擎区间、字体必须是词表内。任何缺失字段用确定性缺省
 * （defaultStyleParams 从聚类角色一步合成完整基线）兜住——styler
 * 是「复核与微调」，不是唯一产出方，链路离了它也能出参数。
 */

import type {
  StyleComposition,
  StyleDecoration,
  StyleParams,
  StylePalette,
  StyleTypography,
} from "./types.js";
import { normalizeStyleHex } from "./types.js";
import type { PaletteRoles, Rgb } from "./extract.js";
import { TYPE_TOKENS, type TypeToken } from "../slides-layout/theme.js";
import { ensureSeriesVisible, guardPalette } from "../slides-layout/color-guard.js";
import {
  contrast,
  hexToRgb,
  luminance,
  mix,
  rgbToHex,
  saturation,
} from "./extract.js";

/** 引擎可用字体词表（macOS 内置栈；styler 只能从这里选）。 */
export const STYLE_FONT_OPTIONS = [
  "PingFang SC",
  "Inter, PingFang SC",
  "Hiragino Sans GB, PingFang SC",
  "Songti SC, Georgia",
  "Georgia, Times New Roman",
  "Yuanti SC",
] as const;
const DEFAULT_FONT = "PingFang SC";

/** layout 技能预设 id 形态（P1a / T3 / D2 / F6 / R1…）。 */

/** 构图家族词表与用户可读名（风格卡 effectLines / 预设缩略图复用）。 */
export const STYLE_COMPOSITIONS = ["swiss", "editorial", "poster", "immersive"] as const;

export const COMPOSITION_LABELS: Record<StyleComposition, string> = {
  swiss: "瑞士网格",
  editorial: "杂志编辑",
  poster: "海报大字",
  immersive: "沉浸大图",
};

/** 候选 composition 缺失/重复时的确定性补位顺序。 */
export const COMPOSITION_FILL_ORDER: readonly StyleComposition[] = ["swiss", "editorial", "poster", "immersive"];

/**
 * 构图效果文案（effectLines 规范：只写达成效果，无来源说明）。
 */
const COMPOSITION_EFFECT_LINES: Record<StyleComposition, string> = {
  swiss: "整篇严格网格对齐，版面秩序统一",
  editorial: "不对称分栏与大留白，杂志编辑式排版",
  poster: "每页一个超大字或大数字，重点极醒目",
  immersive: "大图与深底主导，沉浸式氛围",
};

export function isStyleComposition(value: unknown): value is StyleComposition {
  return typeof value === "string" && (STYLE_COMPOSITIONS as readonly string[]).includes(value);
}

/**
 * 构图家族缺失/非法时的确定性推导（幂等：只依赖归一后的 palette 与字体，
 * 第二次归一看到合法值直接保留）。immersive 不参与推导——它只来自用户挑图。
 */
function deriveComposition(palette: StylePalette, fontHeading: string): StyleComposition {
  if (luminance(hexToRgb(palette.background)) < 0.35) return "poster";
  if (fontHeading.includes("Songti") || fontHeading.includes("Georgia")) return "editorial";
  return "swiss";
}

/** 风格卡效果行追加构图条目（幂等：已有「构图：」行不重复；超上限替换末条）。 */
export function appendCompositionEffectLine(effectLines: string[], composition: StyleComposition): string[] {
  const line = `构图：${COMPOSITION_LABELS[composition]}——${COMPOSITION_EFFECT_LINES[composition]}`;
  if (effectLines.some((item) => item.startsWith("构图："))) return effectLines;
  if (effectLines.length >= 10) return [...effectLines.slice(0, 9), line];
  return [...effectLines, line];
}

function clampNumber(value: unknown, min: number, max: number, field: string, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  if (parsed < min || parsed > max) {
    throw new Error(`风格字段 ${field} 越界：${String(parsed)}（允许 ${String(min)}~${String(max)}）`);
  }
  return parsed;
}

function optionalHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`风格色值 ${field} 缺失`);
  return normalizeStyleHex(value, field);
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`风格字段 ${field} 越界：${JSON.stringify(value)}`);
  }
  return value as T;
}

function font(value: unknown, field: string): string {
  if (typeof value === "string" && (STYLE_FONT_OPTIONS as readonly string[]).includes(value)) return value;
  throw new Error(`风格字体 ${field} 不在词表内：${JSON.stringify(value)}`);
}

/** 主色渐次与强调色；同色强调时保留三档，不重复系列色。 */
export function deriveChartSeries(primary: string, accent: string, background: string): string[] {
  const p = hexToRgb(primary);
  const bg = hexToRgb(background);
  const ac = hexToRgb(accent);
  return [...new Set([
    primary,
    rgbToHex(mix(p, bg, 0.3)),
    rgbToHex(mix(p, bg, 0.55)),
    accent,
    rgbToHex(mix(ac, bg, 0.3)),
  ])];
}

/**
 * 色板关系闸门（美学硬约束的确定性修复层）。
 * 单个色号合法不等于整块色板可用：正文压底色对比不足、主色艳到廉价、
 * 强调色不可读、卡面与页底无层次——这些关系问题不整体打回（会丢掉
 * styler 的整体意图），而是逐项修复并记录，修复本身确定性可复现。
 */
const PRIMARY_SATURATION_CAP = 0.72;
const ACCENT_SATURATION_CAP = 0.8;
const INK: Rgb = { r: 17, g: 17, b: 17 };
const PURE_WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** HSV 降饱和（保明度）：往同明度灰混，S(1-t)=cap 闭式解一步到位。 */
function desaturateToCap(rgb: Rgb, cap: number): Rgb {
  const s = saturation(rgb);
  if (s <= cap) return rgb;
  const m = Math.max(rgb.r, rgb.g, rgb.b);
  if (m <= 0) return rgb;
  return mix(rgb, { r: m, g: m, b: m }, Math.min(1, 1 - cap / s));
}

/** 朝指定方向步进混色，直到与底色对比度达标；到头仍不达标给终值（纯黑/白几乎总能过）。 */
function stepToContrast(rgb: Rgb, bg: Rgb, target: number, toward: Rgb): Rgb {
  let best = rgb;
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    best = mix(rgb, toward, t);
    if (contrast(best, bg) >= target) return best;
  }
  return best;
}

/** 卡面色标准推导：按底色明暗定方向与档位；flat（无描边无阴影）时加大档位保分离。 */
function surfaceTarget(bg: Rgb, flat: boolean): Rgb {
  const bgL = luminance(bg);
  // 深底的 WCAG 亮度对混白不敏感（非线性），档位给大些才落得进层次带。
  if (bgL < 0.35) return mix(bg, PURE_WHITE, flat ? 0.18 : 0.09);
  if (bgL >= 0.96) return mix(bg, { r: 34, g: 34, b: 38 }, flat ? 0.05 : 0.025);
  return mix(bg, PURE_WHITE, flat ? 0.85 : 0.6);
}

export function sanitizePaletteRelations(
  palette: StylePalette,
  decoration: StyleDecoration,
  notes: string[] = [],
): StylePalette {
  const bg = hexToRgb(palette.background);
  const lightBg = luminance(bg) >= 0.35;

  let primary = hexToRgb(palette.primary);
  if (saturation(primary) > PRIMARY_SATURATION_CAP) {
    primary = desaturateToCap(primary, PRIMARY_SATURATION_CAP);
    notes.push(`primary 饱和度超过 ${String(PRIMARY_SATURATION_CAP)}，已降饱和（保明度）`);
  }
  if (lightBg && contrast(primary, bg) < 3) {
    primary = stepToContrast(primary, bg, 3, INK);
    notes.push("primary 与浅底对比度不足 3:1（浅底页标题用主色），已加深");
  }

  let accent = hexToRgb(palette.accent);
  if (saturation(accent) > ACCENT_SATURATION_CAP) {
    accent = desaturateToCap(accent, ACCENT_SATURATION_CAP);
    notes.push(`accent 饱和度超过 ${String(ACCENT_SATURATION_CAP)}，已降饱和`);
  }
  if (contrast(accent, bg) < 2.5) {
    accent = stepToContrast(accent, bg, 2.5, lightBg ? INK : PURE_WHITE);
    notes.push("accent 与底色对比度不足 2.5:1，已加深/提亮");
  }

  let text = hexToRgb(palette.text);
  if (contrast(text, bg) < 4.5) {
    text = stepToContrast(text, bg, 4.5, lightBg ? INK : PURE_WHITE);
    notes.push("text 与底色对比度不足 4.5:1，已加深/提亮");
  }

  let textMuted = hexToRgb(palette.textMuted);
  if (contrast(textMuted, bg) < 3) {
    for (let t = 0.1; t <= 1.0001; t += 0.1) {
      textMuted = mix(textMuted, text, t);
      if (contrast(textMuted, bg) >= 3) break;
    }
    notes.push("textMuted 与底色对比度不足 3:1，已向正文色拉近");
  }

  let onDarkText = hexToRgb(palette.onDarkText);
  const deepCover = mix(primary, INK, 0.75);
  if (contrast(onDarkText, deepCover) < 3.5) {
    onDarkText = stepToContrast(onDarkText, deepCover, 3.5, PURE_WHITE);
    notes.push("onDarkText 在深底封面上对比度不足 3.5:1，已提亮");
  }

  const flat = decoration.cardShadow === "none" && decoration.cardStroke == null;
  const bgL = luminance(bg);
  const sL = luminance(hexToRgb(palette.surface));
  const whiteBg = lightBg && bgL >= 0.96;
  const delta = whiteBg ? bgL - sL : sL - bgL;
  const minDelta = flat ? (lightBg ? 0.05 : 0.03) : (lightBg ? 0.03 : 0.015);
  const maxDelta = lightBg ? 0.3 : 0.14;
  const surfaceHex = delta >= minDelta && delta <= maxDelta
    ? palette.surface
    : rgbToHex(surfaceTarget(bg, flat));
  if (surfaceHex !== palette.surface) {
    notes.push(whiteBg
      ? "surface 与白色页底层次不足（或跳档过大），已按底色重推卡面色"
      : "surface 与页底层次越界（无描边无阴影时要求更宽档位），已按底色重推卡面色");
  }

  return {
    ...palette,
    primary: rgbToHex(primary),
    accent: rgbToHex(accent),
    text: rgbToHex(text),
    textMuted: rgbToHex(textMuted),
    onDarkText: rgbToHex(onDarkText),
    surface: surfaceHex,
  };
}

export function normalizeStyleParams(raw: unknown, notes: string[] = []): StyleParams {
  if (!raw || typeof raw !== "object") throw new Error("风格参数必须是对象");
  const row = raw as Record<string, unknown>;

  const paletteRow = row.palette as Record<string, unknown> | undefined;
  if (!paletteRow) throw new Error("风格参数缺少 palette");
  const explicitChartSeries = Array.isArray(paletteRow.chartSeries) && paletteRow.chartSeries.length >= 3
    ? (paletteRow.chartSeries as unknown[]).slice(0, 6).map((item, index) => optionalHex(item, `chartSeries[${String(index)}]`))
    : null;
  const basePalette: StylePalette = {
    background: optionalHex(paletteRow.background, "palette.background"),
    surface: optionalHex(paletteRow.surface, "palette.surface"),
    primary: optionalHex(paletteRow.primary, "palette.primary"),
    accent: optionalHex(paletteRow.accent, "palette.accent"),
    text: optionalHex(paletteRow.text, "palette.text"),
    textMuted: optionalHex(paletteRow.textMuted, "palette.textMuted"),
    onDarkText: optionalHex(paletteRow.onDarkText, "palette.onDarkText"),
    chartSeries: [],
  };

  const typoRow = row.typography as Record<string, unknown> | undefined;
  const sizesRow = (typoRow?.sizes ?? {}) as Record<string, unknown>;
  const typography: StyleTypography = {
    fontHeading: font(typoRow?.fontHeading ?? DEFAULT_FONT, "typography.fontHeading"),
    fontBody: font(typoRow?.fontBody ?? DEFAULT_FONT, "typography.fontBody"),
    sizes: {
      coverTitle: clampNumber(sizesRow.coverTitle, 40, 110, "sizes.coverTitle", 64),
      sectionTitle: clampNumber(sizesRow.sectionTitle, 28, 60, "sizes.sectionTitle", 40),
      pageTitle: clampNumber(sizesRow.pageTitle, 20, 40, "sizes.pageTitle", 28),
      subtitle: clampNumber(sizesRow.subtitle, 14, 24, "sizes.subtitle", 18),
      body: clampNumber(sizesRow.body, 12, 18, "sizes.body", 14),
      caption: clampNumber(sizesRow.caption, 9, 13, "sizes.caption", 11),
      kpi: clampNumber(sizesRow.kpi, 28, 90, "sizes.kpi", 44),
      table: clampNumber(sizesRow.table, 9, 24, "sizes.table", 13),
    },
    ...((): { typeScale?: Partial<Record<TypeToken, number>> } => {
      const row = typoRow?.typeScale as Record<string, unknown> | undefined;
      if (!row) return {};
      const scale: Partial<Record<TypeToken, number>> = {};
      for (const token of TYPE_TOKENS) {
        const value = row[token];
        if (typeof value === "number" && Number.isFinite(value)) {
          scale[token] = clampNumber(value, 9, 120, `typeScale.${token}`, value);
        }
      }
      return Object.keys(scale).length > 0 ? { typeScale: scale } : {};
    })(),
    headingBold: typeof typoRow?.headingBold === "boolean" ? typoRow.headingBold : true,
  };

  const spacingRow = (row.spacing ?? {}) as Record<string, unknown>;
  const spacing = {
    margin: clampNumber(spacingRow.margin, 32, 96, "spacing.margin", 60),
    gutter: clampNumber(spacingRow.gutter, 8, 40, "spacing.gutter", 20),
    cardPadding: clampNumber(spacingRow.cardPadding, 8, 32, "spacing.cardPadding", 16),
    cornerRadius: clampNumber(spacingRow.cornerRadius, 0, 32, "spacing.cornerRadius", 8),
  };

  const decoRow = (row.decoration ?? {}) as Record<string, unknown>;
  const decoration: StyleDecoration = {
    cardStroke: decoRow.cardStroke == null ? null : optionalHex(decoRow.cardStroke, "decoration.cardStroke"),
    cardStrokeWidthPt: clampNumber(decoRow.cardStrokeWidthPt ?? 0.75, 0.25, 3, "decoration.cardStrokeWidthPt", 0.75),
    cardShadow: optionalEnum(decoRow.cardShadow ?? "none", ["none", "soft", "medium", "strong"] as const, "decoration.cardShadow"),
    divider: optionalEnum(decoRow.divider ?? "line", ["line", "none"] as const, "decoration.divider"),
    imageFit: optionalEnum(decoRow.imageFit ?? "cover", ["cover", "contain"] as const, "decoration.imageFit"),
  };

  // 颜色守门（C1/C2/C4/C5）：先压大面积饱和、再按对比度与明度差修，**色相全部保留**。
  // 放在 sanitizePaletteRelations 之前：它会改写底色（降饱和），卡面与图元必须按新底色重推。
  const guarded = guardPalette({
    background: basePalette.background,
    surface: basePalette.surface,
    primary: basePalette.primary,
    accent: basePalette.accent,
    text: basePalette.text,
    textMuted: basePalette.textMuted,
    onDarkText: basePalette.onDarkText,
  });
  notes.push(...guarded.notes);

  const palette = sanitizePaletteRelations({ ...basePalette, ...guarded.palette }, decoration, notes);
  palette.chartSeries = explicitChartSeries
    ?? deriveChartSeries(palette.primary, palette.accent, palette.background);
  // 系列色不参与色板推导，但要保证每一条在底色上看得见（暗红柱压深红底就是这一步拦住的）。
  const seriesGuard = ensureSeriesVisible(palette.chartSeries, palette.background);
  palette.chartSeries = seriesGuard.series;
  notes.push(...seriesGuard.notes);

  const motifRow = (row.motif ?? {}) as Record<string, unknown>;
  const motifSpecRaw = (motifRow.spec ?? {}) as Record<string, unknown>;
  const motifSpec: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(motifSpecRaw).slice(0, 6)) {
    if (typeof value === "string" || typeof value === "number") motifSpec[key] = value;
  }

  const effectLines = Array.isArray(row.effectLines)
    ? (row.effectLines as unknown[])
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim().slice(0, 120))
      .slice(0, 10)
    : [];

  const composition = isStyleComposition(row.composition)
    ? row.composition
    : deriveComposition(palette, typography.fontHeading);

  return {
    palette,
    typography,
    spacing,
    decoration,
    motif: {
      kind: optionalEnum(motifRow.kind ?? "none",
        ["ghost-number", "ghost-word", "color-band", "corner-accent", "none"] as const, "motif.kind"),
      spec: motifSpec,
    },
    darkCover: typeof row.darkCover === "boolean" ? row.darkCover : luminance(hexToRgb(palette.background)) < 0.35,
    effectLines,
    composition,
  };
}

/** 从聚类角色一步合成完整合法基线（styler 缺省/失败时的兜底，也是自校起点）。 */
export function defaultStyleParams(
  roles: PaletteRoles,
  options: { cornerRadius?: number; shadow?: StyleDecoration["cardShadow"] } = {},
): StyleParams {
  return normalizeStyleParams({
    palette: {
      background: roles.background,
      surface: roles.surface,
      primary: roles.primary,
      accent: roles.accent,
      text: roles.text,
      textMuted: roles.textMuted,
      onDarkText: roles.onDarkText,
      chartSeries: deriveChartSeries(roles.primary, roles.accent, roles.background),
    },
    typography: {
      fontHeading: DEFAULT_FONT,
      fontBody: DEFAULT_FONT,
      sizes: {},
      headingBold: true,
    },
    spacing: {
      margin: 60,
      gutter: 20,
      cardPadding: 16,
      cornerRadius: options.cornerRadius ?? 8,
    },
    decoration: {
      cardStroke: null,
      cardStrokeWidthPt: 0.75,
      cardShadow: options.shadow ?? "none",
      divider: "line",
      imageFit: "cover",
    },
    motif: { kind: "none", spec: {} },
    darkCover: roles.darkCover,
    effectLines: [],
  });
}
