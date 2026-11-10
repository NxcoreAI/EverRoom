/**
 * funnel 组件：实心收窄条，默认 filled（主色明度渐隐 + 反白字），不再默认墨色空心。
 * form 保留三态：outline=透明 + 墨色描边；filled=主色明度渐隐；tint=强调浅档。
 *
 * 版面：首级占满 frame 宽度、逐级线性收窄到 42%；条高均分且足够厚（行距压到
 * 一笔细缝），阶段名 24pt、数值 15pt 上下成组居中，条不再像细线。
 * 无底面语义：默认平铺，仅 style.surface 显式时铺底。
 */

import { splitRows, type Frame } from "../../grid.js";
import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateTextWidth } from "../../text-metrics.js";

export interface FunnelItem {
  stage: string;
  value?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const NO_FILL = "#00000000";

function inkHeight(sizePt: number): number {
  return Math.round(estimateLineHeight(Math.max(18, sizePt)));
}

export function expandFunnel(
  items: FunnelItem[],
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
  const n = items.length;
  const rowGap = Math.max(4, Math.round(m.tightGap * 0.45));
  const rows = splitRows(box, n, rowGap);
  const darkPage = isDarkColor(skin.colors.background);
  const strongInk = darkPage ? skin.colors.inkText : skin.colors.text;
  const solid = darkPage ? mixHex(skin.colors.primary, skin.colors.text, 0.32) : skin.colors.primary;
  const rampTarget = darkPage ? skin.colors.text : skin.colors.background;
  const stageBase = Math.max(22, Math.min(30, Math.round(m.title * 0.92)));
  const valueBase = Math.max(15, Math.round(m.body * 0.95));
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";

  items.forEach((item, index) => {
    const row = rows[index]!;
    const ratio = 1 - 0.58 * (index / Math.max(1, n - 1));
    const barW = Math.max(80, Math.round(row.w * ratio));
    const x = Math.round(row.x + (row.w - barW) / 2);
    const fill = form === "filled"
      ? mixHex(solid, rampTarget, 0.04 + 0.33 * (index / Math.max(1, n - 1)))
      : form === "tint" ? skin.colors.emphasisSoft : NO_FILL;
    const darkFill = form !== "outline" && isDarkColor(fill);
    const stageColor = form === "outline"
      ? skin.colors.text
      : darkFill ? skin.colors.inverse : strongInk;
    const valueColor = form === "outline"
      ? skin.colors.muted
      : darkFill ? mixHex(skin.colors.inverse, fill, 0.18) : mixHex(strongInk, fill, 0.3);

    // 窄条上逐级缩号，保证阶段名不横向冲出条宽（窄区域也不出现「字比条宽」）。
    const innerW = Math.max(40, barW - 2 * Math.max(12, Math.round(m.pad * 0.5)));
    let stageSize = stageBase;
    while (stageSize > 16 && estimateTextWidth(item.stage, stageSize) > innerW) stageSize -= 1;
    let valueSize = valueBase;
    if (item.value) {
      while (valueSize > 12 && estimateTextWidth(item.value, valueSize) > innerW) valueSize -= 1;
    }
    const stageInk = inkHeight(stageSize);
    const valueInk = item.value ? inkHeight(valueSize) : 0;
    const gap = Math.max(2, Math.round(m.tightGap * 0.25));
    const need = stageInk + (valueInk ? gap + valueInk : 0);
    if (need > row.h - 6) {
      bad(`${what} 第 ${index + 1} 级「${item.stage}」内容高约 ${Math.round(need)}px 超过条高 ${Math.round(row.h)}px——精简文字或减少级数`);
    }
    elements.push({
      type: "shape",
      shape: "rect",
      fill,
      ...(form === "outline" ? { stroke: { color: skin.colors.text, widthPt: 1.25 } } : {}),
      x,
      y: Math.round(row.y),
      w: barW,
      h: Math.round(row.h),
    });
    const blockTop = Math.round(row.y + (row.h - need) / 2);
    elements.push(
      textElement({ x: x + Math.round((barW - innerW) / 2), y: blockTop, w: innerW, h: stageInk }, [
        { runs: skin.heading(item.stage, stageSize, stageColor), align },
      ]),
    );
    if (item.value) {
      elements.push(
        textElement({ x: x + Math.round((barW - innerW) / 2), y: blockTop + stageInk + gap, w: innerW, h: valueInk }, [
          { runs: skin.body(item.value, valueSize, valueColor), align },
        ]),
      );
    }
  });
  return elements;
}
