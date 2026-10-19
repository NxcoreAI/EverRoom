/**
 * orgChart 组件（editorial）。根节点墨色实心块配反白字，子节点发丝描边空心块，
 * 细线连接。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface OrgNode {
  title: string;
  subtitle?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

function nodeElements(node: OrgNode, frame: Frame, theme: ResolvedTheme, root: boolean): { elements: SpecElement[]; h: number; titleH: number } {
  const titleSize = root ? Math.min(17, Math.max(14, theme.sizes.body + 2)) : Math.min(15, Math.max(13, theme.sizes.body));
  const subSize = theme.sizes.caption;
  const innerW = frame.w - 20;
  const titleH = estimateLines(node.title, titleSize, innerW) * estimateLineHeight(titleSize) + 4;
  const subH = node.subtitle ? estimateLines(node.subtitle, subSize, innerW) * estimateLineHeight(subSize) + 2 : 0;
  const h = titleH + subH + 22;
  const box: SpecElement = root
    ? { type: "shape", shape: "rect", fill: theme.colors.text, x: frame.x, y: frame.y, w: frame.w, h }
    : { type: "shape", shape: "rect", fill: "#00000000", stroke: { color: theme.colors.divider, widthPt: 1.25 }, x: frame.x, y: frame.y, w: frame.w, h };
  const titleColor = root ? theme.colors.onDarkText : theme.colors.text;
  const elements: SpecElement[] = [
    box,
    textElement({ x: frame.x + 10, y: frame.y + 11, w: innerW, h: titleH }, [
      { runs: bodyRuns(node.title, titleSize, titleColor, theme, true), align: "center" },
    ]),
  ];
  if (node.subtitle) {
    elements.push(
      textElement({ x: frame.x + 10, y: frame.y + 11 + titleH, w: innerW, h: subH }, [
        { runs: bodyRuns(node.subtitle, subSize, root ? theme.colors.onDarkText : theme.colors.textMuted, theme), align: "center" },
      ]),
    );
  }
  return { elements, h, titleH };
}

function hline(x1: number, x2: number, y: number, theme: ResolvedTheme): SpecElement {
  return {
    type: "shape",
    shape: "line",
    x: Math.round(Math.min(x1, x2)),
    y: Math.round(y),
    w: Math.round(Math.abs(x2 - x1)),
    h: 1,
    stroke: { color: theme.colors.divider, widthPt: 1 },
  };
}

function vline(x: number, y1: number, y2: number, theme: ResolvedTheme): SpecElement {
  return {
    type: "shape",
    shape: "line",
    x: Math.round(x),
    y: Math.round(Math.min(y1, y2)),
    w: 1,
    h: Math.round(Math.abs(y2 - y1)),
    stroke: { color: theme.colors.divider, widthPt: 1 },
  };
}

export function expandOrgChart(
  root: OrgNode,
  children: OrgNode[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const rootW = Math.min(frame.w * 0.4, 320);
  const rootFrame: Frame = { x: frame.x + (frame.w - rootW) / 2, y: frame.y, w: rootW, h: 0 };
  const childCells = splitColumns(frame, children.length, theme.spacing.gutter);
  const childHeights = children.map((child) => nodeElements(child, childCells[0]!, theme, false).h);
  const maxChildH = Math.max(...childHeights);
  const rootH = nodeElements(root, rootFrame, theme, true).h;
  const gap = 40;
  const total = rootH + gap + maxChildH;
  if (total > frame.h) {
    bad(`${what} 两层内容高约 ${Math.round(total)}px 超过 ${Math.round(frame.h)}px——精简节点文字或减少子节点`);
  }
  const top = frame.y + (frame.h - total) / 2;
  const elements: SpecElement[] = [];
  const rootY = top;
  const rootBottom = rootY + rootH;
  const childrenTop = rootBottom + gap;
  const midY = rootBottom + gap / 2;
  const rootCx = frame.x + frame.w / 2;
  const centers = childCells.map((cell) => cell.x + cell.w / 2);

  elements.push(...nodeElements(root, { ...rootFrame, y: rootY, h: rootH }, theme, true).elements);
  elements.push(vline(rootCx, rootBottom, midY, theme));
  elements.push(hline(centers[0]!, centers[centers.length - 1]!, midY, theme));
  children.forEach((child, i) => {
    elements.push(vline(centers[i]!, midY, childrenTop, theme));
    elements.push(...nodeElements(child, { ...childCells[i]!, y: childrenTop, h: maxChildH }, theme, false).elements);
  });
  return elements;
}
