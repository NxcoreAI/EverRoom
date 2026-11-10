/**
 * 预设展开的画布几何：网格框架、n 等分、比例分栏。
 * 口径与 layout 技能文档一致：画布 1280×720，页标题区 y=40~100，
 * 内容区 y=140~680，间距取 4 的倍数，除不尽的余数给最后一格。
 */

import { snap4 } from "./theme.js";

export const CANVAS_W = 1280;
export const CANVAS_H = 720;
export const CONTENT_TOP = 140;
export const CONTENT_BOTTOM = 680;
export const TITLE_Y = 44;
export const TITLE_MAX_BOTTOM = 136;

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 内容区（主元素区）。 */
export function contentFrame(margin: number): Frame {
  return {
    x: margin,
    y: CONTENT_TOP,
    w: CANVAS_W - 2 * margin,
    h: CONTENT_BOTTOM - CONTENT_TOP,
  };
}

/** n 等分横向格子（列），余数给最后一格。 */
export function splitColumns(frame: Frame, count: number, gutter: number): Frame[] {
  if (count < 1) throw new Error("PRESET_INVALID: 等分数必须 ≥1");
  const total = frame.w - (count - 1) * gutter;
  const base = Math.floor(total / count);
  const cells: Frame[] = [];
  let x = frame.x;
  for (let i = 0; i < count; i++) {
    const w = i === count - 1 ? total - base * (count - 1) : base;
    cells.push({ x, y: frame.y, w, h: frame.h });
    x += w + gutter;
  }
  return cells;
}

/** n 等分纵向格子（行）。 */
export function splitRows(frame: Frame, count: number, gutter: number): Frame[] {
  if (count < 1) throw new Error("PRESET_INVALID: 等分数必须 ≥1");
  const total = frame.h - (count - 1) * gutter;
  const base = Math.floor(total / count);
  const cells: Frame[] = [];
  let y = frame.y;
  for (let i = 0; i < count; i++) {
    const h = i === count - 1 ? total - base * (count - 1) : base;
    cells.push({ x: frame.x, y, w: frame.w, h });
    y += h + gutter;
  }
  return cells;
}

/** 「62/38」比例串 → [0.62, 0.38]。 */
export function parseRatio(ratio: string): [number, number] {
  const match = /^(\d{2})\/(\d{2})$/.exec(ratio.trim());
  if (!match) throw new Error(`PRESET_INVALID: 比例档位格式错误（${ratio}），合法值如 50/50、62/38、70/30、38/62`);
  return [Number(match[1]) / 100, Number(match[2]) / 100];
}

/** 按比例把 frame 分成两栏（缝隙 gutter），first 在左。 */
export function splitByRatio(frame: Frame, ratio: string, gutter: number, firstOnLeft = true): [Frame, Frame] {
  const [a, b] = parseRatio(ratio);
  const total = frame.w - gutter;
  const firstW = snap4(Math.round(total * a));
  const secondW = total - firstW;
  if (firstOnLeft) {
    return [
      { x: frame.x, y: frame.y, w: firstW, h: frame.h },
      { x: frame.x + firstW + gutter, y: frame.y, w: secondW, h: frame.h },
    ];
  }
  return [
    { x: frame.x, y: frame.y, w: secondW, h: frame.h },
    { x: frame.x + secondW + gutter, y: frame.y, w: firstW, h: frame.h },
  ];
}

/** 框内收缩 padding。 */
export function padFrame(frame: Frame, padding: number): Frame {
  return {
    x: frame.x + padding,
    y: frame.y + padding,
    w: Math.max(1, frame.w - 2 * padding),
    h: Math.max(1, frame.h - 2 * padding),
  };
}

/** 框顶部取高 h 的条，返回 [条, 剩余]。 */
export function takeTop(frame: Frame, h: number, gap = 0): [Frame, Frame] {
  return [
    { x: frame.x, y: frame.y, w: frame.w, h },
    { x: frame.x, y: frame.y + h + gap, w: frame.w, h: frame.h - h - gap },
  ];
}
