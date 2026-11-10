/**
 * LayoutTree v2：slot 栅格 + type token + bleed + runs + stats。
 *
 * 与 v1 并存：normalizeTree 在根节点 version===2 时走本模块，返回一个带 `v2`
 * 载荷的占位 LayoutTree；v1 flex 编译器完全不改。这样旧 deck 的树照常通过，
 * 新语法可以在同一套 validate/measure/落页链路里逐步灰度。
 */

import { TYPE_TOKENS, type TypeToken } from "../../theme.js";
import { ICON_NAMES } from "../icons.js";
import type { ComponentStyleInput } from "../components/kit.js";
import { normalizeComponentLeaf, type ComponentLeaf } from "../components/index.js";

export const V2_COMPOSITIONS = ["immersive", "hero-data", "editorial", "swiss", "poster", "chapter"] as const;
export type V2Composition = typeof V2_COMPOSITIONS[number];

export const V2_TONES = [
  "text", "muted", "primary", "accent", "inverse", "inverseMuted",
  "surface", "primarySoft", "divider", "chart1", "chart2", "chart3", "chart4", "chart5", "chart6",
] as const;

export type V2BleedSide = "left" | "right" | "top" | "bottom" | "x" | "y" | "all";
export type V2Bleed = boolean | V2BleedSide | V2BleedSide[];

export interface V2Slot {
  col: [number, number];
  row: [number, number];
}

export interface V2Grid {
  cols: number;
  rows: number;
  gutter: number;
  rowGutter: number;
  margin: number;
}

export interface V2Run {
  text: string;
  token?: TypeToken;
  bold?: boolean;
  tone?: string;
  font?: "heading" | "body" | "serif";
  letterSpacing?: number;
}

export interface V2Paragraph {
  runs: V2Run[];
  align?: "left" | "center" | "right";
  lineSpacingPct?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
}

export interface V2TextNode {
  type: "text";
  token: TypeToken;
  text?: string;
  runs?: V2Run[];
  paragraphs?: V2Paragraph[];
  tone?: string;
  bold?: boolean;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
  letterSpacing?: number;
  lineHeightPct?: number;
  fit?: "none" | "shrink" | "ellipsis";
  maxLines?: number;
  /** 竖排（中文单字逐行堆叠）；默认横排。 */
  direction?: "horizontal" | "vertical";
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2ImageNode {
  type: "image";
  url: string;
  fit?: "cover" | "contain";
  focus?: { x?: number; y?: number };
  caption?: string;
  grayscale?: boolean;
  duotone?: boolean;
  radius?: boolean;
  /** 图片裁切蒙版：圆形或圆角。 */
  mask?: "circle" | "rounded";
  /** 盖在图片上的 scrim（颜色 + 透明度），给文字留可读底。 */
  scrim?: { color?: string; opacity?: number };
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2ShapeNode {
  type: "shape";
  shape?: string;
  /** 语义色：分隔线/色块取主题色，避免 DSL 里出现裸色号（与 text.tone 同一套词表）。 */
  tone?: string;
  fill?: string;
  gradient?: { stops: { pos: number; color: string }[]; angle: number };
  stroke?: { color: string; widthPt: number };
  radius?: boolean;
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2StatsNode {
  type: "stats";
  items: { value: string; unit?: string; label: string }[];
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2ChartNode {
  type: "chart";
  kind: string;
  categories: string[];
  series: { name: string; values: number[] }[];
  colors?: string[];
  pointColors?: (string | null)[][];
  dataLabels?: boolean;
  legend?: boolean;
  gridlines?: boolean;
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2TableCell {
  text: string;
  bold?: boolean;
  tone?: string;
  fill?: string;
  align?: "left" | "center" | "right";
  span?: number;
}

export interface V2TableNode {
  type: "table";
  /** 首行表头默认 primary 底反白；false 时按普通行。 */
  header?: boolean;
  /** banded=蓝底表头+隔行；outline=白底+主色边框；minimal=无底色，仅横线。 */
  style?: "banded" | "outline" | "minimal";
  rows: V2TableCell[][];
  colWidths?: number[];
  rowHeights?: number[];
  fontSize?: number;
  borderColor?: string;
  zebra?: boolean;
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2ComponentNode {
  type: "component";
  name: string;
  /** agent 语义样式（surface/separator/align/density/numeral/accent/motif）；缺省跟随风格卡。 */
  style?: ComponentStyleInput;
  /** 归一后的组件载荷（items/variants/style），编译时交给 expandComponent。 */
  component: ComponentLeaf;
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2IconNode {
  type: "icon";
  name: string;
  tone?: string;
  slot: V2Slot;
  bleed?: V2Bleed;
}

export interface V2PathNode {
  type: "path";
  /** SVG path d；由 genoffice 在落页时转 custGeom。 */
  d: string;
  fill?: string;
  stroke?: { color: string; widthPt: number };
  slot: V2Slot;
  bleed?: V2Bleed;
}

export type V2GroupDirection = "row" | "column" | "overlay";
export type V2GroupPanel = "surface" | "tint" | "dark" | "outline";

/** overlay 子节点在父分区内的矩形（父区域百分比 0~100，与 v1 place 同义）。 */
export interface V2Place {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** group 的公共字段（页面级 group 与嵌套 group 共用）。 */
interface V2GroupFields {
  type: "group";
  direction: V2GroupDirection;
  /** 子区域比例（仅 row/column；个数须等于 children 数，缺省均分）。 */
  weights?: number[];
  /** 缝隙 = 主题 gutter（row）/ rowGutter（column）× gapScale。 */
  gapScale?: number;
  /** 帧内边距（px）：先扣内边距再分区。 */
  pad?: number;
  /** 仅 column：子区域划分不变，内容未铺满时整组按 start/center/end 平移。 */
  justify?: "start" | "center" | "end";
  /** 底板垫在所有子节点下面。 */
  panel?: V2GroupPanel;
  children: V2GroupChild[];
}

/**
 * group 节点：v2 原生分区，不再内嵌 v1 flex 树。
 * 子节点不带 slot/bleed——位置由父 group 的 weights（row/column）或 place（overlay）决定。
 */
export interface V2GroupNode extends V2GroupFields {
  slot: V2Slot;
  bleed?: V2Bleed;
}

/** 嵌套在 group 里的 group：同样不带 slot/bleed。 */
export type V2ChildGroupNode = V2GroupFields;

/** group 子节点的附加定位字段：row/column 用 weight，overlay 用 place。 */
interface V2ChildPlacement {
  weight?: number;
  place?: V2Place;
}

export type V2GroupChild =
  | (Omit<V2TextNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2ImageNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2ShapeNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2StatsNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2ChartNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2TableNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2ComponentNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2IconNode, "slot" | "bleed"> & V2ChildPlacement)
  | (Omit<V2PathNode, "slot" | "bleed"> & V2ChildPlacement)
  | (V2ChildGroupNode & V2ChildPlacement);

/** 归一产物：页面级节点补 slot/bleed，group 子节点不补（位置由父分区决定）。 */
type MaybePlaced<T> = T extends unknown
  ? Omit<T, "slot" | "bleed"> & { slot?: V2Slot; bleed?: V2Bleed }
  : never;

export interface V2ConnectorNode {
  type: "connector";
  /** 画布百分比坐标（0~100）。 */
  from: { x: number; y: number };
  to: { x: number; y: number };
  arrow?: boolean;
  tone?: string;
  widthPt?: number;
}

export type V2Node =
  | V2TextNode | V2ImageNode | V2ShapeNode | V2StatsNode | V2ChartNode | V2TableNode | V2ComponentNode
  | V2IconNode | V2PathNode | V2GroupNode | V2ConnectorNode;

export interface V2Footer {
  left?: string;
  center?: string;
  right?: string;
  pageNumbers?: boolean;
  tone?: "text" | "muted" | "inverse";
}

export interface V2Page {
  version: 2;
  id?: string;
  role: string;
  title?: string;
  composition: V2Composition;
  safeArea?: "content" | "full";
  background?: string;
  dark?: boolean;
  /** Speaker notes copied from storyboard.copy.speakerNotes; written into the PPTX notesSlide. */
  notes?: string;
  grid?: Partial<V2Grid>;
  footer?: V2Footer;
  nodes: V2Node[];
}

const DEFAULT_GRID: V2Grid = { cols: 12, rows: 8, gutter: 24, rowGutter: 16, margin: 64 };
const NODE_TYPES = new Set(["text", "image", "shape", "stats", "chart", "table", "component", "icon", "path", "group", "connector"]);
const MAX_GROUP_DEPTH = 3;
const MAX_GROUP_CHILDREN = 12;
/** 页面节点预算：group 子节点同样计入（与页面级 1~64 同口径）。 */
const MAX_TOTAL_NODES = 64;

/**
 * 演讲备注的唯一归一：去首尾空白并截到 2000 字。
 * schema 归一、提交期内容校验（checkSemanticRendered）与落页编译必须共用同一口径，
 * 否则长备注/带空白的备注会被判成「讲稿未完整保留」永远提交不过。
 */
export function normalizeSpeakerNotes(value: string): string {
  return value.trim().slice(0, 2000);
}
const SHAPES = new Set(["rect", "roundRect", "ellipse", "line", "lineArrow"]);
const CHART_KINDS = new Set(["bar", "barStacked", "line", "area", "waterfall", "pie", "doughnut", "scatter", "comboBarLine"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fail(message: string): never {
  throw new Error(`V2_INVALID: ${message}`);
}

function stringField(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) fail(`${field} 必填`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field} 必须是字符串`);
  const trimmed = value.trim().slice(0, max);
  if (required && !trimmed) fail(`${field} 不能为空`);
  return trimmed || undefined;
}

function numberField(value: unknown, field: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${field} 必须是数字`);
  return Math.min(max, Math.max(min, Math.round(value * 100) / 100));
}

function intField(value: unknown, field: string, min: number, max: number, fallback: number): number {
  return Math.round(numberField(value, field, min, max, fallback));
}

function tokenField(value: unknown, field: string): TypeToken {
  if (typeof value !== "string" || !(TYPE_TOKENS as readonly string[]).includes(value)) {
    fail(`${field} 必须是 type token（${TYPE_TOKENS.join("/")}）`);
  }
  return value as TypeToken;
}

function toneField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(V2_TONES as readonly string[]).includes(value)) {
    fail(`${field} 必须是语义 tone（${V2_TONES.join("/")}）`);
  }
  return value;
}

function normalizeBleed(value: unknown): V2Bleed | undefined {
  if (value === undefined || typeof value === "boolean") return value as boolean | undefined;
  if (typeof value === "string") {
    if (!["left", "right", "top", "bottom", "x", "y", "all"].includes(value)) fail(`bleed 非法 ${value}`);
    return value as V2BleedSide;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) fail("bleed 数组不能为空");
    if (value.some((item) => typeof item !== "string" || !["left", "right", "top", "bottom", "x", "y", "all"].includes(item))) {
      fail("bleed 数组含非法方向");
    }
    return value as V2BleedSide[];
  }
  fail("bleed 必须是 boolean/方向/方向数组");
}

/** 归一上下文：子节点模式（不带 slot/bleed）与 group 嵌套深度。 */
interface NodeContext {
  /** true＝group 子节点：不写 slot、不写 bleed。 */
  child?: boolean;
  /** group 嵌套深度：页面级 group = 1。 */
  groupDepth: number;
}

/**
 * 位置字段归一：页面级节点写 slot（可选 bleed）；group 子节点的位置由父分区给出，
 * 写了 slot/bleed 直接报错——否则模型会以为还能像页面节点那样自由摆位。
 */
function placementFields(
  raw: Record<string, unknown>,
  grid: V2Grid,
  field: string,
  ctx: NodeContext,
): { slot?: V2Slot; bleed?: V2Bleed } {
  if (ctx.child) {
    if (raw.slot !== undefined) fail(`${field}.slot 不能写——group 子节点的位置由 direction/weights（overlay 用 place）决定`);
    if (raw.bleed !== undefined) fail(`${field}.bleed 不能写——group 子节点只能占父分给它的区域，不能外溢到画布`);
    return {};
  }
  return {
    slot: normalizeSlot(raw.slot, grid, `${field}.slot`),
    ...(raw.bleed !== undefined ? { bleed: normalizeBleed(raw.bleed) as V2Bleed } : {}),
  };
}

/** overlay 子节点的百分比定位（与 v1 place 同义：x+w≤100、y+h≤100）。 */
function normalizePlace(value: unknown, field: string): V2Place | undefined {
  if (value === undefined) return undefined;
  const raw = record(value);
  if (!raw) fail(`${field} 必须是 {x,y,w,h}（父区域的百分比 0~100）`);
  const [x, y, w, h] = (["x", "y", "w", "h"] as const).map((key) => {
    const item = raw[key];
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > 100) {
      fail(`${field}.${key} 必须是 0~100 的数字`);
    }
    return Math.round(item * 100) / 100;
  }) as [number, number, number, number];
  if (w <= 0 || h <= 0) fail(`${field} 的 w/h 必须大于 0`);
  if (x + w > 100.01 || y + h > 100.01) {
    fail(`${field} 越界：x+w=${Math.round((x + w) * 100) / 100}、y+h=${Math.round((y + h) * 100) / 100}，均不得超过 100`);
  }
  return { x, y, w, h };
}

function normalizeSlot(value: unknown, grid: V2Grid, field: string): V2Slot {
  const slot = record(value);
  if (!slot) fail(`${field} 缺失`);
  const col = Array.isArray(slot.col) ? slot.col : null;
  const row = Array.isArray(slot.row) ? slot.row : null;
  if (!col || !row || col.length !== 2 || row.length !== 2) fail(`${field} 需要 col:[c1,c2], row:[r1,r2]`);
  const [c1, c2] = col.map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item)) fail(`${field}.col 必须是整数`);
    return item;
  }) as [number, number];
  const [r1, r2] = row.map((item) => {
    if (typeof item !== "number" || !Number.isInteger(item)) fail(`${field}.row 必须是整数`);
    return item;
  }) as [number, number];
  if (!(1 <= c1 && c1 <= c2 && c2 <= grid.cols)) fail(`${field}.col 越界（1~${grid.cols}）`);
  if (!(1 <= r1 && r1 <= r2 && r2 <= grid.rows)) fail(`${field}.row 越界（1~${grid.rows}）`);
  return { col: [c1, c2], row: [r1, r2] };
}

function normalizeRun(value: unknown, nodeToken: TypeToken, index: number): V2Run {
  const raw = record(value);
  if (!raw) fail(`runs[${index}] 必须是对象`);
  // run 文本保留首尾空白：中文「标签 + 全角空格 + 正文」靠它分隔，trim 会把间距吃掉。
  if (typeof raw.text !== "string" || raw.text.length === 0) fail(`runs[${index}].text 必须是非空字符串`);
  const text = raw.text.slice(0, 2000);
  const token = raw.token === undefined ? nodeToken : tokenField(raw.token, `runs[${index}].token`);
  const font = raw.font === undefined
    ? undefined
    : raw.font === "heading" || raw.font === "body" || raw.font === "serif"
      ? raw.font
      : fail(`runs[${index}].font 非法`);
  return {
    text,
    ...(raw.token !== undefined ? { token } : {}),
    ...(raw.bold === true ? { bold: true } : {}),
    ...(toneField(raw.tone, `runs[${index}].tone`) ? { tone: raw.tone as string } : {}),
    ...(font ? { font } : {}),
    ...(raw.letterSpacing !== undefined ? { letterSpacing: numberField(raw.letterSpacing, `runs[${index}].letterSpacing`, -4, 12, 0) } : {}),
  };
}

function normalizeParagraph(value: unknown, nodeToken: TypeToken, index: number): V2Paragraph {
  const raw = record(value);
  if (!raw || !Array.isArray(raw.runs) || raw.runs.length === 0) fail(`paragraphs[${index}].runs 必须是非空数组`);
  return {
    runs: raw.runs.map((run, runIndex) => normalizeRun(run, nodeToken, runIndex)),
    ...(raw.align === "left" || raw.align === "center" || raw.align === "right" ? { align: raw.align } : {}),
    ...(raw.lineSpacingPct !== undefined ? { lineSpacingPct: numberField(raw.lineSpacingPct, `paragraphs[${index}].lineSpacingPct`, 60, 300, 110) } : {}),
    ...(raw.spaceBeforePt !== undefined ? { spaceBeforePt: numberField(raw.spaceBeforePt, `paragraphs[${index}].spaceBeforePt`, 0, 96, 0) } : {}),
    ...(raw.spaceAfterPt !== undefined ? { spaceAfterPt: numberField(raw.spaceAfterPt, `paragraphs[${index}].spaceAfterPt`, 0, 96, 0) } : {}),
  };
}

function normalizeText(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2TextNode> {
  const token = tokenField(raw.token, `${field}.token`);
  const paragraphs = Array.isArray(raw.paragraphs)
    ? raw.paragraphs.map((item, i) => normalizeParagraph(item, token, i))
    : undefined;
  const runs = Array.isArray(raw.runs) ? raw.runs.map((item, i) => normalizeRun(item, token, i)) : undefined;
  const text = stringField(raw.text, `${field}.text`, 2000);
  if (!text && !runs && !paragraphs) fail(`${field} 需要 text/runs/paragraphs 之一`);
  const align = raw.align === "center" || raw.align === "right" ? raw.align : "left";
  const valign = raw.valign === "middle" || raw.valign === "bottom" ? raw.valign : "top";
  return {
    type: "text",
    token,
    ...(text ? { text } : {}),
    ...(runs ? { runs } : {}),
    ...(paragraphs ? { paragraphs } : {}),
    ...(toneField(raw.tone, `${field}.tone`) ? { tone: raw.tone as string } : {}),
    ...(raw.bold === true ? { bold: true } : {}),
    align,
    valign,
    ...(raw.letterSpacing !== undefined ? { letterSpacing: numberField(raw.letterSpacing, `${field}.letterSpacing`, -4, 12, 0) } : {}),
    ...(raw.lineHeightPct !== undefined ? { lineHeightPct: numberField(raw.lineHeightPct, `${field}.lineHeightPct`, 60, 160, 110) } : {}),
    ...(raw.fit === "shrink" || raw.fit === "ellipsis" ? { fit: raw.fit } : { fit: "none" }),
    ...(raw.maxLines !== undefined ? { maxLines: intField(raw.maxLines, `${field}.maxLines`, 1, 4, 2) } : {}),
    ...(raw.direction === "vertical" ? { direction: "vertical" } : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeImage(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2ImageNode> {
  const url = stringField(raw.url, `${field}.url`, 500, true)!;
  if (!/^(https?:\/\/|everroom-material:\/\/)/i.test(url)) fail(`${field}.url 只接受 http(s) 或 everroom-material://`);
  const focusRaw = record(raw.focus);
  const focus = focusRaw
    ? {
        ...(focusRaw.x !== undefined ? { x: numberField(focusRaw.x, `${field}.focus.x`, 0, 100, 50) } : {}),
        ...(focusRaw.y !== undefined ? { y: numberField(focusRaw.y, `${field}.focus.y`, 0, 100, 50) } : {}),
      }
    : undefined;
  return {
    type: "image",
    url,
    fit: raw.fit === "contain" ? "contain" : "cover",
    ...(focus ? { focus } : {}),
    ...(stringField(raw.caption, `${field}.caption`, 40) ? { caption: raw.caption as string } : {}),
    ...(raw.grayscale === true ? { grayscale: true } : {}),
    ...(raw.duotone === true ? { duotone: true } : {}),
    ...(raw.radius === true ? { radius: true } : {}),
    ...(raw.mask === "circle" || raw.mask === "rounded" ? { mask: raw.mask } : {}),
    ...(record(raw.scrim) ? (() => {
      const scrim = record(raw.scrim)!;
      const opacity = scrim.opacity !== undefined ? numberField(scrim.opacity, `${field}.scrim.opacity`, 0, 1, 0.55) : 0.55;
      const color = scrim.color !== undefined ? stringField(scrim.color, `${field}.scrim.color`, 9, true)! : undefined;
      if (color && !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) fail(`${field}.scrim.color 非法`);
      return { scrim: { ...(color ? { color } : {}), opacity } };
    })() : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeShape(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2ShapeNode> {
  const gradientRaw = record(raw.gradient);
  let gradient: V2ShapeNode["gradient"];
  if (gradientRaw) {
    const stops = Array.isArray(gradientRaw.stops) ? gradientRaw.stops : [];
    if (stops.length < 2 || stops.length > 3) fail(`${field}.gradient 需要 2~3 stops`);
    const normalized = stops.map((stop, i) => {
      const rec = record(stop);
      if (!rec) fail(`${field}.gradient.stops[${i}] 非法`);
      const color = stringField(rec.color, `${field}.gradient.stops[${i}].color`, 9, true)!;
      if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) fail(`${field}.gradient.stops[${i}].color 非法`);
      return { pos: numberField(rec.pos, `${field}.gradient.stops[${i}].pos`, 0, 1, 0), color };
    });
    gradient = { stops: normalized, angle: numberField(gradientRaw.angle, `${field}.gradient.angle`, 0, 359, 90) };
  }
  const strokeRaw = record(raw.stroke);
  const stroke = strokeRaw
    ? {
        color: stringField(strokeRaw.color, `${field}.stroke.color`, 9, true)!,
        widthPt: numberField(strokeRaw.widthPt ?? 1, `${field}.stroke.widthPt`, 0.25, 24, 1),
      }
    : undefined;
  const tone = toneField(raw.tone, `${field}.tone`);
  if (!gradient && !stringField(raw.fill, `${field}.fill`, 9) && !stroke && !tone) {
    fail(`${field} 需要 fill/gradient/stroke/tone 之一`);
  }
  const shape = typeof raw.shape === "string" && SHAPES.has(raw.shape) ? raw.shape : "rect";
  return {
    type: "shape",
    shape,
    ...(tone ? { tone: raw.tone as string } : {}),
    ...(stringField(raw.fill, `${field}.fill`, 9) ? { fill: raw.fill as string } : {}),
    ...(gradient ? { gradient } : {}),
    ...(stroke ? { stroke } : {}),
    ...(raw.radius === true ? { radius: true } : {}),
    ...(raw.mask === "circle" || raw.mask === "rounded" ? { mask: raw.mask } : {}),
    ...(record(raw.scrim) ? (() => {
      const scrim = record(raw.scrim)!;
      const opacity = scrim.opacity !== undefined ? numberField(scrim.opacity, `${field}.scrim.opacity`, 0, 1, 0.55) : 0.55;
      const color = scrim.color !== undefined ? stringField(scrim.color, `${field}.scrim.color`, 9, true)! : undefined;
      if (color && !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color)) fail(`${field}.scrim.color 非法`);
      return { scrim: { ...(color ? { color } : {}), opacity } };
    })() : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeStats(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2StatsNode> {
  const itemsRaw = Array.isArray(raw.items) ? raw.items : [];
  if (itemsRaw.length < 2 || itemsRaw.length > 4) fail(`${field}.items 需要 2~4 条`);
  const items = itemsRaw.map((item, i) => {
    const rec = record(item);
    if (!rec) fail(`${field}.items[${i}] 非法`);
    return {
      value: stringField(rec.value, `${field}.items[${i}].value`, 14, true)!,
      ...(stringField(rec.unit, `${field}.items[${i}].unit`, 8) ? { unit: rec.unit as string } : {}),
      label: stringField(rec.label, `${field}.items[${i}].label`, 20, true)!,
    };
  });
  return {
    type: "stats",
    items,
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeChart(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2ChartNode> {
  const kind = stringField(raw.kind, `${field}.kind`, 20, true)!;
  if (!CHART_KINDS.has(kind)) fail(`${field}.kind 非法 ${kind}`);
  const categories = Array.isArray(raw.categories) ? raw.categories.map((item) => String(item).slice(0, 40)) : [];
  if (categories.length < 2 || categories.length > 24) fail(`${field}.categories 需要 2~24 个`);
  const seriesRaw = Array.isArray(raw.series) ? raw.series : [];
  if (seriesRaw.length < 1 || seriesRaw.length > 6) fail(`${field}.series 需要 1~6 组`);
  const series = seriesRaw.map((item, i) => {
    const rec = record(item);
    if (!rec) fail(`${field}.series[${i}] 非法`);
    const values = Array.isArray(rec.values) ? rec.values : [];
    if (values.length !== categories.length || values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      fail(`${field}.series[${i}].values 必须与 categories 等长且为数字`);
    }
    return { name: stringField(rec.name, `${field}.series[${i}].name`, 40, true)!, values: values as number[] };
  });
  const colors = Array.isArray(raw.colors) ? raw.colors.filter((c): c is string => typeof c === "string").slice(0, 6) : undefined;
  const pointColors = Array.isArray(raw.pointColors)
    ? raw.pointColors.map((row) => Array.isArray(row) ? row.map((c) => (typeof c === "string" ? c : null)) : [])
    : undefined;
  return {
    type: "chart",
    kind,
    categories,
    series,
    ...(colors ? { colors } : {}),
    ...(pointColors ? { pointColors } : {}),
    ...(raw.dataLabels === true ? { dataLabels: true } : {}),
    ...(raw.legend === true ? { legend: true } : {}),
    ...(raw.gridlines === true ? { gridlines: true } : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeIcon(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2IconNode> {
  const name = typeof raw.name === "string" ? raw.name.trim().toLowerCase() : "";
  if (!ICON_NAMES.includes(name)) {
    fail(`${field}.name 必须是引擎图标集内的名称（如 check-circle、bolt、users、rocket-launch）`);
  }
  return {
    type: "icon",
    name,
    ...(typeof raw.tone === "string" ? { tone: raw.tone.slice(0, 24) } : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizePath(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2PathNode> {
  const d = typeof raw.d === "string" ? raw.d.trim() : "";
  if (d.length < 4 || d.length > 3000) fail(`${field}.d 长度非法`);
  const stroke = record(raw.stroke);
  return {
    type: "path",
    d,
    ...(typeof raw.fill === "string" ? { fill: raw.fill.slice(0, 24) } : {}),
    ...(stroke && typeof stroke.color === "string" && typeof stroke.widthPt === "number"
      ? { stroke: { color: stroke.color.slice(0, 24), widthPt: Math.min(12, Math.max(0.25, stroke.widthPt)) } }
      : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeTable(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2TableNode> {
  const rowsRaw = Array.isArray(raw.rows) ? raw.rows : null;
  if (!rowsRaw || rowsRaw.length < 2 || rowsRaw.length > 12) fail(`${field}.rows 需要 2~12 行`);
  let columns = 0;
  const rows = rowsRaw.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length < 1 || row.length > 8) fail(`${field}.rows[${rowIndex}] 需要 1~8 列`);
    const cells = row.map((cell, cellIndex): V2TableCell => {
      const object = record(cell);
      const text = typeof cell === "string" ? cell : object && typeof object.text === "string" ? object.text : null;
      if (text === null || text.length === 0) fail(`${field}.rows[${rowIndex}][${cellIndex}].text 缺失`);
      return {
        text: text.slice(0, 120),
        ...(object?.bold === true ? { bold: true } : {}),
        ...(typeof object?.tone === "string" ? { tone: object.tone.slice(0, 24) } : {}),
        ...(typeof object?.fill === "string" && /^#[0-9a-fA-F]{6}$/.test(object.fill) ? { fill: object.fill } : {}),
        ...(object?.align === "left" || object?.align === "center" || object?.align === "right" ? { align: object.align } : {}),
        ...(typeof object?.span === "number" && Number.isInteger(object.span) && object.span >= 1 && object.span <= 8 ? { span: object.span } : {}),
      };
    });
    const span = cells.reduce((sum, cell) => sum + (cell.span ?? 1), 0);
    if (columns === 0) columns = span;
    if (span !== columns) fail(`${field}.rows[${rowIndex}] 列数 ${span} 与首行 ${columns} 不一致`);
    return cells;
  });
  return {
    type: "table",
    ...(raw.header === false ? { header: false } : {}),
    ...(raw.style === "outline" || raw.style === "minimal" ? { style: raw.style } : {}),
    rows,
    ...(Array.isArray(raw.colWidths) ? { colWidths: (raw.colWidths as unknown[]).filter((item): item is number => typeof item === "number" && item > 0).slice(0, columns) } : {}),
    ...(Array.isArray(raw.rowHeights) ? { rowHeights: (raw.rowHeights as unknown[]).filter((item): item is number => typeof item === "number" && item > 0).slice(0, rows.length) } : {}),
    ...(typeof raw.fontSize === "number" ? { fontSize: Math.min(20, Math.max(8, Math.round(raw.fontSize))) } : {}),
    ...(typeof raw.borderColor === "string" && /^#[0-9a-fA-F]{6}$/.test(raw.borderColor) ? { borderColor: raw.borderColor } : {}),
    ...(raw.zebra === false ? { zebra: false } : {}),
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeWeights(value: unknown, count: number, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${field}.weights 必须是数字数组`);
  if (value.length !== count) {
    fail(`${field}.weights 个数 ${value.length} 必须等于 children 数 ${count}（缺省均分）`);
  }
  return value.map((item, i) => {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0.1 || item > 20) {
      fail(`${field}.weights[${i}] 必须是 0.1~20 的数字`);
    }
    return Math.round(item * 100) / 100;
  });
}

/** group 子节点：复用各类型归一函数，再补 weight（row/column）或 place（overlay）。 */
function normalizeGroupChild(
  value: unknown,
  grid: V2Grid,
  field: string,
  ctx: NodeContext,
  direction: V2GroupDirection,
): V2GroupChild {
  const raw = record(value);
  if (!raw) fail(`${field} 必须是对象`);
  if (raw.type === "connector") fail(`${field} 不允许 connector——group 子节点只放内容区块`);
  // normalizeNode 已拦掉未知类型；child 模式已拦掉 slot/bleed。
  const node = normalizeNode(raw, grid, field, ctx) as V2GroupChild;
  if (direction === "overlay") {
    if (raw.weight !== undefined) fail(`${field}.weight 只用于 row/column 分组——overlay 用 place 定位`);
    const place = normalizePlace(raw.place, `${field}.place`);
    if (!place) fail(`${field}.place 必填——overlay 分组的每个子节点都要用 place 指定百分比区域`);
    return { ...node, place };
  }
  if (raw.place !== undefined) fail(`${field}.place 只用于 overlay 分组的子节点（row/column 用 weight 分比例）`);
  if (raw.weight === undefined) return node;
  return { ...node, weight: numberField(raw.weight, `${field}.weight`, 0.1, 20, 1) };
}

function normalizeGroup(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2GroupNode> {
  if (raw.tree !== undefined) {
    fail("group 不再接受 v1 树：把 tree 拆成 children 的 v2 节点，用 weight 表达比例");
  }
  const depth = (ctx.groupDepth ?? 0) + 1;
  if (depth > MAX_GROUP_DEPTH) {
    fail(`group 最多嵌套 ${MAX_GROUP_DEPTH} 层（${field} 已是第 ${depth} 层）——去掉一层 group，或把子内容提回页面级 slot`);
  }
  const direction = raw.direction;
  if (direction !== "row" && direction !== "column" && direction !== "overlay") {
    fail(`${field}.direction 必须是 row/column/overlay`);
  }
  const childrenRaw = Array.isArray(raw.children) ? raw.children : [];
  if (childrenRaw.length < 1 || childrenRaw.length > MAX_GROUP_CHILDREN) {
    fail(`${field}.children 数量 ${childrenRaw.length} 不在 1~${MAX_GROUP_CHILDREN}——合并子内容，或改用页面级 slot 排布`);
  }
  if (direction === "overlay") {
    if (raw.weights !== undefined) fail(`${field}.weights 不支持 overlay 分组——叠层子节点各自用 place 定位`);
    if (raw.gapScale !== undefined) fail(`${field}.gapScale 不支持 overlay 分组——子节点间距用 place 自行留出`);
  }
  let justify: "start" | "center" | "end" | undefined;
  if (raw.justify !== undefined) {
    if (raw.justify !== "start" && raw.justify !== "center" && raw.justify !== "end") {
      fail(`${field}.justify 必须是 start/center/end`);
    }
    if (direction !== "column") fail(`${field}.justify 只用于 column 分组（row 用 weights 分比例，overlay 用 place 定位）`);
    justify = raw.justify;
  }
  const children = childrenRaw.map((child, i) =>
    normalizeGroupChild(child, grid, `${field}/children/${i}`, { child: true, groupDepth: depth }, direction));
  const weights = direction === "overlay" ? undefined : normalizeWeights(raw.weights, children.length, field);
  const gapScale = direction === "overlay" || raw.gapScale === undefined
    ? undefined
    : numberField(raw.gapScale, `${field}.gapScale`, 0, 4, 1);
  const pad = raw.pad === undefined ? undefined : intField(raw.pad, `${field}.pad`, 0, 48, 0);
  const panel = raw.panel;
  return {
    type: "group",
    direction,
    ...(weights ? { weights } : {}),
    ...(gapScale !== undefined ? { gapScale } : {}),
    ...(pad !== undefined ? { pad } : {}),
    ...(justify ? { justify } : {}),
    ...(panel === "surface" || panel === "tint" || panel === "dark" || panel === "outline" ? { panel } : {}),
    children,
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeConnector(raw: Record<string, unknown>, field: string): V2ConnectorNode {
  const point = (value: unknown, field: string): { x: number; y: number } => {
    const recordValue = record(value);
    if (!recordValue || typeof recordValue.x !== "number" || typeof recordValue.y !== "number") {
      fail(`${field} 需要 {x,y}`);
    }
    return { x: Math.max(0, Math.min(100, recordValue.x)), y: Math.max(0, Math.min(100, recordValue.y)) };
  };
  return {
    type: "connector",
    from: point(raw.from, "from"),
    to: point(raw.to, "to"),
    ...(raw.arrow === false ? { arrow: false } : {}),
    ...(typeof raw.tone === "string" ? { tone: raw.tone.slice(0, 24) } : {}),
    ...(typeof raw.widthPt === "number" ? { widthPt: Math.max(0.5, Math.min(6, raw.widthPt)) } : {}),
  };
}

function normalizeComponentNode(raw: Record<string, unknown>, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2ComponentNode> {
  let leaf: ComponentLeaf;
  try {
    leaf = normalizeComponentLeaf(raw, field);
  } catch (error) {
    // 组件层错误前缀统一成 v2 口径，validate 回传的缺陷仍带具体改法。
    fail(error instanceof Error ? error.message.replace(/^LAYOUT_TREE_INVALID: /, "") : String(error));
  }
  return {
    type: "component",
    name: leaf.name,
    ...(leaf.style ? { style: leaf.style } : {}),
    component: leaf,
    ...placementFields(raw, grid, field, ctx),
  };
}

function normalizeNode(value: unknown, grid: V2Grid, field: string, ctx: NodeContext): MaybePlaced<V2Node> {
  const raw = record(value);
  if (!raw) fail(`${field} 必须是对象`);
  const type = raw.type;
  if (typeof type !== "string" || !NODE_TYPES.has(type)) fail(`${field}.type 非法 ${String(type)}`);
  switch (type) {
    case "text": return normalizeText(raw, grid, field, ctx);
    case "image": return normalizeImage(raw, grid, field, ctx);
    case "shape": return normalizeShape(raw, grid, field, ctx);
    case "stats": return normalizeStats(raw, grid, field, ctx);
    case "chart": return normalizeChart(raw, grid, field, ctx);
    case "table": return normalizeTable(raw, grid, field, ctx);
    case "icon": return normalizeIcon(raw, grid, field, ctx);
    case "path": return normalizePath(raw, grid, field, ctx);
    case "component": return normalizeComponentNode(raw, grid, field, ctx);
    case "group": return normalizeGroup(raw, grid, field, ctx);
    case "connector": return normalizeConnector(raw, field);
    default: fail(`${field}.type 非法`);
  }
}

function normalizeFooter(value: unknown): V2Footer | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const footer: V2Footer = {};
  for (const key of ["left", "center", "right"] as const) {
    const text = stringField(raw[key], `footer.${key}`, 120);
    if (text) footer[key] = text;
  }
  if (raw.pageNumbers === true) footer.pageNumbers = true;
  if (raw.tone === "text" || raw.tone === "muted" || raw.tone === "inverse") footer.tone = raw.tone;
  return Object.keys(footer).length > 0 ? footer : undefined;
}

function hasBleed(node: V2Node): boolean {
  if (node.type === "connector") return false;
  return node.bleed === true || (Array.isArray(node.bleed) && node.bleed.length > 0) || (typeof node.bleed === "string");
}

/** 展平 group 子节点：composition 硬约束、节点预算都按递归后的全量算。 */
function flattenNodes(nodes: ReadonlyArray<V2Node | V2GroupChild>): Array<V2Node | V2GroupChild> {
  const out: Array<V2Node | V2GroupChild> = [];
  for (const node of nodes) {
    out.push(node);
    if (node.type === "group") out.push(...flattenNodes(node.children));
  }
  return out;
}

function countChildNodes(nodes: ReadonlyArray<V2GroupChild>): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.type === "group" ? countChildNodes(node.children) : 0), 0);
}

function countNodes(nodes: ReadonlyArray<V2Node>): number {
  return nodes.reduce((sum, node) => sum + 1 + (node.type === "group" ? countChildNodes(node.children) : 0), 0);
}

function validateRecipe(page: V2Page): void {
  const all = flattenNodes(page.nodes);
  const textTokens = all.flatMap((node) => (node.type === "text" ? [node.token] : []));
  const hasImage = all.some((node) => node.type === "image");
  // bleed 只存在于页面级节点（group 子节点不许 bleed），所以这一条只看 page.nodes。
  const hasBleedImage = page.nodes.some((node) => node.type === "image" && hasBleed(node));
  const hasChart = all.some((node) => node.type === "chart");
  const hasHero = textTokens.includes("hero");
  const hasHeading = textTokens.includes("h1") || textTokens.includes("h2");
  const hasDisplay = textTokens.includes("display");
  switch (page.composition) {
    case "immersive":
      if (!hasBleedImage) fail(`composition immersive 需要至少一个 bleed 图片节点`);
      break;
    case "hero-data":
      if (!hasHero && !hasChart) fail(`composition hero-data 需要 hero 文字或 chart`);
      break;
    case "editorial":
      if (!hasImage) fail(`composition editorial 需要至少一个图片节点`);
      if (!hasHeading) fail(`composition editorial 需要 h1/h2 主张`);
      break;
    case "poster":
    case "chapter":
      if (!hasDisplay) fail(`composition ${page.composition} 需要 display 文字`);
      break;
    case "swiss":
      break;
    default:
      fail(`composition 非法 ${page.composition}`);
  }
}

/** 根节点 version===2 时调用；任何不合规直接抛错，让 validate 把错误回给 layouter。 */
export function normalizeV2Page(raw: unknown): V2Page {
  const page = record(raw);
  if (!page) fail("页面必须是对象");
  if (page.version !== 2) fail("version 必须是 2");
  const composition = page.composition;
  if (typeof composition !== "string" || !(V2_COMPOSITIONS as readonly string[]).includes(composition)) {
    fail(`composition 必须是 ${V2_COMPOSITIONS.join("/")} 之一`);
  }
  const gridRaw = record(page.grid) ?? {};
  // 只保存显式给了的 grid 字段：缺省值由 theme.spacing（风格卡的 margin/gutter）在编译期决定，
  // 不再用 64/24 硬编码把风格卡覆盖掉。
  const grid: Partial<V2Grid> = {
    ...(gridRaw.cols !== undefined ? { cols: intField(gridRaw.cols, "grid.cols", 1, 12, DEFAULT_GRID.cols) } : {}),
    ...(gridRaw.rows !== undefined ? { rows: intField(gridRaw.rows, "grid.rows", 1, 12, DEFAULT_GRID.rows) } : {}),
    ...(gridRaw.gutter !== undefined ? { gutter: intField(gridRaw.gutter, "grid.gutter", 0, 48, DEFAULT_GRID.gutter) } : {}),
    ...(gridRaw.rowGutter !== undefined ? { rowGutter: intField(gridRaw.rowGutter, "grid.rowGutter", 0, 48, DEFAULT_GRID.rowGutter) } : {}),
    ...(gridRaw.margin !== undefined ? { margin: intField(gridRaw.margin, "grid.margin", 0, 96, DEFAULT_GRID.margin) } : {}),
  };
  const bounds: V2Grid = { ...DEFAULT_GRID, ...grid };
  const nodesRaw = Array.isArray(page.nodes) ? page.nodes : [];
  if (nodesRaw.length < 1 || nodesRaw.length > 64) fail(`nodes 数量 ${nodesRaw.length} 不在 1~64`);
  // 页面级节点一律带 slot（placementFields 在非 child 模式强制），故这里的断言是安全的。
  const nodes = nodesRaw.map(
    (node, index) => normalizeNode(node, bounds, `nodes[${index}]`, { groupDepth: 0 }) as V2Node,
  );
  const total = countNodes(nodes);
  if (total > MAX_TOTAL_NODES) {
    fail(`节点总数 ${total}（含 group 子节点）超过 ${MAX_TOTAL_NODES}——层级过碎，合并兄弟节点`);
  }
  const footer = normalizeFooter(page.footer);
  const result: V2Page = {
    version: 2,
    ...(stringField(page.id, "id", 64) ? { id: page.id as string } : {}),
    role: stringField(page.role, "role", 20, true)!,
    ...(stringField(page.title, "title", 80) ? { title: page.title as string } : {}),
    composition: composition as V2Composition,
    safeArea: page.safeArea === "full" ? "full" : "content",
    ...(stringField(page.background, "background", 9) ? { background: page.background as string } : {}),
    ...(page.dark === true ? { dark: true } : {}),
    ...(typeof page.notes === "string" && page.notes.trim() ? { notes: normalizeSpeakerNotes(page.notes) } : {}),
    ...(Object.keys(grid).length > 0 ? { grid } : {}),
    ...(footer ? { footer } : {}),
    nodes,
  };
  validateRecipe(result);
  return result;
}

/** 供 measure 判断是否 v2 占位树。 */
export function isV2Page(value: unknown): value is V2Page {
  const rec = record(value);
  return Boolean(rec && rec.version === 2 && Array.isArray(rec.nodes) && typeof rec.composition === "string");
}
