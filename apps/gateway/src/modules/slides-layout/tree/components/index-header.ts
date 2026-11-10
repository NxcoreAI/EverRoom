/**
 * indexHeader 组件（editorial）：栏头 / 章节序号。
 *
 * 无底面语义：默认平铺。衬线大序号（按区域高自适应，最高 72pt，强调色）+ 标题
 * + 右侧小注，一条 2px 墨色底线压区域下缘——同排多个栏头的线天然对齐。
 * 区域较高时（章节页）整块垂直居中并补一条强调色眉标，避免窄带漂在纸中间；
 * 区域较矮时（并列栏头）保持顶对齐的紧凑栏头。序号字体/底线走 skin 语义。
 */

import { textElement, type SpecElement } from "../../elements.js";
import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { estimateLineHeight, estimateTextWidth, singleLineBoxHeight } from "../../text-metrics.js";

export interface IndexHeaderInput {
  num: string;
  title: string;
  note?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

/** LibreOffice/PowerPoint 实测字宽普遍比估算宽 10~20%：小注宽度按 88% 收。 */
const NOTE_WIDTH_FACTOR = 0.88;

export function expandIndexHeader(
  input: IndexHeaderInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme; // 组件只读 skin
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";
  const showNum = skin.numeral !== "none";
  // 序号：设计系统给的 display×0.6 与区域高双封顶（栏头矮时自动收成紧凑序号）。
  const serialSize = Math.max(
    24,
    Math.min(72, Math.round(m.display * 0.62), Math.round(box.h * 0.34)),
  );
  const titleSize = Math.max(20, Math.min(38, Math.round(serialSize * 0.55)));
  const noteSize = m.label;
  const serialH = singleLineBoxHeight(serialSize);
  const titleH = singleLineBoxHeight(titleSize);
  const noteH = singleLineBoxHeight(noteSize);
  const serialW = showNum ? Math.round(estimateTextWidth(input.num, serialSize)) + Math.round(m.tightGap * 0.7) : 0;
  const numTitleGap = showNum ? Math.max(16, Math.round(m.tightGap * 0.9)) : 0;
  const titleW = Math.min(
    Math.round(box.w - serialW - numTitleGap),
    Math.max(48, Math.round(estimateTextWidth(input.title, titleSize) + 4)),
  );
  if (showNum && serialW + numTitleGap + titleW > box.w) {
    bad(`${what}「${input.num} ${input.title}」栏头超宽（框 ${frame.w}px）——缩短标题`);
  }
  const noteAvail = box.w - (serialW + numTitleGap + titleW + Math.round(m.tightGap * 1.2));
  if (input.note && estimateTextWidth(input.note, noteSize) > noteAvail * NOTE_WIDTH_FACTOR) {
    bad(`${what}「${input.title}」右侧小注「${input.note}」放不下（可用 ${Math.round(noteAvail)}px）——缩短小注`);
  }
  if (serialH + Math.max(4, Math.round(m.tightGap * 0.4)) > box.h) {
    bad(`${what} 区域高 ${frame.h}px 不够一行栏头（需约 ${Math.round(serialH)}px）——加大该子树权重`);
  }

  // 高区域（章节页）：整块垂直居中 + 眉标，让空白对称；矮区域（并列栏头）：顶对齐紧凑。
  const eyebrowH = Math.max(3, Math.round(m.label * 0.24));
  const eyebrowGap = Math.round(m.tightGap * 0.8);
  const tall = box.h > serialH * 1.9;
  const blockH = tall ? eyebrowH + eyebrowGap + serialH : serialH;
  const rowY = tall ? box.y + Math.round((box.h - blockH) / 2) : box.y;
  if (tall) {
    elements.push(
      skin.accentRule(box, {
        x: Math.round(box.x),
        y: Math.round(rowY),
        width: Math.max(32, Math.round(m.display * 0.3)),
        height: eyebrowH,
      }),
    );
  }

  const serialY = tall ? rowY + eyebrowH + eyebrowGap : rowY;
  if (showNum) {
    const numRuns = skin.numeralRun(input.num, serialSize, skin.colors.emphasis);
    elements.push(
      textElement({ x: Math.round(box.x), y: Math.round(serialY), w: serialW, h: serialH }, [
        { runs: numRuns ?? [] },
      ]),
    );
  }
  // 标题与序号基线对齐（相对行高差），不是盒顶对齐。
  const titleY = serialY + Math.round(estimateLineHeight(serialSize) - estimateLineHeight(titleSize));
  const titleX = Math.round(box.x + serialW + numTitleGap);
  elements.push(
    textElement({ x: titleX, y: Math.round(titleY), w: titleW, h: titleH }, [
      { runs: skin.heading(input.title, titleSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
    ]),
  );
  if (input.note) {
    const noteY = titleY + Math.round((estimateLineHeight(titleSize) - estimateLineHeight(noteSize)) / 2);
    elements.push(
      textElement(
        { x: titleX + titleW + Math.round(m.tightGap * 1.2), y: Math.round(noteY), w: Math.max(32, noteAvail), h: noteH },
        [{ runs: [{ ...skin.micro(input.note, skin.colors.muted), sizePt: noteSize }], align: "right" }],
      ),
    );
  }
  // 2px 墨色底线：栏头身份（separator 非 line 时整条消失，退回纯文字栏头）。
  const ruleH = Math.max(2, Math.round(m.label * 0.16));
  const ruleIsLine = skin.dividerH(box, Math.round(box.y + box.h - ruleH)) !== null;
  if (ruleIsLine) {
    elements.push({
      type: "shape",
      shape: "rect",
      fill: skin.colors.text,
      x: Math.round(box.x),
      y: Math.round(box.y + box.h - ruleH),
      w: Math.round(box.w),
      h: ruleH,
    });
  }
  return elements;
}
