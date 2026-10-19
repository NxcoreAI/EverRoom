/**
 * agenda 组件（editorial）。衬线双位序号 + 条目，行底发丝线，超四条分两栏。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandAgenda(items: string[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const half = Math.ceil(items.length / 2);
  const columns = items.length > 4 ? splitColumns(frame, 2, theme.spacing.gutter * 2) : [frame];
  const numSize = 26;
  const numFont = numeralFont(theme);
  const textSize = Math.min(19, Math.max(14, theme.sizes.subtitle - 2));
  columns.forEach((col, c) => {
    const slice = items.slice(c * half, (c + 1) * half);
    const numW = 64;
    const textW = col.w - numW;
    const rowH = Math.max(estimateLineHeight(numSize) * 1.3, estimateLineHeight(textSize) * 1.7);
    const rowGap = 18;
    const total = slice.length * (rowH + rowGap);
    if (total > col.h) {
      bad(`${what} 条目高约 ${Math.round(total)}px 超过 ${Math.round(col.h)}px——减少条目或精简文字`);
    }
    const top = col.y + Math.max(0, (col.h - total) / 2);
    slice.forEach((item, j) => {
      const index = c * half + j;
      const y = top + j * (rowH + rowGap);
      elements.push(
        textElement({ x: col.x, y, w: numW, h: rowH }, [
          { runs: [{ text: String(index + 1).padStart(2, "0"), sizePt: numSize, color: theme.colors.primary, ...(numFont ? { font: numFont } : {}) }] },
        ]),
      );
      const lines = estimateLines(item, textSize, textW);
      elements.push(
        textElement({ x: col.x + numW, y: y + (rowH - lines * estimateLineHeight(textSize)) / 2, w: textW, h: rowH }, [
          { runs: bodyRuns(item, textSize, theme.colors.text, theme) },
        ]),
      );
      // 行底发丝线
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(col.x),
        y: Math.round(y + rowH + rowGap / 2 - 1),
        w: Math.round(col.w),
        h: 1,
      });
    });
  });
  return elements;
}
