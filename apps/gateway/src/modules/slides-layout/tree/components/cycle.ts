/**
 * cycle 组件：大环 + 编号节点 + 环外标签。默认 marker=number：强调色圆形节点
 * 直径 ~40px、内嵌反白衬线序号；marker=dot 时退化为强调色实心圆点。
 *
 * 环半径按「节点半径 + 标签外接框」在四个方向上的可用空间反推，环尽量大而
 * 标签落在环外；节点标题 22pt 粗体。环用主色压暗 2px，节点用强调色。
 * 无底面语义：默认平铺，仅 style.surface 显式时铺底。
 */

import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import type { Frame } from "../../grid.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

export interface CycleItem {
  title: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const NO_FILL = "#00000000";

export function expandCycle(
  items: CycleItem[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  marker: "dot" | "number" = "number",
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "field")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const n = items.length;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  const labelSize = Math.max(22, Math.min(28, Math.round(m.title * 0.85)));
  const labelH = singleLineBoxHeight(labelSize);
  const labelW = Math.max(
    120,
    Math.min(240, Math.max(...items.map((item) => Math.round(estimateTextWidth(item.title, labelSize)))) + 20),
  );
  const useNumber = marker === "number" && skin.numeral !== "none";
  // 编号节点 36–40px（按 frame 高推导），圆点 14px。
  const badgeD = Math.max(28, Math.min(44, Math.round(m.serial)));
  const markerD = useNumber ? badgeD : 14;
  const markerGap = Math.max(10, Math.round(m.tightGap * 0.7));

  // 每个方向上「节点中心 → 标签外接框边缘」的距离。
  const labelOffsetAt = (angle: number): number =>
    markerD / 2 + markerGap + (Math.abs(Math.cos(angle)) * labelW + Math.abs(Math.sin(angle)) * labelH) / 2;
  // 环半径取所有节点在水平/垂直方向都不越界的最大值。
  let ringR = Math.min(box.w, box.h) * 0.44;
  items.forEach((_, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
    const sin = Math.abs(Math.sin(angle));
    const cos = Math.abs(Math.cos(angle));
    const off = labelOffsetAt(angle);
    const pad = 6;
    if (sin > 1e-3) {
      ringR = Math.min(ringR, (box.h / 2 - pad - labelH / 2) / sin - off);
    }
    if (cos > 1e-3) {
      ringR = Math.min(ringR, (box.w / 2 - pad - labelW / 2) / cos - off);
    }
  });
  if (ringR < 56) {
    bad(`${what} 区域过小（${Math.round(box.w)}×${Math.round(box.h)}px）装不下 ${n} 个节点——加大权重或减少节点`);
  }

  // 环：主色压暗的 2px 细环，与强调色节点形成双层结构。
  const ringColor = mixHex(skin.colors.primary, skin.colors.text, 0.32);
  elements.push({
    type: "shape",
    shape: "ellipse",
    fill: NO_FILL,
    stroke: { color: ringColor, widthPt: 2 },
    x: Math.round(cx - ringR),
    y: Math.round(cy - ringR),
    w: Math.round(ringR * 2),
    h: Math.round(ringR * 2),
  });

  const align = skin.alignExplicit ? skin.paragraphAlign : "center";
  // 反白/正字随强调底色明度：浅底用「与页底反相」的深墨，深色页也不会浅上浅。
  const strongInk = isDarkColor(skin.colors.background) ? skin.colors.inkText : skin.colors.text;
  const numeralColor = isDarkColor(skin.colors.emphasis) ? skin.colors.inverse : strongInk;
  items.forEach((item, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
    const nx = cx + Math.cos(angle) * ringR;
    const ny = cy + Math.sin(angle) * ringR;
    // 标记
    const markerFrame = {
      x: Math.round(nx - markerD / 2),
      y: Math.round(ny - markerD / 2),
      w: Math.round(markerD),
      h: Math.round(markerD),
    };
    if (useNumber) {
      const runs = skin.numeralRun(
        String(index + 1),
        Math.max(12, Math.round(markerD * 0.52)),
        numeralColor,
      );
      elements.push({
        type: "shape",
        shape: "ellipse",
        fill: skin.colors.emphasis,
        ...markerFrame,
        ...(runs ? { paragraphs: [{ runs, align: "center" as const }], valign: "middle" as const } : {}),
      });
    } else {
      elements.push({ type: "shape", shape: "ellipse", fill: skin.colors.emphasis, ...markerFrame });
    }
    // 标签：沿半径外推，落在环外；再夹回框内防越界。
    const offset = labelOffsetAt(angle);
    const lx = cx + Math.cos(angle) * (ringR + offset);
    const ly = cy + Math.sin(angle) * (ringR + offset);
    const labelX = Math.min(Math.max(lx - labelW / 2, box.x), box.x + box.w - labelW);
    const labelY = Math.min(Math.max(ly - labelH / 2, box.y), box.y + box.h - labelH);
    elements.push(
      textElement({ x: Math.round(labelX), y: Math.round(labelY), w: labelW, h: labelH }, [
        { runs: skin.body(item.title, labelSize, skin.colors.text, true), align },
      ], "middle"),
    );
  });
  return elements;
}
