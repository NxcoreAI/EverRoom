/**
 * timeline 组件（editorial）。发丝线脊柱 + 方头刻度 + 衬线年份 + 静音说明；
 * h＝横轴（年份在上、说明在下），v＝竖轴（左轴右文）。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import { textBoxHeight } from "../../text-metrics.js";

export interface TimelineItem {
  label: string;
  text: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandTimeline(
  direction: "h" | "v",
  items: TimelineItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const elements: SpecElement[] = [];
  const labelSize = Math.min(26, Math.max(20, Math.round(theme.sizes.subtitle * 1.3)));
  const labelFont = numeralFont(theme);
  const textSize = theme.sizes.caption;
  const gutter = theme.spacing.gutter;
  const yearRun = (t: string, size: number, color: string, bold = true) => ({
    runs: [{ text: t, sizePt: size, bold, color, ...(labelFont ? { font: labelFont } : {}) }],
    align: "center" as const,
  });

  if (direction === "h") {
    const cells = splitColumns(frame, items.length, gutter * 1.5);
    const axisY = Math.round(frame.y + frame.h / 2);
    elements.push({
      type: "shape",
      shape: "rect",
      fill: theme.colors.divider,
      x: Math.round(frame.x),
      y: axisY,
      w: Math.round(frame.w),
      h: 1,
    });
    cells.forEach((cell, i) => {
      const item = items[i]!;
      const labelH = textBoxHeight(item.label, labelSize, cell.w);
      const textH = textBoxHeight(item.text, textSize, cell.w);
      const need = labelH + 34 + textH;
      if (need > cell.h) {
        bad(`${what} 第 ${i + 1} 条「${item.label}」内容高约 ${Math.round(need)}px 超过区域 ${Math.round(cell.h)}px——精简条目文字或减少条目`);
      }
      const cx = cell.x + cell.w / 2;
      // 方头刻度（组件无"当前"语义，一律静音刻度）
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(cx - 2),
        y: axisY - 8,
        w: 4,
        h: 16,
      });
      elements.push(
        textElement({ x: cell.x, y: axisY - 14 - labelH, w: cell.w, h: labelH }, [
          yearRun(item.label, labelSize, theme.colors.text),
        ]),
      );
      elements.push(
        textElement({ x: cell.x, y: axisY + 18, w: cell.w, h: textH }, [
          { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme), align: "center" },
        ]),
      );
    });
    return elements;
  }

  const rows = splitRows(frame, items.length, gutter);
  const axisX = Math.round(frame.x + 2);
  elements.push({
    type: "shape",
    shape: "rect",
    fill: theme.colors.divider,
    x: axisX,
    y: Math.round(frame.y),
    w: 1,
    h: Math.round(frame.h),
  });
  const textX = frame.x + 32;
  const textW = frame.w - 32;
  rows.forEach((row, i) => {
    const item = items[i]!;
    const labelH = textBoxHeight(item.label, labelSize, textW);
    const textH = textBoxHeight(item.text, textSize, textW);
    const need = labelH + 6 + textH + 10;
    if (need > row.h) {
      bad(`${what} 第 ${i + 1} 条「${item.label}」内容高约 ${Math.round(need)}px 超过 ${Math.round(row.h)}px——精简条目文字或减少条目`);
    }
    elements.push({
      type: "shape",
      shape: "rect",
      fill: theme.colors.divider,
      x: axisX - 1,
      y: Math.round(row.y + 4),
      w: 3,
      h: 14,
    });
    elements.push(
      textElement({ x: textX, y: row.y, w: textW, h: labelH }, [
        { runs: [{ text: item.label, sizePt: labelSize, bold: true, color: theme.colors.text, ...(labelFont ? { font: labelFont } : {}) }] },
      ]),
    );
    elements.push(
      textElement({ x: textX, y: row.y + labelH + 6, w: textW, h: textH }, [
        { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme) },
      ]),
    );
  });
  return elements;
}
