/**
 * persona 组件（editorial）：人物画像双栏。
 *
 * 左栏：首字徽章/头像 + 姓名 + 职位（强调色全大写微标签），整块在卡内垂直居中；
 * 右栏：要点按行均分并压发丝线，铺满整栏高度；栏间一条全高竖线承担结构。
 * 卡面/内边距/字号全部来自 ComponentSkin。
 */

import { padFrame, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import {
  estimateLineHeight,
  estimateLines,
  singleLineBoxHeight,
  textBoxHeight,
} from "../../text-metrics.js";

export interface PersonaInput {
  person: { name: string; role?: string };
  points: string[];
  image?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const DENSITY_PAD: Record<string, number> = { tight: 0.9, normal: 1, airy: 1.12 };

function cardPad(skin: ComponentSkin, frame: Frame): number {
  const m = skin.metrics(frame);
  const scale = DENSITY_PAD[skin.density] ?? 1;
  return Math.max(26, Math.min(36, Math.round(m.pad * scale)));
}

function cardBox(skin: ComponentSkin, frame: Frame, pad: number): Frame {
  const base = skin.contentBox(frame);
  const styled = Math.min(skin.pad, Math.floor(Math.min(frame.w, frame.h) * 0.18));
  const guard = Math.floor(Math.min(base.w, base.h) * 0.06);
  const inset = Math.min(Math.max(0, pad - styled), guard);
  return inset > 0 ? padFrame(base, inset) : base;
}

export function expandPersona(
  input: PersonaInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const elements: SpecElement[] = [...skin.paint(frame)];
  if (skin.surface !== "none") elements.push(...skin.motifDecor(frame, "corner"));
  const pad = cardPad(skin, frame);
  const box = cardBox(skin, frame, pad);
  const align = skin.alignExplicit ? skin.paragraphAlign : "left";

  const gutter = Math.max(m.gap, 32);
  const leftW = Math.max(180, Math.round(box.w * 0.3));
  const rightX = box.x + leftW + gutter;
  const rightW = Math.max(120, box.w - leftW - gutter);
  if (rightW < 160) {
    bad(`${what} 右栏可用宽 ${Math.round(rightW)}px 不足——减少父级侧栏权重`);
  }

  const avatarSize = Math.min(150, Math.max(96, Math.round(Math.min(leftW * 0.9, box.h * 0.34))));
  const nameSize = Math.max(28, Math.min(36, m.title + 2));
  const roleSize = m.label;
  const pointSize = Math.max(18, m.body);

  const nameLines = estimateLines(input.person.name, nameSize, leftW);
  const nameH = nameLines * estimateLineHeight(nameSize) + 8;
  const roleH = input.person.role ? singleLineBoxHeight(roleSize) : 0;
  const leftContentH = avatarSize + Math.round(m.tightGap * 1.4) + nameH + roleH;
  if (leftContentH > box.h) {
    bad(`${what} 左栏内容高约 ${Math.round(leftContentH)}px 超过 ${Math.round(box.h)}px——精简姓名或加大权重`);
  }

  // 竖线：双栏结构件（separator 非 line 时自动消失）。
  const divider = skin.dividerV(frame, Math.round(rightX - gutter / 2), Math.round(box.y), Math.round(box.h));
  if (divider) elements.push(divider);

  // 左栏：整体垂直居中（顶/底留白对称，不悬浮）。
  let y = box.y + Math.round((box.h - leftContentH) / 2);
  const avatarX = Math.round(box.x);
  if (input.image) {
    const radiusAdj = skin.imageRadiusAdj(avatarSize, avatarSize);
    elements.push({
      type: "image",
      url: input.image,
      fit: skin.imageFit,
      ...(radiusAdj !== undefined ? { radiusAdj } : {}),
      x: avatarX,
      y: Math.round(y),
      w: avatarSize,
      h: avatarSize,
    });
  } else {
    elements.push({
      type: "shape",
      shape: "ellipse",
      fill: skin.colors.emphasisSoft,
      x: avatarX,
      y: Math.round(y),
      w: avatarSize,
      h: avatarSize,
    });
    const initialSize = Math.round(avatarSize * 0.42);
    elements.push(
      textElement(
        { x: avatarX, y: Math.round(y + (avatarSize - singleLineBoxHeight(initialSize)) / 2), w: avatarSize, h: singleLineBoxHeight(initialSize) },
        [{ runs: skin.heading(skin.initials(input.person.name), initialSize, skin.colors.emphasis), align: "center" }],
      ),
    );
  }
  y += avatarSize + Math.round(m.tightGap * 1.4);
  elements.push(
    textElement({ x: box.x, y: Math.round(y), w: leftW, h: nameH }, [
      { runs: skin.heading(input.person.name, nameSize, skin.colors.text), align },
    ]),
  );
  y += nameH;
  if (input.person.role) {
    elements.push(
      textElement({ x: box.x, y: Math.round(y), w: leftW, h: roleH }, [
        { runs: [{ ...skin.micro(input.person.role, skin.colors.emphasis), sizePt: roleSize }], align },
      ]),
    );
  }

  // 右栏：要点按行均分铺满；行间发丝线承担分组。
  const textX = rightX;
  const textW = Math.max(80, rightW);
  const rowCount = Math.max(1, input.points.length);
  const rowH = Math.floor(box.h / rowCount);
  if (rowH < textBoxHeight(input.points[0] ?? "", pointSize, textW)) {
    bad(`${what} 要点行高 ${rowH}px 装不下正文——精简要点或减少条数`);
  }
  input.points.forEach((point, j) => {
    const rowY = box.y + rowH * j;
    const textH = textBoxHeight(point, pointSize, textW);
    const textY = rowY + Math.max(0, Math.round((rowH - textH) / 2));
    elements.push(
      textElement({ x: textX, y: textY, w: textW, h: textH }, [
        { runs: skin.body(point, pointSize, skin.colors.text), ...(align === "center" ? { align } : {}) },
      ]),
    );
    if (j < input.points.length - 1) {
      const line = skin.dividerH({ x: rightX, y: rowY, w: rightW, h: rowH }, Math.round(rowY + rowH));
      if (line) elements.push(line);
    }
  });
  return elements;
}
