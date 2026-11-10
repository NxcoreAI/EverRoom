/**
 * pointList：要点纵列。序号/标签/正文 + 条目间发丝线；内容按可用高度均匀分布，
 * 不再挤在中间留出上下两条空带。
 */

import { textElement, type SpecElement } from "../../elements.js";
import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface PointItem {
  label: string;
  body: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandPointList(
  items: PointItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  numbered = false,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "corner")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const labelSize = Math.round(m.title * 0.92);
  const bodySize = m.body;
  const serialSize = Math.round(m.serial * 0.62);
  const showSerial = numbered && skin.numeral !== "none";
  const serialW = showSerial ? Math.round(estimateTextWidth("00", serialSize)) + m.tightGap : 0;
  const textW = box.w - serialW;
  const labelH = singleLineBoxHeight(labelSize);
  const align = skin.paragraphAlign;
  const labelGap = Math.max(4, Math.round(m.tightGap * 0.5));
  const heights = items.map((item) => {
    if (estimateTextWidth(item.label, labelSize) > textW) {
      bad(`${what} 条目「${item.label}」标签超宽（可用 ${Math.round(textW)}px）——缩短标签`);
    }
    const bodyH = textBoxHeight(item.body, bodySize, textW);
    return { bodyH, entryH: labelH + labelGap + bodyH };
  });
  const sum = heights.reduce((total, h) => total + h.entryH, 0);
  const gap = items.length > 1 ? Math.min(72, Math.max(m.gap, Math.round((box.h - sum) / items.length))) : 0;
  const total = sum + gap * (items.length - 1);
  if (total > box.h + 2) {
    bad(`${what} 内容高约 ${Math.round(total)}px 超过区域 ${Math.round(box.h)}px——精简正文或减少条目`);
  }
  let y = box.y + Math.max(0, (box.h - total) / 2);
  items.forEach((item, i) => {
    const { bodyH, entryH } = heights[i]!;
    if (showSerial) {
      const runs = skin.numeralRun(String(i + 1).padStart(2, "0"), serialSize, skin.colors.emphasis);
      elements.push(textElement({ x: box.x, y: y - 4, w: serialW - m.tightGap, h: labelH }, [{ runs: runs ?? [] }]));
    }
    elements.push(
      textElement({ x: box.x + serialW, y, w: textW, h: labelH }, [
        { runs: skin.body(item.label, labelSize, skin.colors.text, true), ...(align === "center" ? { align } : {}) },
      ]),
    );
    elements.push(
      textElement({ x: box.x + serialW, y: y + labelH + labelGap, w: textW, h: bodyH }, [
        { runs: skin.body(item.body, bodySize, skin.colors.muted), ...(align === "center" ? { align } : {}) },
      ]),
    );
    if (i < items.length - 1) {
      const divider = skin.dividerH(box, Math.round(y + entryH + gap / 2));
      if (divider) elements.push(divider);
    }
    y += entryH + gap;
  });
  return elements;
}
