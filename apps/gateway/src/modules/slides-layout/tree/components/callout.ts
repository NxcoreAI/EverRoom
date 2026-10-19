/**
 * calloutBox 组件（editorial）。左侧强调色竖条 + 一句加粗结论，
 * 板高跟内容走、框内垂直居中（强调条形态）。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface CalloutInput {
  text: string;
  icon?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandCallout(input: CalloutInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const size = Math.min(20, Math.max(15, theme.sizes.subtitle - 2));
  const pad = theme.spacing.cardPadding + 8;
  const iconSize = 26;
  const barW = 4;
  const iconW = input.icon ? iconSize + 16 : 0;
  const innerW = frame.w - pad * 2 - barW - iconW;
  const lines = estimateLines(input.text, size, innerW);
  const textH = lines * estimateLineHeight(size) + 8;
  const need = textH + pad * 2 - 20;
  if (need > frame.h || innerW < 120) {
    bad(`${what} 内容高约 ${Math.round(Math.max(need, 0))}px 超过 ${Math.round(frame.h)}px 或宽不足——精简文字或加大该子树权重`);
  }
  // 强调条形态：板高跟内容走，框内垂直居中
  const panelH = Math.min(frame.h, Math.max(96, Math.round(need + 36)));
  const panelY = frame.y + Math.max(0, Math.round((frame.h - panelH) / 2));
  const elements: SpecElement[] = [
    { type: "shape", shape: "rect", fill: theme.colors.primary, x: Math.round(frame.x), y: Math.round(panelY), w: barW, h: Math.round(panelH) },
  ];
  if (input.icon) {
    elements.push({
      type: "icon",
      icon: input.icon,
      color: theme.colors.primary,
      x: Math.round(frame.x + barW + pad),
      y: Math.round(panelY + (panelH - iconSize) / 2),
      w: iconSize,
      h: iconSize,
    });
  }
  elements.push(
    textElement(
      { x: frame.x + barW + pad + iconW, y: panelY, w: innerW, h: panelH },
      [{ runs: bodyRuns(input.text, size, theme.colors.text, theme, true) }],
      "middle",
    ),
  );
  return elements;
}
