/**
 * layeredStack 组件（editorial）：分层规格单。
 *
 * 卡片语义：每条目一张行带（skin.paint + contentBox），行间留缝不叠圆角；
 * 行内左：衬线大序号（强调色）+ 标题 24；右：说明 16（静音），行带内垂直居中。
 * 无底面语义（surface:none）时退化为平铺行 + 行顶/收尾发丝线。
 */

import { padFrame, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

export interface LayerItem {
  title: string;
  text?: string;
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

const pad2 = (n: number): string => String(n).padStart(2, "0");

export function expandLayeredStack(
  items: LayerItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const elements: SpecElement[] = [];
  const flat = skin.surface === "none";
  const gutter = flat ? 0 : Math.max(8, Math.round(m.tightGap * 0.9));
  const rows = splitRows(frame, items.length, gutter);
  const pad = cardPad(skin, frame);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const titleSize = Math.min(26, Math.max(22, Math.round(m.title * 0.86)));
  const textSize = Math.max(16, m.body - 1);
  const serialBase = Math.max(28, Math.min(40, Math.round(m.serial * 0.92)));

  rows.forEach((row, i) => {
    const item = items[i]!;
    if (flat) {
      const line = skin.dividerH(frame, Math.round(row.y));
      if (line) elements.push(line);
      if (i === rows.length - 1) {
        const bottom = skin.dividerH(frame, Math.round(row.y + row.h - 1));
        if (bottom) elements.push(bottom);
      }
    } else {
      elements.push(...skin.paint(row));
    }
    const box = flat ? padFrame(row, Math.min(pad, Math.floor(Math.min(row.w, row.h) * 0.16))) : cardBox(skin, row, pad);
    const serialSize = Math.max(20, Math.min(serialBase, Math.floor(box.h / 2.6)));
    const serialW = Math.max(40, Math.round(estimateTextWidth("00", serialSize) + m.tightGap * 0.9));
    const titleW = Math.min(Math.round(box.w * 0.3), 260);
    const textX = box.x + serialW + titleW + Math.round(m.tightGap * 0.9);
    const textW = Math.max(80, box.w - serialW - titleW - Math.round(m.tightGap * 0.9));
    const titleH = estimateLines(item.title, titleSize, titleW) * estimateLineHeight(titleSize) + 8;
    const textH = item.text
      ? estimateLines(item.text, textSize, textW) * estimateLineHeight(textSize) + 4
      : 0;
    const contentH = Math.max(titleH, textH);
    if (contentH > box.h) {
      bad(`${what} 第 ${i + 1} 层「${item.title}」内容高约 ${Math.round(contentH)}px 超过 ${Math.round(box.h)}px——精简文字或减少层级`);
    }
    // 行带内垂直居中：序号/标题/说明同一条中线，行带不「上不沾天下不着地」。
    const textY = box.y + Math.round((box.h - contentH) / 2);
    const serialRuns = skin.numeralRun(pad2(i + 1), serialSize, skin.colors.emphasis, false)
      ?? skin.body(pad2(i + 1), serialSize, skin.colors.emphasis, true);
    elements.push(
      textElement(
        { x: box.x, y: Math.round(textY + (contentH - singleLineBoxHeight(serialSize)) / 2), w: serialW - Math.round(m.tightGap * 0.5), h: singleLineBoxHeight(serialSize) },
        [{ runs: serialRuns }],
      ),
    );
    elements.push(
      textElement({ x: box.x + serialW, y: Math.round(textY), w: titleW, h: titleH }, [
        { runs: skin.heading(item.title, titleSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement({ x: textX, y: Math.round(textY), w: textW, h: textH }, [
          { runs: skin.body(item.text, textSize, skin.colors.muted), ...(align === "center" ? { align } : {}) },
        ]),
      );
    }
  });
  return elements;
}
