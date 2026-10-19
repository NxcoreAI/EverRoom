/**
 * funnel 组件（editorial）。横条改直角矩形（无圆角），墨色向页底单调渐隐，
 * 宽与色同步讲收窄；文字随底色明度翻转。
 */

import { splitRows, type Frame } from "../../grid.js";
import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import { bodyRuns, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight } from "../../text-metrics.js";

export interface FunnelItem {
  stage: string;
  value?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandFunnel(items: FunnelItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const elements: SpecElement[] = [];
  const rows = splitRows(frame, items.length, 10);
  const n = items.length;
  const stageSize = Math.min(16, Math.max(13, theme.sizes.body + 1));
  const valueSize = theme.sizes.caption;
  rows.forEach((row, i) => {
    const item = items[i]!;
    const widthRatio = 1 - (0.55 * i) / Math.max(1, n - 1);
    const barW = Math.round(row.w * widthRatio);
    const x = Math.round(row.x + (row.w - barW) / 2);
    const stageH = singleLineBoxHeight(stageSize);
    const valueH = item.value ? singleLineBoxHeight(valueSize) : 0;
    const need = stageH + (valueH ? 2 + valueH : 0) + 10;
    if (need > row.h) {
      bad(`${what} 第 ${i + 1} 级「${item.stage}」内容高约 ${Math.round(need)}px 超过 ${Math.round(row.h)}px——精简文字或减少级数`);
    }
    // 单调渐隐：逐级向页底色收淡（editorial 用墨色而不是主色，主色留给刻标与数字）
    const fill = mixHex(theme.colors.text, theme.colors.background, (i / Math.max(1, n - 1)) * 0.78);
    elements.push({
      type: "shape",
      shape: "rect",
      fill,
      x,
      y: Math.round(row.y),
      w: barW,
      h: Math.round(row.h),
    });
    const textColor = isDarkColor(fill) ? theme.colors.onDarkText : theme.colors.text;
    const top = row.y + (row.h - need + 10) / 2;
    elements.push(
      textElement({ x: x + 12, y: top, w: barW - 24, h: stageH }, [
        { runs: bodyRuns(item.stage, stageSize, textColor, theme, true), align: "center" },
      ]),
    );
    if (item.value) {
      elements.push(
        textElement({ x: x + 12, y: top + stageH + 2, w: barW - 24, h: valueH }, [
          { runs: bodyRuns(item.value, valueSize, textColor, theme), align: "center" },
        ]),
      );
    }
  });
  return elements;
}
