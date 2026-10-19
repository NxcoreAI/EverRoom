/**
 * persona 组件（editorial）。无卡片——头像圆 + 姓名/角色/破折号要点，
 * 整组在框内垂直居中。
 */

import type { Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface PersonaInput {
  person: { name: string; role?: string };
  points: string[];
  image?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandPersona(input: PersonaInput, frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const pad = theme.spacing.cardPadding;
  const nameSize = Math.min(24, Math.max(18, theme.sizes.subtitle));
  const roleSize = theme.sizes.caption;
  const pointSize = theme.sizes.body;
  const avatarUpper = Math.min(frame.h * 0.5, 104, (frame.w - pad * 2) * 0.32);
  const measureW = frame.w - pad * 2 - avatarUpper - 20 - pad;
  const nameH = estimateLines(input.person.name, nameSize, measureW) * estimateLineHeight(nameSize) + 4;
  const roleH = input.person.role ? estimateLineHeight(roleSize) + 4 : 0;
  const pointH = input.points.map((p) => estimateLines(`—　${p}`, pointSize, measureW) * estimateLineHeight(pointSize) + 10);
  const pointsH = pointH.reduce((a, b) => a + b, 0);
  const need = nameH + (roleH ? 6 + roleH : 0) + 14 + pointsH;
  if (need > frame.h || measureW < 140) {
    bad(`${what} 内容高约 ${Math.round(need)}px 超过 ${Math.round(frame.h)}px——精简要点`);
  }
  const avatarSize = Math.min(need + pad, frame.h, avatarUpper);
  const contentH = Math.max(need, avatarSize);
  const top = frame.y + Math.max(0, (frame.h - contentH) / 2);
  const avatarX = Math.round(frame.x);
  const avatarY = Math.round(top + (contentH - avatarSize) / 2);
  const elements: SpecElement[] = [];
  if (input.image) {
    elements.push({
      type: "image",
      url: input.image,
      fit: "cover",
      x: avatarX,
      y: avatarY,
      w: Math.round(avatarSize),
      h: Math.round(avatarSize),
    });
  } else {
    elements.push({
      type: "shape",
      shape: "ellipse",
      fill: theme.colors.primarySoft,
      x: avatarX,
      y: avatarY,
      w: Math.round(avatarSize),
      h: Math.round(avatarSize),
    });
    elements.push({
      type: "icon",
      icon: "user",
      color: theme.colors.primary,
      x: Math.round(avatarX + avatarSize * 0.26),
      y: Math.round(avatarY + avatarSize * 0.24),
      w: Math.round(avatarSize * 0.48),
      h: Math.round(avatarSize * 0.48),
    });
  }
  const textX = frame.x + avatarSize + 20;
  const textW = frame.w - (textX - frame.x);
  let y = top;
  elements.push(
    textElement({ x: textX, y, w: textW, h: nameH }, [
      { runs: headingRuns(input.person.name, nameSize, theme.colors.text, theme) },
    ]),
  );
  y += nameH;
  if (input.person.role) {
    elements.push(
      textElement({ x: textX, y: y + 6, w: textW, h: roleH }, [
        { runs: bodyRuns(input.person.role, roleSize, theme.colors.textMuted, theme) },
      ]),
    );
    y += 6 + roleH;
  }
  y += 14;
  input.points.forEach((point, j) => {
    const h = pointH[j]!;
    elements.push(
      textElement({ x: textX, y, w: textW, h }, [
        { runs: bodyRuns(`—　${point}`, pointSize, theme.colors.text, theme) },
      ]),
    );
    y += h;
  });
  return elements;
}
