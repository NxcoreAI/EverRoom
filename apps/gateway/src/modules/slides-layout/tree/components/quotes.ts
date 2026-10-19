/**
 * quotes 组件（editorial）：2~3 条客户评价卡。星级（可选，金档小星）+ 引文
 * + 短发丝线 + 头像圆图（可选）与署名。列间竖发丝线分隔。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface QuoteEntry {
  text: string;
  name: string;
  role?: string;
  avatar?: string;
  /** 星级 1~5；缺省不画星。 */
  rating?: number;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandQuotes(items: QuoteEntry[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const cols = splitColumns(frame, items.length, theme.spacing.gutter * 2);
  const textSize = Math.min(15, Math.max(13, theme.sizes.body));
  const metaSize = theme.sizes.caption;
  const starSize = 13;
  const avatarSize = 34;
  const gold = theme.colors.chartSeries[3] ?? theme.colors.accent;
  const elements: SpecElement[] = [];
  const rendered = items.map((item, i) => {
    const col = cols[i]!;
    const starH = item.rating ? starSize + 8 : 0;
    const textH = estimateLines(item.text, textSize, col.w) * estimateLineHeight(textSize) + 6;
    const nameH = estimateLineHeight(metaSize) * 1.6 + 8;
    const roleH = estimateLineHeight(metaSize) * 1.6 + 8;
    const need = starH + textH + 16 + 14 + Math.max(avatarSize, nameH + roleH);
    if (need > col.h) {
      bad(`${what} 第 ${i + 1} 条「${item.text.slice(0, 12)}…」内容高约 ${Math.round(need)}px 超过 ${Math.round(col.h)}px——精简引文`);
    }
    return { item, col, starH, textH, nameH, roleH, need };
  });
  const contentH = Math.max(...rendered.map((r) => r.need));
  const top = frame.y + Math.max(0, (frame.h - contentH) / 2);
  rendered.forEach(({ item, col, starH, textH, nameH, roleH }, i) => {
    if (i > 0) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(col.x - theme.spacing.gutter),
        y: Math.round(top),
        w: 1,
        h: Math.round(contentH),
      });
    }
    let y = top;
    if (item.rating) {
      for (let s = 0; s < item.rating; s++) {
        elements.push({
          type: "icon",
          icon: "star",
          color: gold,
          x: Math.round(col.x + s * (starSize + 3)),
          y: Math.round(y),
          w: starSize,
          h: starSize,
        });
      }
      y += starH;
    }
    elements.push(
      textElement({ x: col.x, y, w: col.w, h: textH }, [
        { runs: bodyRuns(item.text, textSize, theme.colors.text, theme) },
      ]),
    );
    y += textH + 16;
    elements.push({
      type: "shape",
      shape: "rect",
      fill: theme.colors.divider,
      x: Math.round(col.x),
      y: Math.round(y),
      w: 28,
      h: 1,
    });
    y += 14;
    // 底部署名：头像（可选）+ 姓名/角色；两行盒子节距放宽（墨迹闸门口径）。
    let textX = col.x;
    const stackH = nameH + roleH;
    const footerW = col.w - (item.avatar ? avatarSize + 10 : 0);
    if (item.avatar) {
      elements.push({
        type: "image",
        url: item.avatar,
        fit: "cover",
        circle: true,
        x: Math.round(col.x),
        y: Math.round(y + (stackH - avatarSize) / 2),
        w: avatarSize,
        h: avatarSize,
      });
      textX = col.x + avatarSize + 10;
    }
    elements.push(
      textElement({ x: textX, y: y + (item.role ? 0 : (stackH - nameH) / 2), w: footerW, h: nameH }, [
        { runs: headingRuns(item.name, metaSize + 1, theme.colors.text, theme) },
      ]),
    );
    if (item.role) {
      elements.push(
        textElement({ x: textX, y: y + nameH, w: footerW, h: roleH }, [
          { runs: bodyRuns(item.role, metaSize, theme.colors.textMuted, theme) },
        ]),
      );
    }
  });
  return elements;
}
