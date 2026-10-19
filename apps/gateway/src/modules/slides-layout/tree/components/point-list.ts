/**
 * pointList 组件（editorial，xPoint 嫁接进词汇表）。刻度要点纵列：
 * 可选衬线序号 + 加粗字距标签一行 + 静音正文折行，条目间发丝线。
 * 内容高跟内容走、整组在区域内垂直居中——过高的框只增加留白。
 */

import { bodyRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface PointItem {
  label: string;
  body: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const ENTRY_GAP = 6;
/** 条目距：发丝线落在间隙中点。 */
const SEPARATOR_GAP = 20;

export function expandPointList(
  items: PointItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  numbered = false,
): SpecElement[] {
  const labelSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const bodySize = theme.sizes.body;
  const serialSize = 15;
  const labelH = singleLineBoxHeight(labelSize);
  const serialTextW = numbered ? Math.round(estimateTextWidth("01", serialSize)) + 4 : 0;
  const serialW = serialTextW > 0 ? serialTextW + 12 : 0;
  const textW = frame.w - serialW;
  const heights = items.map((item) => {
    if (estimateTextWidth(item.label, labelSize) > textW) {
      bad(`${what} 条目「${item.label}」标签超宽（可用 ${Math.round(textW)}px）——缩短标签`);
    }
    const bodyH = textBoxHeight(item.body, bodySize, textW);
    return { bodyH, entryH: labelH + ENTRY_GAP + bodyH };
  });
  const total = heights.reduce((sum, h) => sum + h.entryH, 0) + SEPARATOR_GAP * (items.length - 1);
  if (total > frame.h + 2) {
    bad(`${what} 内容高约 ${Math.round(total)}px 超过区域 ${Math.round(frame.h)}px——精简正文或减少条目`);
  }
  const serialFont = numbered ? numeralFont(theme) : undefined;
  const elements: SpecElement[] = [];
  let y = frame.y + Math.max(0, (frame.h - total) / 2);
  items.forEach((item, i) => {
    const { bodyH, entryH } = heights[i]!;
    if (numbered) {
      elements.push(
        textElement({ x: frame.x, y, w: serialTextW, h: labelH }, [
          {
            runs: [
              {
                text: String(i + 1).padStart(2, "0"),
                sizePt: serialSize,
                bold: true,
                color: theme.colors.primary,
                ...(serialFont ? { font: serialFont } : {}),
              },
            ],
          },
        ]),
      );
    }
    elements.push(
      textElement({ x: frame.x + serialW, y, w: textW, h: labelH }, [
        { runs: [{ text: item.label, sizePt: labelSize, bold: true, color: theme.colors.text, letterSpacing: 1 }] },
      ]),
    );
    elements.push(
      textElement({ x: frame.x + serialW, y: y + labelH + ENTRY_GAP, w: textW, h: bodyH }, [
        { runs: bodyRuns(item.body, bodySize, theme.colors.textMuted, theme) },
      ]),
    );
    if (i < items.length - 1) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(frame.x),
        y: Math.round(y + entryH + SEPARATOR_GAP / 2),
        w: Math.round(frame.w),
        h: 1,
      });
    }
    y += entryH + SEPARATOR_GAP;
  });
  return elements;
}
