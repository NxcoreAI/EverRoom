/**
 * featureCards：卡片行。图标/图槽 + 标题 + 正文；卡面由风格卡决定。
 * 标题与正文组成紧凑阅读组顶对齐（图片卡图片在上文字在下）；图标保持小尺度，
 * 不画装饰短线与压底序号。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface FeatureItem {
  title: string;
  body?: string;
  icon?: string;
  image?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandFeatureCards(
  items: FeatureItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const m = skin.metrics(frame);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const cells = splitColumns(frame, items.length, m.gap);
  const iconSize = 40;
  const elements: SpecElement[] = [];
  // 溢出降档：先按原字号换行，正文有限缩至 16pt、标题至 20pt，最后一档同时压缩行间间距
  // （全卡同档，同级文字一致）。
  const sizePairs: Array<[number, number, number]> = [[m.title, m.body, 1], [m.title, 16, 1], [20, 16, 1], [20, 16, 0.5]];
  let titleSize = sizePairs[0]![0]!;
  let bodySize = sizePairs[0]![1]!;
  let built: Array<{ item: FeatureItem; box: Frame; innerW: number; imageH: number; titleH: number; bodyH: number; topBlock: number; bodyGap: number; need: number }> = [];
  for (const [tSize, bSize, gapScale] of sizePairs) {
    titleSize = tSize;
    bodySize = bSize;
    built = items.map((item, i) => {
      const cell = cells[i]!;
      const box = skin.contentBox(cell);
      const innerW = box.w;
      const imageH = item.image ? Math.round(box.h * 0.44) : 0;
      const titleH = estimateLines(item.title, tSize, innerW) * estimateLineHeight(tSize, 108) + 4;
      const bodyH = item.body ? estimateLines(item.body, bSize, innerW) * estimateLineHeight(bSize, 124) + 4 : 0;
      const topBlock = imageH > 0 ? imageH + Math.round(m.tightGap * 1.1 * gapScale) : item.icon ? iconSize + Math.round(m.tightGap * 1.2 * gapScale) : 0;
      const bodyGap = Math.round(m.tightGap * 0.8 * gapScale);
      const need = topBlock + titleH + (bodyH ? bodyGap + bodyH : 0);
      return { item, box, innerW, imageH, titleH, bodyH, topBlock: Math.round(topBlock), bodyGap, need };
    });
    if (built.every((entry) => entry.need <= entry.box.h)) break;
  }
  const overflow = built.find((entry) => entry.need > entry.box.h);
  if (overflow) {
    bad(`${what}「${overflow.item.title.slice(0, 12)}」内容高约 ${Math.round(overflow.need)}px 超过 ${Math.round(overflow.box.h)}px——精简正文或加大权重`);
  }
  cells.forEach((cell) => elements.push(...skin.paint(cell)));
  built.forEach(({ item, box, innerW, imageH, titleH, bodyH, topBlock, bodyGap }) => {
    let y = box.y;
    if (item.image && imageH > 0) {
      const radiusAdj = skin.imageRadiusAdj(innerW, imageH);
      elements.push({
        type: "image", url: item.image, fit: skin.imageFit,
        ...(radiusAdj !== undefined ? { radiusAdj } : {}),
        x: Math.round(box.x), y: Math.round(y), w: Math.round(innerW), h: imageH,
      });
    } else if (item.icon) {
      elements.push({
        type: "icon", icon: item.icon, color: skin.colors.emphasis,
        x: Math.round(box.x), y: Math.round(box.y), w: iconSize, h: iconSize,
      });
    }
    // 标题紧随图标/图片，正文随行：紧凑阅读组顶对齐。
    const titleY = box.y + topBlock;
    elements.push(
      textElement({ x: box.x, y: titleY, w: innerW, h: titleH }, [
        { runs: skin.heading(item.title, titleSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
      ]),
    );
    if (item.body) {
      elements.push(
        textElement({ x: box.x, y: titleY + titleH + bodyGap, w: innerW, h: bodyH }, [
          { runs: skin.body(item.body, bodySize, skin.colors.muted), ...(align === "center" ? { align } : {}) },
        ]),
      );
    }
  });
  return elements;
}
