/**
 * venn 组件：双圆主色淡填充 + 主色 1.5px 描边，交叠处自然叠深一档。
 * 视觉：圆直径按短边推到 260–300px（大而稳），两侧标签 24pt 粗体落月牙中心、
 * 交集标签 20pt 强调色落透镜中心；标签按可用宽度自适应缩号，保证不压弧线。
 * 无底面语义：默认平铺，仅 style.surface 显式时铺底。
 */

import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import type { Frame } from "../../grid.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

export interface VennInput {
  a: string;
  b: string;
  both?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** 标签按可用宽度逐档缩号，返回 [字号, 文本宽]。 */
function fitLabel(text: string, size: number, maxW: number): [number, number] {
  let sizePt = size;
  while (sizePt > 14 && estimateTextWidth(text, sizePt) > maxW) sizePt -= 1;
  return [sizePt, Math.min(maxW, Math.round(estimateTextWidth(text, sizePt)))];
}

export function expandVenn(
  input: VennInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "corner")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";

  // 圆直径 260–300：短边驱动，最大 300，最小 180（再小就报缺陷）。
  const diameter = Math.min(420, Math.round(box.h * 0.74), Math.round(box.w * 0.4));
  if (diameter < 180) {
    bad(`${what} 区域过小（${Math.round(box.w)}×${Math.round(box.h)}px）——加大该子树权重`);
  }
  const radius = diameter / 2;
  const lens = Math.round(diameter * 0.44);
  const centerDistance = diameter - lens;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const leftCx = cx - centerDistance / 2;
  const rightCx = cx + centerDistance / 2;

  const sideSize = Math.max(22, Math.min(30, Math.round(m.title)));
  const bothSize = Math.max(17, Math.round(sideSize * 0.8));
  const sideMaxW = Math.max(48, centerDistance - 16);
  const bothMaxW = Math.max(40, lens - 14);
  const [aSize, aW] = fitLabel(input.a, sideSize, sideMaxW);
  const [bSize, bW] = fitLabel(input.b, sideSize, sideMaxW);
  const [bothFitSize, bothW] = input.both
    ? fitLabel(input.both, bothSize, bothMaxW)
    : [bothSize, 0];
  const aH = singleLineBoxHeight(aSize);
  const bH = singleLineBoxHeight(bSize);
  const bothH = singleLineBoxHeight(bothFitSize);

  const circle = (circleCx: number): SpecElement => ({
    type: "shape",
    shape: "ellipse",
    fill: `${skin.colors.primary}1C`,
    stroke: {
      color: isDarkColor(skin.colors.background)
        ? mixHex(skin.colors.primary, skin.colors.text, 0.4)
        : skin.colors.primary,
      widthPt: 2,
    },
    x: Math.round(circleCx - radius),
    y: Math.round(cy - radius),
    w: diameter,
    h: diameter,
  });
  elements.push(circle(leftCx), circle(rightCx));

  const labelBox = (centerX: number, w: number, h: number) => ({
    x: Math.round(centerX - w / 2),
    y: Math.round(cy - h / 2),
    w: Math.round(w),
    h: Math.round(h),
  });
  elements.push(
    textElement(labelBox(cx - radius, aW + 8, aH), [
      { runs: skin.body(input.a, aSize, skin.colors.text, true), align },
    ], "middle"),
  );
  if (input.both !== undefined) {
    // 交集标签垫一块页底色小胶囊：把两条圆弧从字下断开，透镜区读得清。
    const bothBox = labelBox(cx, bothW + 8, bothH);
    elements.push({
      type: "shape", shape: "roundRect", fill: skin.colors.background,
      x: Math.round(bothBox.x - 6), y: Math.round(bothBox.y - 2),
      w: Math.round(bothBox.w + 12), h: Math.round(bothBox.h + 4), adj: 50000,
    });
    elements.push(
      textElement(bothBox, [
        { runs: skin.body(input.both, bothFitSize, skin.colors.emphasis, true), align },
      ], "middle"),
    );
  }
  elements.push(
    textElement(labelBox(cx + radius, bW + 8, bH), [
      { runs: skin.body(input.b, bSize, skin.colors.text, true), align },
    ], "middle"),
  );
  return elements;
}
