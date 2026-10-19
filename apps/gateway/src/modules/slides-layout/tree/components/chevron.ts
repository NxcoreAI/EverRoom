/**
 * chevron 组件（editorial）。箭头改描边空心（透明填充 + 墨色发丝描边），
 * 文字压在箭头上，不再用色面交替。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { textBoxHeight } from "../../text-metrics.js";

export interface ChevronItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandChevron(items: ChevronItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const cells = splitColumns(frame, items.length, theme.spacing.gutter);
  const titleSize = Math.min(16, Math.max(13, theme.sizes.body + 1));
  const textSize = theme.sizes.caption;
  const textPad = 26;
  cells.forEach((cell, i) => {
    const item = items[i]!;
    const innerW = cell.w - textPad;
    const titleH = textBoxHeight(item.title, titleSize, innerW);
    const textH = item.text ? textBoxHeight(item.text, textSize, innerW) : 0;
    const need = titleH + (textH ? 4 + textH : 0) + 24;
    if (need > cell.h) {
      bad(`${what} 第 ${i + 1} 段「${item.title}」内容高约 ${Math.round(need)}px 超过 ${Math.round(cell.h)}px——精简文字或减少段数`);
    }
    const first = i === 0;
    elements.push({
      type: "shape",
      shape: first ? "homePlate" : "chevron",
      fill: "#00000000",
      stroke: { color: theme.colors.text, widthPt: 1 },
      x: Math.round(cell.x),
      y: Math.round(cell.y),
      w: Math.round(cell.w),
      h: Math.round(cell.h),
    });
    const top = cell.y + (cell.h - need + 24) / 2;
    elements.push(
      textElement({ x: cell.x + textPad / 2, y: top, w: innerW, h: titleH }, [
        { runs: bodyRuns(item.title, titleSize, theme.colors.text, theme, true), align: "center" },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: cell.x + textPad / 2, y: top + titleH + 4, w: innerW, h: textH }, [
          { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme), align: "center" },
        ]),
      );
    }
  });
  return elements;
}
