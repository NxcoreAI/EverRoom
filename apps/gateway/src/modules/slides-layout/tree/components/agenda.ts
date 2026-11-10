/**
 * agenda：目录。衬线大序号 + 条目 + 行规则；按可用高度均匀分布，两栏（>4 条）。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandAgenda(items: string[], frame: Frame, theme: ResolvedTheme, what: string, skin: ComponentSkin): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "corner")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const serialSize = m.serial;
  const textSize = Math.round(m.title * 0.86);
  const numW = Math.max(64, Math.round(estimateTextWidth("00", serialSize)) + m.gap);
  const columns = items.length > 4 ? splitColumns(box, 2, Math.round(m.gap * 1.6)) : [box];
  const half = Math.ceil(items.length / 2);
  columns.forEach((col, c) => {
    const slice = items.slice(c * half, (c + 1) * half);
    const textW = col.w - numW;
    const rowH = Math.max(singleLineBoxHeight(serialSize), singleLineBoxHeight(textSize) + Math.round(m.tightGap * 0.8));
    const sum = rowH * slice.length;
    const gap = slice.length > 1 ? Math.min(64, Math.max(m.gap, Math.round((col.h - sum) / slice.length))) : 0;
    const total = sum + gap * (slice.length - 1);
    if (total > col.h + 2) {
      bad(`${what} 条目高约 ${Math.round(total)}px 超过区域 ${Math.round(col.h)}px——减少条目或精简文字`);
    }
    let y = col.y + Math.max(0, (col.h - total) / 2);
    slice.forEach((item, j) => {
      const index = c * half + j;
      const serialRuns = skin.numeralRun(String(index + 1).padStart(2, "0"), serialSize, skin.colors.emphasis);
      elements.push(textElement({ x: col.x, y: y - Math.round(singleLineBoxHeight(serialSize) * 0.08), w: numW - m.gap, h: singleLineBoxHeight(serialSize) }, [{ runs: serialRuns ?? [] }]));
      elements.push(
        textElement({ x: col.x + numW, y: y + Math.round((rowH - singleLineBoxHeight(textSize)) / 2), w: textW, h: singleLineBoxHeight(textSize) }, [
          { runs: skin.body(item, textSize, skin.colors.text, true) },
        ]),
      );
      if (j < slice.length - 1) {
        const divider = skin.dividerH(col, Math.round(y + rowH + gap / 2));
        if (divider) elements.push(divider);
      }
      y += rowH + gap;
    });
  });
  return elements;
}
