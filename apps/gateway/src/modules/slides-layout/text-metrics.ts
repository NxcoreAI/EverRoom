/**
 * 文本折行/高度估算器——系数逐字对齐 genoffice 引擎 estimateTextInk
 * （apps/desktop/vendor/genoffice/apps/slides/src/main/page-spec.ts）：
 * 行高 = sizePt×1.8×(lineSpacingPct/110)，CJK 字宽 ×1.35、拉丁 ×0.7，
 * 段前/段后距 ×1.33。预设展开器据此定框高，保证引擎闸门（墨迹重叠、
 * 实测溢出）在正常情况下不会触发。
 */

const CJK_CHAR = /[⺀-鿿豈-﫿＀-￯]/;

export const DEFAULT_SIZE_PT = 18;

export interface TextRunInput {
  text: string;
  sizePt?: number;
}

export interface TextParagraphInput {
  runs: TextRunInput[];
  lineSpacingPct?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
}

/** 逐字符累加文本像素宽度（与引擎同系数）。 */
export function estimateTextWidth(text: string, sizePt: number): number {
  let width = 0;
  for (const ch of text) width += (CJK_CHAR.test(ch) ? 1.35 : 0.7) * sizePt;
  return width;
}

/** 一行高度（px）。 */
export function estimateLineHeight(sizePt: number, lineSpacingPct = 110): number {
  return sizePt * 1.8 * (lineSpacingPct / 110);
}

/** 单段落在给定框宽下的折行行数。 */
export function estimateLines(text: string, sizePt: number, boxWidth: number): number {
  return Math.max(1, Math.ceil(estimateTextWidth(text, sizePt) / Math.max(1, boxWidth)));
}

/** 多段落在给定框宽下的内容总高（px），含段前/段后距。 */
export function estimateParagraphsHeight(paragraphs: TextParagraphInput[], boxWidth: number): number {
  let height = 0;
  for (const paragraph of paragraphs) {
    const size = Math.max(DEFAULT_SIZE_PT, ...paragraph.runs.map((run) => run.sizePt ?? DEFAULT_SIZE_PT));
    const text = paragraph.runs.map((run) => run.text).join("");
    const lineH = estimateLineHeight(size, paragraph.lineSpacingPct);
    const lines = estimateLines(text, size, boxWidth);
    height += lines * lineH + (paragraph.spaceBeforePt ?? 0) * 1.33 + (paragraph.spaceAfterPt ?? 0) * 1.33;
  }
  return height;
}

/** 单行文本框给高：行高 + 余量（与提示词「加一行余量」口径一致，取 0.35 行）。 */
export function singleLineBoxHeight(sizePt: number): number {
  return Math.round(estimateLineHeight(sizePt) * 1.35);
}

/** 纯文本块（一种字号）在框宽下建议框高。 */
export function textBoxHeight(text: string, sizePt: number, boxWidth: number): number {
  const lines = estimateLines(text, sizePt, boxWidth);
  return Math.round(lines * estimateLineHeight(sizePt) + estimateLineHeight(sizePt) * 0.35);
}
