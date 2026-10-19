/**
 * 预设展开的主题解析：styleParams（slides-styler 风格卡，键名以
 * agents/slides-styler/schemas/output.schema.json 为真源）→ 展开器直接可用的
 * 主题对象。styleParams 缺失时用与 layout 技能文档口径一致的缺省主题。
 * 坐标、字号、配色全部在这里定：预设描述符只管结构，不管取值。
 */

export interface StyleParamsInput {
  palette?: {
    background?: string;
    surface?: string;
    primary?: string;
    accent?: string;
    text?: string;
    textMuted?: string;
    onDarkText?: string;
    chartSeries?: string[];
  };
  typography?: {
    fontHeading?: string;
    fontBody?: string;
    sizes?: Partial<Record<
      "coverTitle" | "sectionTitle" | "pageTitle" | "subtitle" | "body" | "caption" | "kpi" | "table",
      number
    >>;
    headingBold?: boolean;
  };
  spacing?: Partial<{ margin: number; gutter: number; cardPadding: number; cornerRadius: number }>;
  decoration?: Partial<{
    cardStroke: string | null;
    cardStrokeWidthPt: number;
    cardShadow: "none" | "soft" | "medium" | "strong";
    divider: "line" | "none";
    imageFit: "cover" | "contain";
  }>;
  /** 页脚契约：缺省（未配置）不注入页脚。pageNumbers 缺省 false。 */
  footer?: Partial<{ brand: string; label: string; pageNumbers: boolean }>;
  darkCover?: boolean;
}

export interface ResolvedTheme {
  colors: {
    background: string;
    surface: string;
    primary: string;
    accent: string;
    text: string;
    textMuted: string;
    onDarkText: string;
    chartSeries: string[];
    /** 分隔线/行线：文字色向底色混 82%。 */
    divider: string;
    /** 深色页（封面/章节）背景：主色向近黑压深。 */
    darkBackground: string;
    /** 卡面：底色提亮一档（深底页略提亮）。 */
    cardSurface: string;
    /** 主色浅档（我方列提亮/当前阶段底）。 */
    primarySoft: string;
  };
  fonts: { heading: string; body: string; headingBold: boolean };
  sizes: {
    coverTitle: number;
    sectionTitle: number;
    pageTitle: number;
    subtitle: number;
    body: number;
    caption: number;
    kpi: number;
    table: number;
  };
  spacing: { margin: number; gutter: number; cardPadding: number; cornerRadius: number };
  decoration: {
    cardStroke: string | null;
    cardStrokeWidthPt: number;
    cardShadow: "none" | "soft" | "medium" | "strong";
    divider: "line" | "none";
    imageFit: "cover" | "contain";
  };
  /** 页脚契约（styleParams.footer 解析产物；未配置时 pageNumbers=false 且 brand/label 为空）。 */
  footer: { brand: string; label: string; pageNumbers: boolean };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(hex: string | undefined, fallback: string): string {
  if (typeof hex !== "string") return fallback;
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  return match ? `#${match[1]!.toLowerCase()}` : fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
}

/** a 向 b 混 mix 比例（0=a，1=b）。 */
export function mixHex(a: string, b: string, mix: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex([r1 + (r2 - r1) * mix, g1 + (g2 - g1) * mix, b1 + (b2 - b1) * mix]);
}

/** hex 追加 alpha 字节（pct 0~1 → 00~FF），产出 8 位 #RRGGBBAA。引擎 srgbClr 按透明度解析。 */
export function withAlpha(hex: string, pct: number): string {
  const byte = Math.round(clamp(pct, 0, 1) * 255);
  return `${rgbToHex(hexToRgb(hex))}${byte.toString(16).padStart(2, "0")}`;
}

/**
 * 图片双色调色对：主色染的双端（暗部=主色向近黑压深，亮部=主色向白提亮）。
 * 品牌色贯穿明暗两端，任意照片染完都落在品牌色域内。
 */
export function duotonePair(theme: ResolvedTheme): [string, string] {
  return [mixHex(theme.colors.primary, "#0B0A08", 0.72), mixHex(theme.colors.primary, "#FFFFFF", 0.88)];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function isDarkColor(hex: string): boolean {
  return luminance(hex) < 0.35;
}

/** 底色三档：深（配浅字）/ 中（浅灰静音字不可读，用正文色）/ 浅（可配静音字）。 */
export function bgTone(hex: string): "dark" | "mid" | "light" {
  const l = luminance(hex);
  return l < 0.35 ? "dark" : l < 0.72 ? "mid" : "light";
}

/**
 * 深色页组件视图：页级 dark/bg 或深色面板上的组件拿到的主题视图。
 * 页相对角色（底/字/静音/分隔线/卡面/主色浅档）按深色页底翻转，推导口径
 * 与 resolveTheme 逐条镜像；品牌角色（primary/accent）与字号间距不动——
 * 组件代码零改动感知深色页，渐隐、翻字、卡面全部自动落到深色页口径。
 */
export function darkPageTheme(theme: ResolvedTheme): ResolvedTheme {
  const bg = theme.colors.darkBackground;
  return {
    ...theme,
    colors: {
      ...theme.colors,
      background: bg,
      text: theme.colors.onDarkText,
      textMuted: mixHex(theme.colors.onDarkText, bg, 0.45),
      divider: mixHex(theme.colors.onDarkText, bg, 0.82),
      cardSurface: deriveCardSurface(bg),
      primarySoft: mixHex(theme.colors.primary, bg, 0.82),
    },
  };
}

/**
 * 卡面从页底推导：浅底提亮一档，深底略提亮（SYSTEM.md 卡片底色口径）。
 * 白底（或近白底）往白混仍停在原地——卡面与页底不可辨，组件里无描边阴影的
 * 裸形状会白上白隐形，此时退到缺省浅灰卡面。
 */
export function deriveCardSurface(background: string): string {
  if (isDarkColor(background)) return mixHex(background, "#FFFFFF", 0.12);
  const mixed = mixHex(background, "#FFFFFF", 0.55);
  return luminance(mixed) - luminance(background) < 0.03 ? DEFAULTS.palette.surface.toLowerCase() : mixed;
}

const DEFAULTS = {
  palette: {
    // 钴蓝纸面：冷纸白 + 墨色 + 唯一钴蓝（editorial 缺省系统）
    background: "#FAFAF8",
    surface: "#F1F1ED",
    primary: "#2447B0",
    accent: "#2447B0",
    text: "#16181D",
    textMuted: "#63676F",
    onDarkText: "#FAFAF8",
    chartSeries: ["#2447B0", "#16181D", "#8A94A8", "#C9A063", "#5B8DEF", "#6E6A61"],
  },
  fonts: { heading: "", body: "", headingBold: true },
  sizes: { coverTitle: 64, sectionTitle: 44, pageTitle: 32, subtitle: 20, body: 14, caption: 12, kpi: 64, table: 14 },
  spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 12 },
  decoration: {
    cardStroke: null,
    cardStrokeWidthPt: 0.75,
    cardShadow: "none" as const,
    divider: "line" as const,
    imageFit: "cover" as const,
  },
};

/** 把 4 的倍数取整（layout 技能：全篇间距只取 4 的倍数）。 */
export function snap4(value: number): number {
  return Math.round(value / 4) * 4;
}

export function resolveTheme(styleParams?: StyleParamsInput | null): ResolvedTheme {
  const palette = styleParams?.palette ?? {};
  const typography = styleParams?.typography ?? {};
  const spacing = styleParams?.spacing ?? {};
  const decoration = { ...DEFAULTS.decoration, ...(styleParams?.decoration ?? {}) };

  const background = normalizeHex(palette.background, DEFAULTS.palette.background);
  const primary = normalizeHex(palette.primary, DEFAULTS.palette.primary);
  // 深底色板未显式给 text 时回落亮色，避免深底黑字。
  const defaultText = isDarkColor(background) ? "#F5F7FA" : DEFAULTS.palette.text;
  const text = normalizeHex(palette.text, defaultText);
  const textMuted = normalizeHex(palette.textMuted, mixHex(text, background, 0.45));
  const chartSeries = (palette.chartSeries ?? DEFAULTS.palette.chartSeries)
    .slice(0, 6)
    .map((hex) => normalizeHex(hex, primary));

  const sizes = { ...DEFAULTS.sizes, ...(typography.sizes ?? {}) };
  sizes.coverTitle = clamp(sizes.coverTitle, 40, 110);
  sizes.sectionTitle = clamp(sizes.sectionTitle, 28, 60);
  sizes.pageTitle = clamp(sizes.pageTitle, 20, 40);
  sizes.subtitle = clamp(sizes.subtitle, 14, 24);
  sizes.body = clamp(sizes.body, 12, 18);
  sizes.caption = clamp(sizes.caption, 9, 13);
  sizes.kpi = clamp(sizes.kpi, 28, 90);
  sizes.table = clamp(sizes.table, 9, 24);

  const margin = clamp(Math.round(spacing.margin ?? DEFAULTS.spacing.margin), 32, 96);
  const gutter = clamp(Math.round(spacing.gutter ?? DEFAULTS.spacing.gutter), 8, 40);

  return {
    colors: {
      background,
      surface: normalizeHex(palette.surface, deriveCardSurface(background)),
      primary,
      accent: normalizeHex(palette.accent, DEFAULTS.palette.accent),
      text,
      textMuted,
      onDarkText: normalizeHex(palette.onDarkText, DEFAULTS.palette.onDarkText),
      chartSeries,
      divider: mixHex(text, background, 0.82),
      // 深色页底：中性暖黑带一丝主色——从主色大幅推导会随主色跑偏（金色主色推出橄榄棕）
      darkBackground: mixHex("#0B0A08", primary, 0.06),
      cardSurface: normalizeHex(palette.surface, deriveCardSurface(background)),
      primarySoft: mixHex(primary, background, 0.82),
    },
    fonts: {
      heading: typography.fontHeading ?? DEFAULTS.fonts.heading,
      body: typography.fontBody ?? DEFAULTS.fonts.body,
      headingBold: typography.headingBold ?? DEFAULTS.fonts.headingBold,
    },
    sizes,
    spacing: {
      margin: snap4(margin),
      gutter: snap4(gutter),
      cardPadding: clamp(Math.round(spacing.cardPadding ?? DEFAULTS.spacing.cardPadding), 8, 32),
      cornerRadius: clamp(Math.round(spacing.cornerRadius ?? DEFAULTS.spacing.cornerRadius), 0, 32),
    },
    decoration,
    footer: {
      brand: (styleParams?.footer?.brand ?? "").trim().slice(0, 24),
      label: (styleParams?.footer?.label ?? "").trim().slice(0, 24),
      pageNumbers: styleParams?.footer?.pageNumbers === true,
    },
  };
}
