/**
 * progress：进度条。标签 + 大数值 + 粗轨道 + 目标刻度；行均分填满高度。
 */

import { splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme, ResolvedTheme as Theme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { mixHex } from "../../theme.js";
import { textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight } from "../../text-metrics.js";

export interface ProgressItem {
  label: string;
  value: number;
  unit?: string;
  target?: number;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandProgress(
  items: ProgressItem[],
  frame: Frame,
  theme: Theme,
  what: string,
  skin: ComponentSkin,
  fill: "ink" | "primary" = "ink",
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const labelSize = Math.round(m.title * 0.72);
  const valueSize = Math.round(m.title * 0.8);
  const labelH = singleLineBoxHeight(labelSize);
  const valueH = singleLineBoxHeight(valueSize);
  const trackH = Math.max(10, Math.round(m.body * 0.8));
  const rows = splitRows(box, items.length, Math.round(m.gap * 0.9));
  const fillColor = fill === "primary" ? skin.colors.emphasis : skin.colors.text;
  const trackColor = mixHex(skin.colors.text, skin.colors.background, 0.88);
  rows.forEach((row, i) => {
    const item = items[i]!;
    const blockH = labelH + Math.round(m.tightGap * 0.8) + trackH;
    if (blockH > row.h) {
      bad(`${what} 第 ${i + 1} 项「${item.label}」行高不足（${Math.round(row.h)}px）——加大权重或减少条目`);
    }
    const top = row.y + Math.max(0, (row.h - blockH) / 2);
    elements.push(
      textElement({ x: row.x, y: top, w: row.w * 0.7, h: labelH }, [
        { runs: skin.body(item.label, labelSize, skin.colors.text, true) },
      ]),
    );
    const valueText = `${Math.round(item.value)}${item.unit ?? "%"}`;
    const targetText = item.target !== undefined ? ` / ${Math.round(item.target)}${item.unit ?? "%"}` : "";
    elements.push(
      textElement({ x: row.x + row.w * 0.7, y: top + Math.round((labelH - valueH) / 2), w: row.w * 0.3, h: valueH }, [
        {
          runs: [
            { text: valueText, sizePt: valueSize, bold: true, color: skin.colors.emphasis, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
            ...(targetText ? [{ text: targetText, sizePt: Math.round(valueSize * 0.58), color: skin.colors.muted }] : []),
          ],
          align: "right",
        },
      ]),
    );
    const barY = Math.round(top + labelH + Math.round(m.tightGap * 0.8));
    elements.push({ type: "shape", shape: "roundRect", fill: trackColor, x: Math.round(row.x), y: barY, w: Math.round(row.w), h: trackH, adj: 50000 });
    const fgW = Math.max(6, Math.round((row.w * item.value) / 100));
    elements.push({ type: "shape", shape: "roundRect", fill: fillColor, x: Math.round(row.x), y: barY, w: fgW, h: trackH, adj: 50000 });
    if (item.target !== undefined && item.target > 0 && item.target <= 100) {
      elements.push({
        type: "shape", shape: "rect", fill: skin.colors.emphasis,
        x: Math.round(row.x + (row.w * item.target) / 100) - 1, y: barY - 6, w: 2, h: trackH + 12,
      });
    }
  });
  return elements;
}
