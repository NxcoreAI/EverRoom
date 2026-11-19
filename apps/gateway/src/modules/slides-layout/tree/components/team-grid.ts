/**
 * teamGrid 组件（editorial）：2~6 人团队卡。≤4 人单行、5~6 人两行（每行 3）。
 *
 * 版式（每张卡）：首字徽章/头像（全组统一尺寸 → 姓名基线对齐）→ 姓名 → 职位
 * （强调色全大写微标签）→ 简介自然向下；有简介时署名与简介之间留发丝线分层。
 * 头像位不画通用 user 图标：无图者一律首字徽章（avatar 变体只换色调语义）。
 */

import { padFrame, splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines, singleLineBoxHeight } from "../../text-metrics.js";

export interface TeamMember {
  name: string;
  role?: string;
  bio?: string;
  /** 头像直链；缺省按 skin 头像变体画首字徽章。 */
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

export function expandTeamGrid(
  members: TeamMember[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
  avatar: "circle" | "initial" = "circle",
): SpecElement[] {
  void theme; // 组件只读 skin
  const m = skin.metrics(frame);
  const n = members.length;
  const cols = n <= 4 ? n : 3;
  const rows: TeamMember[][] = [];
  for (let i = 0; i < n; i += cols) rows.push(members.slice(i, i + cols));
  const gutter = Math.max(m.gap, Math.round(m.gap * 1.25));
  const rowFrames = splitRows(frame, rows.length, gutter);
  const nameSize = Math.max(20, Math.round(m.title * 0.68));
  const roleSize = m.label;
  const bioSize = Math.max(14, Math.round(m.caption + 2));
  const align = skin.alignExplicit ? skin.paragraphAlign : "center";
  const pad = cardPad(skin, frame);
  const elements: SpecElement[] = [];

  // 先规划全部卡框：头像尺寸全组统一（姓名基线随之对齐）。
  const planned = rows.flatMap((row, r) => {
    const rowFrame = rowFrames[r]!;
    const cells = splitColumns(rowFrame, row.length, gutter);
    return row.map((member, i) => ({ member, cell: cells[i]!, box: cardBox(skin, cells[i]!, pad) }));
  });
  const nameHs = planned.map(({ member, box }) => estimateLines(member.name, nameSize, box.w) * estimateLineHeight(nameSize) + 12);
  const roleHs = planned.map(({ member }) => (member.role ? singleLineBoxHeight(roleSize) : 0));
  const bioHs = planned.map(({ member, box }) => (member.bio
    ? estimateLines(member.bio, bioSize, box.w) * estimateLineHeight(bioSize) + 2
    : 0));

  // 统一头像尺寸：从最紧的卡反推，全部成员共用（≥56px 下限）。
  const avatarCeil = (box: Frame) => Math.min(150, Math.max(72, Math.min(Math.round(box.w * 0.78), Math.round(box.h * 0.3))));
  let avatarFit = Math.min(...planned.map(({ box }) => avatarCeil(box)));
  const gapA = Math.round(m.tightGap * 1.1);
  const gapB = Math.round(m.tightGap * 0.8);
  const fits = (size: number) => planned.every(({ box }, i) =>
    size + gapA + nameHs[i]! + roleHs[i]! + bioHs[i]! + (bioHs[i] ? gapB : 0) <= box.h);
  while (avatarFit > 56 && !fits(avatarFit)) avatarFit -= 4;
  if (!fits(avatarFit)) {
    const { member, box } = planned[0]!;
    bad(`${what}「${member.name}」内容高超过 ${Math.round(box.h)}px——精简简介或减少人数`);
  }

  planned.forEach(({ member, cell, box }, i) => {
    elements.push(...skin.paint(cell));
    const cx = box.x + box.w / 2;
    let y = box.y;

    const avatarX = align === "center" ? Math.round(cx - avatarFit / 2) : Math.round(box.x);
    if (member.image) {
      elements.push({
        type: "image",
        url: member.image,
        fit: skin.imageFit,
        circle: true,
        x: avatarX,
        y: Math.round(y),
        w: avatarFit,
        h: avatarFit,
      });
    } else {
      // avatar:circle（缺省）= 主色实心圆 + 纸色首字（最强头像占位）；
      // avatar:initial = 浅强调圆 + 强调色首字（编辑感徽章）。
      const solid = avatar === "circle";
      elements.push({
        type: "shape",
        shape: "ellipse",
        fill: solid ? skin.colors.primary : skin.colors.emphasisSoft,
        x: avatarX,
        y: Math.round(y),
        w: avatarFit,
        h: avatarFit,
      });
      const initialSize = Math.max(18, Math.round(avatarFit * 0.42));
      elements.push(
        textElement(
          { x: avatarX, y: Math.round(y + (avatarFit - singleLineBoxHeight(initialSize)) / 2), w: avatarFit, h: singleLineBoxHeight(initialSize) },
          [{
            runs: skin.heading(
              skin.initials(member.name),
              initialSize,
              solid ? skin.colors.background : skin.colors.emphasis,
            ),
            align: "center",
          }],
        ),
      );
    }
    y += avatarFit + gapA;

    elements.push(
      textElement({ x: box.x, y: Math.round(y), w: box.w, h: nameHs[i]! }, [
        { runs: skin.heading(member.name, nameSize, skin.colors.text), align },
      ]),
    );
    y += nameHs[i]!;
    if (member.role) {
      elements.push(
        textElement({ x: box.x, y: Math.round(y), w: box.w, h: roleHs[i]! }, [
          { runs: [{ ...skin.micro(member.role, skin.colors.emphasis), sizePt: roleSize }], align },
        ]),
      );
      y += roleHs[i]!;
    }
    if (member.bio) {
      // 署名与简介之间一条发丝线：把「身份」与「说明」分层（结构件，不是装饰）。
      const line = skin.dividerH(box, Math.round(y + gapB / 2));
      if (line) elements.push(line);
      y += gapB;
      elements.push(
        textElement({ x: box.x, y: Math.round(y), w: box.w, h: bioHs[i]! }, [
          { runs: skin.body(member.bio, bioSize, skin.colors.muted), align },
        ]),
      );
    }
  });
  return elements;
}
