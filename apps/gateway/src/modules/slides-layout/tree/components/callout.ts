/**
 * calloutBox：单点强调。强调色竖条 + 图标 + 一句结论；默认浅色面板，字号随 frame 放大。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export interface CalloutInput {
  text: string;
  icon?: string;
  form?: "bar" | "panel" | "tint";
}

export function expandCallout(
  leaf: CalloutInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  formOverride?: "bar" | "panel" | "tint",
): SpecElement[] {
  void theme;
  const form = formOverride ?? leaf.form ?? "bar";
  const m = skin.metrics(frame);
  const elements: SpecElement[] = [];
  const radius = Math.min(50000, Math.round((skin.radius / Math.max(1, Math.min(frame.w, frame.h))) * 100000));
  if (form === "panel") {
    elements.push(...skin.paint(frame));
  } else if (form === "tint" || form === "bar") {
    elements.push({
      type: "shape", shape: "roundRect", fill: skin.colors.emphasisSoft,
      x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h),
      ...(radius ? { adj: radius } : {}),
    });
  }
  if (form !== "panel") {
    elements.push({
      type: "shape", shape: "rect", fill: skin.colors.emphasis,
      x: Math.round(frame.x), y: Math.round(frame.y), w: 6, h: Math.round(frame.h),
    });
  }
  const base = skin.contentBox(frame);
  const padX = Math.round(frame.w * 0.05);
  const box: Frame = {
    x: base.x + padX,
    y: base.y + Math.round(frame.h * 0.04),
    w: Math.max(1, base.w - padX * 2),
    h: Math.max(1, base.h - Math.round(frame.h * 0.08)),
  };
  const iconSize = Math.max(36, Math.round(m.title * 1.4));
  const iconBlock = leaf.icon ? iconSize + Math.round(m.gap * 0.7) : 0;
  const textW = Math.min(box.w, Math.round(frame.w * 0.78));
  // 结论句字号 29pt 起，溢出优先收缩（标题类下限 20pt），仍不够才报错。
  let textSize = Math.min(Math.round(m.title * 1.22), 40);
  let lines = estimateLines(leaf.text, textSize, textW);
  let textH = lines * estimateLineHeight(textSize, 120) + 4;
  while (textSize > 20 && iconBlock + textH > box.h + 2) {
    textSize -= 2;
    lines = estimateLines(leaf.text, textSize, textW);
    textH = lines * estimateLineHeight(textSize, 120) + 4;
  }
  const total = iconBlock + textH;
  if (total > box.h + 2) {
    bad(`${what} 内容高约 ${Math.round(total)}px 超过 ${Math.round(box.h)}px——精简文字或加大该子树权重`);
  }
  const top = box.y + Math.max(0, (box.h - total) / 2);
  if (leaf.icon) {
    elements.push({
      type: "icon", icon: leaf.icon, color: skin.colors.emphasis,
      x: Math.round(box.x + (box.w - iconSize) / 2), y: Math.round(top), w: iconSize, h: iconSize,
    });
  }
  elements.push(
    textElement(
      { x: box.x + Math.round((box.w - textW) / 2), y: top + iconBlock, w: textW, h: textH },
      [{ runs: skin.body(leaf.text, textSize, skin.colors.text, true), align: "center", lineSpacingPct: 120 }],
      "middle",
    ),
  );
  return elements;
}
