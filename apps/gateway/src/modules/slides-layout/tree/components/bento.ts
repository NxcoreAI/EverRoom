/**
 * bentoGrid 组件（editorial）。信息拼贴改发丝网格：格与格之间用 1px 分隔线，
 * 无底板；wide 占整行。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface BentoItem {
  title: string;
  body?: string;
  icon?: string;
  /** 图槽：格子顶部圆角图片块（给了 image 时 icon 不画）。 */
  image?: string;
  /** 占满整行。 */
  wide?: boolean;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

function hline(frame: Frame, y: number, theme: ResolvedTheme): SpecElement {
  return { type: "shape", shape: "rect", fill: theme.colors.divider, x: Math.round(frame.x), y: Math.round(y), w: Math.round(frame.w), h: 1 };
}

export function expandBentoGrid(items: BentoItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  // 行规划：wide 独占一行；普通条目两两配对，落单的独占左半行
  const rows: BentoItem[][] = [];
  let pair: BentoItem[] = [];
  for (const item of items) {
    if (item.wide) {
      if (pair.length > 0) {
        rows.push(pair);
        pair = [];
      }
      rows.push([item]);
    } else {
      pair.push(item);
      if (pair.length === 2) {
        rows.push(pair);
        pair = [];
      }
    }
  }
  if (pair.length > 0) rows.push(pair);

  const rowFrames = splitRows(frame, rows.length, theme.spacing.gutter * 1.5);
  const titleSize = Math.min(17, Math.max(14, theme.sizes.body + 2));
  const bodySize = theme.sizes.caption;
  const pad = theme.spacing.cardPadding;
  const elements: SpecElement[] = [];
  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    // 行间水平发丝线（首行上方不画）
    if (r > 0) elements.push(hline(frame, rowFrame.y - theme.spacing.gutter * 0.75, theme));
    const cells = row.length === 1 ? (row[0]!.wide ? [rowFrame] : splitColumns(rowFrame, 2, theme.spacing.gutter * 1.5).slice(0, 1)) : splitColumns(rowFrame, 2, theme.spacing.gutter * 1.5);
    // 行内竖向分隔线（非 wide 行）
    if (row.length === 2) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round((cells[0]!.x + cells[0]!.w + cells[1]!.x) / 2),
        y: Math.round(rowFrame.y),
        w: 1,
        h: Math.round(rowFrame.h),
      });
    }
    row.forEach((item, i) => {
      const cell = cells[i]!;
      const innerW = cell.w;
      const iconSize = 24;
      // 图槽高：格子高的 1/3 封顶、56px 起步；放不下就不画图。
      const imgH = item.image ? Math.min(110, Math.max(56, Math.round(cell.h * 0.34))) : 0;
      const iconH = !item.image && item.icon ? iconSize + 8 : 0;
      const titleH = estimateLines(item.title, titleSize, innerW) * estimateLineHeight(titleSize) + 4;
      const bodyH = item.body ? estimateLines(item.body, bodySize, innerW) * estimateLineHeight(bodySize) + 4 : 0;
      const need = imgH + iconH + titleH + (bodyH ? 6 + bodyH : 0);
      if (need > cell.h || innerW < 100) {
        bad(`${what}「${item.title.slice(0, 12)}」格内容高约 ${Math.round(need)}px 超过 ${Math.round(cell.h)}px——精简正文或减少条目`);
      }
      const top = cell.y + Math.max(0, (cell.h - need) / 2);
      let y = top;
      if (item.image && imgH > 0) {
        const radiusAdj =
          theme.spacing.cornerRadius > 0
            ? Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.min(innerW, imgH)) * 100000))
            : undefined;
        elements.push({
          type: "image",
          url: item.image,
          fit: "cover",
          ...(radiusAdj !== undefined ? { radiusAdj } : {}),
          x: Math.round(cell.x),
          y: Math.round(y),
          w: Math.round(innerW),
          h: imgH,
        });
        y += imgH + 8;
      } else if (item.icon) {
        elements.push({
          type: "icon",
          icon: item.icon,
          color: theme.colors.primary,
          x: Math.round(cell.x),
          y: Math.round(y),
          w: iconSize,
          h: iconSize,
        });
        y += iconH;
      }
      elements.push(
        textElement({ x: cell.x, y, w: innerW, h: titleH }, [
          { runs: headingRuns(item.title, titleSize, theme.colors.text, theme) },
        ]),
      );
      y += titleH;
      if (item.body) {
        elements.push(
          textElement({ x: cell.x, y: y + 6, w: innerW, h: bodyH }, [
            { runs: bodyRuns(item.body, bodySize, theme.colors.textMuted, theme) },
          ]),
        );
      }
    });
  });
  return elements;
}
