/**
 * pyramid 组件（editorial）。层改描边空心（透明填充 + 墨色发丝描边），
 * 文字压在层上，自上而下同构。
 */

import { splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { textBoxHeight } from "../../text-metrics.js";

export interface TierItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandPyramid(items: TierItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const rows = splitRows(frame, items.length, 8);
  const n = items.length;
  const titleSize = Math.min(16, Math.max(13, theme.sizes.body + 1));
  const textSize = theme.sizes.caption;
  rows.forEach((row, i) => {
    const item = items[i]!;
    // 层宽：顶层最窄（顶格 45%），向下每层加宽到 100%
    const widthRatio = 0.45 + (0.55 * i) / Math.max(1, n - 1);
    const tierW = Math.round(row.w * widthRatio);
    const x = Math.round(row.x + (row.w - tierW) / 2);
    const innerW = tierW - 24;
    const titleH = textBoxHeight(item.title, titleSize, innerW);
    const textH = item.text ? textBoxHeight(item.text, textSize, innerW) : 0;
    const need = titleH + (textH ? 4 + textH : 0) + 12;
    if (need > row.h) {
      bad(`${what} 第 ${i + 1} 层「${item.title}」内容高约 ${Math.round(need)}px 超过 ${Math.round(row.h)}px——精简文字或减少层级`);
    }
    elements.push({
      type: "shape",
      shape: i === 0 ? "triangle" : "trapezoid",
      fill: "#00000000",
      stroke: { color: theme.colors.text, widthPt: 1 },
      x,
      y: Math.round(row.y),
      w: tierW,
      h: Math.round(row.h),
    });
    const top = row.y + (row.h - need + 12) / 2;
    elements.push(
      textElement({ x: x + 12, y: top, w: innerW, h: titleH }, [
        { runs: bodyRuns(item.title, titleSize, theme.colors.text, theme, true), align: "center" },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: x + 12, y: top + titleH + 4, w: innerW, h: textH }, [
          { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme), align: "center" },
        ]),
      );
    }
  });
  return elements;
}
