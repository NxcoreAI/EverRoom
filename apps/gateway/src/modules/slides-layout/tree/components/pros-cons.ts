/**
 * prosCons 组件（editorial）：利弊两栏对照。
 *
 * 无底面语义：默认平铺（只在 agent 显式写 style.surface 时铺底）。每栏 = 强调刻标
 * + 图标 + 标题（title 档）+ 2px 表头线，条目 18pt 带图标与行间发丝线，竖向均分
 * 铺到栏底；两栏之间一条全高竖线。优势列墨色、风险列静音灰。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, singleLineBoxHeight } from "../../text-metrics.js";

export interface ProsConsInput {
  pros: string[];
  cons: string[];
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function expandProsCons(
  input: ProsConsInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const gutter = Math.max(m.gap, Math.round(m.gap * 1.4));
  const cols = splitColumns(box, 2, gutter);
  const titleSize = Math.min(30, Math.max(26, Math.round(m.title * 0.94)));
  const itemSize = Math.max(18, m.body);
  const iconSize = Math.max(20, Math.round(m.body * 1.1));
  const badgeD = Math.max(40, Math.min(56, Math.round(m.body * 2.7)));
  const headRuleH = Math.max(2, Math.round(m.label * 0.16));

  const sides = ([
    ["pros", input.pros, "check", "优势", skin.colors.emphasis, skin.colors.text],
    ["cons", input.cons, "x-mark", "风险", skin.colors.muted, skin.colors.muted],
  ] as const).map(([key, list, icon, label, markColor, ink], i) => {
    const col = cols[i]!;
    const titleH = singleLineBoxHeight(titleSize);
    const headH = Math.max(titleH, badgeD);
    const headTop = col.y;
    const headRuleY = headTop + headH + Math.round(m.tightGap * 0.7);
    const itemsTop = headRuleY + headRuleH + Math.round(m.tightGap * 0.9);
    const textW = col.w - iconSize - Math.round(m.tightGap * 0.8);
    const textHs = list.map((point) => estimateLines(point, itemSize, textW) * estimateLineHeight(itemSize));
    const avail = box.y + box.h - itemsTop;
    const rowH = Math.floor(avail / Math.max(1, list.length));
    const over = textHs.find((h) => h > rowH + 2);
    if (over !== undefined) {
      bad(`${what} ${label}栏条目行高 ${rowH}px 装不下正文（需 ${Math.round(over)}px）——精简${key === "pros" ? "优势" : "风险"}条目`);
    }
    return { key, list, icon, label, markColor, ink, col, headTop, headH, titleH, headRuleY, itemsTop, textW, textHs, rowH, avail };
  });

  // 中央全高竖线：两栏结构件（separator 非 line 时自动消失）。
  const divider = skin.dividerV(box, Math.round(box.x + box.w / 2), Math.round(box.y), Math.round(box.h));
  if (divider) elements.push(divider);

  sides.forEach(({ list, icon, label, markColor, ink, col, headTop, headH, titleH, headRuleY, itemsTop, textW, textHs, rowH }) => {
    // 表头：色调圆形图标徽章 + 标题（图标徽章比裸图标更像「栏目」，不是散点）
    elements.push({
      type: "shape",
      shape: "ellipse",
      fill: skin.colors.tint,
      x: Math.round(col.x),
      y: Math.round(headTop + (headH - badgeD) / 2),
      w: badgeD,
      h: badgeD,
    });
    elements.push({
      type: "icon",
      icon,
      color: markColor,
      x: Math.round(col.x + (badgeD - iconSize * 0.9) / 2),
      y: Math.round(headTop + (headH - iconSize * 0.9) / 2),
      w: Math.round(iconSize * 0.9),
      h: Math.round(iconSize * 0.9),
    });
    const labelX = Math.round(col.x + badgeD + Math.round(m.tightGap * 1.2));
    const countW = Math.round(titleSize * 1.4);
    const labelW = Math.max(40, col.x + col.w - countW - Math.round(m.tightGap * 0.6) - labelX);
    elements.push(
      textElement({ x: labelX, y: headTop, w: labelW, h: titleH }, [
        { runs: skin.heading(label, titleSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
      ]),
    );
    // 表头右侧条目数（标本卡式索引，给栏头一个右端点）
    const countRuns = skin.numeralRun(pad2(list.length), Math.max(20, Math.round(titleSize * 0.72)), skin.colors.divider, false);
    if (countRuns) {
      elements.push(
        textElement({ x: Math.round(col.x + col.w - countW), y: headTop, w: countW, h: titleH }, [
          { runs: countRuns, align: "right" },
        ]),
      );
    }
    // 2px 表头线（列宽）
    elements.push({
      type: "shape",
      shape: "rect",
      fill: skin.colors.divider,
      x: Math.round(col.x),
      y: Math.round(headRuleY),
      w: Math.round(col.w),
      h: headRuleH,
    });

    // 条目：每行均分栏底高度，正文与图标在行内垂直居中，行间发丝线。
    list.forEach((point, j) => {
      const h = textHs[j]!;
      const rowY = itemsTop + rowH * j;
      const textY = rowY + Math.round((rowH - h) / 2);
      elements.push({
        type: "icon",
        icon,
        color: markColor,
        x: Math.round(col.x),
        y: Math.round(textY + (estimateLineHeight(itemSize) - iconSize) / 2),
        w: iconSize,
        h: iconSize,
      });
      elements.push(
        textElement({ x: Math.round(col.x + iconSize + Math.round(m.tightGap * 0.8)), y: Math.round(textY), w: textW, h }, [
          { runs: skin.body(point, itemSize, ink), ...(align === "center" ? { align } : {}) },
        ]),
      );
      if (j < list.length - 1) {
        const line = skin.dividerH(col, Math.round(rowY + rowH));
        if (line) elements.push(line);
      }
    });
    // 栏底收尾线：与表头线同宽的 1px 发丝线，压住两栏的竖向节奏。
    const bottomRule = skin.dividerH(col, Math.round(box.y + box.h - 1));
    if (bottomRule) elements.push(bottomRule);
  });
  return elements;
}
