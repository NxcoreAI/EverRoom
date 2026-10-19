/**
 * layeredStack 组件（editorial）。分层规格单：每行一条顶部发丝线，
 * 左标题右说明，无色面。
 */

import { splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface LayerItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandLayeredStack(items: LayerItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const rows = splitRows(frame, items.length, 0);
  const titleSize = Math.min(17, Math.max(14, theme.sizes.body + 2));
  const textSize = theme.sizes.caption;
  const padY = 14;
  const titleW = Math.min(frame.w * 0.3, 200);
  const pad = theme.spacing.cardPadding;
  const textW = frame.w - titleW - pad * 2;
  rows.forEach((row, i) => {
    const item = items[i]!;
    const titleH = estimateLines(item.title, titleSize, titleW) * estimateLineHeight(titleSize);
    const textH = item.text ? estimateLines(item.text, textSize, textW) * estimateLineHeight(textSize) + 4 : 0;
    const contentH = Math.max(titleH, textH);
    const need = padY * 2 + contentH;
    if (need > row.h) {
      bad(`${what} 第 ${i + 1} 层「${item.title}」内容高约 ${Math.round(need)}px 超过 ${Math.round(row.h)}px——精简文字或减少层级`);
    }
    // 行顶发丝线（末行画底部收尾线）
    elements.push({
      type: "shape",
      shape: "rect",
      fill: theme.colors.divider,
      x: Math.round(frame.x),
      y: Math.round(row.y),
      w: Math.round(frame.w),
      h: 1,
    });
    if (i === rows.length - 1) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(frame.x),
        y: Math.round(row.y + row.h - 1),
        w: Math.round(frame.w),
        h: 1,
      });
    }
    const innerTop = row.y + (row.h - contentH) / 2;
    elements.push(
      textElement({ x: frame.x, y: innerTop, w: titleW, h: titleH }, [
        { runs: bodyRuns(item.title, titleSize, theme.colors.text, theme, true) },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: frame.x + titleW + pad, y: innerTop, w: textW, h: textH }, [
          { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme) },
        ]),
      );
    }
  });
  return elements;
}
