/**
 * pyramid 组件：实心能力金字塔，默认 filled（主色明度渐变：顶深底浅 + 反白字）。
 * form 保留三态：outline=透明 + 墨色描边；filled=主色明度渐变；tint=强调浅档。
 *
 * 几何：真金字塔切片——用 path 画每层的梯形（顶点在 frame 顶部中线、底边占满
 * frame 宽度），层与层之间留细缝，侧边斜率连续；每层文字按「该层中线高度处的
 * 层宽」反推可用宽度，短标题居中落在层里，不会压到斜边。
 * 引擎 path 上限 4：层数 ≤4 走真切片，5 层退化为梯形堆叠（同色阶）。
 * 无底面语义：默认平铺，仅 style.surface 显式时铺底。
 */

import { splitRows, type Frame } from "../../grid.js";
import { isDarkColor, mixHex, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, textBoxHeight } from "../../text-metrics.js";

export interface TierItem {
  title: string;
  text?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const NO_FILL = "#00000000";
/** 引擎每页 path 上限（page-spec MAX_PATHS）。 */
const MAX_PATH_TIERS = 4;

function inkHeight(sizePt: number, lines = 1): number {
  return Math.round(estimateLineHeight(Math.max(18, sizePt)) * lines);
}

interface TierGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 该层顶部宽度（相对层框）。 */
  topW: number;
}

export function expandPyramid(
  items: TierItem[],
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
  const tierGap = Math.max(4, Math.round(m.tightGap * 0.4));
  const rowH = Math.floor((box.h - (n - 1) * tierGap) / n);
  if (rowH < 52) {
    bad(`${what} 区域过小（高 ${Math.round(box.h)}px）装不下 ${n} 层——加大权重或减少层级`);
  }
  const totalH = box.h;
  const baseW = box.w;
  const titleSize = Math.max(20, Math.min(26, Math.round(m.title * 0.85)));
  const bodySize = Math.max(13, Math.round(m.body * 0.85));
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";

  // 层几何：按金字塔斜率（顶部中线为顶点、底边满宽）计算每层上下宽度；
  // 下一层的顶宽接上一层的底宽，缝口两侧不错位（观感是连续切面而非阶梯）。
  const seamW = (index: number) => Math.round((baseW * index * (rowH + tierGap)) / totalH);
  const tiers: TierGeometry[] = items.map((_, index) => {
    const yRel = index * (rowH + tierGap);
    const topW = seamW(index);
    const bottomW = index === n - 1 ? baseW : seamW(index + 1);
    return {
      x: Math.round(box.x + (baseW - bottomW) / 2),
      y: Math.round(box.y + yRel),
      w: bottomW,
      h: rowH,
      topW,
    };
  });

  // 深色页上主色贴着深底会发闷：底档向页面墨色提亮，渐变方向仍保持「顶深底浅」。
  const darkPage = isDarkColor(skin.colors.background);
  const strongInk = darkPage ? skin.colors.inkText : skin.colors.text;
  const solid = darkPage ? mixHex(skin.colors.primary, skin.colors.text, 0.34) : skin.colors.primary;
  const rampTarget = darkPage ? skin.colors.text : skin.colors.background;
  const tierFill = (index: number): string => {
    if (form === "outline") return NO_FILL;
    if (form === "tint") return skin.colors.emphasisSoft;
    return mixHex(solid, rampTarget, 0.05 + 0.37 * (index / Math.max(1, n - 1)));
  };

  if (n <= MAX_PATH_TIERS) {
    tiers.forEach((tier, index) => {
      const inset = Math.max(0, Math.round((tier.w - tier.topW) / 2));
      const d = `M ${inset} 0 L ${tier.w - inset} 0 L ${tier.w} ${tier.h} L 0 ${tier.h} Z`;
      elements.push({
        type: "path",
        d,
        fill: tierFill(index),
        ...(form === "outline" ? { stroke: { color: skin.colors.text, widthPt: 1.25 } } : {}),
        x: tier.x,
        y: tier.y,
        w: tier.w,
        h: tier.h,
      });
    });
  } else {
    // 5 层：退化���梯形堆叠（引擎 path 上限 4），同色阶保证观感一致。
    splitRows(box, n, tierGap).forEach((row, index) => {
      const ratio = 0.44 + (0.56 * index) / Math.max(1, n - 1);
      const tierW = Math.round(row.w * ratio);
      elements.push({
        type: "shape",
        shape: index === 0 ? "triangle" : "trapezoid",
        fill: tierFill(index),
        ...(form === "outline" ? { stroke: { color: skin.colors.text, widthPt: 1.25 } } : {}),
        x: Math.round(row.x + (row.w - tierW) / 2),
        y: Math.round(row.y),
        w: tierW,
        h: Math.round(row.h),
      });
    });
  }

  items.forEach((item, index) => {
    const tier = tiers[index]!;
    const fill = tierFill(index);
    const darkFill = form !== "outline" && isDarkColor(fill);
    const titleColor = form === "outline"
      ? skin.colors.text
      : darkFill ? skin.colors.inverse : strongInk;
    const bodyColor = form === "outline"
      ? skin.colors.muted
      : darkFill ? mixHex(skin.colors.inverse, fill, 0.22) : mixHex(strongInk, fill, 0.32);

    // 该层中线高度处的层宽决定文本安全宽度（梯形中线宽 = 上下宽均值）。
    const centerWidth = Math.round((tier.w + tier.topW) / 2);
    const textW = Math.max(56, centerWidth - 28);
    const titleLines = estimateLines(item.title, titleSize, textW);
    const bodyLines = item.text ? estimateLines(item.text, bodySize, textW) : 0;
    const titleInk = inkHeight(titleSize, titleLines);
    const bodyInk = item.text ? inkHeight(bodySize, bodyLines) : 0;
    const gap = Math.round(m.tightGap * 0.5);
    const need = titleInk + (bodyInk ? gap + bodyInk : 0);
    if (need > tier.h - 8) {
      bad(`${what} 第 ${index + 1} 层「${item.title}」内容高约 ${Math.round(need)}px 超过层高 ${tier.h}px——精简文字或减少层级`);
    }
    const textX = Math.round(box.x + (baseW - textW) / 2);
    const blockTop = Math.round(tier.y + (tier.h - need) / 2);
    elements.push(
      textElement({ x: textX, y: blockTop, w: textW, h: textBoxHeight(item.title, titleSize, textW) }, [
        { runs: skin.heading(item.title, titleSize, titleColor), align },
      ]),
    );
    if (item.text) {
      elements.push(
        textElement(
          { x: textX, y: blockTop + titleInk + gap, w: textW, h: textBoxHeight(item.text, bodySize, textW) },
          [{ runs: skin.body(item.text, bodySize, bodyColor), align }],
        ),
      );
    }
  });
  return elements;
}
