/**
 * 页面的**结构指标**：把"这页排得乱不乱"变成数字。
 *
 * 只测量、不修正——这是第二册的第一步：先让现状有多差变成可比的数，
 * 否则后面加骨架库没法判断是不是真的改好了。
 *
 * 量的五件事（都对应一类真实崩坏）：
 *   1. 主角面积：一页该只有一个东西在抢注意力；
 *   2. 留白率：挤成一张纸 vs 空得像没做完；
 *   3. 对齐轴：每块各自居中 → 视觉上是散的；
 *   4. 行长度 measure：通栏长文是"AI 味"的隐形来源；
 *   5. 字号档数：全挤两档显平，五档以上显乱。
 */

import { CANVAS_H, CANVAS_W, CONTENT_BOTTOM, CONTENT_TOP } from "./grid.js";
import {
  CRAFT_BANDS,
  CRAFT_LIMITS,
  MAX_WHITESPACE_JUMP,
  craftBandFor,
  fontTiers,
  formRuleFor,
  measureCharsFor,
  ptToPx,
  tierSpan,
  type CraftBand,
} from "./craft.js";
import type { SpecElement, SpecParagraph } from "./elements.js";
import { estimateLines } from "./text-metrics.js";
import type { ResolvedTheme } from "./theme.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 内容区（不含页标题带）：判断版式结构时只看这一块。 */
export function contentBox(): Rect {
  return { x: 0, y: CONTENT_TOP, w: CANVAS_W, h: CONTENT_BOTTOM - CONTENT_TOP };
}

/**
 * 页脚带起点：页脚/页码/分隔线是**页面装饰**，不是内容块。
 * 把它们算进"对齐轴/字号档/留白"会让每页都多一档字号、多一条轴——
 * 量的是版式，不是 chrome。
 */
export const CHROME_TOP = 660;

/** 大字（≥40pt）不参与"行长度"判定：一屏一句的标语天生就是长行。 */
const MEASURE_SKIP_PT = 40;

function clip(rect: Rect, box: Rect): Rect | null {
  const x = Math.max(rect.x, box.x);
  const y = Math.max(rect.y, box.y);
  const right = Math.min(rect.x + rect.w, box.x + box.w);
  const bottom = Math.min(rect.y + rect.h, box.y + box.h);
  if (right <= x || bottom <= y) return null;
  return { x, y, w: right - x, h: bottom - y };
}

/** 若干矩形的并集面积（坐标压缩，n 很小，够用且无依赖）。 */
export function unionArea(rects: ReadonlyArray<Rect>, box: Rect): number {
  const clipped = rects
    .map((rect) => clip(rect, box))
    .filter((rect): rect is Rect => rect !== null && rect.w > 0 && rect.h > 0);
  if (clipped.length === 0) return 0;
  const xs = [...new Set(clipped.flatMap((rect) => [rect.x, rect.x + rect.w]))].sort((a, b) => a - b);
  const ys = [...new Set(clipped.flatMap((rect) => [rect.y, rect.y + rect.h]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < ys.length - 1; j += 1) {
      const cx = xs[i]!;
      const cy = ys[j]!;
      const cw = xs[i + 1]! - cx;
      const ch = ys[j + 1]! - cy;
      if (cw <= 0 || ch <= 0) continue;
      const covered = clipped.some(
        (rect) => rect.x <= cx && rect.y <= cy && rect.x + rect.w >= cx + cw && rect.y + rect.h >= cy + ch,
      );
      if (covered) area += cw * ch;
    }
  }
  return area;
}

/** 两块的显著重叠面积（取较小者面积的比例）。 */
export function overlapRatio(a: Rect, b: Rect): number {
  const intersection = clip(a, { x: b.x, y: b.y, w: b.w, h: b.h });
  if (!intersection) return 0;
  const small = Math.min(a.w * a.h, b.w * b.h);
  if (small <= 0) return 0;
  return (intersection.w * intersection.h) / small;
}

interface TextSample {
  text: string;
  sizePt: number;
  boxW: number;
  x: number;
  align: "left" | "center" | "right";
}

function paragraphsOf(element: SpecElement): SpecParagraph[] {
  if (element.type === "text") return element.paragraphs;
  if (element.type === "shape") return element.paragraphs ?? [];
  return [];
}

/** 抽出所有"看得见的字"：文本/形状里的段落，逐 run 取最大字号。 */
function textSamples(element: SpecElement): TextSample[] {
  const samples: TextSample[] = [];
  for (const paragraph of paragraphsOf(element)) {
    const text = paragraph.runs.map((run) => run.text).join("").trim();
    if (!text) continue;
    const sizePt = Math.max(...paragraph.runs.map((run) => run.sizePt ?? 0), 0);
    if (sizePt <= 0) continue;
    samples.push({ text, sizePt, boxW: element.w, x: element.x, align: paragraph.align ?? "left" });
  }
  return samples;
}

/** 该元素是不是"视觉块"（判断主角与留白时只算这些，背景/分隔线不算）。 */
function isVisualBlock(element: SpecElement, box: Rect): boolean {
  if (element.type === "text") return element.w * element.h > 0;
  if (element.type === "shape") {
    // 全屏色块是背景，不是内容块。
    return !(element.w >= box.w * 0.98 && element.h >= box.h * 0.98);
  }
  return element.w * element.h > 0;
}

export interface PageStructure {
  /** 主角面积比：最大视觉块 / 内容区。 */
  heroAreaRatio: number;
  heroType: string;
  /** 留白率：1 − 并集面积 / 内容区。 */
  whitespaceRatio: number;
  /** 文字左边缘聚类数（对齐轴数）。 */
  alignAxes: number;
  alignAxisXs: number[];
  /** 最长一行的字数（按字宽估算）。 */
  measureMax: number;
  /** 超出行长上限的文字块数。 */
  measureOver: number;
  /** 同页字号档数。 */
  tierSpan: number;
  /** 显著压叠的成对数。 */
  overlaps: number;
  /** 未落在 16px 间距网格上的块数。 */
  offGrid: number;
  elementCount: number;
}

export interface MeasurePageOptions {
  theme: ResolvedTheme;
  /** 覆盖内容区（出血页/整版图可以放宽）。 */
  box?: Rect;
  /** 结构档：远距投影用 projected，近距研读用 document。缺省 projected。 */
  band?: CraftBand;
}

/** 单页结构指标。纯函数：同输入同输出。 */
export function measurePage(elements: ReadonlyArray<SpecElement>, options: MeasurePageOptions): PageStructure {
  const box = options.box ?? contentBox();
  const blocks = elements.filter((element) => isVisualBlock(element, box) && element.y < CHROME_TOP);
  const boxArea = box.w * box.h;

  let heroAreaRatio = 0;
  let heroType = "none";
  for (const block of blocks) {
    const area = block.w * block.h;
    if (area > heroAreaRatio * boxArea) {
      heroAreaRatio = area / boxArea;
      heroType = block.type;
    }
  }

  const covered = unionArea(blocks, box);
  const whitespaceRatio = boxArea > 0 ? Math.max(0, 1 - covered / boxArea) : 0;

  // 对齐轴：文字左边缘按 12px 容差聚类（渲染取整 + 光学对齐的余量）。
  const edges = [...new Set(blocks.filter((element) => element.type === "text").map((element) => element.x))].sort((a, b) => a - b);
  const axisXs: number[] = [];
  for (const edge of edges) {
    const last = axisXs[axisXs.length - 1];
    if (last === undefined || edge - last > 12) axisXs.push(edge);
  }

  let measureMax = 0;
  let measureOver = 0;
  const sizes: number[] = [];
  for (const element of blocks) {
    for (const sample of textSamples(element)) {
      sizes.push(sample.sizePt);
      // 用与渲染器同一套估算：折成几行 → 每行几个字。
      const lines = sample.boxW > 0 ? estimateLines(sample.text, sample.sizePt, sample.boxW) : sample.text.length;
      const chars = Math.max(1, Math.round(sample.text.length / Math.max(1, lines)));
      measureMax = Math.max(measureMax, chars);
      // 行长度限制针对"需要连续读的正文"：display/hero 这种一屏一句的大字，
      // 长一点是排版问题（折行由 measure 的溢出检查管），不是"读不动"。
      if (sample.sizePt >= MEASURE_SKIP_PT) continue;
      if (chars > measureCharsFor(sample.sizePt, options.theme.typeScale, options.band ?? CRAFT_BANDS.projected)) measureOver += 1;
    }
  }

  // 压叠只算"文字压文字"：发丝线、色块底、组件内部层叠都是有意为之，
  // 真看起来断掉的是两段字叠在一起。发丝线（<3px）本来就不是块，一并排除。
  const textBlocks = elements.filter((element) => {
    if (!isVisualBlock(element, box) || element.y >= CHROME_TOP) return false;
    return paragraphsOf(element).some((paragraph) => paragraph.runs.some((run) => run.text.trim().length > 0));
  });
  const solid = textBlocks.filter((block) => block.w > 3 && block.h > 3);
  let overlaps = 0;
  for (let i = 0; i < solid.length; i += 1) {
    for (let j = i + 1; j < solid.length; j += 1) {
      if (overlapRatio(solid[i]!, solid[j]!) > CRAFT_LIMITS.overlapTolerance) overlaps += 1;
    }
  }

  const offGrid = blocks.filter((block) => {
    const gaps = [block.x, block.y].filter((value) => value > 0 && value < CANVAS_W);
    return gaps.some((value) => Math.abs(value - Math.round(value / 16) * 16) > 1);
  }).length;

  return {
    heroAreaRatio: Number(heroAreaRatio.toFixed(3)),
    heroType,
    whitespaceRatio: Number(whitespaceRatio.toFixed(3)),
    alignAxes: axisXs.length,
    alignAxisXs: axisXs,
    measureMax,
    measureOver,
    tierSpan: tierSpan(sizes),
    overlaps,
    offGrid,
    elementCount: blocks.length,
  };
}

export interface DeckStructureInput {
  pages: ReadonlyArray<ReadonlyArray<SpecElement>>;
  theme: ResolvedTheme;
  /** 场景距离（far/near）；缺省 far（投影档）。 */
  distance?: "far" | "near";
  /** 场景密度（只影响留白区间）。 */
  density?: "airy" | "standard" | "dense";
  /** 每页的骨架 id（v3 之后才有；缺省用 composition 或空）。 */
  keys?: ReadonlyArray<string | undefined>;
  /** 每页的形态（用于表格占比的分母口径）。 */
  forms?: ReadonlyArray<string | undefined>;
}

export interface DeckStructureReport {
  pageCount: number;
  pages: PageStructure[];
  /** 最长连续同骨架页数。 */
  maxKeyRun: number;
  /** 骨架种类数（缺省 key 时按 0 处理）。 */
  keyVariety: number;
  /** 带表格的页数 / 总页数。 */
  tableShare: number;
  tableAllowance: number;
  /** 页均留白率。 */
  avgWhitespace: number;
  /** 相邻页留白率最大跳变。 */
  maxWhitespaceJump: number;
  /** 字号档数（全册）。 */
  tierSpan: number;
  failures: string[];
}

/** 最长连续相同 key 的页数。 */
export function maxConsecutiveRun(keys: ReadonlyArray<string | undefined>): number {
  let best = 0;
  let run = 0;
  let previous: string | undefined;
  for (const key of keys) {
    if (key && key === previous) run += 1;
    else run = key ? 1 : 0;
    previous = key;
    best = Math.max(best, run);
  }
  return best;
}

export function deckStructure(input: DeckStructureInput): DeckStructureReport {
  const band = craftBandFor(input.distance);
  const pages = input.pages.map((elements) => measurePage(elements, { theme: input.theme, band }));
  const keys = input.pages.map((_page, index) => input.keys?.[index]);
  const tablePages = input.pages.filter((elements) => elements.some((element) => element.type === "table")).length;
  const tableAllowance = Math.max(1, Math.ceil(input.pages.length / CRAFT_LIMITS.tableShareDenominator));
  const whitespace = pages.map((page) => page.whitespaceRatio);
  const jumps = whitespace.slice(1).map((value, index) => Math.abs(value - whitespace[index]!));
  const allSizes = pages.flatMap((page) => (page.tierSpan > 0 ? [page.tierSpan] : []));

  const failures: string[] = [];
  const whitespaceBand = input.density
    ? CRAFT_LIMITS.whitespaceRatio[input.density]
    : band.whitespaceRatio;
  pages.forEach((page, index) => {
    const where = `第 ${index + 1} 页`;
    const rule = formRuleFor(input.forms?.[index], band);
    if (page.heroAreaRatio < rule.heroMin) {
      failures.push(`${where}：主角面积 ${(page.heroAreaRatio * 100).toFixed(0)}% < ${rule.heroMin * 100}%（这页没有主角）`);
    }
    // 上限先由密度决定，形态可以再放宽（过渡页本来就该空）。下限仍按密度。
    const whiteMax = Math.max(whitespaceBand.max, rule.whitespaceMax);
    const whiteMin = Math.min(whitespaceBand.min, rule.whitespaceMin);
    if (page.whitespaceRatio < whiteMin || page.whitespaceRatio > whiteMax) {
      failures.push(
        `${where}：留白率 ${(page.whitespaceRatio * 100).toFixed(0)}% 落在 ${whiteMin * 100}~${whiteMax * 100}% 之外`,
      );
    }
    if (page.alignAxes > rule.maxAxes) {
      failures.push(`${where}：文字左边缘有 ${page.alignAxes} 条对齐轴（该形态上限 ${rule.maxAxes}）`);
    }
    if (page.measureOver > 0) {
      const cap = measureCharsFor(input.theme.typeScale.body, input.theme.typeScale, band);
      failures.push(`${where}：${page.measureOver} 个文字块行长度超限（正文 ≤${cap} 字/行）`);
    }
    if (page.tierSpan > band.tierSpan.max) {
      failures.push(`${where}：字号 ${page.tierSpan} 档（上限 ${band.tierSpan.max} 档，太多显乱）`);
    }
    if (page.tierSpan < rule.minTiers) {
      failures.push(`${where}：全页只有 ${page.tierSpan} 档字号（该形态下限 ${rule.minTiers} 档，太平）`);
    }
    if (page.heroAreaRatio > rule.heroMax) {
      failures.push(`${where}：主角面积 ${(page.heroAreaRatio * 100).toFixed(0)}% > ${rule.heroMax * 100}%（一块吃掉整页）`);
    }
    if (page.overlaps > 0) failures.push(`${where}：${page.overlaps} 处块压叠`);
  });
  if (maxConsecutiveRun(keys) >= 3) {
    failures.push(`全册：连续 ${maxConsecutiveRun(keys)} 页用同一个骨架（禁止连续三页）`);
  }
  if (tablePages > tableAllowance) {
    failures.push(`全册：${tablePages} 页用了表格，超过配额 ${tableAllowance} 页`);
  }
  const maxJump = jumps.length > 0 ? Math.max(...jumps) : 0;
  if (maxJump > MAX_WHITESPACE_JUMP) {
    failures.push(`全册：相邻页留白率跳变 ${(maxJump * 100).toFixed(0)}%（上限 ${MAX_WHITESPACE_JUMP * 100}%），页面忽挤忽空`);
  }

  return {
    pageCount: input.pages.length,
    pages,
    maxKeyRun: maxConsecutiveRun(keys),
    keyVariety: new Set(keys.filter((key): key is string => Boolean(key))).size,
    tableShare: input.pages.length > 0 ? Number((tablePages / input.pages.length).toFixed(3)) : 0,
    tableAllowance,
    avgWhitespace: whitespace.length > 0 ? Number((whitespace.reduce((a, b) => a + b, 0) / whitespace.length).toFixed(3)) : 0,
    maxWhitespaceJump: Number(maxJump.toFixed(3)),
    tierSpan: allSizes.length > 0 ? Math.max(...allSizes) : 0,
    failures,
  };
}

/** 供报告用的一行摘要。 */
export function structureSummary(report: DeckStructureReport): string {
  const hero = report.pages.map((page) => `${Math.round(page.heroAreaRatio * 100)}%`).join("/");
  return [
    `${report.pageCount} 页`,
    `留白 ${Math.round(report.avgWhitespace * 100)}%`,
    `对齐轴 max ${Math.max(...report.pages.map((page) => page.alignAxes), 0)}`,
    `measure max ${Math.max(...report.pages.map((page) => page.measureMax), 0)} 字`,
    `档数 ${report.tierSpan}`,
    `表格 ${report.tableShare}`,
    `主角 ${hero}`,
    `失败 ${report.failures.length}`,
  ].join(" · ");
}

export const STRUCTURE_CANVAS = { width: CANVAS_W, height: CANVAS_H, ptToPx } as const;
