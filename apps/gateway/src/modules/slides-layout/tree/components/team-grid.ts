/**
 * teamGrid 组件（editorial）：2~6 人团队网格。圆形头像 + 姓名 + 职位（主色小字）
 * + 两行简介；≤4 人单行，5~6 人两行（每行 3 个）。整组在框内垂直居中。
 */

import { splitColumns, splitRows, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface TeamMember {
  name: string;
  role?: string;
  bio?: string;
  /** 头像直链；缺省画 user 图标占位。 */
  image?: string;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export function expandTeamGrid(members: TeamMember[], frame: Frame, theme: ResolvedTheme, what: string): SpecElement[] {
  const n = members.length;
  const cols = n <= 4 ? n : 3;
  const rows: TeamMember[][] = [];
  for (let i = 0; i < n; i += cols) rows.push(members.slice(i, i + cols));
  const rowFrames = splitRows(frame, rows.length, theme.spacing.gutter * 2);
  const nameSize = Math.min(17, Math.max(15, theme.sizes.body + 2));
  const metaSize = theme.sizes.caption;
  const elements: SpecElement[] = [];
  rows.forEach((row, r) => {
    const rowFrame = rowFrames[r]!;
    const cells = splitColumns(rowFrame, row.length, theme.spacing.gutter * 2);
    row.forEach((member, i) => {
      const cell = cells[i]!;
      const avatarSize = Math.round(Math.min(88, cell.h * 0.42, cell.w * 0.5));
      const nameH = estimateLines(member.name, nameSize, cell.w) * estimateLineHeight(nameSize) + 4;
      const roleH = member.role ? estimateLineHeight(metaSize) + 2 : 0;
      const bioH = member.bio ? estimateLines(member.bio, metaSize, cell.w) * estimateLineHeight(metaSize) : 0;
      const gap = 8;
      const need = avatarSize + gap + nameH + roleH + (member.bio ? 6 + bioH : 0);
      if (need > cell.h) {
        bad(`${what}「${member.name}」内容高约 ${Math.round(need)}px 超过 ${Math.round(cell.h)}px——精简简介或减少人数`);
      }
      // 整卡在 cell 内垂直居中
      let y = cell.y + Math.max(0, (cell.h - need) / 2);
      const cx = cell.x + cell.w / 2;
      if (member.image) {
        elements.push({
          type: "image",
          url: member.image,
          fit: "cover",
          circle: true,
          x: Math.round(cx - avatarSize / 2),
          y: Math.round(y),
          w: avatarSize,
          h: avatarSize,
        });
      } else {
        elements.push({
          type: "icon",
          icon: "user",
          color: theme.colors.primary,
          x: Math.round(cx - avatarSize / 2),
          y: Math.round(y),
          w: avatarSize,
          h: avatarSize,
        });
      }
      y += avatarSize + gap;
      elements.push(
        textElement({ x: cell.x, y, w: cell.w, h: nameH }, [
          { runs: headingRuns(member.name, nameSize, theme.colors.text, theme), align: "center" },
        ]),
      );
      y += nameH;
      if (member.role) {
        elements.push(
          textElement({ x: cell.x, y, w: cell.w, h: roleH }, [
            { runs: bodyRuns(member.role, metaSize, theme.colors.primary, theme), align: "center" },
          ]),
        );
        y += roleH;
      }
      if (member.bio) {
        elements.push(
          textElement({ x: cell.x, y: y + 6, w: cell.w, h: bioH }, [
            { runs: bodyRuns(member.bio, metaSize, theme.colors.textMuted, theme), align: "center" },
          ]),
        );
      }
    });
  });
  return elements;
}
