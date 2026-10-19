/**
 * quote 组件（editorial）。强调色小刻 + 衬线引文 + 静音署名，整组垂直居中。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, numeralFont, textElement, type SpecElement } from "../../elements.js";
import { singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";
import type { ComponentLeaf } from "./index.js";

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandQuote(leaf: Extract<ComponentLeaf, { name: "quote" }>, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const quoteSize = Math.min(28, Math.max(19, theme.sizes.subtitle + 5));
  const authorSize = theme.sizes.caption;
  const quoteFont = numeralFont(theme);
  const quoteH = textBoxHeight(leaf.text, quoteSize, frame.w);
  const authorH = leaf.author ? singleLineBoxHeight(authorSize) : 0;
  const need = 3 + 22 + quoteH + (authorH ? 10 + authorH : 0);
  if (need > frame.h) {
    bad(`${what} 引言内容高约 ${Math.round(need)}px 超过区域 ${Math.round(frame.h)}px——精简引文`);
  }
  const top = frame.y + Math.max(0, (frame.h - need) / 2);
  const tickW = 30;
  const elements: SpecElement[] = [
    // 居中强调刻
    { type: "shape", shape: "rect", fill: theme.colors.primary, x: Math.round(frame.x + frame.w / 2 - tickW / 2), y: Math.round(top), w: tickW, h: 3 },
    textElement(
      { x: frame.x, y: top + 25, w: frame.w, h: quoteH },
      [
        {
          runs: [{ text: leaf.text, sizePt: quoteSize, color: theme.colors.text, ...(quoteFont ? { font: quoteFont } : {}) }],
          align: "center",
        },
      ],
      "middle",
    ),
  ];
  if (leaf.author) {
    elements.push(
      textElement({ x: frame.x, y: top + 25 + quoteH + 10, w: frame.w, h: authorH }, [
        { runs: bodyRuns(leaf.author, authorSize, theme.colors.textMuted, theme), align: "center" },
      ]),
    );
  }
  return elements;
}
