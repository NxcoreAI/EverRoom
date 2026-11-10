/**
 * chevron 组件：实心箭头链条，默认 filled（主色实填 + 反白字），不再默认 1px 空心。
 * form 保留三态：outline=透明填充 + 墨色描边（旧观感）；filled=主色实填；tint=浅色实填。
 *
 * 几何：箭头高度约 frame 的 60%，尖深 = 高度/2（OOXML chevron 顶点深度 = min(w,h)/2）；
 * 相邻形状之间留 TIP_GAP 的页底斜缝，让「箭头咬合」在实心填充下依然可辨。
 * 文字按斜边安全区反推宽度：文本块高 L 时可用宽 ≈ 段宽 − L/2（斜边收口），
 * 因此标题字号 22pt 起、正文 14pt，文字居中落在箭身里而不是压棱线。
 * 无底面语义：默认平铺，仅 style.surface 显式时铺底。
 */

import type { Frame } from "../../grid.js";
import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, textBoxHeight } from "../../text-metrics.js";

export interface ChevronItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const NO_FILL = "#00000000";
/** 形状之间的页底斜缝（px）：实心链上让每段的箭尖可见。 */
const TIP_GAP = 6;

function inkHeight(sizePt: number, lines = 1): number {
  return Math.round(estimateLineHeight(Math.max(18, sizePt)) * lines);
}

export function expandChevron(
  items: ChevronItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  form: "outline" | "filled" | "tint" = "filled",
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const titleSize = Math.max(20, Math.min(28, Math.round(m.title * 0.85)));
  const bodySize = Math.max(14, Math.round(m.body * 0.9));
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";

  // 高度 ~60% frame；窄区域退让到可读比例（尖深不能吃掉全部段宽）。
  let shapeH = Math.max(140, Math.round(box.h * 0.6));
  let tip = Math.round(shapeH / 2);
  let step = Math.floor((box.w - tip) / items.length);
  while (step < 118 && shapeH > 84) {
    shapeH = Math.round(shapeH * 0.82);
    tip = Math.round(shapeH / 2);
    step = Math.floor((box.w - tip) / items.length);
  }
  if (step < 56 || step <= TIP_GAP) {
    bad(`${what} 区域过窄（宽 ${Math.round(box.w)}px）装不下 ${items.length} 段箭头——减少段数或加大权重`);
  }
  const shapeW = step + tip - TIP_GAP;
  const y0 = Math.round(box.y + (box.h - shapeH) / 2);

  // 深色页上主色贴着深底会发闷：向页面墨色提亮一档，保证箭头与页底仍有对比。
  const darkPage = isDarkColor(skin.colors.background);
  const strongInk = darkPage ? skin.colors.inkText : skin.colors.text;
  const solid = darkPage ? mixHex(skin.colors.primary, skin.colors.text, 0.32) : skin.colors.primary;
  const fill = form === "filled" ? solid : form === "tint" ? skin.colors.emphasisSoft : NO_FILL;
  const darkFill = form !== "outline" && isDarkColor(fill);
  const titleColor = form === "outline"
    ? skin.colors.text
    : darkFill ? skin.colors.inverse : strongInk;
  const bodyColor = form === "outline"
    ? skin.colors.muted
    : darkFill ? mixHex(skin.colors.inverse, fill, 0.2) : mixHex(strongInk, fill, 0.3);

  items.forEach((item, index) => {
    const x = Math.round(box.x + index * step);
    const isHome = index === 0;
    elements.push({
      type: "shape",
      shape: isHome ? "homePlate" : "chevron",
      fill,
      ...(form === "outline" ? { stroke: { color: skin.colors.text, widthPt: 1.25 } } : {}),
      x,
      y: y0,
      w: Math.round(shapeW),
      h: shapeH,
    });

    // 文本块高度决定斜边安全宽：L 高文本块可用宽 ≈ 段宽 − L/2。
    let textW = Math.max(64, Math.round(step * 0.74));
    let titleInk = inkHeight(titleSize, estimateLines(item.title, titleSize, textW));
    let bodyInk = item.text ? inkHeight(bodySize, estimateLines(item.text, bodySize, textW)) : 0;
    let need = titleInk + (bodyInk ? Math.round(m.tightGap * 0.5) + bodyInk : 0);
    for (let pass = 0; pass < 4; pass += 1) {
      const safeW = Math.floor((isHome ? step + tip : step) - need / 2 - 24);
      if (safeW >= textW) break;
      textW = Math.max(56, safeW);
      titleInk = inkHeight(titleSize, estimateLines(item.title, titleSize, textW));
      bodyInk = item.text ? inkHeight(bodySize, estimateLines(item.text, bodySize, textW)) : 0;
      need = titleInk + (bodyInk ? Math.round(m.tightGap * 0.5) + bodyInk : 0);
    }
    if (need > shapeH - 16) {
      bad(`${what} 第 ${index + 1} 段「${item.title}」内容高约 ${Math.round(need)}px 超过箭头 ${shapeH}px——精简文字`);
    }
    // 安全区 = [左斜边/凹口, 右斜边收口]；文字落在箭身中心。
    const leftEdge = isHome ? x : x + tip;
    const rightEdge = x + shapeW - Math.round(need / 2);
    const textX = Math.round((leftEdge + rightEdge) / 2 - textW / 2);
    const blockTop = Math.round(y0 + (shapeH - need) / 2);
    elements.push(
      textElement({ x: textX, y: blockTop, w: textW, h: textBoxHeight(item.title, titleSize, textW) }, [
        { runs: skin.heading(item.title, titleSize, titleColor), align },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement(
          { x: textX, y: blockTop + titleInk + Math.round(m.tightGap * 0.5), w: textW, h: textBoxHeight(item.text, bodySize, textW) },
          [{ runs: skin.body(item.text, bodySize, bodyColor), align }],
        ),
      );
    }
  });
  return elements;
}
