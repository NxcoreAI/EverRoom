/**
 * 组件样式层（component kit）：把 agent 的语义 style + 风格卡主题解析成具体绘制 token。
 *
 * 分工：
 * - agent 只写语义枚举（surface/separator/align/density/numeral/accent/motif）；
 * - 风格卡（StyleParams → ResolvedTheme.design）给默认值；
 * - 本模块确定性解析出填充/描边/阴影/圆角/间距/字体/对齐/母题，组件只读 skin，不写裸像素。
 *
 * 归一失败抛 LAYOUT_TREE_INVALID（v1 树可自纠；v2 由 v2 schema 转成 V2_INVALID）。
 */

import { padFrame, type Frame } from "../../grid.js";
import {
  COMPONENT_ACCENTS,
  COMPONENT_ALIGNS,
  COMPONENT_DENSITIES,
  COMPONENT_NUMERALS,
  COMPONENT_SEPARATORS,
  COMPONENT_SURFACES,
  isDarkColor,
  mixHex,
  snap4,
  withAlpha,
  type ComponentAccent,
  type ComponentAlign,
  type ComponentDensity,
  type ComponentNumeral,
  type ComponentSeparator,
  type ComponentSurface,
  type MotifKind,
  type ResolvedTheme,
  type TypeToken,
} from "../../theme.js";
import { bodyRuns, headingRuns, shapeElement, type SpecElement, type SpecRun } from "../../elements.js";

export const COMPONENT_STYLE_KEYS = [
  "surface", "separator", "align", "density", "numeral", "accent", "motif",
] as const;

export interface ComponentStyleInput {
  surface?: ComponentSurface;
  separator?: ComponentSeparator;
  align?: ComponentAlign;
  density?: ComponentDensity;
  numeral?: ComponentNumeral;
  accent?: ComponentAccent;
  /** inherit=跟随风格卡母题；none=本组件不画母题。 */
  motif?: "inherit" | "none";
}

function bad(message: string): never {
  throw new Error(`LAYOUT_TREE_INVALID: ${message}`);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    bad(`${field} 必须是 ${allowed.join("|")}，收到 ${String(value)}`);
  }
  return value as T;
}

/** 组件 `style` 归一：未知字段直接报错（不再静默丢弃），值必须是枚举。 */
export function normalizeComponentStyle(raw: unknown, path: string): ComponentStyleInput | undefined {
  if (raw === undefined) return undefined;
  const rec = record(raw);
  if (!rec) bad(`${path} 必须是对象（可用字段：${COMPONENT_STYLE_KEYS.join("/")}）`);
  for (const key of Object.keys(rec)) {
    if (!(COMPONENT_STYLE_KEYS as readonly string[]).includes(key)) {
      bad(`${path}.${key} 不支持的样式字段（可用：${COMPONENT_STYLE_KEYS.join("/")}）`);
    }
  }
  const style: ComponentStyleInput = {};
  const surface = enumField(rec.surface, COMPONENT_SURFACES, `${path}.surface`);
  const separator = enumField(rec.separator, COMPONENT_SEPARATORS, `${path}.separator`);
  const align = enumField(rec.align, COMPONENT_ALIGNS, `${path}.align`);
  const density = enumField(rec.density, COMPONENT_DENSITIES, `${path}.density`);
  const numeral = enumField(rec.numeral, COMPONENT_NUMERALS, `${path}.numeral`);
  const accent = enumField(rec.accent, COMPONENT_ACCENTS, `${path}.accent`);
  if (rec.motif !== undefined && rec.motif !== "inherit" && rec.motif !== "none") {
    bad(`${path}.motif 必须是 inherit|none，收到 ${String(rec.motif)}`);
  }
  if (surface) style.surface = surface;
  if (separator) style.separator = separator;
  if (align) style.align = align;
  if (density) style.density = density;
  if (numeral) style.numeral = numeral;
  if (accent) style.accent = accent;
  if (rec.motif === "inherit" || rec.motif === "none") style.motif = rec.motif;
  return Object.keys(style).length > 0 ? style : undefined;
}

/** agent 可写的 style 摘要（错误文案/技能文档共用）。 */
export const COMPONENT_STYLE_HINT =
  "style: { surface: none|card|tint|outline|ink|band, separator: line|gap|none, "
  + "align: start|center, density: tight|normal|airy, numeral: serif|sans|none, "
  + "accent: primary|accent|muted, motif: inherit|none }";

export interface ComponentSkin {
  /** 解析后的样式枚举（组件可用它做局部判断）。 */
  surface: ComponentSurface;
  separator: ComponentSeparator;
  align: ComponentAlign;
  density: ComponentDensity;
  numeral: ComponentNumeral;
  accent: ComponentAccent;
  motif: { kind: MotifKind; spec: Record<string, string | number> } | null;

  /** 语义色（全部来自风格卡；组件不再直接写 theme.colors.*）。 */
  colors: {
    text: string;
    muted: string;
    primary: string;
    /** 唯一强调位：刻标/顶条/星/目标刻度。 */
    emphasis: string;
    /** 强调位浅档（tint 底/浅色条）。 */
    emphasisSoft: string;
    inverse: string;
    /** 反白底上的静音文字。 */
    inverseMuted: string;
    /** ink 底上的文字色。 */
    inkText: string;
    divider: string;
    card: string;
    tint: string;
    background: string;
  };
  /** 间距：density 已乘进去，且 snap4。 */
  gap: number;
  tightGap: number;
  looseGap: number;
  pad: number;
  radius: number;
  fonts: { heading: string; body: string; numeral: string };
  imageFit: "cover" | "contain";
  paragraphAlign: "left" | "center";
  /** agent 是否显式写了 align（组件可据此保留自己的历史默认对齐）。 */
  alignExplicit: boolean;
  /** agent 是否显式写了 surface（无底面语义的组件只在显式时铺底）。 */
  surfaceExplicit: boolean;

  /**
   * 组件排版尺度：语义字号固定在 1280×720 设计基准（见 docs/slides-component-visual-system.zh-CN.md），
   * 不随组件框高度缩放——同一风格卡下同级文字保持一致；间距按 frame 尺寸推导。
   * 字号角色：核心数据 display 80（组件按数字长度向下适配至 56）、组件内标题 24、
   * 正文 18、标签 14、注释 12、序号 28。溢出优先换行/压间距，字号收缩不低于角色下限
   * （正文 16、标题 20、注释 12）。
   */
  metrics(frame: Frame): {
    display: number;
    title: number;
    body: number;
    label: number;
    caption: number;
    serial: number;
    pad: number;
    gap: number;
    tightGap: number;
  };
  /** 全大写微标签 run（字距拉开、正文色/强调色）。 */
  micro(text: string, color?: string, sizePt?: number): SpecRun;
  /** 强调色短规则（刻标/标题前的短横）。 */
  accentRule(frame: Frame, options?: { width?: number; height?: number; x?: number; y?: number }): SpecElement;
  /** 姓名首字（中文取首字，拉丁取首字母；头像占位用）。 */
  initials(name: string): string;

  /** 语义字号。 */
  size(name: "coverTitle" | "sectionTitle" | "pageTitle" | "subtitle" | "body" | "caption" | "kpi" | "table"): number;
  token(token: TypeToken): number;

  /** 标题/正文 run 工厂（字体与字重来自风格卡）。 */
  heading(text: string, sizePt: number, color?: string): SpecRun[];
  body(text: string, sizePt: number, color?: string, bold?: boolean): SpecRun[];
  /** 装饰性序号/年份/大数字（numeral:none 时返回 undefined，调用方应省略该元素）。 */
  numeralRun(text: string, sizePt: number, color: string, bold?: boolean): SpecRun[] | undefined;

  /** 铺底面（整组/每条目）；返回元素，不改变 frame。 */
  paint(frame: Frame): SpecElement[];
  /** 铺完底面后内容可用的框（none 原样；其余按 pad 内缩）。 */
  contentBox(frame: Frame): Frame;
  /** 分隔线；separator !== "line" 时返回 null（调用方不要放元素）。 */
  dividerH(frame: Frame, y: number, width?: number): SpecElement | null;
  dividerV(frame: Frame, x: number, y: number, height: number): SpecElement | null;
  /** 母题装饰（形状级；不受墨迹闸门影响）。 */
  motifDecor(frame: Frame, anchor?: "top" | "corner" | "field"): SpecElement[];
  /** 图片圆角（skin.radius 的绝对像素 → roundRect adj；无圆角返回 undefined）。 */
  imageRadiusAdj(w: number, h: number): number | undefined;
}

const DENSITY_SCALE: Record<ComponentDensity, number> = { tight: 0.75, normal: 1, airy: 1.4 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundRectAdj(theme: ResolvedTheme, w: number, h: number): number | undefined {
  if (theme.spacing.cornerRadius <= 0) return undefined;
  return Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(w, h))) * 100000));
}

/** 风格卡 → 组件缺省样式 + 每组件 style 覆盖。 */
export function resolveComponentSkin(
  style: ComponentStyleInput | undefined,
  theme: ResolvedTheme,
  _what = "组件",
): ComponentSkin {
  const design = theme.design;
  const surface = style?.surface ?? design.surface;
  const separator = style?.separator ?? design.separator;
  const align = style?.align ?? design.align;
  const density = style?.density ?? design.density;
  const numeral = style?.numeral ?? design.numeral;
  const accent = style?.accent ?? design.accent;
  const motif = style?.motif === "none"
    ? null
    : design.motif.kind === "none" ? null : design.motif;

  const scale = DENSITY_SCALE[density];
  const gap = Math.max(0, snap4(theme.spacing.gutter * scale));
  const tightGap = Math.max(0, snap4(theme.spacing.gutter * 0.75 * scale));
  const looseGap = Math.max(0, snap4(theme.spacing.gutter * 1.5 * scale));
  const pad = Math.round(theme.spacing.cardPadding * scale);
  const emphasis = accent === "primary"
    ? theme.colors.primary
    : accent === "muted" ? theme.colors.textMuted : theme.colors.accent;
  const numeralFont = numeral === "none"
    ? undefined
    : numeral === "sans"
      ? (theme.fonts.body || theme.fonts.heading || undefined)
      : (theme.fonts.heading || theme.fonts.body || "Songti SC");

  const inkFill = theme.colors.text;
  const inkText = isDarkColor(inkFill) ? theme.colors.onDarkText : theme.colors.background;
  // ink 底面反白：文字/静音/分隔线整体切到反白档，组件无需逐个判断 surface。
  const onInk = surface === "ink";
  const inkMuted = mixHex(inkText, inkFill, 0.35);
  const inkDivider = withAlpha(inkText, 0.24);

  const contentInset = surface === "none" ? 0 : surface === "band" ? 0 : pad;

  const skin: ComponentSkin = {
    surface,
    separator,
    align,
    density,
    numeral,
    accent,
    motif,
    colors: {
      text: onInk ? inkText : theme.colors.text,
      muted: onInk ? inkMuted : theme.colors.textMuted,
      primary: theme.colors.primary,
      emphasis,
      emphasisSoft: accent === "muted" ? theme.colors.cardSurface : mixHex(emphasis, theme.colors.background, 0.88),
      inverse: theme.colors.onDarkText,
      inverseMuted: mixHex(theme.colors.onDarkText, theme.colors.darkBackground, 0.45),
      inkText,
      divider: onInk ? inkDivider : theme.colors.divider,
      card: theme.colors.cardSurface,
      tint: mixHex(theme.colors.primary, theme.colors.background, 0.93),
      background: theme.colors.background,
    },
    gap,
    tightGap,
    looseGap,
    pad,
    radius: theme.spacing.cornerRadius,
    fonts: {
      heading: theme.fonts.heading,
      body: theme.fonts.body,
      numeral: numeralFont ?? (theme.fonts.body || theme.fonts.heading),
    },
    imageFit: theme.decoration.imageFit,
    paragraphAlign: align === "center" ? "center" : "left",
    alignExplicit: style?.align !== undefined,
    surfaceExplicit: style?.surface !== undefined,

    metrics(frame) {
      const minDim = Math.max(1, Math.min(frame.w, frame.h));
      const densityScale = DENSITY_SCALE[density];
      // 文字角色固定在 1280×720 设计基准，不随 frame 高度缩放（同级文字一致）；
      // density 只乘间距，不乘字号。溢出由组件换行/压间距，字号不低于角色下限。
      return {
        display: 80,
        title: 24,
        body: 18,
        label: 14,
        caption: 12,
        serial: 28,
        pad: clamp(Math.round(Math.max(theme.spacing.cardPadding * 1.4, minDim * 0.045) * densityScale), 10, 46),
        gap: Math.max(snap4(Math.round(Math.max(theme.spacing.gutter * 1.2, minDim * 0.05) * densityScale)), 8),
        tightGap: Math.max(snap4(Math.round(Math.max(theme.spacing.gutter * 0.6, minDim * 0.025) * densityScale)), 6),
      };
    },
    micro(text, color, sizePt) {
      // 标签角色固定 14pt（显式传入时尊重调用方，但不低于 10）。
      return {
        text,
        sizePt: Math.max(10, Math.round(sizePt ?? 14)),
        bold: true,
        color: color ?? theme.colors.textMuted,
        letterSpacing: 1.6,
        ...(theme.fonts.body ? { font: theme.fonts.body } : {}),
      };
    },
    accentRule(frame, options = {}) {
      return {
        type: "shape", shape: "rect", fill: emphasis,
        x: Math.round(options.x ?? frame.x),
        y: Math.round(options.y ?? frame.y),
        w: Math.round(options.width ?? 28),
        h: Math.round(options.height ?? 3),
      };
    },
    initials(name) {
      const trimmed = String(name).trim();
      if (!trimmed) return "·";
      const chars = [...trimmed];
      if (/^[A-Za-z]/.test(trimmed)) {
        return chars.slice(0, 2).join("").toUpperCase();
      }
      return chars[0]!;
    },
    size(name) {
      return theme.sizes[name];
    },
    token(token) {
      return theme.typeScale[token];
    },

    heading(text, sizePt, color) {
      return headingRuns(text, sizePt, color ?? theme.colors.text, theme);
    },
    body(text, sizePt, color, bold = false) {
      return bodyRuns(text, sizePt, color ?? theme.colors.textMuted, theme, bold);
    },
    numeralRun(text, sizePt, color, bold = true) {
      // numeral:none 时返回 undefined，调用方应省略该元素；字体未配置时回落引擎默认（正文字体）。
      if (numeral === "none") return undefined;
      return [{ text, sizePt, bold, color, ...(numeralFont ? { font: numeralFont } : {}) }];
    },

    paint(frame) {
      return paintSurface(surface, frame, theme, emphasis, contentInset);
    },
    contentBox(frame) {
      if (surface === "band") {
        // band 只占顶部条：内容让出条高 + 一点呼吸。
        const bandH = Math.max(4, Math.min(8, Math.round(contentInset * 0.4) || 4));
        return { x: frame.x, y: frame.y + bandH + 6, w: frame.w, h: Math.max(1, frame.h - bandH - 6) };
      }
      if (contentInset <= 0) return frame;
      // 小框保护：内边距最多吃掉短边 18%，避免 card 把小格内容压没。
      const inset = Math.min(contentInset, Math.max(0, Math.floor(Math.min(frame.w, frame.h) * 0.18)));
      return inset > 0 ? padFrame(frame, inset) : frame;
    },
    dividerH(frame, y, width) {
      if (separator !== "line") return null;
      return {
        type: "shape", shape: "rect",
        fill: onInk ? inkDivider : theme.colors.divider,
        x: Math.round(frame.x), y: Math.round(y),
        w: Math.round(width ?? frame.w), h: 1,
      };
    },
    dividerV(frame, x, y, height) {
      if (separator !== "line") return null;
      return {
        type: "shape", shape: "rect",
        fill: onInk ? inkDivider : theme.colors.divider,
        x: Math.round(x), y: Math.round(y), w: 1, h: Math.round(height),
      };
    },
    motifDecor(frame, anchor = "top") {
      // 母题是「表面上的签名」：没有底面的组件不重复画，避免一页多个色带；
      // 页级母题由 pageMotifElements 统一承担。
      if (surface === "none") return [];
      return motifElements(motif, frame, theme, emphasis, anchor, surface);
    },
    imageRadiusAdj(w, h) {
      if (theme.spacing.cornerRadius <= 0) return undefined;
      return Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(w, h))) * 100000));
    },
  };
  return skin;
}

function paintSurface(
  surface: ComponentSurface,
  frame: Frame,
  theme: ResolvedTheme,
  emphasis: string,
  inset: number,
): SpecElement[] {
  if (surface === "none") return [];
  const shape = "roundRect";
  if (surface === "card") {
    // 走 elements.shapeElement：cardStroke/cardStrokeWidthPt/cardShadow/cornerRadius 一次生效。
    return [shapeElement(frame, shape, theme, { fill: theme.colors.cardSurface })];
  }
  if (surface === "tint") {
    return [{
      type: "shape", shape,
      fill: mixHex(theme.colors.primary, theme.colors.background, 0.93),
      x: Math.round(frame.x), y: Math.round(frame.y),
      w: Math.round(frame.w), h: Math.round(frame.h),
      ...(roundRectAdj(theme, frame.w, frame.h) !== undefined ? { adj: roundRectAdj(theme, frame.w, frame.h)! } : {}),
    }];
  }
  if (surface === "outline") {
    return [{
      type: "shape", shape,
      fill: "#00000000",
      stroke: {
        color: theme.decoration.cardStroke ?? theme.colors.divider,
        widthPt: theme.decoration.cardStroke ? theme.decoration.cardStrokeWidthPt : 1,
      },
      x: Math.round(frame.x), y: Math.round(frame.y),
      w: Math.round(frame.w), h: Math.round(frame.h),
      ...(roundRectAdj(theme, frame.w, frame.h) !== undefined ? { adj: roundRectAdj(theme, frame.w, frame.h)! } : {}),
    }];
  }
  if (surface === "ink") {
    return [{
      type: "shape", shape,
      fill: theme.colors.text,
      x: Math.round(frame.x), y: Math.round(frame.y),
      w: Math.round(frame.w), h: Math.round(frame.h),
      ...(roundRectAdj(theme, frame.w, frame.h) !== undefined ? { adj: roundRectAdj(theme, frame.w, frame.h)! } : {}),
    }];
  }
  // band：只铺顶部强调色带，不做整块底面（content 仍占满 frame，调用方自行让出条高）。
  const bandH = Math.max(4, Math.min(8, Math.round(inset * 0.4) || 4));
  return [{
    type: "shape", shape: "rect",
    fill: emphasis,
    x: Math.round(frame.x), y: Math.round(frame.y),
    w: Math.round(frame.w), h: bandH,
  }];
}

/**
 * 页级母题：全篇重复的视觉签名（风格卡 motif.kind）。
 * 只画形状（不用文字），压在内容之下；色带/角落/幽灵场三种语言。
 */
export function pageMotifElements(theme: ResolvedTheme, options: { role?: string } = {}): SpecElement[] {
  const motif = theme.design.motif;
  if (motif.kind === "none") return [];
  const canvasW = 1280;
  const canvasH = 720;
  const emphasis = theme.design.accent === "primary" ? theme.colors.primary : theme.colors.accent;
  if (motif.kind === "color-band") {
    const side = typeof motif.spec.side === "string" ? motif.spec.side : "left";
    const w = Math.max(6, Math.min(24, Math.round(Number(motif.spec.width) || 8)));
    if (side === "right") {
      return [{ type: "shape", shape: "rect", fill: emphasis, x: canvasW - w, y: 0, w, h: canvasH }];
    }
    if (side === "bottom") {
      return [{ type: "shape", shape: "rect", fill: emphasis, x: 0, y: canvasH - w, w: canvasW, h: w }];
    }
    if (side === "top") {
      return [{ type: "shape", shape: "rect", fill: emphasis, x: 0, y: 0, w: canvasW, h: w }];
    }
    return [{ type: "shape", shape: "rect", fill: emphasis, x: 0, y: 0, w, h: canvasH }];
  }
  if (motif.kind === "corner-accent") {
    const d = Math.max(18, Math.min(48, Math.round(Number(motif.spec.size) || 26)));
    return [{ type: "shape", shape: "ellipse", fill: withAlpha(emphasis, 0.9), x: canvasW - d - 40, y: 40, w: d, h: d }];
  }
  // ghost-number / ghost-word：右下低透明度几何剪影（两块，像数字/大字侧影）。
  const alpha = Math.max(0.03, Math.min(0.14, Number(motif.spec.alpha) || 0.07));
  const baseY = Math.round(canvasH * 0.56);
  const h = Math.round(canvasH * 0.38);
  const w1 = Math.round(canvasW * 0.11);
  const w2 = Math.round(canvasW * 0.07);
  const x1 = canvasW - 40 - w2 - 12 - w1;
  return [
    { type: "shape", shape: "roundRect", fill: withAlpha(theme.colors.primary, alpha), x: x1, y: baseY, w: w1, h,
      ...(roundRectAdj(theme, w1, h) !== undefined ? { adj: roundRectAdj(theme, w1, h)! } : {}) },
    { type: "shape", shape: "roundRect", fill: withAlpha(theme.colors.primary, alpha), x: canvasW - 40 - w2, y: baseY, w: w2, h,
      ...(roundRectAdj(theme, w2, h) !== undefined ? { adj: roundRectAdj(theme, w2, h)! } : {}) },
  ];
}

/** 封面/章节类语义页：风格卡 darkCover 为 true 时确定性落深底（agent 不写 dark 也不丢风格）。 */
export const DARK_COVER_ROLES = new Set(["cover", "section", "closing"]);

function motifElements(
  motif: { kind: MotifKind; spec: Record<string, string | number> } | null,
  frame: Frame,
  theme: ResolvedTheme,
  emphasis: string,
  anchor: "top" | "corner" | "field",
  surface: ComponentSurface,
): SpecElement[] {
  if (!motif) return [];
  if (motif.kind === "color-band") {
    if (surface === "band") return [];
    const h = Math.max(3, Math.min(8, Math.round(frame.h * 0.012) + 3));
    return [{
      type: "shape", shape: "rect", fill: emphasis,
      x: Math.round(frame.x), y: Math.round(frame.y),
      w: Math.round(frame.w), h,
    }];
  }
  if (motif.kind === "corner-accent") {
    const d = Math.max(10, Math.min(22, Math.round(Math.min(frame.w, frame.h) * 0.08)));
    const x = anchor === "corner" ? frame.x : frame.x + frame.w - d;
    return [{
      type: "shape", shape: "ellipse", fill: withAlpha(emphasis, 0.85),
      x: Math.round(x), y: Math.round(frame.y),
      w: d, h: d,
    }];
  }
  // ghost-number / ghost-word：形状级「幽灵场」——低透明度几何块给编号/大字垫气，
  // 不用文字，避免 PPTX 墨迹重叠闸门把整页拒掉。
  const w = Math.round(Math.min(frame.w * 0.46, frame.h * 0.9));
  const h = Math.round(Math.min(frame.h * 0.8, w * 0.62));
  return [{
    type: "shape", shape: "roundRect",
    fill: withAlpha(theme.colors.primary, 0.06),
    x: Math.round(frame.x + frame.w - w - 8), y: Math.round(frame.y + 8),
    w, h,
    ...(theme.spacing.cornerRadius > 0
      ? { adj: Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(w, h))) * 100000)) }
      : {}),
  }];
}
