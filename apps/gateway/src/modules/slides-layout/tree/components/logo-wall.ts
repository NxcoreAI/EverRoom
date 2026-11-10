/**
 * logoWall 组件（editorial）：客户字标墙。
 *
 * 版式：卡面内均匀网格（2 行），字标 26–28pt + 字距 2.4pt、静音色；图片字标
 * contain 完整呈现（monochrome 时灰度）；格间发丝线（竖线 + 行线）把「墙」的
 * 网格秩序画出来，而不是让字标漂在大片空白里。卡面/网格线来自 ComponentSkin。
 */

import { padFrame, splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth } from "../../text-metrics.js";

export interface LogoSlot {
  /** 图标直链；给图时 contain 完整呈现（monochrome 时灰度）。 */
  image?: string;
  /** 文字字标；与 image 二选一。 */
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

export function expandLogoWall(
  slots: LogoSlot[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  monochrome = true,
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const elements: SpecElement[] = [...skin.paint(frame)];
  if (skin.surface !== "none") elements.push(...skin.motifDecor(frame, "top"));
  const pad = cardPad(skin, frame);
  const box = cardBox(skin, frame, pad);
  const n = slots.length;
  const rowCount = n <= 3 ? 1 : n <= 6 ? 2 : 2;
  const perRow = Math.ceil(n / rowCount);
  const rows: LogoSlot[][] = [];
  for (let i = 0; i < n; i += perRow) rows.push(slots.slice(i, i + perRow));
  const rowFrames = splitRows(box, rows.length, 0);
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";
  const markSize = Math.max(26, Math.min(28, Math.round(m.title * 0.93)));
  const tracking = Math.max(1.6, Math.round(markSize * 0.086));

  // 网格线：行间一条横线，列间全高竖线（separator 非 line 时自动消失）。
  rows.forEach((_, r) => {
    if (r > 0) {
      const line = skin.dividerH(box, Math.round(rowFrames[r]!.y));
      if (line) elements.push(line);
    }
  });
  const colCount = Math.max(...rows.map((row) => row.length));
  for (let c = 1; c < colCount; c++) {
    const line = skin.dividerV(box, Math.round(box.x + (box.w * c) / colCount), Math.round(box.y), Math.round(box.h));
    if (line) elements.push(line);
  }

  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    const cells = splitColumns(rowFrame, row.length, 0);
    const imgH = Math.round(Math.min(72, rowFrame.h * 0.42));
    row.forEach((slot, i) => {
      const cell = cells[i]!;
      if (slot.image) {
        // contain 完整呈现；灰度由 monochrome 变体决定（false = 保留原色）。
        const w = Math.round(cell.w * 0.52);
        const h = Math.max(28, imgH);
        elements.push({
          type: "image",
          url: slot.image,
          fit: "contain",
          ...(monochrome ? { grayscale: true } : {}),
          x: Math.round(cell.x + (cell.w - w) / 2),
          y: Math.round(cell.y + (cell.h - h) / 2),
          w,
          h,
        });
      } else if (slot.text) {
        const text = slot.text;
        // 字标框给足宽度（引擎实测字宽比估算宽 10~20%，字距另算），避免换行；
        // 放不下时先降字号，仍放不下报错。
        const boxW = Math.round(cell.w - m.tightGap * 2);
        const widthAt = (size: number) => estimateTextWidth(text, size) * 1.2 + text.length * tracking;
        let size = markSize;
        while (widthAt(size) > boxW && size > 18) size -= 1;
        if (widthAt(size) > boxW) {
          bad(`${what} 字标「${text}」超宽（每格可用 ${Math.round(boxW)}px）——缩短字标`);
        }
        const run = { ...skin.heading(text, size, skin.colors.muted)[0]!, letterSpacing: tracking };
        const lineH = Math.round(size * 1.35);
        elements.push(
          textElement(
            { x: Math.round(cell.x + m.tightGap), y: Math.round(cell.y + (cell.h - lineH) / 2), w: boxW, h: lineH },
            [{ runs: [run], align }],
          ),
        );
      } else {
        bad(`${what} 第 ${r * perRow + i + 1} 个位置缺 image 或 text`);
      }
    });
  });
  return elements;
}
