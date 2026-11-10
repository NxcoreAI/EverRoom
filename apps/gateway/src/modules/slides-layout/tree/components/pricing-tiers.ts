/**
 * pricingTiers：定价卡。名称微标签 + 大价格 + 特性 + 底部 CTA；
 * featured 档浅强调底 + 一条强调边，非重点档用风格卡卡面；卡内内容上下分布填满。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, estimateTextWidth } from "../../text-metrics.js";

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
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const m = skin.metrics(frame);
  const cols = splitColumns(frame, tiers.length, m.gap);
  const elements: SpecElement[] = [];
  const nameSize = Math.max(12, m.label);
  const priceSize = Math.min(Math.round(m.display * 0.62), 76);
  const featureSize = m.body;
  const checkSize = Math.max(14, Math.round(featureSize * 0.9));
  const ctaH = Math.max(40, Math.round(m.body * 2.4));
  const rendered = tiers.map((tier, i) => {
    const cell = cols[i]!;
    const isFeatured = featured === i;
    const box = skin.contentBox(cell);
    const priceH = estimateLineHeight(priceSize, 100);
    const nameH = estimateLineHeight(nameSize, 110) + 4;
    const featureHs = tier.features.map((f) => Math.max(1, estimateLines(f, featureSize, box.w - checkSize - 12)) * estimateLineHeight(featureSize, 122) + Math.round(m.tightGap * 0.7));
    const topBlock = nameH + Math.round(m.tightGap * 0.6) + priceH + Math.round(m.gap * 0.5);
    const need = topBlock + featureHs.reduce((a, b) => a + b, 0) + Math.round(m.gap * 0.5) + ctaH;
    if (need > box.h + 2) {
      bad(`${what} 档「${tier.name}」内容高约 ${Math.round(need)}px 超过 ${Math.round(box.h)}px——精简特性行或减少档位`);
    }
    return { tier, cell, isFeatured, box, nameH, priceH, featureHs, need, topBlock };
  });
  rendered.forEach(({ tier, cell, isFeatured, box, nameH, priceH, featureHs, topBlock }) => {
    if (isFeatured) {
      // featured：浅强调底 + 一条强调边（不叠反白/顶条/阴影）；文字用正常档色。
      const radius = Math.min(50000, Math.round((skin.radius / Math.max(1, Math.min(cell.w, cell.h))) * 100000));
      elements.push({
        type: "shape", shape: "roundRect", fill: skin.colors.emphasisSoft,
        stroke: { color: skin.colors.emphasis, widthPt: 1.25 },
        x: Math.round(cell.x), y: Math.round(cell.y), w: Math.round(cell.w), h: Math.round(cell.h),
        ...(radius ? { adj: radius } : {}),
      });
    } else {
      elements.push(...skin.paint(cell));
    }
    // 名称微标签
    elements.push(textElement({ x: box.x, y: box.y, w: box.w, h: nameH }, [
      { runs: [skin.micro(tier.name, isFeatured ? skin.colors.emphasis : skin.colors.muted)] },
    ]));
    // 价格
    const priceRuns = skin.numeral !== "none"
      ? (skin.numeralRun(tier.price, priceSize, skin.colors.text) ?? [])
      : [{ text: tier.price, sizePt: priceSize, bold: true, color: skin.colors.text, ...(skin.fonts.body ? { font: skin.fonts.body } : {}) }];
    elements.push(textElement({ x: box.x, y: box.y + nameH + Math.round(m.tightGap * 0.6), w: box.w, h: priceH }, [{
      runs: [
        ...priceRuns,
        ...(tier.unit ? [{ text: ` ${tier.unit}`, sizePt: Math.round(m.body * 0.85), color: skin.colors.muted, ...(skin.fonts.body ? { font: skin.fonts.body } : {}) }] : []),
      ],
    }]));
    const ruleY = box.y + topBlock - Math.round(m.gap * 0.25);
    const rule = skin.dividerH(box, ruleY);
    if (rule) elements.push(rule);
    // 特性
    let y = box.y + topBlock;
    tier.features.forEach((feature) => {
      const h = featureHs[tier.features.indexOf(feature)] ?? Math.round(m.body * 1.8);
      elements.push({ type: "icon", icon: "check", color: skin.colors.emphasis, x: Math.round(box.x), y: Math.round(y + 4), w: checkSize, h: checkSize });
      elements.push(textElement({ x: box.x + checkSize + 12, y, w: box.w - checkSize - 12, h }, [
        { runs: skin.body(feature, featureSize, skin.colors.muted) },
      ]));
      y += h;
    });
    // CTA 沉底
    const ctaText = tier.cta ?? "选择";
    const ctaW = Math.min(box.w, Math.max(140, Math.round(estimateTextWidth(ctaText, m.label) + 56)));
    const ctaY = box.y + box.h - ctaH;
    elements.push({
      type: "shape", shape: "roundRect",
      ...(isFeatured
        ? { fill: skin.colors.emphasis }
        : { fill: "#00000000", stroke: { color: skin.colors.divider, widthPt: 1 } }),
      x: Math.round(box.x), y: Math.round(ctaY), w: Math.round(ctaW), h: ctaH, adj: 50000,
      paragraphs: [{ runs: [{ text: ctaText, sizePt: Math.max(12, m.label), bold: true, color: isFeatured ? skin.colors.text : skin.colors.text }], align: "center" }],
      valign: "middle",
    });
  });
  return elements;
}
