/**
 * comparison 组件（editorial）：2~4 方对照。中央竖发丝线分栏，非重点列静音灰；
 * featured 列（可省）：tint 垫板 + 3px 主色顶条 + 「推荐」圆角签，墨色正字。
 * 要点支持三态标记：{ text, mark: "yes"|"mid"|"no" } → 钩/横/叉图标打头。
 */

import { splitColumns, type Frame } from "../../grid.js";
import type { ResolvedTheme } from "../../theme.js";
import { mixHex } from "../../theme.js";
import { bodyRuns, headingRuns, textElement, type SpecElement } from "../../elements.js";
import { estimateLineHeight, estimateLines } from "../../text-metrics.js";

export interface ComparisonPoint {
  text: string;
  /** 三态标记：yes=主色钩、mid=静音横、no=浅灰叉；缺省无图标（— 项目符）。 */
  mark?: "yes" | "mid" | "no";
}

export interface ComparisonSide {
  title: string;
  tag?: string;
  points: Array<string | ComparisonPoint>;
}

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

const MARK_ICONS: Record<"yes" | "mid" | "no", string> = {
  yes: "check-circle",
  mid: "minus",
  no: "x-mark",
};

export function expandComparison(
  sides: ComparisonSide[],
  featured: number | undefined,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
): SpecElement[] {
  const elements: SpecElement[] = [];
  const gutter = theme.spacing.gutter * 2;
  const cols = splitColumns(frame, sides.length, gutter);
  const titleSize = Math.min(22, Math.max(17, theme.sizes.subtitle - 1));
  const pointSize = Math.min(16, Math.max(13, theme.sizes.body + 1));
  const iconSize = 15;
  const hasFeatured = featured !== undefined;
  // 逐列测高：featured 列的 tint 垫板全高；内容 = 刻标(有 tag 时) + 标题 + 要点。
  const rendered = sides.map((side, i) => {
    const isFeatured = featured === i;
    const col = cols[i]!;
    // featured 列的 tag 转为徽章文案，不占内容高。
    const tagH = side.tag && !isFeatured ? estimateLineHeight(pointSize) + 6 : 0;
    const titleH = Math.max(1, estimateLines(side.title, titleSize, col.w)) * estimateLineHeight(titleSize) + 6;
    const pointH = side.points.map((p) => {
      const text = typeof p === "string" ? p : p.text;
      const prefix = typeof p === "string" ? "—　" : "　　";
      return estimateLines(`${prefix}${text}`, pointSize, col.w - (typeof p === "string" ? 0 : iconSize + 6)) * estimateLineHeight(pointSize) + 10;
    });
    const contentH = tagH + titleH + 14 + pointH.reduce((a, b) => a + b, 0);
    if (contentH > col.h) {
      bad(`${what} 第 ${i + 1} 列「${side.title}」内容高约 ${Math.round(contentH)}px 超过区域 ${Math.round(col.h)}px——精简要点或减少列`);
    }
    return { side, isFeatured, col, tagH, titleH, pointH, contentH };
  });
  const contentH = Math.max(...rendered.map((r) => r.contentH));
  const top = frame.y + Math.max(0, (frame.h - contentH) / 2);
  // 非重点列之间的竖发丝线
  rendered.forEach(({ col }, i) => {
    if (i === 0 || (hasFeatured && (i === featured! || i - 1 === featured!))) return;
    elements.push({
      type: "shape",
      shape: "rect",
      fill: theme.colors.divider,
      x: Math.round(col.x - gutter / 2),
      y: Math.round(top),
      w: 1,
      h: Math.round(contentH),
    });
  });
  rendered.forEach(({ side, isFeatured, col, tagH, titleH, pointH }, i) => {
    const ink = isFeatured || !hasFeatured ? theme.colors.text : theme.colors.textMuted;
    let y = top;
    if (isFeatured) {
      // tint 垫板全列高 + 3px 主色顶条 + 「推荐」圆角签
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: mixHex(theme.colors.primary, theme.colors.background, 0.93),
        x: Math.round(col.x - 12),
        y: Math.round(top - 14),
        w: Math.round(col.w + 24),
        h: Math.round(Math.min(frame.h, contentH + 28)),
        adj: Math.min(50000, Math.round((theme.spacing.cornerRadius / Math.max(1, col.w + 24)) * 100000)),
      });
      elements.push({ type: "shape", shape: "rect", fill: theme.colors.primary, x: Math.round(col.x - 12), y: Math.round(top - 14), w: Math.round(col.w + 24), h: 3 });
      const badgeText = side.tag || "推荐";
      const badgeW = Math.max(52, Math.round(badgeText.length * (pointSize - 2) * 1.05 + 20));
      elements.push({
        type: "shape",
        shape: "roundRect",
        fill: theme.colors.primary,
        x: Math.round(col.x - 12 + (col.w + 24 - badgeW) / 2),
        y: Math.round(top - 26),
        w: badgeW,
        h: 24,
        adj: 50000,
        paragraphs: [{ runs: [{ text: badgeText, sizePt: 10, bold: true, color: theme.colors.onDarkText }] }],
        valign: "middle",
      });
    } else if (side.tag) {
      // 非重点列的 tag：主色小字刻标
      elements.push(
        textElement({ x: col.x, y, w: col.w, h: tagH }, [
          { runs: [{ text: side.tag, sizePt: pointSize - 2, bold: true, color: theme.colors.primary }] },
        ]),
      );
      y += tagH;
    }
    elements.push(
      textElement({ x: col.x, y: y + (isFeatured ? 14 : 0), w: col.w, h: titleH }, [
        { runs: headingRuns(side.title, titleSize, ink, theme) },
      ]),
    );
    y += (isFeatured ? 14 : 0) + titleH + 14;
    side.points.forEach((point, j) => {
      const h = pointH[j]!;
      if (typeof point === "string") {
        elements.push(
          textElement({ x: col.x, y, w: col.w, h }, [
            { runs: bodyRuns(`—　${point}`, pointSize, ink, theme) },
          ]),
        );
      } else {
        const markColor =
          point.mark === "yes" ? theme.colors.primary : point.mark === "mid" ? theme.colors.textMuted : mixHex(theme.colors.text, theme.colors.background, 0.68);
        elements.push({
          type: "icon",
          icon: MARK_ICONS[point.mark ?? "mid"],
          color: markColor,
          x: Math.round(col.x + (isFeatured ? 14 : 0)),
          y: Math.round(y + 2),
          w: iconSize,
          h: iconSize,
        });
        elements.push(
          textElement({ x: col.x + (isFeatured ? 14 : 0) + iconSize + 6, y, w: col.w - iconSize - 6, h }, [
            { runs: bodyRuns(point.text, pointSize, ink, theme) },
          ]),
        );
      }
      y += h;
    });
  });
  return elements;
}
