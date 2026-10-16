/**
 * PageSpec 元素工厂：预设描述符只给结构与文案，颜色/字体/字号/圆角/阴影
 * 全部由主题统一盖在这里——描述符不出现任何色号。
 */

import { duotonePair, withAlpha, type ResolvedTheme } from "./theme.js";
import { estimateTextWidth } from "./text-metrics.js";

export interface SpecRun {
  text: string;
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  font?: string;
  /** 字距（pt）；眉标/字标用。genoffice 写为 a:rPr@spc。 */
  letterSpacing?: number;
}

export interface SpecParagraph {
  runs: SpecRun[];
  align?: "left" | "center" | "right";
  lineSpacingPct?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
  bullet?: boolean;
}

export interface SpecBase {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextElement extends SpecBase {
  type: "text";
  paragraphs: SpecParagraph[];
  valign?: "top" | "middle" | "bottom";
  shadow?: "soft" | "medium" | "strong";
}

export interface ShapeElement extends SpecBase {
  type: "shape";
  shape: string;
  fill?: string;
  gradient?: { stops: { pos: number; color: string }[]; angle: number };
  stroke?: { color: string; widthPt: number };
  paragraphs?: SpecParagraph[];
  valign?: "top" | "middle" | "bottom";
  shadow?: "soft" | "medium" | "strong";
}

export interface ImageElement extends SpecBase {
  type: "image";
  url: string;
  fit?: "cover" | "contain";
  shadow?: "soft" | "medium" | "strong";
  /** 圆角卡（roundRect adj，1/1000 %）；缺省直角。 */
  radiusAdj?: number;
  /** 圆形裁切（ellipse）；赢过 radiusAdj。 */
  circle?: boolean;
  /** cover 裁切焦点（图片宽高百分比 0~100）；缺省居中。 */
  focus?: { x: number; y: number };
  /** 主题双色调 [暗部, 亮部]（srgbClr hex）。 */
  duotone?: [string, string];
  /** 灰度化（a:grayscl）。 */
  grayscale?: boolean;
}

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartElement extends SpecBase {
  type: "chart";
  chart: string;
  categories: string[];
  series: ChartSeries[];
  title?: string;
  colors?: string[];
  /** 逐点填色 [系列][类目]（稀疏；null=系列色）；单点高亮走这里。 */
  pointColors?: (string | null)[][];
  legend?: boolean;
  dataLabels?: boolean;
  gridlines?: boolean;
}

export interface IconElement extends SpecBase {
  type: "icon";
  icon: string;
  color?: string;
}

export type TableCell = string | { text: string; bold?: boolean; color?: string; fill?: string; align?: "left" | "center" | "right"; span?: number };

export interface TableElement extends SpecBase {
  type: "table";
  rows: TableCell[][];
  colWidths?: number[];
  rowHeights?: number[];
  fontSize?: number;
  borderColor?: string;
  horizontalBordersOnly?: boolean;
  verticalBordersOnly?: boolean;
  borderWidthPt?: number;
  zebra?: string;
}

export interface PathElement extends SpecBase {
  type: "path";
  d: string;
  fill?: string;
  fillRule?: "evenodd";
  stroke?: { color: string; widthPt: number };
}

export type SpecElement =
  | TextElement
  | ShapeElement
  | ImageElement
  | ChartElement
  | IconElement
  | TableElement
  | PathElement;

export interface PageSpec {
  background?: string;
  elements: SpecElement[];
}

export function headingRuns(text: string, sizePt: number, color: string, theme: ResolvedTheme): SpecRun[] {
  return [{ text, sizePt, color, ...(theme.fonts.heading ? { font: theme.fonts.heading } : {}), ...(theme.fonts.headingBold ? { bold: true } : {}) }];
}

export function bodyRuns(text: string, sizePt: number, color: string, theme: ResolvedTheme, bold = false): SpecRun[] {
  return [{ text, sizePt, color, ...(theme.fonts.body ? { font: theme.fonts.body } : {}), ...(bold ? { bold: true } : {}) }];
}

export function textElement(
  frame: { x: number; y: number; w: number; h: number },
  paragraphs: SpecParagraph[],
  valign: "top" | "middle" | "bottom" = "top",
): TextElement {
  return { type: "text", x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h), paragraphs, valign };
}

export function shapeElement(
  frame: { x: number; y: number; w: number; h: number },
  shape: string,
  theme: ResolvedTheme,
  options: {
    fill?: string;
    paragraphs?: SpecParagraph[];
    valign?: "top" | "middle" | "bottom";
    stroke?: { color: string; widthPt: number };
    shadow?: "none" | "soft" | "medium" | "strong";
  } = {},
): ShapeElement {
  const fill = options.fill ?? theme.colors.cardSurface;
  // 圆角随主题（绝对像素），不随卡变大变肿：OOXML 默认 adj = 短边 1/6，大卡会气球化
  const adj =
    shape === "roundRect"
      ? Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(frame.w, frame.h))) * 100000))
      : undefined;
  return {
    type: "shape",
    shape,
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    fill,
    ...(adj !== undefined ? { adj } : {}),
    ...(options.paragraphs ? { paragraphs: options.paragraphs, valign: options.valign ?? "middle" } : {}),
    ...(options.stroke ?? (theme.decoration.cardStroke
      ? { stroke: { color: theme.decoration.cardStroke, widthPt: theme.decoration.cardStrokeWidthPt } }
      : {})),
    ...(theme.decoration.cardShadow !== "none" && (options.shadow ?? "soft") !== "none"
      ? { shadow: (options.shadow ?? theme.decoration.cardShadow) as "soft" | "medium" | "strong" }
      : {}),
  };
}

/** 编辑系统数字衬线：主题标题字体优先，缺省宋体系——数字用衬线是整套组件的排印签名。 */
export function numeralFont(theme: ResolvedTheme): string | undefined {
  const font = theme.fonts.heading || "Songti SC";
  return font || undefined;
}

/** 卡片底色 roundRect（主题卡面 + 主题描边/阴影）。 */
export function card(frame: { x: number; y: number; w: number; h: number }, theme: ResolvedTheme, fill?: string): ShapeElement {
  return shapeElement(frame, "roundRect", theme, { fill: fill ?? theme.colors.cardSurface });
}

export function imageElement(
  frame: { x: number; y: number; w: number; h: number },
  url: string,
  theme: ResolvedTheme,
  fit?: "cover" | "contain",
  opts: {
    radius?: boolean;
    circle?: boolean;
    focus?: { x?: number; y?: number };
    duotone?: boolean;
    grayscale?: boolean;
    caption?: string;
  } = {},
): { element: ImageElement; extra: SpecElement[] } {
  // 圆角随主题绝对像素换算成 roundRect adj（与 shapeElement 同口径：不随卡变肿）。
  const radiusAdj =
    opts.radius && !opts.circle && theme.spacing.cornerRadius > 0
      ? Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(frame.w, frame.h))) * 100000))
      : undefined;
  const element: ImageElement = {
    type: "image",
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    url,
    fit: fit ?? theme.decoration.imageFit,
    ...(theme.decoration.cardShadow !== "none" ? { shadow: theme.decoration.cardShadow as "soft" } : {}),
    ...(radiusAdj !== undefined ? { radiusAdj } : {}),
    ...(opts.circle ? { circle: true } : {}),
    ...(opts.focus && (opts.focus.x !== undefined || opts.focus.y !== undefined)
      ? { focus: { x: opts.focus.x ?? 50, y: opts.focus.y ?? 50 } }
      : {}),
    ...(opts.duotone ? { duotone: duotonePair(theme) } : {}),
    ...(opts.grayscale ? { grayscale: true } : {}),
  };
  // 压图小字签：左下角玻璃底（深色 55% alpha）+ onDark 小字，宽随文字（统一量测器，中英文同口径）、不超框。
  const extra: SpecElement[] = [];
  if (opts.caption) {
    const textW = estimateTextWidth(opts.caption, theme.sizes.caption);
    const w = Math.min(Math.round(frame.w) - 24, Math.max(48, Math.round(textW + theme.sizes.caption * 2)));
    const h = 26;
    const x = Math.round(frame.x) + 12;
    const y = Math.round(frame.y + frame.h) - h - 12;
    extra.push({
      type: "shape",
      shape: "roundRect",
      x,
      y,
      w,
      h,
      fill: withAlpha(theme.colors.darkBackground, 0.55),
      adj: 50000,
      paragraphs: [{ runs: [{ text: opts.caption, sizePt: theme.sizes.caption, color: theme.colors.onDarkText }] }],
      valign: "middle",
    });
  }
  return { element, extra };
}

export function httpUrl(url: string, what: string): string {
  if (/^https?:\/\//i.test(url) || /^everroom-material:\/\//i.test(url)) return url;
  throw new Error(`PRESET_INVALID: ${what} 只接受 http(s) 直链或 everroom-material:// 素材引用，收到 ${String(url).slice(0, 60)}`);
}

/** 断言字符串非空并截断。 */
export function requireText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`PRESET_INVALID: 缺少 ${what}`);
  return value.trim().slice(0, max);
}

export function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}
