/**
 * comparison：多方对照。每方一张卡（风格卡卡面），featured 用浅强调底 + 一条
 * 强调边（不叠顶条/阴影；徽章仅在已有标签文本时显示）；标题起点与首条要点
 * 起点跨列统一，列间不因标签差异错位。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { mixHex } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, estimateTextWidth } from "../../text-metrics.js";

export interface ComparisonPoint {
  text: string;
  mark?: "yes" | "mid" | "no";
}

export interface ComparisonSide {
  title: string;
  tag?: string;
  points: Array<string | ComparisonPoint>;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const MARK_ICONS: Record<"yes" | "mid" | "no", string> = {
  yes: "check-circle",
  mid: "minus",
  no: "x-mark",
};

export function expandComparison(
  sides: ComparisonSide[],
  featured: number | undefined,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const m = skin.metrics(frame);
  const cells = splitColumns(frame, sides.length, m.gap);
  const elements: SpecElement[] = [];
  const titleSize = Math.round(m.title * 0.86);
  const pointSize = m.body;
  const iconSize = Math.max(16, Math.round(pointSize * 0.95));
  // 要点字号统一切档：先 18pt，列高不够整体降到 16pt（全列一致，同级文字不漂移）。
  const renderAt = (size: number, icon: number) => sides.map((side, i) => {
    const cell = cells[i]!;
    const isFeatured = featured === i;
    const box = skin.contentBox(cell);
    const titleH = estimateLines(side.title, titleSize, box.w) * estimateLineHeight(titleSize, 108) + 4;
    const pointsH = side.points.map((point) => {
      const text = typeof point === "string" ? point : point.text;
      return estimateLines(text, size, box.w - icon - 10) * estimateLineHeight(size, 122) + Math.round(m.tightGap * 1.1);
    });
    return { side, cell, isFeatured, box, titleH, pointsH, size, icon };
  });
  // 跨列统一：标签带高度、标题起点、标题高、首条要点起点全部取全组一致值。
  const tagBandH = sides.some((side) => side.tag) ? 30 : 0;
  const titleH = Math.max(...sides.map((side, i) => estimateLines(side.title, titleSize, skin.contentBox(cells[i]!).w) * estimateLineHeight(titleSize, 108) + 4));
  let rendered = renderAt(pointSize, iconSize);
  for (const candidate of [16]) {
    const overflows = (entries: typeof rendered) => entries.some(({ box, titleH: tH, pointsH }) => {
      const tY = box.y + tagBandH + (tagBandH > 0 ? 6 : 12);
      const pTop = tY + tH + Math.round(m.tightGap * 0.8) + Math.round(m.gap * 0.7);
      return pTop + pointsH.reduce((a, b) => a + b, 0) > box.y + box.h + 2;
    });
    if (!overflows(rendered)) break;
    rendered = renderAt(candidate, Math.max(16, Math.round(candidate * 0.95)));
  }
  const pointSizeFinal = rendered[0]!.size;
  const iconSizeFinal = rendered[0]!.icon;
  const titleY = rendered[0]!.box.y + tagBandH + (tagBandH > 0 ? 6 : 12);
  const ruleY = titleY + titleH + Math.round(m.tightGap * 0.8);
  const pointsTop = ruleY + Math.round(m.gap * 0.7);
  rendered.forEach(({ side, cell, isFeatured, box, pointsH }) => {
    if (isFeatured) {
      const radius = Math.min(50000, Math.round((skin.radius / Math.max(1, Math.min(cell.w, cell.h))) * 100000));
      elements.push({
        type: "shape", shape: "roundRect", fill: skin.colors.emphasisSoft,
        stroke: { color: skin.colors.emphasis, widthPt: 1.25 },
        x: Math.round(cell.x), y: Math.round(cell.y), w: Math.round(cell.w), h: Math.round(cell.h),
        ...(radius ? { adj: radius } : {}),
      });
      // 徽章仅在已有标签文本时显示，不自动生成「推荐」文案。
      if (side.tag) {
        const badgeW = Math.max(58, Math.round(estimateTextWidth(side.tag, 10) + 26));
        elements.push({
          type: "shape", shape: "roundRect", fill: skin.colors.emphasis,
          x: Math.round(box.x), y: Math.round(box.y), w: badgeW, h: 26, adj: 50000,
          paragraphs: [{ runs: [{ text: side.tag, sizePt: 10, bold: true, color: skin.colors.inverse }], align: "center" }],
          valign: "middle",
        });
      }
    } else {
      elements.push(...skin.paint(cell));
      if (side.tag) {
        elements.push(
          textElement({ x: box.x, y: box.y, w: box.w, h: 22 }, [
            { runs: [skin.micro(side.tag, skin.colors.emphasis)] },
          ]),
        );
      }
    }
    elements.push(
      textElement({ x: box.x, y: titleY, w: box.w, h: titleH }, [
        { runs: skin.heading(side.title, titleSize, skin.colors.text) },
      ]),
    );
    const rule = skin.dividerH(box, ruleY);
    if (rule) elements.push(rule);
    const sum = pointsH.reduce((a, b) => a + b, 0);
    // 间距压缩档：内容贴近满高时行距降到 0.5 档，避免 2px 级溢出误报。
    const gap = Math.max(Math.round(m.tightGap * 0.5), Math.min(48, Math.round((box.y + box.h - pointsTop - sum) / Math.max(1, pointsH.length))));
    if (pointsTop + sum + gap * Math.max(0, pointsH.length - 1) > box.y + box.h + 2) {
      bad(`${what}「${side.title}」内容高约 ${Math.round(pointsTop + sum - box.y)}px 超过区域 ${Math.round(box.h)}px——精简要点或减少列`);
    }
    let y = pointsTop;
    side.points.forEach((point, j) => {
      const h = pointsH[j]!;
      if (typeof point === "string") {
        elements.push(
          textElement({ x: box.x, y, w: box.w, h }, [
            { runs: skin.body(`—　${point}`, pointSizeFinal, skin.colors.muted) },
          ]),
        );
      } else {
        const markColor = point.mark === "yes"
          ? skin.colors.emphasis
          : point.mark === "no"
            ? mixHex(skin.colors.text, skin.colors.background, 0.55)
            : skin.colors.muted;
        elements.push({
          type: "icon", icon: MARK_ICONS[point.mark ?? "mid"], color: markColor,
          x: Math.round(box.x), y: Math.round(y + 3), w: iconSizeFinal, h: iconSizeFinal,
        });
        elements.push(
          textElement({ x: box.x + iconSizeFinal + 10, y, w: box.w - iconSizeFinal - 10, h }, [
            { runs: skin.body(point.text, pointSizeFinal, skin.colors.text) },
          ]),
        );
      }
      y += h + gap;
    });
  });
  return elements;
}
