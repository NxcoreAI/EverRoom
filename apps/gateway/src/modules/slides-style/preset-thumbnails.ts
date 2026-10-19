/**
 * 风格卡版式缩略图：按构图家族出通用分块线框（封面/内容/数据三张）→ 调色 SVG。
 *
 * 预设库已删（布局树链路）：这里只表达家族的骨架气质——网格/不对称/大字/满版；
 * 坐标示例 M=60/G=20，按 styleParams 联动边距与圆角；文字一律假字条，不渲染真文案。
 */

import type { StyleParams } from "./types.js";

export type ThumbnailRole = "cover" | "content" | "data";

export interface PresetThumbnail {
  role: ThumbnailRole;
  /** 用户可读标签，如「封面 · 瑞士网格」。 */
  label: string;
  svg: string;
}

interface ThumbRect {
  t: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  /** 圆角（1280 画布尺度）。 */
  r?: number;
  /** 0~1 不透明度。 */
  o?: number;
}

interface ThumbCircle {
  t: "circle";
  cx: number;
  cy: number;
  d: number;
  fill: string;
  o?: number;
}

type ThumbEl = ThumbRect | ThumbCircle;

const CANVAS_W = 1280;
const CANVAS_H = 720;

function rect(x: number, y: number, w: number, h: number, fill: string, r?: number, o?: number): ThumbRect {
  const el: ThumbRect = { t: "rect", x, y, w, h, fill };
  if (r !== undefined) el.r = r;
  if (o !== undefined) el.o = o;
  return el;
}

function circle(cx: number, cy: number, d: number, fill: string, o?: number): ThumbCircle {
  const el: ThumbCircle = { t: "circle", cx, cy, d, fill };
  if (o !== undefined) el.o = o;
  return el;
}

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** 向黑（amount<0）或白（amount>0）混合；深底/色场推导用，保持确定性。 */
function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const mix = (channel: number): number =>
    Math.round(amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount);
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** 页标题假字条（1280 尺度 h=28）。 */
function titleBar(m: number, text: string): ThumbRect {
  return rect(m, 76, 520, 28, text);
}

/** 卡内正文假字条组：等距下行，末条收短模拟自然段。 */
function bodyBars(
  x: number,
  y: number,
  w: number,
  count: number,
  muted: string,
  step = 20,
  o = 0.75,
): ThumbEl[] {
  return Array.from({ length: count }, (_, i) =>
    rect(x, y + i * step, i === count - 1 ? w * 0.62 : w, 8, muted, 4, o),
  );
}

/** 柱状图假象：贴基线上行、系列色轮转（chartSeries 空时退 primary）。 */
function chartBars(
  x: number,
  baseline: number,
  barW: number,
  gap: number,
  heights: number[],
  series: string[],
  fallback: string,
): ThumbEl[] {
  const colors = series.length ? series : [fallback];
  return heights.map((h, i) =>
    rect(x + i * (barW + gap), baseline - h, barW, h, colors[i % colors.length] ?? fallback),
  );
}

interface RecipeContext {
  m: number;
  g: number;
  radius: number;
  stroke: string | null;
  palette: StyleParams["palette"];
  darkCover: boolean;
}

/** 卡片：surface 底 + 圆角；有描边配置时叠 2px 描边框。 */
function cardWithStroke(ctx: RecipeContext, x: number, y: number, w: number, h: number): ThumbEl[] {
  const els: ThumbEl[] = [rect(x, y, w, h, ctx.palette.surface, ctx.radius)];
  if (ctx.stroke) {
    els.push(rect(x, y, w, h, ctx.stroke, ctx.radius, 1));
    els.push(rect(x + 2, y + 2, w - 4, h - 4, ctx.palette.surface, Math.max(0, ctx.radius - 2)));
  }
  return els;
}

/* ---------------- 封面预设 ---------------- */

/** P1a 深色大字封面：全页深底 + 左对齐大标题 + 右下低透明 ghost 数字。 */
function p1a(ctx: RecipeContext): ThumbEl[] {
  const deep = shade(ctx.palette.primary, -0.45);
  const white = ctx.palette.onDarkText;
  return [
    rect(0, 0, CANVAS_W, CANVAS_H, deep),
    // ghost 数字（右下，低透明，两个块像数字剪影）
    rect(880, 400, 140, 260, white, 16, 0.08),
    rect(1050, 400, 90, 260, white, 12, 0.08),
    rect(ctx.m, 252, 280, 12, white, 6, 0.55),
    rect(ctx.m, 284, 760, 64, white, 10),
    rect(ctx.m, 364, 560, 64, white, 10),
    rect(ctx.m, 456, 430, 16, white, 8, 0.7),
  ];
}

/** P1b 大色块封面：浅底 + 右侧满高主色竖带，标题在色带内。 */
function p1b(ctx: RecipeContext): ThumbEl[] {
  const white = ctx.palette.onDarkText;
  return [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    rect(640, 0, 640, CANVAS_H, ctx.palette.primary),
    rect(ctx.m, 280, 260, 12, ctx.palette.textMuted, 6),
    rect(ctx.m, 312, 180, 10, ctx.palette.textMuted, 5, 0.6),
    rect(700, 300, 480, 52, white, 10),
    rect(700, 368, 420, 52, white, 10),
    rect(700, 440, 340, 14, white, 7, 0.7),
  ];
}

/** P1c 超大字白底封面：超大标题即锚点，其余全部克制。 */
function p1c(ctx: RecipeContext): ThumbEl[] {
  return [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    rect(ctx.m, 210, 300, 12, ctx.palette.textMuted, 6),
    rect(ctx.m, 250, 1090, 110, ctx.palette.text, 16),
    rect(ctx.m, 380, 860, 110, ctx.palette.text, 16),
    rect(ctx.m, 530, 420, 16, ctx.palette.textMuted, 8),
  ];
}

/** P2 大图压字封面：全幅图 + 半透明遮罩 + 居中白字。 */
function p2(ctx: RecipeContext): ThumbEl[] {
  const image = shade(ctx.palette.primary, -0.2);
  const white = ctx.palette.onDarkText;
  return [
    rect(0, 0, CANVAS_W, CANVAS_H, image),
    rect(0, 240, CANVAS_W, 480, "#000000", undefined, 0.35),
    rect(410, 316, 460, 44, white, 10),
    rect(470, 380, 340, 14, white, 7, 0.75),
  ];
}

/* ---------------- 内容页预设 ---------------- */

/** F2 横幅+卡片阵：深色横幅 + 3 等宽卡片（swiss 内容页代表）。 */
function f2(ctx: RecipeContext): ThumbEl[] {
  const contentW = CANVAS_W - ctx.m * 2;
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    rect(ctx.m, 140, contentW, 72, ctx.palette.primary),
    rect(ctx.m + 24, 164, 560, 20, ctx.palette.onDarkText, 8),
    rect(ctx.m + contentW - 184, 156, 160, 40, ctx.palette.accent, 8),
  ];
  const cardW = Math.floor((contentW - ctx.g * 2) / 3);
  for (let i = 0; i < 3; i += 1) {
    const x = ctx.m + i * (cardW + ctx.g);
    els.push(...cardWithStroke(ctx, x, 232, cardW, 428));
    els.push(rect(x + 24, 256, 44, 16, i === 0 ? ctx.palette.accent : shade(ctx.palette.primary, 0.45), 8));
    els.push(rect(x + 24, 288, 200, 16, ctx.palette.text, 6));
    els.push(...bodyBars(x + 24, 320, cardW - 48, 4, ctx.palette.textMuted));
  }
  return els;
}

/** P7 双栏图文 62/38：左大图 + 右文字栏（editorial 内容页代表）。 */
function p7(ctx: RecipeContext): ThumbEl[] {
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    rect(ctx.m, 140, 700, 520, ctx.palette.primary, undefined, 0.22),
    rect(800, 170, 320, 20, ctx.palette.text, 8),
    ...bodyBars(800, 210, 420, 4, ctx.palette.textMuted),
  ];
  for (let i = 0; i < 3; i += 1) {
    const y = 330 + i * 36;
    els.push(circle(808, y + 5, 8, ctx.palette.accent));
    els.push(rect(828, y, 300, 10, ctx.palette.text, 5, 0.85));
  }
  return els;
}

/** D2 结论横幅+数字行：横幅主张 + 1×4 KPI 数字格 + 底部趋势条图（poster 内容页代表）。 */
function d2(ctx: RecipeContext): ThumbEl[] {
  const contentW = CANVAS_W - ctx.m * 2;
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    rect(ctx.m, 140, contentW, 72, ctx.palette.primary),
    rect(ctx.m + 24, 164, 680, 20, ctx.palette.onDarkText, 8),
    rect(ctx.m + contentW - 194, 152, 170, 48, ctx.palette.accent, 10),
  ];
  const cellW = (contentW - ctx.g * 3) / 4;
  for (let i = 0; i < 4; i += 1) {
    const x = ctx.m + i * (cellW + ctx.g);
    const first = i === 0;
    els.push(rect(x, first ? 244 : 252, first ? 230 : 190, first ? 64 : 56, first ? ctx.palette.accent : ctx.palette.primary, 10));
    els.push(rect(x, first ? 328 : 322, 160, 10, ctx.palette.textMuted, 5));
  }
  els.push(...cardWithStroke(ctx, ctx.m, 460, contentW, 220));
  els.push(...chartBars(ctx.m + 40, 650, 120, 40, [70, 110, 90, 150, 190, 230], ctx.palette.chartSeries, ctx.palette.primary));
  return els;
}

/** P6 半图半卡 62/38：左大图 + 右三张痛点卡（immersive 内容页代表）。 */
function p6(ctx: RecipeContext): ThumbEl[] {
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    rect(ctx.m, 140, 700, 520, ctx.palette.primary, undefined, 0.3),
  ];
  for (let i = 0; i < 3; i += 1) {
    const y = 140 + i * 180;
    els.push(...cardWithStroke(ctx, 780, y, 440, 160));
    els.push(rect(800, y + 22, 28, 28, i === 0 ? ctx.palette.accent : shade(ctx.palette.primary, 0.45), 8));
    els.push(rect(840, y + 28, 220, 14, ctx.palette.text, 6));
    els.push(...bodyBars(800, y + 70, 320, 2, ctx.palette.textMuted));
  }
  return els;
}

/* ---------------- 数据页预设 ---------------- */

/** D3 全宽图表页：单图占满内容区（swiss 数据页代表）。 */
function d3(ctx: RecipeContext): ThumbEl[] {
  const contentW = CANVAS_W - ctx.m * 2;
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    ...cardWithStroke(ctx, ctx.m, 140, contentW, 520),
  ];
  for (const y of [260, 360, 460]) {
    els.push(rect(ctx.m + 20, y, contentW - 40, 2, ctx.palette.textMuted, 1, 0.25));
  }
  els.push(...chartBars(ctx.m + 50, 640, 120, 40, [140, 220, 180, 300, 240, 360, 320], ctx.palette.chartSeries, ctx.palette.primary));
  return els;
}

/** D5 图表+侧栏结论 70/30：主图 + 右侧结论小卡（editorial 数据页代表）。 */
function d5(ctx: RecipeContext): ThumbEl[] {
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    ...cardWithStroke(ctx, ctx.m, 140, 760, 520),
    ...chartBars(ctx.m + 40, 640, 100, 30, [160, 240, 200, 320, 280], ctx.palette.chartSeries, ctx.palette.primary),
  ];
  for (let i = 0; i < 3; i += 1) {
    const y = 140 + i * 180;
    els.push(...cardWithStroke(ctx, 860, y, 360, 160));
    els.push(rect(884, y + 24, i === 0 ? 180 : 150, 14, i === 0 ? ctx.palette.accent : ctx.palette.text, 6));
    els.push(...bodyBars(884, y + 56, 300, 3, ctx.palette.textMuted));
  }
  return els;
}

/** D1 KPI 大数字带 1×4 + 底部趋势图（poster 数据页代表）。 */
function d1(ctx: RecipeContext): ThumbEl[] {
  const contentW = CANVAS_W - ctx.m * 2;
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
  ];
  const cellW = (contentW - ctx.g * 3) / 4;
  for (let i = 0; i < 4; i += 1) {
    const x = ctx.m + i * (cellW + ctx.g);
    const first = i === 0;
    els.push(rect(x, first ? 200 : 210, first ? 230 : 190, first ? 72 : 64, first ? ctx.palette.accent : ctx.palette.primary, 10));
    els.push(rect(x, first ? 290 : 288, 160, 10, ctx.palette.textMuted, 5));
  }
  els.push(...cardWithStroke(ctx, ctx.m, 480, contentW, 200));
  els.push(...chartBars(ctx.m + 45, 655, 110, 25, [60, 90, 120, 110, 150, 170, 190, 210], ctx.palette.chartSeries, ctx.palette.primary));
  return els;
}

/** D4 散点定位：scatter 主图 + 右侧结论窄栏（immersive 数据页代表）。 */
function d4(ctx: RecipeContext): ThumbEl[] {
  const els: ThumbEl[] = [
    rect(0, 0, CANVAS_W, CANVAS_H, ctx.palette.background),
    titleBar(ctx.m, ctx.palette.text),
    ...cardWithStroke(ctx, ctx.m, 140, 800, 520),
    rect(ctx.m + 40, 400, 720, 2, ctx.palette.textMuted, 1, 0.3),
    rect(ctx.m + 400, 180, 2, 440, ctx.palette.textMuted, 1, 0.3),
  ];
  const colors = ctx.palette.chartSeries.length ? ctx.palette.chartSeries : [ctx.palette.primary];
  const dots: Array<[number, number, number, number]> = [
    [200, 320, 18, 0],
    [340, 260, 14, 1],
    [520, 420, 16, 0],
    [660, 300, 12, 2],
    [420, 220, 10, 3],
    [260, 480, 12, 1],
  ];
  for (const [x, y, d, colorIndex] of dots) {
    const seriesColor = colors[colorIndex % colors.length] ?? ctx.palette.primary;
    els.push(circle(x, y, d, colorIndex === 0 ? ctx.palette.accent : seriesColor));
  }
  for (let i = 0; i < 2; i += 1) {
    const y = 140 + i * 270;
    els.push(...cardWithStroke(ctx, 900, y, 320, 250));
    els.push(rect(924, y + 26, 170, 14, i === 0 ? ctx.palette.accent : ctx.palette.text, 6));
    els.push(...bodyBars(924, y + 60, 260, 3, ctx.palette.textMuted));
  }
  return els;
}

/* ---------------- 选型与渲染 ---------------- */

type Composition = NonNullable<StyleParams["composition"]>;

function coverRecipe(composition: Composition, darkCover: boolean): { draw: (ctx: RecipeContext) => ThumbEl[] } {
  if (composition === "editorial") return { draw: p1c };
  if (composition === "poster") return { draw: p1b };
  if (composition === "immersive") return { draw: p2 };
  return { draw: darkCover ? p1a : p1c };
}

function contentRecipe(composition: Composition): { draw: (ctx: RecipeContext) => ThumbEl[] } {
  if (composition === "editorial") return { draw: p7 };
  if (composition === "poster") return { draw: d2 };
  if (composition === "immersive") return { draw: p6 };
  return { draw: f2 };
}

function dataRecipe(composition: Composition): { draw: (ctx: RecipeContext) => ThumbEl[] } {
  if (composition === "editorial") return { draw: d5 };
  if (composition === "poster") return { draw: d1 };
  if (composition === "immersive") return { draw: d4 };
  return { draw: d3 };
}

const COMPOSITION_LABELS: Record<Composition, string> = {
  swiss: "瑞士网格",
  editorial: "编辑杂志",
  poster: "海报大字",
  immersive: "沉浸大图",
};

const ROLE_LABELS: Record<ThumbnailRole, string> = {
  cover: "封面",
  content: "内容页",
  data: "数据页",
};

const FALLBACK_PARAMS: StyleParams = {
  palette: {
    background: "#f4f1ea",
    surface: "#ffffff",
    primary: "#1e3a5f",
    accent: "#e0a03c",
    text: "#2f2b28",
    textMuted: "#8f8a81",
    onDarkText: "#f2f4f7",
    chartSeries: [],
  },
  typography: {
    fontHeading: "PingFang SC",
    fontBody: "PingFang SC",
    sizes: {
      coverTitle: 64, sectionTitle: 40, pageTitle: 28, subtitle: 20,
      body: 14, caption: 12, kpi: 56, table: 13,
    },
    headingBold: true,
  },
  spacing: { margin: 60, gutter: 20, cardPadding: 16, cornerRadius: 8 },
  decoration: { cardStroke: null, cardStrokeWidthPt: 0.75, cardShadow: "none", divider: "line", imageFit: "cover" },
  motif: { kind: "none", spec: {} },
  darkCover: true,
  effectLines: [],
};

/** 三个页型各出一张当前构图家族的通用线框缩略图。 */
export function presetThumbnails(params: StyleParams | null): PresetThumbnail[] {
  const merged = params ?? FALLBACK_PARAMS;
  const composition = merged.composition ?? "swiss";
  const ctx: RecipeContext = {
    m: merged.spacing.margin,
    g: merged.spacing.gutter,
    radius: merged.spacing.cornerRadius,
    stroke: merged.decoration.cardStroke,
    palette: merged.palette,
    darkCover: merged.darkCover,
  };
  const picks: Array<{ role: ThumbnailRole; draw: (ctx: RecipeContext) => ThumbEl[] }> = [
    { role: "cover", draw: coverRecipe(composition, ctx.darkCover).draw },
    { role: "content", draw: contentRecipe(composition).draw },
    { role: "data", draw: dataRecipe(composition).draw },
  ];
  return picks.map(({ role, draw }) => ({
    role,
    label: `${ROLE_LABELS[role]} · ${COMPOSITION_LABELS[composition]}`,
    svg: renderSvg(draw(ctx)),
  }));
}

function renderSvg(els: ThumbEl[]): string {
  const scale = 320 / CANVAS_W;
  const parts = els.map((el) => {
    if (el.t === "circle") {
      const attrs = [
        `cx="${(el.cx * scale).toFixed(1)}"`,
        `cy="${(el.cy * scale).toFixed(1)}"`,
        `r="${((el.d / 2) * scale).toFixed(1)}"`,
        `fill="${el.fill}"`,
      ];
      if (el.o !== undefined) attrs.push(`fill-opacity="${el.o}"`);
      return `<circle ${attrs.join(" ")}/>`;
    }
    const attrs = [
      `x="${(el.x * scale).toFixed(1)}"`,
      `y="${(el.y * scale).toFixed(1)}"`,
      `width="${(el.w * scale).toFixed(1)}"`,
      `height="${(el.h * scale).toFixed(1)}"`,
      `fill="${el.fill}"`,
    ];
    if (el.r) attrs.push(`rx="${Math.min(el.r * scale, (el.h * scale) / 2).toFixed(1)}"`);
    if (el.o !== undefined) attrs.push(`fill-opacity="${el.o}"`);
    return `<rect ${attrs.join(" ")}/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180" role="img">${parts.join("")}</svg>`;
}
