/**
 * venn 组件（editorial）。双圆改发丝描边空心（透明填充 + 墨色描边），
 * 交集标签用主色。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight } from "../../text-metrics.js";

export interface VennInput {
  a: string;
  b: string;
  both?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandVenn(input: VennInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const labelSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const labelH = singleLineBoxHeight(labelSize);
  const overlap = 0.32;
  const rx = Math.min(frame.w * 0.3, frame.h * 0.42);
  const ry = Math.min(frame.h * 0.4, rx * 1.05);
  if (ry < 60) {
    bad(`${what} 区域过小（高 ${Math.round(frame.h)}px）——加大该子树权重`);
  }
  const cy = frame.y + frame.h / 2;
  const ax = frame.x + frame.w * 0.36;
  const bx = frame.x + frame.w * 0.64;
  const labelW = Math.min(frame.w * 0.24, 200);

  // 标签框：a 圆左半、交集居中、b 圆右半，两两不重叠
  const aBox = { x: Math.round(ax - labelW * 0.75), y: Math.round(cy - labelH / 2), w: Math.round(labelW), h: labelH };
  const bothBox = { x: Math.round((ax + bx) / 2 - labelW / 2), y: Math.round(cy - labelH / 2), w: Math.round(labelW), h: labelH };
  const bBox = { x: Math.round(bx - labelW * 0.25), y: Math.round(cy - labelH / 2), w: Math.round(labelW), h: labelH };
  if (aBox.x + aBox.w > bothBox.x - 8 || bothBox.x + bothBox.w > bBox.x + 8) {
    bad(`${what} 标签放不下（区域 ${Math.round(frame.w)}px 宽）——缩短两侧与交集标签`);
  }

  const elements: SpecElement[] = [
    {
      type: "shape",
      shape: "ellipse",
      fill: "#00000000",
      stroke: { color: theme.colors.text, widthPt: 1.25 },
      x: Math.round(ax - rx),
      y: Math.round(cy - ry),
      w: Math.round(rx * 2),
      h: Math.round(ry * 2),
    },
    {
      type: "shape",
      shape: "ellipse",
      fill: "#00000000",
      stroke: { color: theme.colors.text, widthPt: 1.25 },
      x: Math.round(bx - rx + rx * overlap),
      y: Math.round(cy - ry),
      w: Math.round(rx * 2),
      h: Math.round(ry * 2),
    },
    textElement(aBox, [{ runs: bodyRuns(input.a, labelSize, theme.colors.text, theme, true), align: "center" }]),
  ];
  if (input.both) {
    elements.push(textElement(bothBox, [{ runs: bodyRuns(input.both, theme.sizes.caption, theme.colors.primary, theme, true), align: "center" }]));
  }
  elements.push(textElement(bBox, [{ runs: bodyRuns(input.b, labelSize, theme.colors.text, theme, true), align: "center" }]));
  return elements;
}
