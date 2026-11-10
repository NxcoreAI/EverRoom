/**
 * 演示页：StyleParams → 单页 PageSpec（确定性模板，不经过 LLM）。
 *
 * 用途：自校闭环的测量靶 + 风格卡的试渲染页。一页里铺满风格要素——
 * 底色、标题字、正文条、卡片（圆角/描边/阴影）、图表系列色、强调色
 * KPI——测得到、看得出。坐标保守留白，保证通过引擎的墨迹重叠校验。
 */

import type { StyleParams } from "./types.js";

/** PageSpec 的结构子集（引擎侧 page-spec.ts 是行为事实源，这里只声明用到的形状）。 */
export interface DemoPageSpec {
  background: string;
  elements: Array<Record<string, unknown>>;
}

export function buildDemoPageSpec(params: StyleParams): DemoPageSpec {
  const { palette, typography, spacing, decoration } = params;
  const m = spacing.margin;
  const fonts = typography.fontBody;
  const headingFonts = typography.fontHeading;
  const sizes = typography.sizes;
  const cardStroke = decoration.cardStroke
    ? { color: decoration.cardStroke, widthPt: decoration.cardStrokeWidthPt }
    : undefined;

  const elements: Array<Record<string, unknown>> = [
    {
      type: "text",
      x: m, y: 96, w: 660, h: 64,
      paragraphs: [{
        align: "left",
        runs: [{ text: "演示页标题示例", sizePt: sizes.pageTitle, bold: typography.headingBold, color: palette.primary, font: headingFonts }],
      }],
    },
    {
      type: "text",
      x: m, y: 168, w: 660, h: 34,
      paragraphs: [{
        align: "left",
        runs: [{ text: "副标题一行，展示正文与次级文字的层级", sizePt: sizes.subtitle, color: palette.textMuted, font: fonts }],
      }],
    },
    {
      type: "text",
      x: m, y: 226, w: 660, h: 180,
      paragraphs: [
        { align: "left", spaceAfterPt: 10, runs: [{ text: "要点一：正文条目与行距示例", sizePt: sizes.body, color: palette.text, font: fonts }] },
        { align: "left", spaceAfterPt: 10, runs: [{ text: "要点二：次级文字与主文字的对比", sizePt: sizes.body, color: palette.text, font: fonts }] },
        { align: "left", runs: [{ text: "要点三：同套字重下的层级关系", sizePt: sizes.body, color: palette.text, font: fonts }] },
      ],
    },
    // 右侧上卡：KPI（强调色大数字）。
    {
      type: "shape",
      kind: "roundRect",
      x: 760, y: 96, w: 460, h: 200,
      fill: palette.surface,
      ...(cardStroke ? { stroke: cardStroke } : {}),
      ...(decoration.cardShadow !== "none" ? { shadow: decoration.cardShadow } : {}),
    },
    {
      type: "text",
      x: 792, y: 140, w: 240, h: 64,
      paragraphs: [{
        align: "left",
        runs: [{ text: "128%", sizePt: Math.round(sizes.kpi * 0.62), bold: true, color: palette.accent, font: headingFonts }],
      }],
    },
    {
      type: "text",
      x: 792, y: 216, w: 300, h: 28,
      paragraphs: [{
        align: "left",
        runs: [{ text: "关键指标名称", sizePt: sizes.caption, color: palette.textMuted, font: fonts }],
      }],
    },
    // 右侧下卡：结论卡。
    {
      type: "shape",
      kind: "roundRect",
      x: 760, y: 320, w: 460, h: 96,
      fill: palette.surface,
      ...(cardStroke ? { stroke: cardStroke } : {}),
      ...(decoration.cardShadow !== "none" ? { shadow: decoration.cardShadow } : {}),
    },
    {
      type: "text",
      x: 792, y: 344, w: 400, h: 48,
      paragraphs: [{
        align: "left",
        runs: [{ text: "卡片示例：圆角、描边与投影档位", sizePt: sizes.body, color: palette.text, font: fonts }],
      }],
    },
    // 底部图表：系列色带（chartSeries 前两个）。
    {
      type: "chart",
      chart: "bar",
      x: m, y: 470, w: 660, h: 190,
      categories: ["一月", "二月", "三月", "四月"],
      series: [
        { name: "系列甲", values: [3, 5, 4, 7] },
        { name: "系列乙", values: [2, 3, 5, 6] },
      ],
      colors: [palette.chartSeries[0], palette.chartSeries[1] ?? palette.accent],
      legend: true,
    },
    // 文本与图表之间的强调色条。
    {
      type: "shape",
      kind: "rect",
      x: m, y: 446, w: 120, h: 6,
      fill: palette.accent,
    },
  ];

  return { background: palette.background, elements };
}
