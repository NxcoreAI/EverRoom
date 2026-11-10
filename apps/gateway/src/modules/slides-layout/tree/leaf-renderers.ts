/**
 * 树叶子的渲染器：把叶子 + 框 → PageSpec 元素。
 * 构件迁自旧 preset-common.ts / presets/data.ts（预设库已删，此处为唯一出处）。
 * 装不下的报错会被 compile.ts 转成缺陷清单回传布局代理自纠。
 */

import type { Frame } from "../grid.js";
import {
  bodyRuns,
  card,
  headingRuns,
  textElement,
  type ChartElement,
  type PageSpec,
  type SpecElement,
  type TableElement,
  type TableCell,
} from "../elements.js";
import { valueAxisPlan } from "../chart-axis.js";
import { contrastRatio } from "../color-guard.js";
import { mixHex, withAlpha, type ResolvedTheme } from "../theme.js";
import {
  estimateLineHeight,
  estimateLines,
  estimateTextWidth,
  singleLineBoxHeight,
  textBoxHeight,
} from "../text-metrics.js";
import type { ChartLeaf, TableLeaf, TextLeaf } from "./schema.js";

export function isTreeErrorLike(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith("LAYOUT_LEAF_INVALID");
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** 页标题带（一行放下；超长报错点名压缩）。 */
export function titleBand(title: string, frame: Frame, theme: ResolvedTheme, dark = false): SpecElement[] {
  const size = theme.sizes.pageTitle;
  const width = estimateTextWidth(title, size);
  const maxChars = Math.floor(frame.w / (size * 1.35));
  if (width > frame.w) {
    bad(`页标题过长——${size}pt 一行最多约 ${maxChars} 个中文字，请压缩成行动标题`);
  }
  const h = singleLineBoxHeight(size);
  return [
    textElement(
      { x: frame.x, y: 44, w: frame.w, h },
      [{ runs: headingRuns(title, size, dark ? theme.colors.onDarkText : theme.colors.text, theme) }],
    ),
  ];
}

/** 文字叶子 → 文本元素（换行拆段，可选项目符号）。 */
export function renderTextLeaf(leaf: TextLeaf, frame: Frame, theme: ResolvedTheme, sizePt: number, dark = false): SpecElement {
  const tone = leaf.tone ?? (dark ? "inverse" : "normal");
  const color =
    tone === "muted" ? theme.colors.textMuted : tone === "inverse" ? theme.colors.onDarkText : theme.colors.text;
  const heading = leaf.variant === "display" || leaf.variant === "heading";
  const runs = heading
    ? headingRuns("", sizePt, color, theme)
    : bodyRuns("", sizePt, color, theme);
  const paragraphs = leaf.text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      runs: [{ ...runs[0]!, text: line }],
      ...(leaf.align ? { align: leaf.align } : {}),
      ...(leaf.bullet ? { bullet: true } : {}),
    }));
  if (paragraphs.length === 0) bad("text 叶子内容为空");
  const valign = leaf.variant === "body" || leaf.variant === "caption" ? ("top" as const) : ("middle" as const);
  return textElement(frame, paragraphs, valign);
}

export interface StatInput {
  value: string;
  label: string;
  unit?: string;
}

/** KPI 数字格：大数字自适应格宽 + 下方标签，整组垂直居中。 */
export function statCell(stat: StatInput, frame: Frame, theme: ResolvedTheme, focus = false): SpecElement[] {
  const padding = theme.spacing.cardPadding;
  const innerW = frame.w - padding * 2;
  if (innerW < 40) bad(`KPI 卡「${stat.value}」格宽不足（${Math.round(frame.w)}px）——加大权重或减少兄弟节点`);
  let size = theme.sizes.kpi;
  if (focus) size = Math.min(90, size + 12);
  const widthAt = (s: number) => {
    const unitS = Math.max(12, Math.round(s * 0.3));
    return estimateTextWidth(stat.value, s) + (stat.unit ? estimateTextWidth(stat.unit, unitS) + 4 : 0);
  };
  if (widthAt(size) > innerW) {
    size = Math.max(28, Math.floor((size * innerW) / widthAt(size)));
    if (widthAt(size) > innerW) {
      bad(`KPI 卡「${stat.value}」数字太长，格宽装不下——精简数值或把单位并入标签`);
    }
  }
  const unitSizeFinal = Math.max(12, Math.round(size * 0.3));
  const valueRuns = [
    { text: stat.value, sizePt: size, bold: true, color: theme.colors.primary },
    ...(stat.unit ? [{ text: ` ${stat.unit}`, sizePt: unitSizeFinal, bold: true, color: theme.colors.textMuted }] : []),
  ];
  const valueH = singleLineBoxHeight(size);
  const labelSize = theme.sizes.caption;
  const labelLines = estimateLines(stat.label, labelSize, innerW);
  const labelH = textBoxHeight(stat.label, labelSize, innerW);
  const gap = 12;
  const total = valueH + gap + labelH;
  // 高度闸：KPI 卡内容高于卡框时墨迹向下溢出会撞进兄弟区域（引擎拒页）——
  // 与宽度闸同口径，装不下点名报错让代理自纠。
  if (total > frame.h) {
    bad(`KPI 卡「${stat.value}」内容高约 ${Math.round(total)}px 超过卡框 ${Math.round(frame.h)}px——加大该子树权重或换文字卡`);
  }
  const top = frame.y + Math.max(0, (frame.h - total) / 2);
  // 卡高跟内容走（上下各约一倍 padding 的呼吸），整卡在框内垂直居中——
  // 满框拉高会把卡片变空壳（内容占比不足三成，PPT 卡片惯例内容占 55%~75%）
  const cardH = Math.min(frame.h, Math.max(180, Math.round(total + padding * 4)));
  const cardY = frame.y + Math.max(0, Math.round((frame.h - cardH) / 2));
  const cardFrame = { ...frame, y: cardY, h: cardH };
  return [
    card(cardFrame, theme, focus ? theme.colors.primarySoft : undefined),
    textElement({ x: frame.x + padding, y: top, w: innerW, h: valueH }, [{ runs: valueRuns }]),
    textElement(
      { x: frame.x + padding, y: top + valueH + gap, w: innerW, h: labelLines * estimateLineHeight(labelSize) + 4 },
      [{ runs: bodyRuns(stat.label, labelSize, theme.colors.textMuted, theme) }],
    ),
  ];
}

export interface CardInput {
  icon?: string;
  title: string;
  body?: string;
}

/** 图文卡：卡面 + 可选 icon + 标题 + 正文；装不下报错点名。 */
export function textCard(input: CardInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const padding = theme.spacing.cardPadding;
  const titleSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const bodySize = Math.min(15, Math.max(12, theme.sizes.body));
  const iconSize = 28;
  const iconW = input.icon ? iconSize + 12 : 0;
  const textW = frame.w - padding * 2 - iconW;
  const titleH = estimateLines(input.title, titleSize, textW) * estimateLineHeight(titleSize);
  const bodyH = input.body ? estimateLines(input.body, bodySize, textW) * estimateLineHeight(bodySize) + 4 : 0;
  const gap = input.body ? 8 : 0;
  const total = titleH + gap + bodyH;
  // 卡高跟内容走，框内垂直居中——满框拉高会把图文卡变空壳
  const cardH = Math.min(frame.h, Math.max(170, Math.round(total + padding * 2 + 28)));
  const cardY = frame.y + Math.max(0, Math.round((frame.h - cardH) / 2));
  const cardFrame = { ...frame, y: cardY, h: cardH };
  const inner = { x: frame.x + padding, y: cardY + padding, w: frame.w - padding * 2, h: cardH - padding * 2 };
  if (inner.w < 60 || inner.h < 40) {
    bad(`${what}「${input.title.slice(0, 12)}」卡框过小（${Math.round(frame.w)}×${Math.round(frame.h)}px）——加大权重`);
  }
  if (total > inner.h) {
    bad(
      `${what}「${input.title.slice(0, 12)}」内容超卡高（约 ${Math.round(total)}px > ${Math.round(inner.h)}px）——精简正文或加大权重`,
    );
  }
  const elements: SpecElement[] = [card(cardFrame, theme)];
  const top = inner.y + Math.max(0, (inner.h - total) / 2);
  if (input.icon) {
    elements.push({
      type: "icon",
      icon: input.icon,
      color: theme.colors.primary,
      x: Math.round(inner.x),
      y: Math.round(top + (titleH - iconSize) / 2),
      w: iconSize,
      h: iconSize,
    });
  }
  elements.push(
    textElement(
      { x: inner.x + iconW, y: top, w: textW, h: titleH + 4 },
      [{ runs: headingRuns(input.title, titleSize, theme.colors.text, theme) }],
    ),
  );
  if (input.body) {
    elements.push(
      textElement(
        { x: inner.x + iconW, y: top + titleH + gap, w: textW, h: bodyH },
        [{ runs: bodyRuns(input.body, bodySize, theme.colors.textMuted, theme) }],
      ),
    );
  }
  return elements;
}

/**
 * 图表叶子 → PageSpec 元素（可能多个：waterfall 展开成形状组，delta 徽章是独立元素）。
 * area 用引擎原生面积图；bar/area 高亮走逐点填色——高亮列主色实心、其余主色浅档，
 * 不靠网格线和图例讲故事（商用图表语言：直接标注 + 重点色）。
 */
export function renderChartLeaf(leaf: ChartLeaf, frame: Frame, theme: ResolvedTheme): SpecElement[] {
  if (leaf.kind === "waterfall") return renderWaterfallLeaf(leaf, frame, theme);
  const points = leaf.categories.length;
  const highlightIdx =
    leaf.highlight === undefined
      ? undefined
      : leaf.highlight === "last"
        ? points - 1
        : leaf.highlight;
  const tint = mixHex(theme.colors.primary, theme.colors.background, 0.8);
  const pointColors =
    highlightIdx === undefined
      ? undefined
      : [leaf.categories.map((_, i) => (i === highlightIdx ? theme.colors.primary : tint))];
  // 小字一律取场景字号（投影 14 / 研读 11）。历史上这里写死 Math.max(9, caption)，
  // 把轴标签、图例、数据标签钉在 9pt——这是"满屏无意义小字"的直接来源之一。
  const captionPt = theme.sizes.caption;
  const seriesColors = theme.colors.chartSeries.slice(
    0,
    Math.max(leaf.series.length, leaf.kind === "pie" || leaf.kind === "doughnut" ? points : leaf.series.length),
  );
  // C6：数据标签压在图元上，必须与**每一条系列色**都拉得开，否则宁可不要标签。
  // 旧产物里出现过系列色标签压在同色柱上（深红压深红），肉眼基本读不出数字。
  const labelsReadable = seriesColors.every((hex) => contrastRatio(theme.colors.text, hex) >= 3);
  const showDataLabels = points <= 8 && leaf.kind !== "scatter" && labelsReadable;
  // 图例只在"多系列且类目足够多"时才有信息量；两根柱配一个图例是纯噪音。
  const showLegend = leaf.legend === true && leaf.series.length > 1 && points > 2;
  const elements: SpecElement[] = [
    {
      type: "chart",
      chart: leaf.kind === "area" ? "area" : leaf.kind,
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: Math.round(frame.w),
      h: Math.round(frame.h),
      categories: leaf.categories,
      series: leaf.series,
      colors: seriesColors,
      ...(pointColors ? { pointColors } : {}),
      ...(showDataLabels ? { dataLabels: true } : {}),
      // 直接标注优先：有标签时关掉网格线，减少一层小字与细线噪音。
      ...(showDataLabels ? { gridlines: false } : {}),
      ...(showLegend ? { legend: true } : {}),
      axis: {
        labelColor: theme.colors.textMuted,
        labelSizePt: captionPt,
        lineColor: theme.colors.divider,
        gridColor: theme.colors.divider,
        legendColor: theme.colors.textMuted,
        legendSizePt: captionPt,
        dataLabelColor: theme.colors.text,
        dataLabelSizePt: captionPt,
        ...valueAxisPlan({
          values: leaf.series.flatMap((series) => series.values),
          dataLabels: showDataLabels,
          categories: points,
        }),
      },
    },
  ];
  // 涨跌徽章：图表右上角主色圆角签（白字），宽随文字。
  if (leaf.delta) {
    const sizePt = theme.sizes.caption;
    const w = Math.min(Math.round(frame.w), Math.round(leaf.delta.length * sizePt * 0.66 + sizePt * 2.4));
    const h = 26;
    elements.push({
      type: "shape",
      shape: "roundRect",
      x: Math.round(frame.x + frame.w - w),
      y: Math.round(frame.y),
      w,
      h,
      fill: theme.colors.primary,
      adj: 50000,
      paragraphs: [{ runs: [{ text: leaf.delta, sizePt, bold: true, color: theme.colors.onDarkText }], align: "center" }],
      valign: "middle",
    } as SpecElement);
  }
  return elements;
}

const WF_PAD_TOP = 26;
const WF_PAD_BOTTOM = 30;
const WF_PAD_X = 6;

/**
 * 瀑布图：形状组（不依赖图表引擎，跨渲染器稳定）。
 * values 为有符号增减（正=升、负=降）；首列从 0 起画，末列画 0→合计的结果柱
 * （商用瀑布惯例：营收→减项→…→利润）。升=主色、降=墨色浅档、结果=系列第 4 档。
 */
function renderWaterfallLeaf(leaf: ChartLeaf, frame: Frame, theme: ResolvedTheme): SpecElement[] {
  const values = leaf.series[0]!.values;
  const n = values.length;
  const running: { start: number; end: number }[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const isResult = i === n - 1;
    const start = isResult ? 0 : total;
    const end = isResult ? total + values[i]! : total + values[i]!;
    running.push({ start, end });
    total = end;
  }
  if (total <= 0) bad("waterfall 合计必须为正——检查 values 的正负与量级");
  const maxV = Math.max(...running.map((r) => Math.max(r.start, r.end)), total);
  const plotY = frame.y + WF_PAD_TOP;
  const plotH = frame.h - WF_PAD_TOP - WF_PAD_BOTTOM;
  const slotW = (frame.w - WF_PAD_X * 2) / n;
  const barW = Math.max(12, Math.min(72, slotW * 0.5));
  const yOf = (v: number) => plotY + plotH * (1 - v / maxV);
  const rise = theme.colors.primary;
  const fall = mixHex(theme.colors.text, theme.colors.background, 0.62);
  const resultColor = theme.colors.chartSeries[3] ?? theme.colors.accent;
  const labelSize = theme.sizes.caption;
  const elements: SpecElement[] = [];
  const fmt = (v: number) => (Number.isInteger(v) ? `${v}` : `${Math.round(v * 10) / 10}`);
  for (let i = 0; i < n; i++) {
    const { start, end } = running[i]!;
    const isResult = i === n - 1;
    const isFall = !isResult && end < start;
    const cx = frame.x + WF_PAD_X + slotW * i + slotW / 2;
    const top = yOf(Math.max(start, end));
    const h = Math.max(2, yOf(Math.min(start, end)) - top);
    const color = isResult ? resultColor : isFall ? fall : rise;
    elements.push({
      type: "shape",
      shape: "roundRect",
      x: Math.round(cx - barW / 2),
      y: Math.round(top),
      w: Math.round(barW),
      h: Math.round(h),
      fill: color,
      adj: Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(barW, h))) * 100000)),
    });
    // 数值标注：升/结果标在上缘上方，降标在下缘下方——落点永远不压柱。
    const labelText = fmt(isResult ? end : Math.abs(values[i]!));
    const labelY = isFall ? top + h + 4 : top - labelSize * 1.6 - 2;
    elements.push(
      textElement(
        { x: Math.round(cx - slotW / 2), y: Math.round(labelY), w: Math.round(slotW), h: Math.round(labelSize * 1.6) },
        [{ runs: [{ text: labelText, sizePt: labelSize, bold: isResult, color: isFall ? theme.colors.textMuted : theme.colors.text }] }],
      ),
    );
    // 类目标签：图底部一行。
    elements.push(
      textElement(
        { x: Math.round(cx - slotW / 2), y: Math.round(plotY + plotH + 6), w: Math.round(slotW), h: Math.round(labelSize * 1.6) },
        [{ runs: [{ text: leaf.categories[i]!, sizePt: labelSize, color: theme.colors.textMuted }] }],
      ),
    );
    // 虚线基准线：在每段的起点水位连接左右柱缘（首列除外）——瀑布的「台阶」读法。
    if (i > 0) {
      const level = yOf(i === n - 1 ? running[i]!.end : running[i]!.start);
      const prevCx = frame.x + WF_PAD_X + slotW * (i - 1) + slotW / 2;
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(Math.min(prevCx + barW / 2, cx - barW / 2)),
        y: Math.round(level),
        w: Math.max(1, Math.round(Math.abs(cx - prevCx) - barW)),
        h: 1,
      });
    }
  }
  return elements;
}

const CHECK_CELL = /^[✓✗★☆]{1,6}$/;
const NUMERIC_CELL = /^[-+￥$€%]?[\d,.．]+[%万亿]?$/;

/** 表格叶子 → 引擎 table 元素（列对齐推断 + 行高预算，迁自 preset-common buildTable）。
 *  `header: false` 时 rows 全按数据行渲染（账目式两列表）；`topRule: true` 顶部压 2px 墨线、表格下移让位。 */
export function renderTableLeaf(leaf: TableLeaf, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const headerOff = leaf.header === false;
  // 账目式顶线：2px 墨线压框顶，表格下移让位
  const ruleH = leaf.topRule === true ? 2 : 0;
  const tableFrame: Frame = leaf.topRule === true
    ? { ...frame, y: frame.y + ruleH + 8, h: frame.h - ruleH - 8 }
    : frame;
  const parsed = leaf.rows as TableCell[][];
  const colCount = parsed[0]!.length;
  const fontSize = Math.min(14, Math.max(12, theme.sizes.table));
  const style = leaf.style ?? "lines";

  const cellText = (row: TableCell[], c: number): string => {
    const cell = row[c]!;
    return typeof cell === "string" ? cell : cell.text;
  };
  const dataRows = headerOff ? parsed : parsed.slice(1);
  const aligns: ("left" | "center" | "right")[] = [];
  for (let c = 0; c < colCount; c++) {
    const column = dataRows.map((row) => cellText(row, c));
    if (column.every((t) => CHECK_CELL.test(t))) aligns.push("center");
    else if (c > 0 && column.length > 0 && column.every((t) => NUMERIC_CELL.test(t))) aligns.push("right");
    else aligns.push("left");
  }

  const widthSum = (leaf.colWidths ?? parsed[0]!.map(() => 1)).reduce((a, b) => a + b, 0);
  const lineH = fontSize * 1.8;
  let estHeight = 0;
  for (const [r, row] of parsed.entries()) {
    let maxLines = 1;
    for (let c = 0; c < colCount; c++) {
      const colW = ((leaf.colWidths ?? parsed[0]!.map(() => 1))[c]! / widthSum) * tableFrame.w - 12;
      maxLines = Math.max(maxLines, estimateLines(cellText(row, c), fontSize, colW));
    }
    const rowFactor = !headerOff && r === 0 ? 1.15 : /合计|总计|小计/.test(cellText(row, 0)) ? 1.2 : 1;
    estHeight += maxLines * lineH * rowFactor + 10;
  }
  if (estHeight > tableFrame.h + 4) {
    bad(`${what} 行高预算约 ${Math.round(estHeight)}px 超过区域 ${Math.round(tableFrame.h)}px——砍行、精简单元格文字或加大权重`);
  }

  const styled: TableCell[][] = parsed.map((row, r) =>
    row.map((cell, c): TableCell => {
      const isHeader = r === 0 && !headerOff;
      if (typeof cell === "string") {
        if (isHeader) {
          if (style === "darkHeader") {
            return { text: cell, bold: true, color: theme.colors.onDarkText, fill: theme.colors.darkBackground, align: "center" };
          }
          return { text: cell, bold: true, color: theme.colors.text };
        }
        const totalRow = /合计|总计|小计/.test(cellText(row, 0));
        return {
          text: cell,
          bold: totalRow || (c === 0 && style === "zebra"),
          ...(totalRow ? { color: theme.colors.primary } : {}),
          align: aligns[c]!,
        };
      }
      return cell;
    }),
  );

  const table: TableElement = {
    type: "table",
    x: Math.round(tableFrame.x),
    y: Math.round(tableFrame.y),
    w: Math.round(tableFrame.w),
    h: Math.round(tableFrame.h),
    rows: styled,
    fontSize,
    ...(leaf.colWidths ? { colWidths: leaf.colWidths } : {}),
    ...(style === "lines" ? { borderColor: theme.colors.divider, horizontalBordersOnly: true, borderWidthPt: 0.5 } : {}),
    ...(style === "zebra" ? { zebra: theme.colors.cardSurface } : {}),
  };
  if (leaf.topRule !== true) return [table];
  // 2px 墨色顶线独立成形状（引擎 table 无顶线参数）；元素序=线先、表后。
  return [
    {
      type: "shape",
      shape: "rect",
      fill: theme.colors.text,
      x: Math.round(frame.x),
      y: Math.round(frame.y),
      w: Math.round(frame.w),
      h: ruleH,
    },
    table,
  ];
}
