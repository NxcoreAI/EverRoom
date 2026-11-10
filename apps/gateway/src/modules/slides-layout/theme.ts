/**
 * 预设展开的主题解析：styleParams（slides-styler 风格卡，键名以
 * agents/slides-styler/schemas/output.schema.json 为真源）→ 展开器直接可用的
 * 主题对象。styleParams 缺失时用与 layout 技能文档口径一致的缺省主题。
 * 坐标、字号、配色全部在这里定：预设描述符只管结构，不管取值。
 *
 * 字号不在这里做设计判断：**场景（scene）决定字号阶梯与硬下限**，风格卡
 * 的字号字段（typography.sizes / typography.typeScale）一律忽略。见 scene.ts。
 */

import { resolveScene, type SceneId } from "./scene.js";

/** v2 排版口径：字号只从 token 取，不写裸 pt。 */
export const TYPE_TOKENS = [
  "display", "hero", "h1", "h2", "h3", "lead", "body", "label", "kicker", "caption",
] as const;
export type TypeToken = typeof TYPE_TOKENS[number];

/** 构图家族：风格卡第三轴；组件默认 surface/density/numeral 由此推导。 */
export const STYLE_COMPOSITIONS = ["swiss", "editorial", "poster", "immersive"] as const;
export type StyleComposition = typeof STYLE_COMPOSITIONS[number];

/** 全篇重复的视觉母题（风格卡 motif.kind）。 */
export const MOTIF_KINDS = ["ghost-number", "ghost-word", "color-band", "corner-accent", "none"] as const;
export type MotifKind = typeof MOTIF_KINDS[number];

/**
 * 组件样式词汇：agent 只写这些语义枚举，像素/色号由 resolveComponentSkin 解析。
 * 枚举同时被 v1 组件归一与 v2 节点归一共用。
 */
export const COMPONENT_SURFACES = ["none", "card", "tint", "outline", "ink", "band"] as const;
export type ComponentSurface = typeof COMPONENT_SURFACES[number];
export const COMPONENT_SEPARATORS = ["line", "gap", "none"] as const;
export type ComponentSeparator = typeof COMPONENT_SEPARATORS[number];
export const COMPONENT_ALIGNS = ["start", "center"] as const;
export type ComponentAlign = typeof COMPONENT_ALIGNS[number];
export const COMPONENT_DENSITIES = ["tight", "normal", "airy"] as const;
export type ComponentDensity = typeof COMPONENT_DENSITIES[number];
export const COMPONENT_NUMERALS = ["serif", "sans", "none"] as const;
export type ComponentNumeral = typeof COMPONENT_NUMERALS[number];
export const COMPONENT_ACCENTS = ["primary", "accent", "muted"] as const;
export type ComponentAccent = typeof COMPONENT_ACCENTS[number];

export interface StyleMotifInput {
  kind?: MotifKind;
  /** 母题参数（如 ghost 的 alpha 与字号、色带方向）；组件按 kind 解释。 */
  spec?: Record<string, string | number>;
}

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
    /**
     * @deprecated 字号只由场景决定（scene.ts）。字段保留只为兼容旧风格卡产物，
     * 运行时**完全忽略**；slides-styler 已不再产出该字段。
     */
    sizes?: Partial<Record<
      "coverTitle" | "sectionTitle" | "pageTitle" | "subtitle" | "body" | "caption" | "kpi" | "table",
      number
    >>;
    headingBold?: boolean;
    /** @deprecated 同 sizes：忽略。 */
    typeScale?: Partial<Record<TypeToken, number>>;
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
  /** 构图家族（风格卡权威来源：用户挑中的纵览候选）。 */
  composition?: StyleComposition;
  /** 母题：全篇重复的视觉签名。 */
  motif?: StyleMotifInput;
}

export interface ResolvedTheme {
  /** 本 deck 的场景（字号体系来源）。 */
  scene: SceneId;
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
  /** v2 字号阶梯（pt）；layout v2 唯一字号来源。 */
  typeScale: Record<TypeToken, number>;
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
  /**
   * 风格卡的设计轴与组件默认值（单一出处）：组件只读这里，不写默认。
   * resolveComponentSkin 在此之上叠加每组件显式 style。
   */
  design: {
    composition: StyleComposition;
    motif: { kind: MotifKind; spec: Record<string, string | number> };
    darkCover: boolean;
    /** 组件缺省底面语言。 */
    surface: ComponentSurface;
    separator: ComponentSeparator;
    align: ComponentAlign;
    density: ComponentDensity;
    numeral: ComponentNumeral;
    /** 唯一强调位取色角色。 */
    accent: ComponentAccent;
  };
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

/** v2 字号阶梯 → 旧的 8 个字号词（compile 的 VARIANT_SIZE_KEY 与组件读这一份）。 */
function sizesFromTypeScale(typeScale: Record<TypeToken, number>): ResolvedTheme["sizes"] {
  return {
    coverTitle: typeScale.display,
    sectionTitle: typeScale.h1,
    pageTitle: typeScale.h2,
    subtitle: typeScale.lead,
    body: typeScale.body,
    caption: typeScale.caption,
    kpi: typeScale.hero,
    table: typeScale.body,
  };
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

/**
 * OOXML 的 typeface 只能有一个字体名，不能是 CSS 的逗号栈；把风格卡的
 * `"Songti SC, Georgia"` 归一成 `"Songti SC"`，让 PowerPoint 对中文/拉丁各自回退，
 * 而不是把整串当字体名找不到后回退到默认字体。
 */
export function primaryFontFamily(value: string | undefined): string {
  if (!value) return "";
  const first = value.split(",")[0]?.trim() ?? "";
  return first.replace(/^["']|["']$/g, "").trim().slice(0, 80);
}

export function resolveTheme(styleParams?: StyleParamsInput | null, sceneId?: string | null): ResolvedTheme {
  const palette = styleParams?.palette ?? {};
  const typography = styleParams?.typography ?? {};
  const spacing = styleParams?.spacing ?? {};
  const decoration = { ...DEFAULTS.decoration, ...(styleParams?.decoration ?? {}) };
  const profile = resolveScene(sceneId);

  const background = normalizeHex(palette.background, DEFAULTS.palette.background);
  const primary = normalizeHex(palette.primary, DEFAULTS.palette.primary);
  // 深底色板未显式给 text 时回落亮色，避免深底黑字。
  const defaultText = isDarkColor(background) ? "#F5F7FA" : DEFAULTS.palette.text;
  const text = normalizeHex(palette.text, defaultText);
  const textMuted = normalizeHex(palette.textMuted, mixHex(text, background, 0.45));
  const chartSeries = (palette.chartSeries ?? DEFAULTS.palette.chartSeries)
    .slice(0, 6)
    .map((hex) => normalizeHex(hex, primary));

  // 字号只由场景决定：typography.sizes / typography.typeScale 一律忽略（风格卡不提取字号）。
  const typeScale: Record<TypeToken, number> = { ...profile.typeScale };
  const sizes = sizesFromTypeScale(typeScale);

  const margin = clamp(Math.round(spacing.margin ?? DEFAULTS.spacing.margin), 32, 96);
  const gutter = clamp(Math.round(spacing.gutter ?? DEFAULTS.spacing.gutter), 8, 40);

  const accent = normalizeHex(palette.accent, DEFAULTS.palette.accent);
  const composition = isStyleComposition(styleParams?.composition) ? styleParams!.composition! : "editorial";
  const motifKind: MotifKind = isMotifKind(styleParams?.motif?.kind) ? styleParams!.motif!.kind! : "none";
  const motif: { kind: MotifKind; spec: Record<string, string | number> } = {
    kind: motifKind,
    // 母题关闭时参数不保留，避免 styleTokens 里出现「none 却带 ghost 参数」的噪声。
    spec: motifKind === "none" ? {} : sanitizeMotifSpec(styleParams?.motif?.spec),
  };
  // 卡面语言由装饰 token 决定：有描边或阴影 = 风格卡在卖卡片；否则看构图家族。
  const surface: ComponentSurface =
    decoration.cardShadow !== "none" || decoration.cardStroke !== null
      ? "card"
      : composition === "immersive"
        ? "tint"
        : "none";

  return {
    scene: profile.id,
    colors: {
      background,
      surface: normalizeHex(palette.surface, deriveCardSurface(background)),
      primary,
      accent,
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
      heading: primaryFontFamily(typography.fontHeading) || DEFAULTS.fonts.heading,
      body: primaryFontFamily(typography.fontBody) || DEFAULTS.fonts.body,
      headingBold: typography.headingBold ?? DEFAULTS.fonts.headingBold,
    },
    sizes,
    typeScale,
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
    design: {
      composition,
      motif,
      darkCover: styleParams?.darkCover ?? true,
      surface,
      // 分隔线关掉时，组件默认退到「只留间距」——不再画任何发丝线。
      separator: decoration.divider === "none" ? "gap" : "line",
      align: "start",
      density: composition === "swiss" ? "tight" : composition === "poster" || composition === "immersive" ? "airy" : "normal",
      // 数字默认正文字体（无衬线商务表达）；agent 显式 numeral:serif 时恢复衬线。
      numeral: "sans",
      accent: accent === primary ? "primary" : "accent",
    },
  };
}

function isStyleComposition(value: unknown): value is StyleComposition {
  return typeof value === "string" && (STYLE_COMPOSITIONS as readonly string[]).includes(value);
}

function isMotifKind(value: unknown): value is MotifKind {
  return typeof value === "string" && (MOTIF_KINDS as readonly string[]).includes(value);
}

function sanitizeMotifSpec(raw: unknown): Record<string, string | number> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const spec: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 8)) {
    if (typeof value === "string") spec[key.slice(0, 24)] = value.slice(0, 80);
    else if (typeof value === "number" && Number.isFinite(value)) spec[key.slice(0, 24)] = value;
  }
  return spec;
}
