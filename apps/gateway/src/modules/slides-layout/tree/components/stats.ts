/**
 * stats 组件：KPI 行。语义：大写标签 + 大数字（56–80pt 按长度适配）+ 单位。
 * 视觉：数字与标签是主体，无装饰短线；列间发丝线承担分组（separator 语义）；
 * 无底面语义，默认平铺，agent 显式 surface 时才铺底。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

export interface StatItem {
  value: string;
  label: string;
  unit?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandStats(
  items: StatItem[],
  frame: Frame,
  theme: ResolvedTheme,
  _what: string,
  skin: ComponentSkin,
  layout: "row" | "column" | "grid" = "row",
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const cells = layoutCells(items.length, layout, box, m.gap);
  const align = skin.paragraphAlign;

  const built = items.map((item, i) => {
    const cell = cells[i]!;
    const innerW = cell.w;
    // 数字宽闸：56–80pt 内按长度适配（单位是注释级，可缩到 12pt），再小报错。
    let displaySize = m.display;
    const widthAt = (s: number) =>
      estimateTextWidth(item.value, s) + (item.unit ? estimateTextWidth(` ${item.unit}`, Math.max(12, Math.round(s * 0.24))) : 0);
    while (displaySize > 56 && widthAt(displaySize) > innerW) displaySize -= 2;
    if (widthAt(displaySize) > innerW) {
      bad(`KPI 卡「${item.value}」数字太长，格宽装不下——精简数值或把单位并入标签`);
    }
    const labelH = singleLineBoxHeight(m.label);
    // 高度不足先在 56–80 档内收缩数字（宽度适配同档），仍不够才报错。
    const gap8 = Math.round(m.tightGap * 0.8);
    let valueH = singleLineBoxHeight(displaySize);
    while (displaySize > 56 && labelH + gap8 + valueH > cell.h) {
      displaySize -= 2;
      valueH = singleLineBoxHeight(displaySize);
    }
    const unitSize = Math.max(12, Math.round(displaySize * 0.24));
    const total = labelH + gap8 + valueH;
    if (total > cell.h) {
      bad(`KPI 卡「${item.value}」内容高约 ${Math.round(total)}px 超过区域 ${Math.round(cell.h)}px——加大该子树权重或减少条目`);
    }
    const top = cell.y + Math.max(0, (cell.h - total) / 2);
    return { item, cell, innerW, displaySize, unitSize, labelH, valueH, total, top };
  });

  built.forEach(({ item, cell, innerW, displaySize, unitSize, labelH, valueH, total, top }, i) => {
    elements.push(
      textElement({ x: cell.x, y: top, w: innerW, h: labelH }, [
        { runs: [skin.micro(item.label, skin.colors.muted)], ...(align === "center" ? { align } : {}) },
      ]),
    );
    elements.push(
      textElement(
        { x: cell.x, y: top + labelH + Math.round(m.tightGap * 0.8), w: cell.w, h: valueH },
        [{
          runs: [
            ...(skin.numeralRun(item.value, displaySize, skin.colors.text) ?? [
              { text: item.value, sizePt: displaySize, bold: true, color: skin.colors.text, ...(skin.fonts.body ? { font: skin.fonts.body } : {}) },
            ]),
            ...(item.unit ? [{
              text: ` ${item.unit}`,
              sizePt: unitSize,
              color: skin.colors.muted,
              ...(skin.fonts.numeral ? { font: skin.fonts.numeral } : {}),
            }] : []),
          ],
          ...(align === "center" ? { align } : {}),
        }],
      ),
    );
    if (i > 0) {
      const divider = layout === "column"
        ? skin.dividerH(box, Math.round(cell.y - m.gap / 2), box.w)
        : skin.dividerV(box, Math.round(cell.x - Math.round(m.gap / 2)), Math.round(cell.y + Math.max(0, (cell.h - total) / 2)), Math.round(Math.max(total, Math.round(cell.h * 0.5))));
      if (divider) elements.push(divider);
    }
  });
  return elements;
}

/** 槽位切分：row=等分列；column=等分行；grid=2 列（奇数末行单列）。 */
function layoutCells(count: number, layout: "row" | "column" | "grid", box: Frame, gap: number): Frame[] {
  if (layout === "row") return splitColumns(box, count, gap);
  if (layout === "column") return splitRows(box, count, gap);
  const cols = 2;
  const rows = Math.ceil(count / cols);
  const rowFrames = splitRows(box, rows, gap);
  return Array.from({ length: count }, (_, i) => {
    const rowFrame = rowFrames[Math.floor(i / cols)]!;
    const rowCount = Math.min(cols, count - Math.floor(i / cols) * cols);
    const cells = splitColumns(rowFrame, rowCount, gap);
    return cells[i % cols]!;
  });
}
