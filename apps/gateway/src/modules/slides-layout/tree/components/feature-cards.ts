/**
 * featureCards 组件：特性行（editorial）。无卡片——图标 + 标题 + 正文，
 * 列间竖发丝线，整组在框内垂直居中。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface FeatureItem {
  title: string;
  body?: string;
  icon?: string;
  /** 图槽：条目顶部圆角图片块（给了 image 时 icon 不画）。 */
  image?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandFeatureCards(items: FeatureItem[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const cells = splitColumns(frame, items.length, theme.spacing.gutter * 1.5);
  const titleSize = Math.min(18, Math.max(14, theme.sizes.body + 2));
  const bodySize = theme.sizes.caption;
  const iconSize = 24;
  const elements: SpecElement[] = [];
  const built = items.map((item, i) => {
    const cell = cells[i]!;
    const innerW = cell.w;
    // 图槽高：条目高的 1/3 封顶，短框收缩到 56px；放不下就不画图。
    const imgH = item.image ? Math.min(120, Math.max(56, Math.round(cell.h * 0.32))) : 0;
    const iconH = !item.image && item.icon ? iconSize + 10 : 0;
    const titleH = estimateLines(item.title, titleSize, innerW) * estimateLineHeight(titleSize) + 4;
    const bodyH = item.body ? estimateLines(item.body, bodySize, innerW) * estimateLineHeight(bodySize) + 4 : 0;
    const total = imgH + iconH + titleH + (bodyH ? 8 + bodyH : 0);
    if (total > cell.h) {
      bad(`${what}「${item.title.slice(0, 12)}」内容高约 ${Math.round(total)}px 超过 ${Math.round(cell.h)}px——精简正文或加大权重`);
    }
    return { item, cell, innerW, imgH, iconH, titleH, bodyH, total };
  });
  const contentH = Math.max(...built.map((b) => b.total));
  const top = frame.y + Math.max(0, (frame.h - contentH) / 2);
  built.forEach((b, i) => {
    const { item, cell, innerW, imgH, iconH, titleH, bodyH } = b;
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
      y += imgH + 10;
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
        textElement({ x: cell.x, y: y + 8, w: innerW, h: bodyH }, [
          { runs: bodyRuns(item.body, bodySize, theme.colors.textMuted, theme) },
        ]),
      );
    }
    // 列间竖发丝线
    if (i > 0) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(cell.x - theme.spacing.gutter * 0.75),
        y: Math.round(top),
        w: 1,
        h: Math.round(contentH),
      });
    }
  });
  return elements;
}
