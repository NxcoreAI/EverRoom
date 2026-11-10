/**
 * timeline：时间轴。衬线大年份 + 轴线/节点 + 说明；横向（年份上）与纵向（左轴右文）。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";
import { mixHex } from "../../theme.js";

export interface TimelineItem {
  label: string;
  text: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandTimeline(
  direction: "h" | "v",
  items: TimelineItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  axis: "line" | "dots" | "none" = "line",
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const labelSize = Math.min(Math.round(m.serial * 1.18), 56);
  const textSize = Math.round(m.body * 1.05);
  const nodeD = Math.max(12, Math.round(m.body * 0.72));
  const axisColor = mixHex(skin.colors.text, skin.colors.background, 0.25);
  const labelFont = skin.fonts.numeral;
  const fitLabel = (label: string, cellW: number): number => {
    let size = labelSize;
    while (size > 20 && estimateTextWidth(label, size) > cellW - 12) size -= 2;
    if (estimateTextWidth(label, size) > cellW - 12) {
      bad(`${what}「${label}」年代超宽（可用 ${cellW}px）——统一短年代格式（如「2026」）`);
    }
    return size;
  };
  if (direction === "h") {
    const cells = splitColumns(box, items.length, m.gap);
    const axisY = Math.round(box.y + box.h * 0.56);
    if (axis === "line") {
      elements.push({ type: "shape", shape: "rect", fill: axisColor, x: Math.round(box.x), y: axisY, w: Math.round(box.w), h: 2 });
      // 两端刻线，轴线像一条真正的时间刻度尺。
      elements.push({ type: "shape", shape: "rect", fill: axisColor, x: Math.round(box.x), y: axisY - 7, w: 2, h: 16 });
      elements.push({ type: "shape", shape: "rect", fill: axisColor, x: Math.round(box.x + box.w - 2), y: axisY - 7, w: 2, h: 16 });
    }
    cells.forEach((cell, i) => {
      const item = items[i]!;
      const size = fitLabel(item.label, cell.w);
      const labelH = singleLineBoxHeight(size);
      const textH = textBoxHeight(item.text, textSize, cell.w);
      const cx = cell.x + cell.w / 2;
      elements.push({ type: "shape", shape: "ellipse", fill: skin.colors.emphasis, x: Math.round(cx - nodeD / 2), y: axisY - Math.round(nodeD / 2), w: nodeD, h: nodeD });
      elements.push(
        textElement({ x: cell.x, y: axisY - 20 - labelH, w: cell.w, h: labelH }, [
          { runs: [{ text: item.label, sizePt: size, bold: true, color: skin.colors.text, ...(labelFont ? { font: labelFont } : {}) }], align: "center" },
        ]),
      );
      elements.push(
        textElement({ x: cell.x, y: axisY + 22, w: cell.w, h: textH }, [
          { runs: skin.body(item.text, textSize, skin.colors.muted), align: "center" },
        ]),
      );
      if (i > 0 && axis === "dots") {
        elements.push({ type: "shape", shape: "ellipse", fill: skin.colors.divider, x: Math.round(cell.x - m.gap / 2 - 2), y: axisY - 2, w: 4, h: 4 });
      }
    });
    return elements;
  }
  const rows = splitRows(box, items.length, Math.round(m.gap * 0.8));
  const axisX = Math.round(box.x + 5);
  elements.push({ type: "shape", shape: "rect", fill: axisColor, x: axisX, y: Math.round(box.y), w: 2, h: Math.round(box.h) });
  // 纵向：年份在左、说明在右，同一行垂直居中——比上下堆叠更省高度，也更像时间轴。
  const yearX = box.x + 24;
  const yearSize = Math.min(Math.round(m.serial * 1.05), 46);
  const yearW = Math.max(96, Math.round(estimateTextWidth("0000 年", yearSize)));
  const textX = yearX + yearW + Math.round(m.gap * 0.8);
  const textW = box.w - (textX - box.x);
  rows.forEach((row, i) => {
    const item = items[i]!;
    let labelPt = yearSize;
    while (labelPt > 20 && singleLineBoxHeight(labelPt) > row.h - 8) labelPt -= 2;
    const labelH = singleLineBoxHeight(labelPt);
    const textH = textBoxHeight(item.text, textSize, textW);
    const total = Math.max(labelH, textH);
    if (total > row.h + 2) {
      bad(`${what} 第 ${i + 1} 条「${item.label}」内容高约 ${Math.round(total)}px 超过 ${Math.round(row.h)}px——精简条目文字或减少条目`);
    }
    const top = row.y + Math.max(0, (row.h - total) / 2);
    elements.push({ type: "shape", shape: "ellipse", fill: skin.colors.emphasis, x: axisX - Math.round(nodeD / 2) + 1, y: Math.round(top + (Math.min(labelH, total) - nodeD) / 2), w: nodeD, h: nodeD });
    elements.push(
      textElement({ x: yearX, y: top + Math.round((total - labelH) / 2), w: yearW, h: labelH }, [
        { runs: [{ text: item.label, sizePt: labelPt, bold: true, color: skin.colors.text, ...(labelFont ? { font: labelFont } : {}) }] },
      ]),
    );
    elements.push(
      textElement({ x: textX, y: top + Math.round((total - textH) / 2), w: textW, h: textH }, [
        { runs: skin.body(item.text, textSize, skin.colors.muted) },
      ]),
    );
  });
  return elements;
}
