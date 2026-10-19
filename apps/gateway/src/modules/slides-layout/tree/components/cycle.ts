/**
 * cycle 组件（editorial）。发丝描边空心环 + 环上主色实心小点，节点标题
 * 沿半径外推放置。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight } from "../../text-metrics.js";

export interface CycleItem {
  title: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandCycle(items: CycleItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const n = items.length;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const labelSize = Math.min(16, Math.max(13, theme.sizes.body));
  const labelH = singleLineBoxHeight(labelSize);
  const labelW = 140;
  const dotD = 10;
  // 标题外推距离：点外 18px
  const labelOffset = dotD / 2 + 20 + labelH / 2;
  const ringR = Math.min((frame.w - labelW) / 2, frame.h / 2 - labelOffset - 4);
  if (ringR < 56) {
    bad(`${what} 区域过小（${Math.round(frame.w)}×${Math.round(frame.h)}px）装不下 ${n} 个节点——加大权重或减少节点`);
  }
  const elements: SpecElement[] = [
    {
      type: "shape",
      shape: "ellipse",
      fill: "#00000000",
      stroke: { color: theme.colors.divider, widthPt: 1.5 },
      x: Math.round(cx - ringR),
      y: Math.round(cy - ringR),
      w: Math.round(ringR * 2),
      h: Math.round(ringR * 2),
    },
  ];
  items.forEach((item, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const nx = cx + Math.cos(angle) * ringR;
    const ny = cy + Math.sin(angle) * ringR;
    // 环上主色实心点
    elements.push({
      type: "shape",
      shape: "ellipse",
      fill: theme.colors.primary,
      x: Math.round(nx - dotD / 2),
      y: Math.round(ny - dotD / 2),
      w: dotD,
      h: dotD,
    });
    // 标题沿半径外推
    const lx = cx + Math.cos(angle) * (ringR + labelOffset);
    const ly = cy + Math.sin(angle) * (ringR + labelOffset);
    const boxX = Math.min(Math.max(lx - labelW / 2, frame.x), frame.x + frame.w - labelW);
    const boxY = Math.min(Math.max(ly - labelH / 2, frame.y), frame.y + frame.h - labelH);
    elements.push(
      textElement({ x: Math.round(boxX), y: Math.round(boxY), w: labelW, h: labelH }, [
        { runs: bodyRuns(item.title, labelSize, theme.colors.text, theme, true), align: "center" },
      ]),
    );
  });
  return elements;
}
