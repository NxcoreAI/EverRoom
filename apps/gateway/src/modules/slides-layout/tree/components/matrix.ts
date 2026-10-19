/**
 * matrix2x2 组件（editorial）。无卡片——网格中央十字发丝线切四象限，
 * 象限内容顶左锚定；四边轴标静音。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface Quadrant {
  title: string;
  points?: string[];
}

export interface MatrixAxes {
  top?: string;
  right?: string;
  bottom?: string;
  left?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const AXIS_MAX = 120;

export function expandMatrix2x2(
  quadrants: Quadrant[],
  axes: MatrixAxes,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const elements: SpecElement[] = [];
  const axisSize = theme.sizes.caption;
  const axisH = 40; // 轴标墨迹估高约 29px，留足与象限标题的间隙
  const topAxis = axes.top ? axisH : 0;
  const bottomAxis = axes.bottom ? axisH : 0;
  const leftAxis = axes.left ? AXIS_MAX : 0;
  const rightAxis = axes.right ? AXIS_MAX : 0;

  const grid: Frame = {
    x: frame.x + (leftAxis ? leftAxis : 0),
    y: frame.y + topAxis,
    w: frame.w - leftAxis - rightAxis,
    h: frame.h - topAxis - bottomAxis,
  };
  if (grid.w < 200 || grid.h < 160) {
    bad(`${what} 区域过小（${Math.round(grid.w)}×${Math.round(grid.h)}px）——加大该子树权重`);
  }

  const axisLabel = (
    text: string,
    f: Frame,
    align: "left" | "center" | "right",
    valign: "top" | "middle" = "top",
  ): void => {
    elements.push(
      textElement(f, [{ runs: bodyRuns(text, axisSize, theme.colors.textMuted, theme), align }], valign),
    );
  };
  if (axes.top) {
    axisLabel(axes.top, { x: grid.x, y: frame.y, w: grid.w, h: axisH - 4 }, "center");
  }
  if (axes.bottom) {
    axisLabel(axes.bottom, { x: grid.x, y: grid.y + grid.h + 4, w: grid.w, h: axisH - 4 }, "center");
  }
  if (axes.left) {
    axisLabel(axes.left, { x: frame.x, y: grid.y, w: leftAxis - 8, h: grid.h }, "right", "middle");
  }
  if (axes.right) {
    axisLabel(axes.right, { x: grid.x + grid.w + 8, y: grid.y, w: rightAxis - 8, h: grid.h }, "left", "middle");
  }

  // 十字发丝线（贯穿网格中央）
  elements.push({
    type: "shape",
    shape: "rect",
    fill: theme.colors.divider,
    x: Math.round(grid.x + grid.w / 2),
    y: Math.round(grid.y),
    w: 1,
    h: Math.round(grid.h),
  });
  elements.push({
    type: "shape",
    shape: "rect",
    fill: theme.colors.divider,
    x: Math.round(grid.x),
    y: Math.round(grid.y + grid.h / 2),
    w: Math.round(grid.w),
    h: 1,
  });

  const cols = splitColumns(grid, 2, theme.spacing.gutter * 1.5);
  const rows = splitRows(grid, 2, theme.spacing.gutter * 1.5);
  const titleSize = Math.min(19, Math.max(15, theme.sizes.body + 3));
  const pointSize = theme.sizes.caption;
  const pad = theme.spacing.cardPadding;
  quadrants.forEach((quadrant, i) => {
    const col = cols[i % 2]!;
    const row = rows[Math.floor(i / 2)]!;
    const cell: Frame = { x: col.x, y: row.y, w: col.w, h: row.h };
    const innerW = cell.w - pad;
    const titleH = estimateLines(quadrant.title, titleSize, innerW) * estimateLineHeight(titleSize) + 4;
    const pointH = (quadrant.points ?? []).map((p) => estimateLines(`—　${p}`, pointSize, innerW - 12) * estimateLineHeight(pointSize) + 6);
    const pointsH = pointH.reduce((a, b) => a + b, 0);
    const need = titleH + 8 + pointsH;
    if (need > cell.h) {
      bad(`${what} 第 ${i + 1} 象限「${quadrant.title}」内容高约 ${Math.round(need)}px 超过 ${Math.round(cell.h)}px——精简要点`);
    }
    elements.push(
      textElement({ x: cell.x, y: cell.y, w: innerW, h: titleH }, [
        { runs: headingRuns(quadrant.title, titleSize, theme.colors.text, theme) },
      ]),
    );
    let y = cell.y + titleH + 8;
    (quadrant.points ?? []).forEach((point, j) => {
      const h = pointH[j]!;
      elements.push(
        textElement({ x: cell.x, y, w: innerW, h }, [
          { runs: bodyRuns(`—　${point}`, pointSize, theme.colors.textMuted, theme) },
        ]),
      );
      y += h;
    });
  });
  return elements;
}
