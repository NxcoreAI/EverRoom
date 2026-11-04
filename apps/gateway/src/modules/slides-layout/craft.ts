/**
 * 排版手艺（craft）：把"看着舒服"里能写成数字的那部分**固定成常量与断言**。
 *
 * 为什么要这个模块：版式崩坏里有一半不是"排法选错了"，而是基本功没做——
 * 行太长、间距各是各的数、字号全挤在两档、一页三个东西抢注意力。
 * 这些都能写成可判定的规则，写一次全册受益，不需要模型懂审美。
 *
 * 约定：
 * - 画布 1280×720px = 960×540pt，所以 **1px = 0.75pt，1pt = 4/3 px**；
 * - 这里只放"数字与判定"，具体怎么排是骨架的事（tree/v3/skeletons）；
 * - 阈值不是拍脑袋：见 docs/slides-layout-batch2-plan.zh-CN.md §6 与基线实测（§附录）。
 */

/** 画布换算：PPTX 侧是 960×540pt，画布是 1280×720px。 */
export const PX_PER_PT = 4 / 3;

export function ptToPx(pt: number): number {
  return pt * PX_PER_PT;
}

export function pxToPt(px: number): number {
  return px / PX_PER_PT;
}

/**
 * 间距网格：所有块间距、内边距吸到 16px（=12pt）的整数倍。
 * 为什么是 16px：它同时是 12pt 的整数倍（121 → 12pt 的常规基线），
 * 而 8pt 基线（10.67px）在 px 画布上除不尽，反而会造成半像素毛边。
 */
export const SPACING_GRID_PX = 16;

export function snapSpacing(px: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.round(px / SPACING_GRID_PX) * SPACING_GRID_PX;
}

/** 是否落在网格上（容差默认 1px，容忍渲染取整）。 */
export function onSpacingGrid(px: number, tolerancePx = 1): boolean {
  if (!Number.isFinite(px)) return false;
  return Math.abs(px - snapSpacing(px)) <= tolerancePx;
}

/** 版式字阶 token（与 scene.ts 的 TypeToken 同名，避免两套词）。 */
export type CraftToken =
  | "display" | "hero" | "h1" | "h2" | "h3"
  | "lead" | "body" | "label" | "kicker" | "caption";

/**
 * 行长度上限（中文字/行）。依据：西文 60~75 字符的经典 measure 换算成中文约 20~30 字；
 * 越大越接近"通栏长文"，眼睛回扫成本陡增，也是"AI 味"的隐形来源。
 */
export const MEASURE_CHARS: Record<CraftToken, number> = {
  display: 10,
  hero: 12,
  h1: 15,
  h2: 17,
  h3: 19,
  lead: 20,
  body: 22,
  label: 26,
  kicker: 26,
  caption: 28,
};

/** 字号 → 行字数上限（取不超过该字号的最大档，找不到就用 body 档）。 */
export function measureCharsFor(
  sizePt: number,
  scale: Partial<Record<CraftToken, number>>,
  band: CraftBand = CRAFT_BANDS.projected,
): number {
  const tokens: CraftToken[] = ["display", "hero", "h1", "h2", "h3", "lead", "body", "label", "kicker", "caption"];
  const ranked = tokens
    .map((token) => ({ token, size: scale[token] }))
    .filter((row): row is { token: CraftToken; size: number } => typeof row.size === "number" && row.size > 0)
    .sort((a, b) => b.size - a.size);
  const limit = (token: CraftToken) => Math.round(MEASURE_CHARS[token] * band.measureFactor);
  for (const row of ranked) {
    if (sizePt >= row.size) return limit(row.token);
  }
  return limit("body");
}

/** 一行装下 chars 个中文字需要多宽（px）。用与渲染器同一套字宽估算。 */
export function lineWidthPx(chars: number, sizePt: number): number {
  // estimateTextWidth 对中文字按 1.35 × sizePt 计；这里复用同一系数，保证与落页口径一致。
  return chars * 1.35 * sizePt;
}

/**
 * 结构闸门的"档"：**阈值必须跟着观看距离走**，不能一套打天下。
 *
 * 依据（2026-10-22 基线实测，见 docs/slides-layout-batch2-plan.zh-CN.md 附录）：
 * 一份人工调整过的"好 deck"（nexwing 13 页，研读型）页均主角 19%、对齐轴最多 7 条、
 * 最长行 33 字、字号 4~7 档——按投影档的尺子（主角 ≥30%、对齐轴 ≤2、正文 ≤22 字）
 * 它每一页都不合格。这不是那份 deck 差，而是**它本来就不是投影用的**：
 * 研读材料就该密、就该多栏、就该长行。所以分两档：
 *
 *   projected（远距：路演/发布会/评审投影）——一页一个主张，主力字号 ≥20pt；
 *   document（近距：培训讲义/研读材料）——允许密排与多栏，但仍有下限（不许低于 12pt 的正文）。
 *
 * 每一档的数字都是"能自动判死"的硬门槛，不是审美偏好。
 */
export interface CraftBand {
  /** 一页一主角：最大元素面积 / 内容区面积。 */
  heroAreaRatio: { min: number; max: number };
  /** 同页文字左边缘至多落在几条对齐轴上。 */
  maxAlignAxes: number;
  /** 行长度上限的倍率（基准见 MEASURE_CHARS）。 */
  measureFactor: number;
  /** 同页字号档数区间。 */
  tierSpan: { min: number; max: number };
  /** 留白率区间（投影档再按场景密度收窄）。 */
  whitespaceRatio: { min: number; max: number };
}

export const CRAFT_BANDS: Record<"projected" | "document", CraftBand> = {
  projected: {
    heroAreaRatio: { min: 0.3, max: 0.72 },
    maxAlignAxes: 2,
    measureFactor: 1,
    tierSpan: { min: 2, max: 4 },
    whitespaceRatio: { min: 0.2, max: 0.5 },
  },
  // 数字来自 nexwing 实测分布的上下包络：主角 10~37%、对齐轴 1~7、行 11~33 字、字号 3~7 档、留白 27~50%。
  document: {
    heroAreaRatio: { min: 0.1, max: 0.55 },
    maxAlignAxes: 6,
    measureFactor: 1.5,
    tierSpan: { min: 2, max: 7 },
    whitespaceRatio: { min: 0.18, max: 0.55 },
  },
};

/**
 * 分形态的主角/对齐轴期望（画廊实测逼出来的修正）：
 * 「一页一主角 ≥30%、对齐轴 ≤2」只对**单主角形态**成立。两栏对照天然有两个块、
 * 三栏轨道天然有三条左边缘——拿单栏的尺子去量，它们永远不合格。
 * 所以按 form 给不同的下限，同时保留"不许变成等权卡片墙"的意图（heroMin 仍为正）。
 */
export interface FormRule {
  /** 最大块的面积下限（内容区占比）。 */
  heroMin: number;
  /** 最大块的面积上限：表格/图片满版本来就该占大头，别当成"满版图"拦掉。 */
  heroMax: number;
  /** 对齐轴上限：约等于该形态允许的列数。 */
  maxAxes: number;
  /** 字号档下限：满宽表格全表同字号是正常的，不逼它凑档。 */
  minTiers: number;
  /** 留白率上限：过渡页/单线索页本来就该空，按形态放宽而不是按密度死卡。 */
  whitespaceMax: number;
  /** 留白率下限：表格/满版图本来就塞满，不按密度档的下限去逼它留空。 */
  whitespaceMin: number;
}

export const FORM_RULES: Record<string, FormRule> = {
  // 文字型主角（一个大数字）按墨迹面积量：60pt 数字 + 标签的墨迹约 25%，
  // 换成 0.3 会让所有"一句结论 + 一个大数字"的页都不达标——照实测定档。
  // minTiers 1：一句话海报（没有数字也没有支撑）本来就是全页一个字号，
  // 靠"大"吃饭而不是靠"层次"；有支撑/数值时骨架自然会摊出 2~4 档。
  "single-fact": { heroMin: 0.25, heroMax: 0.72, maxAxes: 2, minTiers: 1, whitespaceMax: 0.6, whitespaceMin: 0.18 },
  quotation: { heroMin: 0.3, heroMax: 0.72, maxAxes: 2, minTiers: 2, whitespaceMax: 0.65, whitespaceMin: 0.18 },
  "image-led": { heroMin: 0.28, heroMax: 0.85, maxAxes: 2, minTiers: 2, whitespaceMax: 0.45, whitespaceMin: 0.12 },
  contrast: { heroMin: 0.2, heroMax: 0.72, maxAxes: 3, minTiers: 2, whitespaceMax: 0.55, whitespaceMin: 0.18 },
  hierarchy: { heroMin: 0.18, heroMax: 0.75, maxAxes: 5, minTiers: 2, whitespaceMax: 0.6, whitespaceMin: 0.15 },
  table: { heroMin: 0.25, heroMax: 0.85, maxAxes: 2, minTiers: 1, whitespaceMax: 0.8, whitespaceMin: 0.08 },
  sequence: { heroMin: 0.18, heroMax: 0.72, maxAxes: 5, minTiers: 2, whitespaceMax: 0.7, whitespaceMin: 0.15 },
  breakdown: { heroMin: 0.18, heroMax: 0.72, maxAxes: 4, minTiers: 2, whitespaceMax: 0.62, whitespaceMin: 0.18 },
  "light-page": { heroMin: 0.15, heroMax: 0.72, maxAxes: 2, minTiers: 1, whitespaceMax: 0.8, whitespaceMin: 0.25 },
};

/** 形态规则；未登记的形态退回投影档的通用值。 */
export function formRuleFor(form: string | undefined, band: CraftBand = CRAFT_BANDS.projected): FormRule {
  const rule = form ? FORM_RULES[form] : undefined;
  return rule ?? {
    heroMin: band.heroAreaRatio.min,
    heroMax: band.heroAreaRatio.max,
    maxAxes: band.maxAlignAxes,
    minTiers: band.tierSpan.min,
    whitespaceMax: band.whitespaceRatio.max,
    whitespaceMin: band.whitespaceRatio.min,
  };
}

/** 场景距离 → 结构档。近距（培训/研读）用 document 档，远距（路演/发布会/评审）用 projected 档。 */
export function craftBandFor(distance: "far" | "near" | undefined): CraftBand {
  return distance === "near" ? CRAFT_BANDS.document : CRAFT_BANDS.projected;
}

/** 投影档的旧常量保留为别名（留白仍按场景密度分三档）。 */
export const CRAFT_LIMITS = {
  heroAreaRatio: CRAFT_BANDS.projected.heroAreaRatio,
  maxAlignAxes: CRAFT_BANDS.projected.maxAlignAxes,
  /** 留白率区间（按场景密度，投影档）。 */
  whitespaceRatio: {
    airy: { min: 0.3, max: 0.62 },
    standard: { min: 0.2, max: 0.5 },
    dense: { min: 0.12, max: 0.4 },
  },
  tierSpan: CRAFT_BANDS.projected.tierSpan,
  /** 显著重叠（交集 > 较小者面积的这个比例）视为压叠。 */
  overlapTolerance: 0.15,
  /** 表格页占比上限：max(1, ceil(页数 / 5)) 由调用方算，这里给分母。 */
  tableShareDenominator: 5,
} as const;

/** 字号档：把 pt 归到"视觉上能分辨的一档"（相差 <12% 视为同档）。 */
export function fontTiers(sizes: ReadonlyArray<number>): number[] {
  const sorted = [...new Set(sizes.filter((size) => Number.isFinite(size) && size > 0))].sort((a, b) => b - a);
  const tiers: number[] = [];
  for (const size of sorted) {
    const last = tiers[tiers.length - 1];
    if (last === undefined || last / size > 1.12) tiers.push(size);
  }
  return tiers;
}

/** 同页字号跨度（档数）。1 档 = 全页一个字号，看着"平"；>4 档 = 乱。 */
export function tierSpan(sizes: ReadonlyArray<number>): number {
  return fontTiers(sizes).length;
}

/** 相邻页留白率差上限：避免"一页挤、一页空"的抖动。 */
export const MAX_WHITESPACE_JUMP = 0.15;
