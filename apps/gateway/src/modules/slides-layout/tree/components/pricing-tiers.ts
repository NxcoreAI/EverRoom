/**
 * pricingTiers 组件（editorial）：2~4 档套餐定价卡。featured 档（恰一个）：
 * tint 垫板 + 3px 主色顶条 + 徽章（tag 文案）+ 实心主色按钮，整列上浮；
 * 其余档：平面内容 + 发丝描边按钮。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { mixHex } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface PricingTier {
  name: string;
  price: string;
  unit?: string;
  features: string[];
  cta?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandPricingTiers(
  tiers: PricingTier[],
  featured: number,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const elements: SpecElement[] = [];
  const gutter = theme.spacing.gutter * 1.5;
  const cols = splitColumns(frame, tiers.length, gutter);
  const nameSize = Math.min(17, Math.max(15, theme.sizes.body + 2));
  const priceSize = Math.min(34, Math.max(26, theme.sizes.subtitle + 12));
  const metaSize = theme.sizes.caption;
  const checkSize = 12;
  const ctaH = 34;
  const rendered = tiers.map((tier, i) => {
    const isFeatured = featured === i;
    const col = cols[i]!;
    const innerX = col.x + (isFeatured ? 18 : 0);
    const innerW = col.w - (isFeatured ? 36 : 0);
    const nameH = estimateLines(tier.name, nameSize, innerW) * estimateLineHeight(nameSize) + 4;
    const priceH = estimateLineHeight(priceSize) + 6;
    const featureHs = tier.features.map(
      (f) => Math.max(1, estimateLines(f, metaSize, innerW - checkSize - 6)) * estimateLineHeight(metaSize) + 8,
    );
    const ctaW = Math.min(innerW, Math.max(120, Math.round((tier.cta ?? "选择").length * metaSize * 1.6 + 40)));
    const need = nameH + priceH + 8 + featureHs.reduce((a, b) => a + b, 0) + 14 + ctaH;
    if (need > col.h) {
      bad(`${what} 档「${tier.name}」内容高约 ${Math.round(need)}px 超过 ${Math.round(col.h)}px——精简特性行或减少档位`);
    }
    return { tier, isFeatured, col, innerX, innerW, nameH, priceH, featureHs, ctaW, need };
  });
  const contentH = Math.max(...rendered.map((r) => r.need));
  rendered.forEach(({ tier, isFeatured, col, innerX, innerW, nameH, priceH, featureHs, ctaW, need }, i) => {
    // featured 整列上浮：先算基准 top，再统一 -12
    const top = frame.y + Math.max(0, (frame.h - contentH) / 2) + (isFeatured ? -12 : 0);
    if (isFeatured) {
      const panelH = Math.min(frame.h - (top - frame.y), need + 32);
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: mixHex(theme.colors.primary, theme.colors.background, 0.93),
        stroke: { color: theme.colors.primary, widthPt: 1.25 },
        x: Math.round(col.x),
        y: Math.round(top - 16),
        w: Math.round(col.w),
        h: Math.round(panelH),
        adj: Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, Math.min(col.w, panelH))) * 100000)),
        shadow: "medium",
      });
      elements.push({ type: "shape", shape: "rect", fill: theme.colors.primary, x: Math.round(col.x), y: Math.round(top - 16), w: Math.round(col.w), h: 3 });
    } else {
      // 非重点档：短顶发丝线
      elements.push({
        type: "shape",
        shape: "rect",
        fill: theme.colors.divider,
        x: Math.round(col.x),
        y: Math.round(top),
        w: Math.round(Math.min(col.w, 56)),
        h: 2,
      });
    }
    let y = top + 6;
    elements.push(
      textElement({ x: innerX, y, w: innerW, h: nameH }, [
        { runs: headingRuns(tier.name, nameSize, isFeatured ? theme.colors.text : theme.colors.textMuted, theme) },
      ]),
    );
    y += nameH;
    // 价格行：大字价格 + 小字单位（同段混排）
    elements.push(
      textElement({ x: innerX, y, w: innerW, h: priceH }, [
        {
          runs: [
            { text: tier.price, sizePt: priceSize, bold: true, color: theme.colors.text },
            ...(tier.unit ? [{ text: ` ${tier.unit}`, sizePt: metaSize, color: theme.colors.textMuted }] : []),
          ],
        },
      ]),
    );
    y += priceH + 8;
    tier.features.forEach((f, j) => {
      const h = featureHs[j]!;
      elements.push({
        type: "icon",
        icon: "check",
        color: theme.colors.primary,
        x: Math.round(innerX),
        y: Math.round(y + 3),
        w: checkSize,
        h: checkSize,
      });
      elements.push(
        textElement({ x: innerX + checkSize + 6, y, w: innerW - checkSize - 6, h }, [
          { runs: bodyRuns(f, metaSize, theme.colors.textMuted, theme) },
        ]),
      );
      y += h;
    });
    y += 14;
    const ctaText = tier.cta ?? "选择";
    if (isFeatured) {
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: theme.colors.primary,
        x: Math.round(innerX),
        y: Math.round(y),
        w: Math.round(ctaW),
        h: ctaH,
        adj: 50000,
        paragraphs: [{ runs: [{ text: ctaText, sizePt: metaSize + 1, bold: true, color: theme.colors.onDarkText }] }],
        valign: "middle",
      });
    } else {
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: theme.colors.background,
        stroke: { color: theme.colors.divider, widthPt: 1 },
        x: Math.round(innerX),
        y: Math.round(y),
        w: Math.round(ctaW),
        h: ctaH,
        adj: 50000,
        paragraphs: [{ runs: [{ text: ctaText, sizePt: metaSize + 1, bold: true, color: theme.colors.primary }] }],
        valign: "middle",
      });
    }
  });
  return elements;
}
