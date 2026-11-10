/**
 * eraRail 组件（editorial）：年代脊线。
 *
 * 无底面语义：默认平铺。整条脊线（2px）+ 每列刻度 + 衬线年代（28–32pt，高亮条
 * 取强调色）+ 静音短注，作为一条水平「时代带」在区域内垂直居中——上下留白对称，
 * 不与页面上其它内容抢位；列间短竖线把带分成均匀列。
 * 脊线走 dividerH（separator 非 line 时脊线与刻度一起收掉），年代字体走 numeral 语义。
 */

import { textElement, type SpecElement } from "../../elements.js";
import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

export interface EraRailItem {
  era: string;
  note: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** 年代字号：按列宽与可用高度自适应，28–32pt 为主体，最紧可降到 18pt。 */
function fitEraSize(era: string, cellW: number, roomH: number, base: number): number {
  for (let size = base; size >= 18; size -= 2) {
    const fitsW = estimateTextWidth(era, size) <= cellW - 24;
    const fitsH = singleLineBoxHeight(size) <= roomH;
    if (fitsW && fitsH) return size;
  }
  bad(`「${era}」年代放不下（每格可用 ${cellW}px）——统一短年代格式（如「2026」「唐代」「1610 年」）`);
}

export function expandEraRail(
  items: EraRailItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  highlight?: number,
): SpecElement[] {
  void theme; // 组件只读 skin
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const railH = Math.max(2, Math.round(m.label * 0.16));
  const tickW = Math.max(3, Math.round(m.label * 0.24));
  const tickH = Math.max(14, Math.round(m.body * 0.95));
  const hotTickH = Math.round(tickH * 1.35);
  const noteSize = Math.max(14, Math.round(m.caption + 2));
  const cellW = box.w / items.length;
  const insetX = Math.round(m.tightGap * 0.8);
  const noteW = Math.max(48, cellW - insetX * 2);
  const noteHs = items.map((item) => textBoxHeight(item.note, noteSize, noteW));
  const maxNoteH = Math.max(...noteHs);
  const railIsLine = skin.dividerH(box, Math.round(box.y)) !== null;
  const baseSize = Math.max(18, Math.min(32, Math.round(m.title * 1.02)));
  const eraGap = Math.round(m.tightGap * 1.9);
  const noteGap = Math.round(m.tightGap * 0.55);
  const tickRoom = Math.max(hotTickH, tickH);
  const roomH = box.h - railH - tickRoom - noteGap - maxNoteH - eraGap;
  const eraSizes = items.map((item) => fitEraSize(item.era, cellW, roomH, baseSize));
  const eraH = singleLineBoxHeight(Math.max(...eraSizes));
  const blockH = railH + tickRoom + eraGap + eraH + noteGap + maxNoteH;
  if (blockH > box.h + 2) {
    bad(`${what} 内容高约 ${Math.round(blockH)}px 超过区域 ${Math.round(box.h)}px——精简短注或加大该子树权重`);
  }
  const bandTop = box.y + Math.max(0, Math.round((box.h - blockH) / 2));
  const railY = bandTop + Math.max(0, Math.round((tickRoom - railH) / 2));
  const eraTop = bandTop + tickRoom + eraGap;
  const noteTop = eraTop + eraH + noteGap;

  // 脊线：2px 墨线横贯（separator 非 line 时不画，刻度也随之收掉）。
  if (railIsLine) {
    elements.push({
      type: "shape",
      shape: "rect",
      fill: skin.colors.text,
      x: Math.round(box.x),
      y: railY,
      w: Math.round(box.w),
      h: railH,
    });
  }

  items.forEach((item, i) => {
    const cellX = Math.round(box.x + cellW * i);
    const hot = highlight === i;
    const eraSize = eraSizes[i]!;
    const eraBoxH = singleLineBoxHeight(eraSize);
    const noteH = noteHs[i]!;
    if (railIsLine) {
      elements.push({
        type: "shape",
        shape: "rect",
        fill: hot ? skin.colors.emphasis : skin.colors.text,
        x: cellX + insetX,
        y: railY,
        w: hot ? tickW + 3 : tickW,
        h: hot ? hotTickH : tickH,
      });
    }
    const eraColor = hot ? skin.colors.emphasis : skin.colors.text;
    const eraRuns = skin.numeralRun(item.era, eraSize, eraColor) ?? skin.heading(item.era, eraSize, eraColor);
    elements.push(
      textElement({ x: cellX + insetX, y: Math.round(eraTop), w: Math.round(cellW - insetX * 2), h: eraBoxH }, [
        { runs: eraRuns, ...(align === "center" ? { align } : {}) },
      ]),
    );
    elements.push(
      textElement({ x: cellX + insetX, y: Math.round(noteTop), w: noteW, h: noteH }, [
        { runs: skin.body(item.note, noteSize, skin.colors.muted), ...(align === "center" ? { align } : {}) },
      ]),
    );
  });
  return elements;
}
