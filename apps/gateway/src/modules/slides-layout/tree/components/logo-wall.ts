/**
 * logoWall 组件（editorial）：4~8 个客户字标/图标，灰度统一视觉重量。
 * 图片：contain 完整呈现 + 灰度化 + 统一高度（行高四成）；无图：文字字标
 * （标题字号、字距拉开、向页底收灰）。≤6 个单行，7~8 个两行均分。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { mixHex } from "../../theme.js";
import { headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth } from "../../text-metrics.js";

export interface LogoSlot {
  /** 图标直链；给图时灰度 contain 完整呈现。 */
  image?: string;
  /** 文字字标；与 image 二选一。 */
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandLogoWall(slots: LogoSlot[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const n = slots.length;
  const rowCount = n <= 6 ? 1 : 2;
  const perRow = Math.ceil(n / rowCount);
  const rows: LogoSlot[][] = [];
  for (let i = 0; i < n; i += perRow) rows.push(slots.slice(i, i + perRow));
  const rowFrames = splitRows(frame, rows.length, theme.spacing.gutter * 2.5);
  const markSize = Math.min(19, Math.max(15, theme.sizes.subtitle - 2));
  const ink = mixHex(theme.colors.text, theme.colors.background, 0.5);
  const elements: SpecElement[] = [];
  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    const cells = splitColumns(rowFrame, row.length, theme.spacing.gutter * 2);
    const imgH = Math.round(Math.min(64, rowFrame.h * 0.4));
    row.forEach((slot, i) => {
      const cell = cells[i]!;
      if (slot.image) {
        // contain 完整呈现 + 灰度：水平居中、垂直居中
        const w = Math.round(cell.w - 16);
        elements.push({
          type: "image",
          url: slot.image,
          fit: "contain",
          grayscale: true,
          x: Math.round(cell.x + (cell.w - w) / 2),
          y: Math.round(cell.y + (rowFrame.h - imgH) / 2),
          w,
          h: imgH,
        });
      } else if (slot.text) {
        const text = slot.text;
        // 宽度用统一量测器（中英文同口径）+ 字距总量，避免 CJK 字标换行。
        const textW = estimateTextWidth(text, markSize) + text.length * 2.4;
        const w = Math.min(cell.w, Math.max(48, Math.round(textW + markSize)));
        elements.push(
          textElement({ x: Math.round(cell.x + (cell.w - w) / 2), y: Math.round(cell.y + (rowFrame.h - markSize * 1.5) / 2), w, h: Math.round(markSize * 1.5) }, [
            { runs: [{ ...headingRuns(text, markSize, ink, theme)[0]!, letterSpacing: 2.4 }], align: "center" as const },
          ]),
        );
      } else {
        bad(`${what} 第 ${r * perRow + i + 1} 个位置缺 image 或 text`);
      }
    });
  });
  return elements;
}
