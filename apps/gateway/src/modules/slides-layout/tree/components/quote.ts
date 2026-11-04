/**
 * quote：大号引文 + 署名。无底面语义，默认平铺；引文正文与署名是主体，
 * 居中排布，允许显式 surface 铺底。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";
import type { ComponentLeaf } from "./index.js";

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandQuote(
  leaf: Extract<ComponentLeaf, { name: "quote" }>,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "corner")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const isNarrow = box.w < box.h * 1.4;
  const textW = Math.round(box.w * (isNarrow ? 0.94 : 0.84));
  const textX = box.x + Math.round((box.w - textW) / 2);
  let quoteSize = Math.min(Math.round(m.display * 0.58), 72);
  // 宽幅引语最多两行、窄幅最多四行：避免「风 / 格卡」这类把词拆开的孤字行。
  const maxLines = isNarrow ? 4 : 2;
  const charCount = [...leaf.text].length;
  // 每行多留一个字：避免「风格 / 卡」这类把词拆到下一行的断法。
  const requiredCapacity = Math.ceil(charCount / maxLines) + 1;
  const capacityAt = (size: number) => Math.floor(textW / (size * 1.35));
  while (quoteSize > 24 && capacityAt(quoteSize) < requiredCapacity) quoteSize -= 2;
  let quoteH = textBoxHeight(leaf.text, quoteSize, textW);
  const authorSize = Math.max(12, m.label);
  const authorH = leaf.author ? singleLineBoxHeight(authorSize) : 0;
  const authorGap = Math.round(m.gap * 0.6);
  const total = quoteH + (authorH ? authorGap + authorH : 0);
  // 先缩引文字号，避免「内容高过框」直接报缺陷。
  while (total > box.h && quoteSize > 22) {
    quoteSize -= 2;
    quoteH = textBoxHeight(leaf.text, quoteSize, textW);
  }
  if (quoteH + (authorH ? authorGap + authorH : 0) > box.h) {
    bad(`${what} 引言内容高约 ${Math.round(quoteH + authorGap + authorH)}px 超过区域 ${Math.round(box.h)}px——精简引文`);
  }
  const contentH = quoteH + (authorH ? authorGap + authorH : 0);
  const top = box.y + Math.max(0, (box.h - contentH) / 2);
  const quoteRuns = skin.numeral !== "none"
    ? (skin.numeralRun(leaf.text, quoteSize, skin.colors.text, false) ?? [])
    : [{ text: leaf.text, sizePt: quoteSize, color: skin.colors.text, ...(skin.fonts.body ? { font: skin.fonts.body } : {}) }];
  elements.push(
    textElement(
      { x: textX, y: top, w: textW, h: quoteH },
      [{ runs: quoteRuns, align: "center", lineSpacingPct: 112 }],
      "middle",
    ),
  );
  if (leaf.author) {
    elements.push(
      textElement({ x: textX, y: top + quoteH + authorGap, w: textW, h: authorH }, [
        { runs: [skin.micro(leaf.author, skin.colors.muted)], align: "center" },
      ]),
    );
  }
  return elements;
}
