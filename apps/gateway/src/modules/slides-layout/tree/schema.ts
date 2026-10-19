/**
 * LayoutTree：布局代理输出的递归嵌套布局树。
 * 全树只有结构与比例（方向/权重/缝隙/内边距），没有任何像素坐标。
 * 坐标由 compile.ts 确定性计算；报错文案面向模型自纠（沿用 PRESET_INVALID 风格）。
 */

import { ICON_NAMES } from "./icons.js";
import { normalizeComponentLeaf, type ComponentLeaf } from "./components/index.js";

export type Direction = "row" | "column" | "overlay";
export type MainJustify = "start" | "center" | "end";
export type TextAlign = "left" | "center" | "right";
export type TextTone = "normal" | "muted" | "inverse";
export type TableStyle = "lines" | "darkHeader" | "zebra";

/**
 * 容器面板底色档（主题词，不是色号）。同一 panel 组件的五种视觉变种：
 * surface=主题卡面平贴 · soft=主色浅档 · tint=渐层釉面（主色 8.5%→3.5% 上下渐层+发丝描边）
 * dark=墨面渐层（深底翻字） · leftBar=白卡+左主色刻标 · nested=tint 洗地+白卡浮起 · outline=细线框。
 */
export type PanelTone = "surface" | "soft" | "dark" | "tint" | "leftBar" | "nested" | "outline";

/** 容器面板：先铺底板再排子节点；dark 面板内文字自动换深色页文字色。 */
export interface PanelSpec {
  tone: PanelTone;
  /** 显式 false 关掉圆角。 */
  radius?: false;
  /** 显式 false 关掉主题描边与阴影。 */
  stroke?: false;
}

export interface TextLeaf {
  type: "text";
  variant: "display" | "heading" | "subtitle" | "body" | "caption";
  text: string;
  align?: TextAlign;
  bullet?: boolean;
  tone?: TextTone;
}

export interface ImageLeaf {
  type: "image";
  url: string;
  /** true=完整放框（contain，可能留空带）；缺省=裁切填满（cover）。两种都不变形。 */
  contain?: boolean;
  /** true＝圆角卡（圆角随主题 cornerRadius）。 */
  radius?: true;
  /** true＝圆形裁切（头像/徽标用；框宜取方形）。circle 赢过 radius。 */
  circle?: true;
  /** cover 裁切焦点（图片宽高的百分比 0~100）；缺省居中。仅 cover 生效。 */
  focus?: { x?: number; y?: number };
  /** true＝主题双色调（主色染的明暗两端）。 */
  duotone?: true;
  /** true＝灰度化（logo 墙等单色化场景）。 */
  grayscale?: true;
  /** 压图小字签（左下角玻璃底）；≤40 字。 */
  caption?: string;
}

export interface PathLeaf {
  type: "path";
  d: string;
}

/** 分隔线：高框渲染竖线、扁框渲染横线（主题分隔线色）。 */
export interface DividerLeaf {
  type: "divider";
}

/** 图标：名称必须在引擎图标集内（Heroicons v2 solid 命名）。 */
export interface IconLeaf {
  type: "icon";
  icon: string;
}

export type ChartKind = "bar" | "barStacked" | "line" | "area" | "waterfall" | "pie" | "doughnut" | "scatter" | "comboBarLine";

export interface ChartLeaf {
  type: "chart";
  kind: ChartKind;
  categories: string[];
  series: { name: string; values: number[] }[];
  legend?: boolean;
  /**
   * 单点高亮（bar/area 首系列）：把该类目画成主色实心、其余降为主色浅档。
   * 数字=类目下标（0 基），"last"=末位。
   */
  highlight?: number | "last";
  /** 涨跌徽章（图表右上角主色圆角签），≤12 字，如 "+42%"。 */
  delta?: string;
}

export interface TableLeaf {
  type: "table";
  rows: (string | { text: string; bold?: boolean; align?: TextAlign })[][];
  colWidths?: number[];
  style?: TableStyle;
  /** 显式 false＝无表头：rows 全是数据行（账目式两列表）。darkHeader 需要表头，二者互斥。 */
  header?: false;
  /** true＝表格顶部压一条 2px 墨线（账目式顶线），表格整体下移让位。 */
  topRule?: true;
}

export type LeafNode = TextLeaf | ImageLeaf | PathLeaf | ChartLeaf | TableLeaf | DividerLeaf | IconLeaf | ComponentLeaf;

/** 页级背景：整页铺图 + 纱罩（缺省深色纱罩；"gradient"＝上深下透的渐层纱罩；"none"＝不压）。 */
export interface BgSpec {
  image: string;
  /** "none" 不压纱罩；"gradient" 渐层纱罩；缺省深色纱罩。 */
  scrim?: "none" | "gradient";
}

/** overlay 容器直接子节点的定位：容器区域的百分比（0~100）。 */
export interface OverlayPlace {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlaceFields {
  place?: OverlayPlace;
}

/** 容器与根的子节点：place 仅在 overlay 容器的直接子节点上合法。 */
export type ChildNode = (ContainerNode | LeafNode) & PlaceFields;

export interface ContainerNode {
  direction: Direction;
  /** 子区域比例（正数，长度须等于 children 数；缺省均分）。 */
  weights?: number[];
  /** 缝隙 = gutter × gapScale（0=无缝）。 */
  gapScale?: number;
  /** 容器内边距（px）。 */
  pad?: number;
  /** 主轴打包（仅 column）：text 叶子按内容自然高、其余均分剩余，整组按 justify 落位。 */
  justify?: MainJustify;
  /** 面板底板（先铺板再排子节点）。 */
  panel?: PanelSpec;
  children: ChildNode[];
}

/** 页根节点：内容区容器 + 页元数据。 */
export interface LayoutTree {
  role: string;
  /** 页标题（进固定标题带）；封面/章节等整页构图可省略，标题作为 display 文字叶子排进版面。 */
  title?: string;
  /** 深色页（封面/章节）：背景用 darkBackground，文字自动换 onDarkText。 */
  dark?: boolean;
  /** 整页背景图（视同深色页：自动压深色纱罩、文字自动换 onDarkText）。 */
  bg?: BgSpec;
  direction: Direction;
  weights?: number[];
  gapScale?: number;
  pad?: number;
  justify?: MainJustify;
  /** 面板底板（铺满内容区，先铺板再排子节点）。 */
  panel?: PanelSpec;
  children: ChildNode[];
}

export type TreeNode = ContainerNode | LeafNode;

export function isLeaf(node: TreeNode): node is LeafNode {
  return typeof (node as LeafNode).type === "string";
}

const MAX_TEXT = 2000;
const MAX_CHILDREN = 12;
const MAX_TOTAL_NODES = 200;
const CHART_KINDS: ChartKind[] = ["bar", "barStacked", "line", "area", "waterfall", "pie", "doughnut", "scatter", "comboBarLine"];
const TEXT_VARIANTS = ["display", "heading", "subtitle", "body", "caption"] as const;
const PANEL_TONES = ["surface", "soft", "dark", "tint", "leftBar", "nested", "outline"] as const;

/** 容器面板的归一。 */
function normalizePanel(raw: unknown, path: string): PanelSpec | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${path}.panel 必须是 { tone, radius?, stroke? }`);
  const p = raw as Record<string, unknown>;
  const tone = p.tone;
  if (typeof tone !== "string" || !(PANEL_TONES as readonly string[]).includes(tone)) {
    bad(`${path}.panel.tone 必须是 ${PANEL_TONES.join("|")}，收到 ${String(tone)}`);
  }
  if (p.radius !== undefined && p.radius !== false) bad(`${path}.panel.radius 只接受 false（关掉圆角）`);
  if (p.stroke !== undefined && p.stroke !== false) bad(`${path}.panel.stroke 只接受 false（关掉描边与阴影）`);
  return {
    tone: tone as PanelTone,
    ...(p.radius === false ? { radius: false } : {}),
    ...(p.stroke === false ? { stroke: false } : {}),
  };
}

class TreeError extends Error {}

function bad(message: string): never {
  throw new TreeError(`LAYOUT_TREE_INVALID: ${message}`);
}

function asNode(value: unknown, path: string): TreeNode {
  spendBudget(path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(`${path} 必须是对象`);
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") return asLeaf(node, path);
  if (node.direction === "row" || node.direction === "column" || node.direction === "overlay") return asContainer(node, path);
  bad(`${path} 无法识别：既不是叶子（缺 type）也不是容器（缺 direction）`);
}

/** place 字段的归一（存在性合法性由调用方按容器方向判定）。 */
function normalizePlace(raw: unknown, path: string): OverlayPlace | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad(`${path}.place 必须是 {x,y,w,h}（容器区域的百分比 0~100）`);
  const p = raw as Record<string, unknown>;
  const vals = (["x", "y", "w", "h"] as const).map((key) => {
    const v = p[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
      bad(`${path}.place.${key} 必须是 0~100 的数字，收到 ${String(v)}`);
    }
    return v as number;
  });
  const [x, y, w, h] = vals as [number, number, number, number];
  if (w <= 0 || h <= 0) bad(`${path}.place 的 w/h 必须大于 0`);
  if (x + w > 100.01 || y + h > 100.01) {
    bad(`${path}.place 越界：x+w=${round2(x + w)}、y+h=${round2(y + h)}，均不得超过 100`);
  }
  return { x, y, w, h };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function asLeaf(node: Record<string, unknown>, path: string): LeafNode {
  switch (node.type) {
    case "text": {
      const text = requiredText(node.text, `${path}.text`);
      const variant = node.variant;
      if (typeof variant !== "string" || !(TEXT_VARIANTS as readonly string[]).includes(variant)) {
        bad(`${path}.variant 必须是 ${TEXT_VARIANTS.join("|")}，收到 ${String(variant)}`);
      }
      const align = node.align;
      if (align !== undefined && !["left", "center", "right"].includes(align as string)) bad(`${path}.align 必须是 left|center|right`);
      const tone = node.tone;
      if (tone !== undefined && !["normal", "muted", "inverse"].includes(tone as string)) bad(`${path}.tone 必须是 normal|muted|inverse`);
      const leaf: TextLeaf = { type: "text", variant: variant as TextLeaf["variant"], text };
      if (align) leaf.align = align as TextAlign;
      if (node.bullet === true) leaf.bullet = true;
      if (tone) leaf.tone = tone as TextTone;
      return leaf;
    }
    case "image": {
      const url = requiredText(node.url, `${path}.url`);
      if (!/^(https?:\/\/|everroom-material:\/\/)/i.test(url)) {
        bad(`${path}.url 只接受 http(s) 直链或 everroom-material:// 素材引用，收到 ${url.slice(0, 60)}`);
      }
      const leaf: ImageLeaf = { type: "image", url, ...(node.contain === true ? { contain: true } : {}) };
      if (node.radius === true) leaf.radius = true;
      else if (node.radius !== undefined) bad(`${path}.radius 只接受 true（圆角卡）`);
      if (node.circle === true) leaf.circle = true;
      else if (node.circle !== undefined) bad(`${path}.circle 只接受 true（圆形裁切）`);
      if (leaf.circle && leaf.radius) bad(`${path}.circle 与 radius 二选一`);
      if (node.focus !== undefined) {
        if (typeof node.focus !== "object" || node.focus === null || Array.isArray(node.focus)) {
          bad(`${path}.focus 必须是 { x?, y? }（图片宽高的百分比 0~100）`);
        }
        const f = node.focus as { x?: unknown; y?: unknown };
        const pct = (v: unknown, what: string): number | undefined => {
          if (v === undefined) return undefined;
          if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) {
            bad(`${path}.focus.${what} 必须是 0~100 的数字，收到 ${String(v)}`);
          }
          return v as number;
        };
        const x = pct(f.x, "x");
        const y = pct(f.y, "y");
        if (x !== undefined || y !== undefined) leaf.focus = { ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) };
      }
      if (node.duotone === true) leaf.duotone = true;
      else if (node.duotone !== undefined) bad(`${path}.duotone 只接受 true（主题双色调）`);
      if (node.grayscale === true) leaf.grayscale = true;
      else if (node.grayscale !== undefined) bad(`${path}.grayscale 只接受 true（灰度化）`);
      if (leaf.grayscale && leaf.duotone) bad(`${path}.grayscale 与 duotone 二选一`);
      const caption = optionalText(node.caption, 40);
      if (caption !== undefined) leaf.caption = caption;
      return leaf;
    }
    case "card": {
      bad(`${path}.type "card" 已拆分为组件——KPI 卡用 { "type": "component", "name": "stats", items: [...] }，文字卡用 "name": "featureCards"`);
    }
    case "component": {
      return normalizeComponentLeaf(node, path);
    }
    case "path": {
      const d = requiredText(node.d, `${path}.d`);
      return { type: "path", d };
    }
    case "divider": {
      return { type: "divider" };
    }
    case "icon": {
      const icon = requiredText(node.icon, `${path}.icon`).toLowerCase();
      if (!ICON_NAMES.includes(icon)) {
        bad(`${path}.icon 必须是引擎图标集内的名称（如 check-circle、light-bulb、chart-bar、rocket-launch、users），收到 ${icon}`);
      }
      return { type: "icon", icon };
    }
    case "chart": {
      const kind = node.kind;
      if (typeof kind !== "string" || !CHART_KINDS.includes(kind as ChartKind)) {
        bad(`${path}.kind 必须是 ${CHART_KINDS.join("|")}，收到 ${String(kind)}`);
      }
      const categories = stringArray(node.categories, `${path}.categories`, 2, 24, 24);
      const seriesRaw = node.series;
      if (!Array.isArray(seriesRaw) || seriesRaw.length < 1 || seriesRaw.length > 6) bad(`${path}.series 必须是 1~6 项的数组`);
      const series = (seriesRaw as Record<string, unknown>[]).map((s, i) => {
        const name = requiredText(s.name, `${path}.series[${i}].name`).slice(0, 20);
        const values = s.values;
        if (!Array.isArray(values) || values.some((v) => typeof v !== "number" || !Number.isFinite(v))) {
          bad(`${path}.series[${i}].values 必须全是数字`);
        }
        if ((values as number[]).length !== categories.length) {
          bad(`${path}.series[${i}].values 数量（${(values as number[]).length}）必须等于 categories（${categories.length}）`);
        }
        return { name, values: values as number[] };
      });
      if (kind === "comboBarLine" && series.length < 2) bad(`${path} comboBarLine 必须至少 2 个系列`);
      if (kind === "waterfall") {
        if (series.length !== 1) bad(`${path} waterfall 只接受 1 个系列（values 为有符号增减，正=升、负=降；末列画 0→合计的结果柱）`);
        if (categories.length > 8) bad(`${path} waterfall 最多 8 列（收到 ${categories.length}）`);
      }
      const leaf: ChartLeaf = { type: "chart", kind: kind as ChartKind, categories, series, ...(node.legend === true ? { legend: true } : {}) };
      if (node.highlight !== undefined) {
        if (node.highlight === "last") leaf.highlight = "last";
        else if (typeof node.highlight === "number" && Number.isInteger(node.highlight) && node.highlight >= 0 && node.highlight < categories.length) {
          leaf.highlight = node.highlight;
        } else {
          bad(`${path}.highlight 必须是 "last" 或 0~${categories.length - 1} 的整数，收到 ${String(node.highlight)}`);
        }
        if (kind === "pie" || kind === "doughnut" || kind === "scatter" || kind === "waterfall") {
          bad(`${path}.highlight 不支持 ${kind}（用于 bar/barStacked/line/area/comboBarLine）`);
        }
      }
      if (node.delta !== undefined) {
        if (kind === "pie" || kind === "doughnut" || kind === "waterfall") {
          bad(`${path}.delta 不支持 ${kind}`);
        }
        const delta = optionalText(node.delta, 12);
        if (delta !== undefined) leaf.delta = delta;
      }
      return leaf;
    }
    case "table": {
      const headerOff = node.header === false;
      if (node.header !== undefined && node.header !== false) {
        bad(`${path}.header 只接受 false（关掉表头，rows 全为数据行）`);
      }
      const rowsRaw = node.rows;
      if (!Array.isArray(rowsRaw) || rowsRaw.length < 2 || rowsRaw.length > 12) bad(`${path}.rows 必须是 2~12 行${headerOff ? "" : "（表头+数据）"}`);
      const colCount = Array.isArray(rowsRaw[0]) ? (rowsRaw[0] as unknown[]).length : -1;
      if (colCount < 2 || colCount > 8) bad(`${path} 每行必须是 2~8 列`);
      const rows = (rowsRaw as unknown[][]).map((row, r) => {
        if (!Array.isArray(row) || row.length !== colCount) bad(`${path}.rows[${r}] 列数必须一致（${colCount} 列）`);
        return row.map((cell) => {
          if (typeof cell === "string") return cell.slice(0, 300);
          if (typeof cell === "object" && cell !== null && typeof (cell as { text?: unknown }).text === "string") {
            const c = cell as { text: string; bold?: boolean; align?: "left" | "center" | "right" };
            return { text: c.text.slice(0, 300), ...(c.bold !== undefined ? { bold: c.bold } : {}), ...(c.align ? { align: c.align } : {}) };
          }
          bad(`${path}.rows[${r}] 的单元格必须是字符串或 {text,...}`);
        });
      });
      let colWidths: number[] | undefined;
      if (node.colWidths !== undefined) {
        const cw = node.colWidths;
        if (!Array.isArray(cw) || cw.length !== colCount || cw.some((v) => typeof v !== "number" || v <= 0)) {
          bad(`${path}.colWidths 长度必须等于列数（${colCount}）且全为正数`);
        }
        colWidths = cw as number[];
      }
      const style = node.style;
      if (style !== undefined && !["lines", "darkHeader", "zebra"].includes(style as string)) {
        bad(`${path}.style 必须是 lines|darkHeader|zebra`);
      }
      if (headerOff && style === "darkHeader") {
        bad(`${path} darkHeader 样式需要表头——与 header: false 互斥`);
      }
      const leaf: TableLeaf = { type: "table", rows };
      if (colWidths) leaf.colWidths = colWidths;
      if (style) leaf.style = style as TableStyle;
      if (headerOff) leaf.header = false;
      if (node.topRule !== undefined) {
        if (node.topRule !== true) bad(`${path}.topRule 只接受 true（表格顶部压 2px 墨线）`);
        leaf.topRule = true;
      }
      return leaf;
    }
    default:
      bad(`${path}.type 必须是 text|image|path|chart|table|divider|icon|component，收到 ${String(node.type)}`);
  }
}

function asContainer(node: Record<string, unknown>, path: string): ContainerNode {
  const direction = node.direction as Direction;
  if (direction === "overlay") {
    if (node.weights !== undefined) bad(`${path}.weights 不支持 overlay 容器——叠层子节点各自用 place 定位`);
    if (node.gapScale !== undefined) bad(`${path}.gapScale 不支持 overlay 容器——子节点间距用 place 自行留出`);
  }
  const childrenRaw = node.children;
  if (!Array.isArray(childrenRaw) || childrenRaw.length < 1) bad(`${path}.children 至少 1 项`);
  if (childrenRaw.length > MAX_CHILDREN) bad(`${path}.children 最多 ${MAX_CHILDREN} 项，收到 ${childrenRaw.length}——拆层级或精简`);
  const children = childrenRaw.map((rawChild, i) => {
    const child = asNode(rawChild, `${path}/${i}`) as ChildNode;
    const placeRaw = (rawChild as Record<string, unknown>).place;
    const place = normalizePlace(placeRaw, `${path}/${i}`);
    if (direction === "overlay") {
      if (!place) bad(`${path}/${i} 缺 place——overlay 容器的每个直接子节点必须用 place 定位（百分比）`);
      return { ...child, place } as ChildNode;
    }
    if (place) bad(`${path}/${i}.place 只允许出现在 overlay 容器的直接子节点上`);
    return child;
  });
  const weights = direction === "overlay" ? undefined : normalizeWeights(node.weights, children.length, path);
  const panel = normalizePanel(node.panel, path);
  return {
    direction,
    ...(weights ? { weights } : {}),
    ...(direction === "overlay" ? {} : normalizeGapScale(node.gapScale, path)),
    ...normalizePad(node.pad, path),
    ...normalizeJustify(node.justify, direction, path),
    ...(panel ? { panel } : {}),
    children,
  };
}

function normalizeJustify(raw: unknown, direction: Direction, path: string): { justify?: MainJustify } {
  if (raw === undefined) return {};
  if (raw === "start") return {}; // 与缺省等价，省字段
  if (raw !== "center" && raw !== "end") bad(`${path}.justify 必须是 start|center|end`);
  if (direction !== "column") bad(`${path}.justify 只用于 column 容器（overlay 子节点用 place 定位，row 上下分无打包语义）`);
  return { justify: raw as MainJustify };
}

/** 根 bg 字段的归一。 */
function normalizeBg(raw: unknown): BgSpec | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("bg 必须是 { image, scrim? }");
  const b = raw as Record<string, unknown>;
  const image = requiredText(b.image, "bg.image");
  if (!/^(https?:\/\/|everroom-material:\/\/)/i.test(image)) {
    bad(`bg.image 只接受 http(s) 直链或 everroom-material:// 素材引用，收到 ${image.slice(0, 60)}`);
  }
  if (b.scrim !== undefined && b.scrim !== "none" && b.scrim !== "gradient") {
    bad('bg.scrim 只接受 "none"（不压纱罩）或 "gradient"（渐层纱罩）；缺省自动压深色纱罩');
  }
  return { image, ...(b.scrim === "none" || b.scrim === "gradient" ? { scrim: b.scrim } : {}) };
}

function normalizeWeights(raw: unknown, count: number, path: string): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) bad(`${path}.weights 必须是数字数组`);
  if (raw.length !== count) bad(`${path}.weights 长度（${raw.length}）必须等于 children 数（${count}）`);
  return (raw as unknown[]).map((v, i) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`${path}.weights[${i}] 必须是正数`);
    if ((v as number) > 20) bad(`${path}.weights[${i}] 最大 20（比例悬殊用 pad 调呼吸感，别用 100:1）`);
    return v as number;
  });
}

function normalizeGapScale(raw: unknown, path: string): { gapScale?: number } {
  if (raw === undefined) return {};
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 4) bad(`${path}.gapScale 必须是 0~4`);
  return raw === 1 ? {} : { gapScale: raw };
}

function normalizePad(raw: unknown, path: string): { pad?: number } {
  if (raw === undefined) return {};
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 48) bad(`${path}.pad 必须是 0~48`);
  return raw === 0 ? {} : { pad: raw };
}

function requiredText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) bad(`缺少 ${what}（非空字符串）`);
  return value.trim().slice(0, MAX_TEXT);
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().slice(0, max);
}

function stringArray(raw: unknown, what: string, min: number, max: number, itemMax: number): string[] {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) bad(`${what} 必须是 ${min}~${max} 项的数组`);
  return (raw as unknown[]).map((item, i) => {
    if (typeof item !== "string" || !item.trim()) bad(`${what}[${i}] 必须是非空字符串`);
    return item.trim().slice(0, itemMax);
  });
}

let nodeBudget = 0;

function spendBudget(path: string): void {
  nodeBudget += 1;
  if (nodeBudget > MAX_TOTAL_NODES) {
    bad(`节点总数超过 ${MAX_TOTAL_NODES}（在 ${path} 附近）——层级过碎，合并兄弟节点`);
  }
}

/** 宽松归一：结构/类型/上限校验 + 字段清洗。错误以 LAYOUT_TREE_INVALID 开头回传模型自纠。 */
export function normalizeTree(raw: unknown): LayoutTree {
  nodeBudget = 0;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) bad("树根必须是对象");
  const root = raw as Record<string, unknown>;
  const role = typeof root.role === "string" && root.role.trim() ? root.role.trim().slice(0, 24) : "content";
  const title = optionalText(root.title, 80);
  const bg = normalizeBg(root.bg);
  if (root.direction !== "row" && root.direction !== "column" && root.direction !== "overlay") bad("root.direction 必须是 row|column|overlay");
  const direction = root.direction as Direction;
  if (direction === "overlay") {
    if (root.weights !== undefined) bad("root.weights 不支持 overlay 根——叠层子节点各自用 place 定位");
    if (root.gapScale !== undefined) bad("root.gapScale 不支持 overlay 根——子节点间距用 place 自行留出");
  }
  const childrenRaw = root.children;
  if (!Array.isArray(childrenRaw) || childrenRaw.length < 1) bad("root.children 至少 1 项");
  if (childrenRaw.length > MAX_CHILDREN) bad(`root.children 最多 ${MAX_CHILDREN} 项`);
  spendBudget("root");
  const children = childrenRaw.map((rawChild, i) => {
    const child = asNode(rawChild, `root/${i}`) as ChildNode;
    const place = normalizePlace((rawChild as Record<string, unknown>).place, `root/${i}`);
    if (direction === "overlay") {
      if (!place) bad(`root/${i} 缺 place——overlay 根的每个直接子节点必须用 place 定位（百分比）`);
      return { ...child, place } as ChildNode;
    }
    if (place) bad(`root/${i}.place 只允许出现在 overlay 容器的直接子节点上`);
    return child;
  });
  const weights = direction === "overlay" ? undefined : normalizeWeights(root.weights, children.length, "root");
  const panel = normalizePanel(root.panel, "root");
  return {
    role,
    ...(title ? { title } : {}),
    ...(root.dark === true ? { dark: true } : {}),
    ...(bg ? { bg } : {}),
    direction,
    ...(weights ? { weights } : {}),
    ...(direction === "overlay" ? {} : normalizeGapScale(root.gapScale, "root")),
    ...normalizePad(root.pad, "root"),
    ...normalizeJustify(root.justify, direction, "root"),
    ...(panel ? { panel } : {}),
    children,
  };
}

/** 归一失败的错误类型（validate 工具据此转缺陷）。 */
export function isTreeError(error: unknown): error is TreeError {
  return error instanceof TreeError;
}
