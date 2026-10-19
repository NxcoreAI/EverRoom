/**
 * stats 组件：指标行（editorial）。无卡片——衬线大数字 + 强调色小刻 + 标签，
 * 列间竖发丝线，整组内容高在框内垂直居中。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface StatItem {
  value: string;
  label: string;
  unit?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandStats(items: StatItem[], frame: Frame, theme: ResolvedTheme, _what: string): SpecElement[] {
  const cells = splitColumns(frame, items.length, theme.spacing.gutter * 1.5);
  const labelSize = theme.sizes.caption;
  const unitSize = Math.max(13, Math.round(theme.sizes.kpi * 0.26));
  const elements: SpecElement[] = [];
  // 先量各列内容高（数字宽闸同旧口径：装不下缩字号，再不行报缺陷）
  const built = items.map((item, i) => {
    const cell = cells[i]!;
    const innerW = cell.w - 4;
    let size = theme.sizes.kpi;
    const widthAt = (s: number) => {
      const unitS = Math.max(12, Math.round(s * 0.26));
      const valueW = estimateRunWidth(item.value, s);
      const unitW = item.unit ? estimateRunWidth(item.unit, unitS) + 6 : 0;
      return valueW + unitW;
    };
    if (widthAt(size) > innerW) {
      size = Math.max(28, Math.floor((size * innerW) / widthAt(size)));
      if (widthAt(size) > innerW) {
        bad(`KPI 卡「${item.value}」数字太长，格宽装不下——精简数值或把单位并入标签`);
      }
    }
    const valueH = singleLineBoxHeight(size);
    const labelH = textBoxHeight(item.label, labelSize, innerW);
    const tickH = 3;
    const gap = 10;
    const total = tickH + gap + labelH + 2 + valueH;
    if (total > frame.h) {
      bad(`KPI 卡「${item.value}」内容高约 ${Math.round(total)}px 超过区域 ${Math.round(frame.h)}px——加大该子树权重或减少条目`);
    }
    return { item, cell, size, valueH, labelH, total, innerW };
  });
  // 无卡片：整组（最高列）在框内垂直居中
  const contentH = Math.max(...built.map((b) => b.total));
  const top = frame.y + Math.max(0, (frame.h - contentH) / 2);
  built.forEach((b, i) => {
    const { item, cell, size, valueH, labelH } = b;
    const x = cell.x + 2;
    elements.push({ type: "shape", shape: "rect", fill: theme.colors.primary, x: Math.round(x), y: Math.round(top), w: 24, h: 3 });
    elements.push(
      textElement({ x, y: top + 13, w: b.innerW, h: labelH }, [
        { runs: bodyRuns(item.label, labelSize, theme.colors.textMuted, theme) },
      ]),
    );
    const valueFont = numeralFont(theme);
    const unitSize = Math.max(13, Math.round(size * 0.26));
    elements.push(
      textElement({ x: x - 4, y: top + 13 + labelH + 2, w: cell.w, h: valueH }, [
        {
          runs: [
            { text: item.value, sizePt: size, bold: true, color: theme.colors.text, ...(valueFont ? { font: valueFont } : {}) },
            ...(item.unit ? [{ text: ` ${item.unit}`, sizePt: unitSize, color: theme.colors.textMuted, ...(valueFont ? { font: valueFont } : {}) }] : []),
          ],
        },
      ]),
    );
    // 列间竖发丝线（首列左侧不画）
    if (i > 0) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(cell.x - theme.spacing.gutter * 0.75),
        y: Math.round(top),
        w: 1,
        h: Math.round(contentH),
      });
    }
  });
  return elements;
}

/** 粗略字宽估算（与 text-metrics 同量级，专供数字宽闸）。 */
function estimateRunWidth(text: string, sizePt: number): number {
  let width = 0;
  for (const ch of text) {
    width += /[⺀-鿿豈-﫿＀-￯]/.test(ch) ? sizePt : sizePt * 0.56;
  }
  return width;
}
