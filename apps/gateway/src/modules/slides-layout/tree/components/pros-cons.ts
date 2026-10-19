/**
 * prosCons 组件：利弊清单（editorial）。无面板——中央竖发丝线，两侧刻标 + 标题，
 * 条目带 check/x 小图标；优势列墨色、风险列静音灰。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface ProsConsInput {
  pros: string[];
  cons: string[];
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandProsCons(input: ProsConsInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const cols = splitColumns(frame, 2, theme.spacing.gutter * 2);
  const titleSize = Math.min(20, Math.max(16, theme.sizes.subtitle - 2));
  const itemSize = theme.sizes.body;
  const iconSize = 17;
  const sides = ([["pros", input.pros, "check-circle", "优势", theme.colors.text], ["cons", input.cons, "x-circle", "风险", theme.colors.textMuted]] as const).map(
    ([key, list, icon, label, ink], i) => {
      const col = cols[i]!;
      const innerW = col.w - iconSize - 10;
      const titleH = estimateLineHeight(titleSize) + 6;
      const itemH = list.map((p) => estimateLines(p, itemSize, innerW) * estimateLineHeight(itemSize) + 12);
      const itemsH = itemH.reduce((a, b) => a + b, 0);
      const contentH = titleH + 16 + itemsH;
      if (contentH > col.h) {
        bad(`${what} ${label}栏内容高约 ${Math.round(contentH)}px 超过 ${Math.round(col.h)}px——精简${key === "pros" ? "优势" : "风险"}条目`);
      }
      return { key, list, icon, label, ink, col, innerW, titleH, itemH, contentH };
    },
  );
  const contentH = Math.max(...sides.map((s) => s.contentH));
  const top = frame.y + Math.max(0, (frame.h - contentH) / 2);
  elements.push({
    type: "shape",
    shape: "rect",
    fill: theme.colors.divider,
    x: Math.round(frame.x + frame.w / 2),
    y: Math.round(top),
    w: 1,
    h: Math.round(contentH),
  });
  sides.forEach(({ key, list, icon, label, ink, col, innerW, titleH, itemH }) => {
    // 刻标 + 标题
    elements.push({ type: "shape", shape: "rect", fill: key === "pros" ? theme.colors.primary : theme.colors.textMuted, x: Math.round(col.x), y: Math.round(top + 4), w: 3, h: 16 });
    elements.push(
      textElement({ x: col.x + 14, y: top, w: col.w - 14, h: titleH }, [
        { runs: bodyRuns(label, titleSize, theme.colors.text, theme, true) },
      ]),
    );
    let y = top + titleH + 16;
    list.forEach((point, j) => {
      const h = itemH[j]!;
      elements.push({
        type: "icon",
        icon,
        color: key === "pros" ? theme.colors.primary : theme.colors.textMuted,
        x: Math.round(col.x + 1),
        y: Math.round(y + 1),
        w: iconSize,
        h: iconSize,
      });
      elements.push(
        textElement({ x: col.x + iconSize + 12, y, w: innerW, h }, [
          { runs: bodyRuns(point, itemSize, ink, theme) },
        ]),
      );
      y += h;
    });
  });
  return elements;
}
