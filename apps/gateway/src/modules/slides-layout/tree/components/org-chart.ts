/**
 * orgChart 组件（editorial）：反白墨色根节点 + 浅色描边子卡 + 1.5px 肘形连线。
 * 视觉：根卡 22pt 反白标题压住页面顶部，子卡 20pt 标题铺满下半区，中间留出
 * 一整段连线跑道——两层结构撑满 frame，不再缩在中间一条。
 * connector 保留 elbow|none；surface 显式时才铺底（无底面语义）。
 */

import { splitColumns, type Frame } from "../../grid.js";
import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, textBoxHeight } from "../../text-metrics.js";

export interface OrgNode {
  title: string;
  subtitle?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

function inkHeight(sizePt: number, lines = 1): number {
  return Math.round(estimateLineHeight(Math.max(18, sizePt)) * lines);
}

/** 圆角卡（圆角取风格卡 cornerRadius，随卡尺寸收敛）。 */
function roundedCard(
  frame: Frame,
  fill: string,
  skin: ComponentSkin,
  stroke?: { color: string; widthPt: number },
): SpecElement {
  const radius = Math.max(0, Math.min(skin.radius, Math.floor(Math.min(frame.w, frame.h) / 2)));
  const adj = radius > 0
    ? Math.min(50000, Math.round((radius / Math.max(1, Math.min(frame.w, frame.h))) * 100000))
    : undefined;
  return {
    type: "shape",
    shape: "roundRect",
    fill,
    ...(adj !== undefined ? { adj } : {}),
    ...(stroke ? { stroke } : {}),
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.round(frame.w),
    h: Math.round(frame.h),
  };
}

interface NodeMetrics {
  titleSize: number;
  subSize: number;
  padX: number;
  padY: number;
  gap: number;
}

function nodeHeight(node: OrgNode, width: number, metrics: NodeMetrics): number {
  const innerW = width - 2 * metrics.padX;
  const titleLines = estimateLines(node.title, metrics.titleSize, innerW);
  const subLines = node.subtitle ? estimateLines(node.subtitle, metrics.subSize, innerW) : 0;
  return inkHeight(metrics.titleSize, titleLines)
    + (subLines > 0 ? metrics.gap + inkHeight(metrics.subSize, subLines) : 0)
    + 2 * metrics.padY;
}

function nodeText(
  node: OrgNode,
  frame: Frame,
  metrics: NodeMetrics,
  titleColor: string,
  subColor: string,
  align: "left" | "center",
  skin: ComponentSkin,
): SpecElement[] {
  const innerW = frame.w - 2 * metrics.padX;
  const titleH = textBoxHeight(node.title, metrics.titleSize, innerW);
  const subH = node.subtitle ? textBoxHeight(node.subtitle, metrics.subSize, innerW) : 0;
  const elements: SpecElement[] = [
    textElement({ x: frame.x + metrics.padX, y: frame.y + metrics.padY, w: innerW, h: titleH }, [
      { runs: skin.body(node.title, metrics.titleSize, titleColor, true), align },
    ]),
  ];
  if (node.subtitle) {
    elements.push(
      textElement({ x: frame.x + metrics.padX, y: frame.y + metrics.padY + titleH + metrics.gap, w: innerW, h: subH }, [
        { runs: skin.body(node.subtitle, metrics.subSize, subColor), align },
      ]),
    );
  }
  return elements;
}

function hline(x1: number, x2: number, y: number, color: string): SpecElement {
  return {
    type: "shape",
    shape: "line",
    x: Math.round(Math.min(x1, x2)),
    y: Math.round(y),
    w: Math.round(Math.abs(x2 - x1)),
    h: 1,
    stroke: { color, widthPt: 1.5 },
  };
}

function vline(x: number, y1: number, y2: number, color: string): SpecElement {
  return {
    type: "shape",
    shape: "line",
    x: Math.round(x),
    y: Math.round(Math.min(y1, y2)),
    w: 1,
    h: Math.round(Math.abs(y2 - y1)),
    stroke: { color, widthPt: 1.5 },
  };
}

export function expandOrgChart(
  root: OrgNode,
  children: OrgNode[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  connector: "elbow" | "none" = "elbow",
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "corner")]
    : [];
  const area = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(area);
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";
  const padX = Math.max(16, Math.round(m.pad * 0.8));
  const padY = Math.max(14, Math.round(m.pad * 0.7));
  const textGap = Math.max(4, Math.round(m.tightGap * 0.35));
  const topPad = Math.max(8, Math.round(m.pad * 0.5));

  const rootMetrics: NodeMetrics = {
    titleSize: Math.max(20, Math.min(28, Math.round(m.title * 0.85))),
    subSize: Math.max(13, Math.round(m.body * 0.85)),
    padX, padY, gap: textGap,
  };
  const childMetrics: NodeMetrics = {
    titleSize: Math.max(18, Math.min(24, Math.round(m.title * 0.72))),
    subSize: Math.max(13, Math.round(m.body * 0.85)),
    padX, padY, gap: textGap,
  };

  const rootW = Math.min(Math.round(area.w * 0.38), 440);
  const rootH = nodeHeight(root, rootW, rootMetrics);
  const childCells = splitColumns(area, children.length, m.gap);
  const childH = Math.max(...children.map((child) => nodeHeight(child, childCells[0]!.w, childMetrics)));

  const totalH = rootH + childH + 2 * topPad;
  if (totalH > area.h) {
    bad(`${what} 两层内容高约 ${Math.round(totalH)}px 超过区域 ${Math.round(area.h)}px——精简节点文字或减少子节点`);
  }
  // 根贴上、子卡贴下：中间整段留给肘形连线，两层结构撑满 frame。
  const rootY = Math.round(area.y + topPad);
  const childY = Math.round(area.y + area.h - topPad - childH);
  const runway = childY - (rootY + rootH);
  if (connector !== "none" && runway < 32) {
    bad(`${what} 两层间距过窄（${Math.round(runway)}px）——加大权重或减少子节点`);
  }
  const midY = Math.round(rootY + rootH + runway * 0.42);
  const rootFrame: Frame = { x: area.x + (area.w - rootW) / 2, y: rootY, w: rootW, h: rootH };
  const rootCx = rootFrame.x + rootW / 2;
  const childCenters = childCells.map((cell) => cell.x + cell.w / 2);
  const elbowColor = mixHex(skin.colors.primary, skin.colors.text, 0.3);

  elements.push(roundedCard(rootFrame, skin.colors.text, skin));
  elements.push(...nodeText(root, rootFrame, rootMetrics, skin.colors.inkText,
    mixHex(skin.colors.inkText, skin.colors.text, 0.32), align, skin));

  if (connector === "elbow") {
    elements.push(vline(rootCx, rootY + rootH, midY, elbowColor));
    elements.push(hline(childCenters[0]!, childCenters[childCenters.length - 1]!, midY, elbowColor));
    children.forEach((_, index) => {
      elements.push(vline(childCenters[index]!, midY, childY, elbowColor));
    });
    // 连接点小圆点：强调色落在每个子卡正上方的分叉处。
    children.forEach((_, index) => {
      const dot = 6;
      elements.push({
        type: "shape", shape: "ellipse", fill: skin.colors.emphasis,
        x: Math.round(childCenters[index]! - dot / 2), y: Math.round(midY - dot / 2), w: dot, h: dot,
      });
    });
  }

  const childFill = skin.colors.tint;
  const childStroke = { color: mixHex(skin.colors.primary, skin.colors.background, 0.72), widthPt: 1.2 };
  const childTitleColor = isDarkColor(childFill) ? skin.colors.inverse : skin.colors.text;
  const childSubColor = isDarkColor(childFill) ? mixHex(skin.colors.inverse, childFill, 0.25) : skin.colors.muted;
  children.forEach((child, index) => {
    const cell = childCells[index]!;
    const childFrame: Frame = { x: cell.x, y: childY, w: cell.w, h: childH };
    elements.push(roundedCard(childFrame, childFill, skin, childStroke));
    elements.push(...nodeText(child, childFrame, childMetrics, childTitleColor, childSubColor, align, skin));
  });
  return elements;
}
