/**
 * bentoGrid 组件（editorial）：信息拼贴。
 *
 * 版式：普通格两两成行（三条时整行三等分），wide 独占整行；各项默认平级（不反白
 * 首格，排列顺序不表达重要程度）。每格：图标（小尺度，左上）或图槽（顶部圆角图片块）
 * → 标题 24 → 正文 18，紧凑阅读组顶对齐。卡面/内边距/字号全部来自 ComponentSkin。
 */

import { padFrame, splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import {
  estimateLineHeight,
  estimateLines,
} from "../../text-metrics.js";

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

const DENSITY_PAD: Record<string, number> = { tight: 0.9, normal: 1, airy: 1.12 };

function cardPad(skin: ComponentSkin, frame: Frame): number {
  const m = skin.metrics(frame);
  const scale = DENSITY_PAD[skin.density] ?? 1;
  return Math.max(26, Math.min(36, Math.round(m.pad * scale)));
}

function cardBox(skin: ComponentSkin, frame: Frame, pad: number): Frame {
  const base = skin.contentBox(frame);
  const styled = Math.min(skin.pad, Math.floor(Math.min(frame.w, frame.h) * 0.18));
  const guard = Math.floor(Math.min(base.w, base.h) * 0.06);
  const inset = Math.min(Math.max(0, pad - styled), guard);
  return inset > 0 ? padFrame(base, inset) : base;
}

/** 行规划：wide 独占一行；连续普通格按 3/2 分组，避免落单半行。 */
function planRows(items: BentoItem[]): BentoItem[][] {
  const rows: BentoItem[][] = [];
  let normal: BentoItem[] = [];
  const flush = (count: number) => {
    while (normal.length > 0) {
      // 3 条 → 一行三等分；其余按 2 条成行；4 条 → 2+2。
      const take = normal.length === 3 ? 3 : Math.min(count, normal.length);
      rows.push(normal.slice(0, take));
      normal = normal.slice(take);
    }
  };
  for (const item of items) {
    if (item.wide) {
      flush(2);
      rows.push([item]);
    } else {
      normal.push(item);
    }
  }
  // 收尾：三条整行，四条 2+2，五条 3+2，其余两两成行。
  while (normal.length > 0) {
    const take = normal.length === 3 || normal.length === 5 ? 3 : Math.min(2, normal.length);
    rows.push(normal.slice(0, take));
    normal = normal.slice(take);
  }
  return rows;
}

export function expandBentoGrid(
  items: BentoItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const rows = planRows(items);
  const gutter = Math.max(m.tightGap, Math.round(m.gap * 0.9));
  const rowFrames = splitRows(frame, rows.length, gutter);
  const pad = cardPad(skin, frame);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const iconSize = 40;
  const elements: SpecElement[] = [];

  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    const cells = row.length === 1 ? [rowFrame] : splitColumns(rowFrame, row.length, gutter);
    row.forEach((item, i) => {
      const cell = cells[i]!;
      elements.push(...skin.paint(cell));
      const box = cardBox(skin, cell, pad);
      const innerW = box.w;
      const imgH = item.image ? Math.min(Math.round(box.h * 0.42), Math.max(56, Math.round(box.h * 0.3))) : 0;
      const topH = item.image ? imgH + Math.round(m.tightGap * 1.1) : item.icon ? iconSize + Math.round(m.tightGap * 1.2) : 0;
      // 溢出降档：正文有限缩至 16pt、标题至 20pt（全格同档）。
      const sizePairs: Array<[number, number]> = [[m.title, m.body], [m.title, 16], [20, 16]];
      let titleSize = sizePairs[0]![0]!;
      let bodySize = sizePairs[0]![1]!;
      let titleH = 0;
      let bodyH = 0;
      for (const [tSize, bSize] of sizePairs) {
        titleSize = tSize;
        bodySize = bSize;
        titleH = estimateLines(item.title, tSize, innerW) * estimateLineHeight(tSize) + 8;
        bodyH = item.body ? estimateLines(item.body, bSize, innerW) * estimateLineHeight(bSize) + 4 : 0;
        if (topH + titleH + (item.body ? bodyH + Math.round(m.tightGap * 0.4) : 0) <= box.h) break;
      }
      const need = topH + titleH + (item.body ? bodyH + Math.round(m.tightGap * 0.4) : 0);
      if (need > box.h) {
        bad(`${what}「${item.title.slice(0, 12)}」格内容高约 ${Math.round(need)}px 超过 ${Math.round(box.h)}px——精简正文或减少条目`);
      }

      let y = box.y;
      if (item.image) {
        const radiusAdj = skin.imageRadiusAdj(innerW, imgH);
        elements.push({
          type: "image",
          url: item.image,
          fit: skin.imageFit,
          ...(radiusAdj !== undefined ? { radiusAdj } : {}),
          x: Math.round(box.x),
          y: Math.round(y),
          w: Math.round(innerW),
          h: imgH,
        });
        y += imgH + Math.round(m.tightGap * 1.1);
      } else if (item.icon) {
        elements.push({
          type: "icon",
          icon: item.icon,
          color: skin.colors.emphasis,
          x: Math.round(box.x),
          y: Math.round(y),
          w: iconSize,
          h: iconSize,
        });
        y += iconSize + Math.round(m.tightGap * 1.2);
      }
      // 标题 + 正文：紧凑阅读组顶对齐（wide 条带同样顶对齐，不放图标补空）。
      elements.push(
        textElement({ x: box.x, y: Math.round(y), w: innerW, h: titleH }, [
          { runs: skin.heading(item.title, titleSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
        ]),
      );
      if (item.body) {
        elements.push(
          textElement({ x: box.x, y: Math.round(y + titleH + Math.round(m.tightGap * 0.4)), w: innerW, h: bodyH }, [
            { runs: skin.body(item.body, bodySize, skin.colors.muted), ...(align === "center" ? { align } : {}) },
          ]),
        );
      }
    });
  });
  return elements;
}
