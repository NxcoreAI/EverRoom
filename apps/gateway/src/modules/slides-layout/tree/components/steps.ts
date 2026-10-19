/**
 * steps 组件（editorial）。幽灵衬线大数字垫底 + 标题 + 说明，
 * 步骤间发丝连接线 + 主色起点小点。
 */

import { splitColumns, type Frame } from "../../grid.js";
import { mixHex, type ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface StepItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandSteps(items: StepItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const cells = splitColumns(frame, items.length, theme.spacing.gutter * 1.5);
  // 幽灵衬线数字在标题上方堆叠。genoffice 墨迹估算系数约 3.6×字号（大于网关的
  // 2.43×），标题与数字的间隙按 1.2×字号预留，否则真机整页拒收。
  const numSize = Math.min(56, Math.max(32, Math.round(frame.h * 0.14)));
  const numFont = numeralFont(theme);
  const ghostColor = mixHex(theme.colors.text, theme.colors.background, 0.88);
  const numH = singleLineBoxHeight(numSize);
  const titleGap = Math.round(numSize * 1.2);
  const titleSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const textSize = theme.sizes.caption;
  cells.forEach((cell, i) => {
    const item = items[i]!;
    const titleH = textBoxHeight(item.title, titleSize, cell.w);
    const textH = item.text ? textBoxHeight(item.text, textSize, cell.w) : 0;
    const need = numH + titleGap + titleH + (textH ? 6 + textH : 0);
    if (need > cell.h) {
      bad(`${what} 第 ${i + 1} 步「${item.title}」内容高约 ${Math.round(need)}px 超过区域 ${Math.round(cell.h)}px——精简步骤文字或减少步骤`);
    }
    const top = cell.y + Math.max(0, (cell.h - need) / 2);
    // 幽灵数字：低对比衬线大字
    elements.push(
      textElement({ x: cell.x - 4, y: top, w: cell.w + 8, h: numH }, [
        { runs: [{ text: String(i + 1).padStart(2, "0"), sizePt: numSize, bold: true, color: ghostColor, ...(numFont ? { font: numFont } : {}) }] },
      ]),
    );
    const titleY = top + numH + titleGap;
    elements.push(
      textElement({ x: cell.x, y: titleY, w: cell.w, h: titleH }, [
        { runs: headingRuns(item.title, titleSize, theme.colors.text, theme) },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: cell.x, y: titleY + titleH + 6, w: cell.w, h: textH }, [
          { runs: bodyRuns(item.text, textSize, theme.colors.textMuted, theme) },
        ]),
      );
    }
    // 步骤间发丝连接线 + 主色起点点
    if (i > 0) {
      const lineY = Math.round(top + numH * 0.5);
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(cell.x - theme.spacing.gutter * 1.5),
        y: lineY,
        w: Math.round(theme.spacing.gutter * 1.5),
        h: 1,
      });
      elements.push({
        type: "shape",
        shape: "ellipse",
        fill: theme.colors.primary,
        x: Math.round(cell.x - theme.spacing.gutter * 1.5 - 2),
        y: lineY - 2,
        w: 4,
        h: 4,
      });
    }
  });
  return elements;
}
