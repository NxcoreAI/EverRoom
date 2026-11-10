/**
 * matrix2x2：四象限。四张卡 + 轴标；象限标题更大，要点按可用高度分布。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
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

const AXIS_MAX = 96;

export function expandMatrix2x2(
  quadrants: Quadrant[],
  axes: MatrixAxes,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const m = skin.metrics(frame);
  const axisH = 44;
  const topAxis = axes.top ? axisH : 0;
  const bottomAxis = axes.bottom ? axisH : 0;
  const leftAxis = axes.left ? AXIS_MAX : 0;
  const rightAxis = axes.right ? AXIS_MAX : 0;
  const grid: Frame = {
    x: frame.x + leftAxis,
    y: frame.y + topAxis,
    w: frame.w - leftAxis - rightAxis,
    h: frame.h - topAxis - bottomAxis,
  };
  if (grid.w < 240 || grid.h < 180) {
    bad(`${what} 区域过小（${Math.round(grid.w)}×${Math.round(grid.h)}px）——加大该子树权重`);
  }
  const axisLabel = (text: string, f: Frame, align: "left" | "center" | "right", valign: "top" | "middle" = "top") => {
    elements.push(textElement(f, [{ runs: [skin.micro(text, skin.colors.muted, m.label + 1)], align }], valign));
  };
  if (axes.top) axisLabel(axes.top, { x: grid.x, y: frame.y, w: grid.w, h: axisH - 6 }, "center");
  if (axes.bottom) axisLabel(axes.bottom, { x: grid.x, y: grid.y + grid.h + 6, w: grid.w, h: axisH - 6 }, "center");
  if (axes.left) axisLabel(axes.left, { x: frame.x, y: grid.y, w: leftAxis - 10, h: grid.h }, "right", "middle");
  if (axes.right) axisLabel(axes.right, { x: grid.x + grid.w + 10, y: grid.y, w: rightAxis - 10, h: grid.h }, "left", "middle");

  const cols = splitColumns(grid, 2, m.gap);
  const rows = splitRows(grid, 2, m.gap);
  const titleSize = Math.round(m.title * 0.8);
  const pointSize = m.body;
  quadrants.forEach((quadrant, i) => {
    const cell: Frame = { x: cols[i % 2]!.x, y: rows[Math.floor(i / 2)]!.y, w: cols[i % 2]!.w, h: rows[Math.floor(i / 2)]!.h };
    elements.push(...skin.paint(cell));
    const box = skin.contentBox(cell);
    const titleH = estimateLines(quadrant.title, titleSize, box.w) * estimateLineHeight(titleSize, 108) + 4;
    const pointHs = (quadrant.points ?? []).map((p) => estimateLines(p, pointSize, box.w - 18) * estimateLineHeight(pointSize, 122) + Math.round(m.tightGap * 0.8));
    const pointsSum = pointHs.reduce((a, b) => a + b, 0);
    const head = titleH + Math.round(m.tightGap * 0.9);
    if (head + pointsSum > box.h + 2) {
      bad(`${what} 第 ${i + 1} 象限「${quadrant.title}」内容高约 ${Math.round(head + pointsSum)}px 超过 ${Math.round(box.h)}px——精简要点`);
    }
    const contentTop = box.y + Math.max(0, Math.round((box.h - head - pointsSum) / 2));
    elements.push(
      textElement({ x: box.x, y: contentTop, w: box.w - 30, h: titleH }, [
        { runs: skin.heading(quadrant.title, titleSize, skin.colors.text) },
      ]),
    );
    const rule = skin.dividerH(box, contentTop + head - Math.round(m.tightGap * 0.5));
    if (rule) elements.push(rule);
    const extra = Math.max(0, Math.round((box.h - head - pointsSum) / Math.max(1, (quadrant.points ?? []).length)));
    let y = contentTop + head;
    (quadrant.points ?? []).forEach((point, j) => {
      const h = pointHs[j]!;
      elements.push(
        textElement({ x: box.x, y, w: box.w, h }, [
          { runs: skin.body(`—　${point}`, pointSize, skin.colors.muted) },
        ]),
      );
      y += h + Math.min(extra, Math.round(m.tightGap * 1.2));
    });
  });
  return elements;
}
