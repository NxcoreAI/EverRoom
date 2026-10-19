/**
 * progress 组件（editorial）。细直角轨 + 墨色填充 + 主色百分比，可选目标刻度
 * （target 0~100，轨上 2px 竖刻）。
 */

import { splitRows, type Frame } from "../../grid.js";
import { mixHex, type ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight } from "../../text-metrics.js";

export interface ProgressItem {
  label: string;
  /** 0~100。 */
  value: number;
  unit?: string;
  /** 目标位（0~100），轨上刻度。 */
  target?: number;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandProgress(items: ProgressItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const rows = splitRows(frame, items.length, Math.max(16, theme.spacing.gutter));
  const labelSize = Math.min(16, Math.max(13, theme.sizes.body + 1));
  const valueSize = theme.sizes.caption;
  const labelH = singleLineBoxHeight(labelSize);
  rows.forEach((row, i) => {
    const item = items[i]!;
    const barH = Math.min(8, Math.max(5, Math.round(row.h - labelH - 10)));
    if (row.h < labelH + barH + 10) {
      bad(`${what} 第 ${i + 1} 项「${item.label}」行高不足（${Math.round(row.h)}px）——加大权重或减少条目`);
    }
    const valueText = `${Math.round(item.value)}${item.unit ?? "%"}`;
    const targetText = item.target !== undefined ? ` / 目标 ${Math.round(item.target)}${item.unit ?? "%"}` : "";
    const y = row.y + Math.max(0, (row.h - labelH - barH - 8) / 2);
    elements.push(
      textElement({ x: row.x, y, w: row.w * 0.72, h: labelH }, [
        { runs: bodyRuns(item.label, labelSize, theme.colors.text, theme, true) },
      ]),
    );
    elements.push(
      textElement({ x: row.x + row.w * 0.72, y: y + 2, w: row.w * 0.28, h: labelH }, [
        { runs: bodyRuns(`${valueText}${targetText}`, valueSize, theme.colors.primary, theme, true), align: "right" },
      ]),
    );
    const barY = Math.round(y + labelH + 8);
    // 轨：贴页底的低对比灰；填充：墨色直角
    elements.push({
      type: "shape",
      shape: "rect",
      fill: mixHex(theme.colors.text, theme.colors.background, 0.92),
      x: Math.round(row.x),
      y: barY,
      w: Math.round(row.w),
      h: barH,
    });
    const fgW = Math.max(3, Math.round((row.w * item.value) / 100));
    elements.push({
      type: "shape",
      shape: "rect",
      fill: theme.colors.text,
      x: Math.round(row.x),
      y: barY,
      w: fgW,
      h: barH,
    });
    if (item.target !== undefined && item.target > 0 && item.target <= 100) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.primary,
        x: Math.round(row.x + (row.w * item.target) / 100) - 1,
        y: barY - 5,
        w: 2,
        h: barH + 10,
      });
    }
  });
  return elements;
}
