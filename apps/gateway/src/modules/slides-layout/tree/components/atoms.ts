/**
 * 参考 BP 抽出的页面级原子：
 * - founderProfile：创始人履历（竖向节点 / 左轨履历）
 * - radialFunnel：中心辐射 → 漏斗汇聚 → 结论
 * - kpiRows：左标签胶囊 + 大数字 + 注脚
 * - categoryCards：四栏“蓝色标题条 + 图形 + 指标”卡片（无照片时的图像卡替代）
 *
 * 组件只读 frame/theme/skin，不写裸坐标/字号；内容放不下时抛 LAYOUT_LEAF_INVALID。
 */

import type { Frame } from "../../grid.js";
import { withAlpha, type ResolvedTheme } from "../../theme.js";
import type { ComponentSkin } from "./kit.js";
import { textElement, type SpecElement } from "../../elements.js";
import { estimateTextWidth, singleLineBoxHeight, textBoxHeight } from "../../text-metrics.js";

function bad(message: string): never {
  throw new Error(`LAYOUT_LEAF_INVALID: ${message}`);
}

export interface FounderColumn {
  title: string;
  meta?: string;
  text: string;
}

export interface FounderSection {
  label?: string;
  heading: string;
  bullets?: string[];
  columns?: FounderColumn[];
  /** columns 是否画横向公司时间轴；缺省 true。 */
  timeline?: boolean;
  /** 相对高度；缺省 1。 */
  weight?: number;
}

export interface FounderProfileInput {
  personName: string;
  role?: string;
  subtitle?: string;
  variant?: "timeline" | "resume";
  /** false = 页面已有 sectionHeader，组件只画履历正文。 */
  showHeader?: boolean;
  sections: FounderSection[];
  skills?: { title: string; text: string }[];
}

function text(
  frame: Frame,
  runs: { text: string; sizePt: number; color: string; font?: string; bold?: boolean }[],
  align: "left" | "center" = "left",
): SpecElement {
  return textElement(frame, [{ runs, align }]);
}

function ellipse(frame: Frame, color: string, outline = false): SpecElement {
  return {
    type: "shape",
    shape: "ellipse",
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    w: Math.max(1, Math.round(frame.w)),
    h: Math.max(1, Math.round(frame.h)),
    ...(outline ? { fill: "#00000000", stroke: { color, widthPt: 1 } } : { fill: color }),
  };
}

export function expandFounderProfile(
  leaf: FounderProfileInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = skin.surfaceExplicit
    ? [...skin.paint(frame), ...skin.motifDecor(frame, "top")]
    : [];
  const box = skin.surfaceExplicit ? skin.contentBox(frame) : frame;
  const m = skin.metrics(box);
  const showHeader = leaf.showHeader !== false;
  const headerH = showHeader ? Math.min(Math.round(box.h * 0.2), Math.round(m.title * 2.6)) : 0;
  if (showHeader) {
    const initials = skin.initials(leaf.personName);
    const avatar = Math.min(headerH - 8, Math.round(box.w * 0.08));
    elements.push(ellipse({ x: box.x, y: box.y + 4, w: avatar, h: avatar }, skin.colors.emphasisSoft));
    elements.push(
      text({ x: box.x, y: box.y + 4 + Math.round((avatar - singleLineBoxHeight(m.title)) / 2), w: avatar, h: singleLineBoxHeight(m.title) }, [
        { text: initials, sizePt: m.title, color: skin.colors.emphasis, bold: true, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
      ], "center"),
    );
    const headX = box.x + avatar + m.gap;
    const headW = box.w - avatar - m.gap;
    const nameSize = Math.min(m.title, Math.round(headerH * 0.34));
    let y = box.y + 2;
    elements.push(text({ x: headX, y, w: headW, h: singleLineBoxHeight(nameSize) }, [
      { text: leaf.personName, sizePt: nameSize, color: skin.colors.text, bold: true, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
      ...(leaf.role ? [{ text: `  ${leaf.role}`, sizePt: Math.max(m.body, Math.round(nameSize * 0.52)), color: skin.colors.muted }] : []),
    ]));
    y += singleLineBoxHeight(nameSize) + Math.round(m.gap * 0.5);
    if (leaf.subtitle) {
      elements.push(text({ x: headX, y, w: headW, h: singleLineBoxHeight(m.body) }, [
        { text: leaf.subtitle, sizePt: m.body, color: skin.colors.muted },
      ]));
    }
  }

  const skillsH = leaf.skills?.length ? Math.max(0, Math.round(box.h * 0.18)) : 0;
  const bodyTop = box.y + headerH + (showHeader ? Math.round(m.gap * 0.8) : 0);
  const bodyBottom = box.y + box.h - skillsH - (skillsH ? m.gap : 0);
  const bodyH = bodyBottom - bodyTop;
  if (bodyH < 60) bad(`${what} 履历正文区域过小（${Math.round(bodyH)}px）`);
  const sections = leaf.sections;
  const weights = sections.map((section) => Math.max(0.5, Math.min(2.2, section.weight ?? 1)));
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const gaps = m.gap * (sections.length - 1);
  const unit = (bodyH - gaps) / weightSum;
  if (unit < 44) bad(`${what} 履历条目过多，正文每行不足 44px——减少 sections`);
  const railW = leaf.variant === "resume" ? Math.round(box.w * 0.14) : Math.round(box.w * 0.055);
  const railX = box.x + Math.round(railW * 0.5);
  const contentX = box.x + railW;
  const contentW = box.w - railW;
  const dot = Math.max(9, Math.round(m.body * 0.7));
  const bodySize = Math.max(11, Math.min(m.body, Math.round(box.h * 0.034)));
  elements.push({ type: "shape", shape: "rect", fill: skin.colors.divider, x: railX, y: bodyTop, w: 2, h: bodyH });
  let cursor = bodyTop;
  sections.forEach((section, i) => {
    const rowH = Math.round(unit * weights[i]!);
    const top = cursor;
    cursor += rowH + m.gap;
    let headingSize = Math.max(12, Math.min(m.title, Math.round(box.h * 0.045), Math.round(rowH * 0.3)));
    while (headingSize > 10 && estimateTextWidth(section.heading, headingSize) > contentW - 12) headingSize -= 1;
    const headingH = singleLineBoxHeight(headingSize);
    elements.push(ellipse({ x: railX - Math.round(dot / 2) + 1, y: top + Math.round(headingH / 2) - Math.round(dot / 2), w: dot, h: dot }, skin.colors.emphasis));
    if (section.label) {
      elements.push(text({ x: box.x, y: top, w: railW - m.gap, h: singleLineBoxHeight(Math.max(9, Math.round(box.h * 0.025))) }, [
        { text: section.label, sizePt: Math.max(9, Math.round(box.h * 0.025)), color: skin.colors.muted, bold: true },
      ], "center"));
    }
    elements.push(text({ x: contentX + 8, y: top, w: contentW - 8, h: headingH }, [
      { text: section.heading, sizePt: headingSize, color: skin.colors.emphasis, bold: true, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
    ]));
    const contentTop = top + headingH + Math.round(m.gap * 0.45);
    const contentH = rowH - headingH - Math.round(m.gap * 0.45);
    if (section.columns?.length) {
      const colGap = Math.round(m.gap * 1.1);
      const cellW = Math.floor((contentW - 8 - colGap * (section.columns.length - 1)) / section.columns.length);
      const titleSize = Math.max(12, Math.min(18, Math.round(bodySize * 1.15)));
      const metaSize = Math.max(9, Math.round(bodySize * 0.85));
      const titleH = singleLineBoxHeight(titleSize);
      const timeline = section.timeline !== false;
      const lineY = contentTop + titleH + 10;
      if (timeline) {
        const firstX = contentX + 8;
        const lastX = contentX + 8 + (section.columns.length - 1) * (cellW + colGap) + cellW;
        elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x: firstX, y: lineY, w: Math.max(2, lastX - firstX), h: 2 });
      }
      section.columns.forEach((column, j) => {
        const cx = contentX + 8 + j * (cellW + colGap);
        elements.push(text({ x: cx, y: contentTop, w: cellW, h: titleH }, [
          { text: column.title, sizePt: titleSize, color: skin.colors.emphasis, bold: true },
          ...(column.meta ? [{ text: `  ${column.meta}`, sizePt: metaSize, color: skin.colors.muted }] : []),
        ]));
        if (timeline) {
          const dot = 10;
          elements.push({ type: "shape", shape: "ellipse", fill: skin.colors.emphasis, x: cx, y: lineY - dot / 2 + 1, w: dot, h: dot });
        }
        const textH = textBoxHeight(column.text, bodySize, cellW);
        const textTop = contentTop + titleH + (timeline ? 22 : Math.round(m.gap * 0.4));
        const required = titleH + (timeline ? 22 : m.gap) + textH;
        if (required > contentH + 2) {
          bad(`${what}「${column.title}」栏内容高约 ${Math.round(required)}px 超过 ${contentH}px——精简 columns`);
        }
        elements.push(text({ x: cx, y: textTop, w: cellW, h: textH }, [
          { text: column.text, sizePt: bodySize, color: skin.colors.text },
        ]));
      });
    } else {
      const bulletText = (section.bullets ?? []).map((bullet) => `• ${bullet}`).join("\n");
      const needed = textBoxHeight(bulletText, bodySize, contentW - 20);
      if (needed > contentH + 2) {
        bad(`${what}「${section.heading}」内容高约 ${Math.round(needed)}px 超过 ${contentH}px——精简 bullets`);
      }
      elements.push(text({ x: contentX + 8, y: contentTop, w: contentW - 8, h: contentH }, [
        { text: bulletText, sizePt: bodySize, color: skin.colors.text },
      ]));
    }
  });

  if (leaf.skills?.length) {
    const top = box.y + box.h - skillsH;
    const cellW = Math.floor((box.w - m.gap * (leaf.skills.length - 1)) / leaf.skills.length);
    leaf.skills.forEach((skill, i) => {
      const x = box.x + i * (cellW + m.gap);
      elements.push({ type: "shape", shape: "rect", fill: skin.colors.divider, x, y: top, w: 2, h: skillsH });
      elements.push(text({ x: x + 12, y: top + 4, w: cellW - 12, h: singleLineBoxHeight(m.body) }, [
        { text: skill.title, sizePt: m.body, color: skin.colors.emphasis, bold: true },
      ]));
      elements.push(text({ x: x + 12, y: top + singleLineBoxHeight(m.body) + m.gap, w: cellW - 12, h: skillsH - singleLineBoxHeight(m.body) - m.gap }, [
        { text: skill.text, sizePt: m.caption, color: skin.colors.text },
      ]));
    });
  }
  return elements;
}

export interface RadialFunnelInput {
  centerTitle: string;
  centerSubtitle?: string;
  satellites: string[];
  bridge?: string;
  conclusionTitle: string;
  conclusionBody?: string;
  footnote?: string;
}

export function expandRadialFunnel(
  leaf: RadialFunnelInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const bottom = leaf.footnote ? Math.round(frame.h * 0.14) : 0;
  const box = { x: frame.x, y: frame.y, w: frame.w, h: frame.h - bottom };
  const centerD = Math.min(box.w * 0.3, box.h * 0.6);
  const cx = box.x + box.w * 0.32;
  const cy = box.y + box.h * 0.5;
  const center = { x: cx - centerD / 2, y: cy - centerD / 2, w: centerD, h: centerD };
  const satelliteD = Math.min(box.w * 0.105, box.h * 0.16);
  const satellites = leaf.satellites.slice(0, 6);
  const radius = centerD * 0.82 + satelliteD * 0.15;
  const angles = [150, 182, 214, 108, 252, 128];
  const positions = satellites.map((_, i) => {
    const angle = (angles[i] ?? 180) * Math.PI / 180;
    return {
      x: Math.max(box.x, Math.min(box.x + box.w - satelliteD, cx + Math.cos(angle) * radius - satelliteD / 2)),
      y: Math.max(box.y, Math.min(box.y + box.h - satelliteD - 18, cy + Math.sin(angle) * radius - satelliteD / 2)),
    };
  });
  satellites.forEach((label, i) => {
    const p = positions[i]!;
    const filled = i % 2 === 0;
    elements.push(ellipse({ x: p.x, y: p.y, w: satelliteD, h: satelliteD }, filled ? skin.colors.emphasis : skin.colors.emphasisSoft, !filled));
    const labelSize = Math.max(9, Math.min(13, Math.round(satelliteD * 0.14)));
    elements.push(text({ x: p.x + 4, y: p.y + Math.round((satelliteD - labelSize * 1.35) / 2), w: satelliteD - 8, h: Math.round(satelliteD * 0.55) }, [
      { text: label, sizePt: labelSize, color: filled ? skin.colors.inverse : skin.colors.text, bold: true },
    ], "center"));
  });
  elements.push(ellipse(center, skin.colors.emphasis));
  const centerTitleSize = Math.max(16, Math.round(centerD * 0.12));
  elements.push(text({ x: center.x + 10, y: center.y + Math.round(centerD * 0.3), w: center.w - 20, h: Math.round(centerD * 0.25) }, [
    { text: leaf.centerTitle, sizePt: centerTitleSize, color: skin.colors.inverse, bold: true },
  ], "center"));
  if (leaf.centerSubtitle) {
    elements.push(text({ x: center.x + 10, y: center.y + Math.round(centerD * 0.56), w: center.w - 20, h: Math.round(centerD * 0.25) }, [
      { text: leaf.centerSubtitle, sizePt: Math.max(11, Math.round(centerTitleSize * 0.6)), color: skin.colors.inverse },
    ], "center"));
  }
  // 参考 p5 的宽箭头：尾段是梯形，右侧是明确的三角箭头。
  const arrow = {
    x: box.x + box.w * 0.6,
    y: box.y + box.h * 0.22,
    w: box.w * 0.2,
    h: box.h * 0.56,
  };
  const headBase = arrow.x + arrow.w * 0.58;
  const tip = arrow.x + arrow.w;
  const midY = arrow.y + arrow.h / 2;
  const d = `M ${arrow.x.toFixed(1)} ${arrow.y.toFixed(1)} L ${headBase.toFixed(1)} ${(arrow.y + arrow.h * 0.04).toFixed(1)} L ${headBase.toFixed(1)} ${(arrow.y - arrow.h * 0.18).toFixed(1)} L ${tip.toFixed(1)} ${midY.toFixed(1)} L ${headBase.toFixed(1)} ${(arrow.y + arrow.h * 1.18).toFixed(1)} L ${headBase.toFixed(1)} ${(arrow.y + arrow.h * 0.96).toFixed(1)} L ${arrow.x.toFixed(1)} ${(arrow.y + arrow.h).toFixed(1)} Z`;
  elements.push({ type: "path", d, fill: skin.colors.emphasisSoft, x: Math.round(arrow.x), y: Math.round(arrow.y - arrow.h * 0.18), w: Math.round(arrow.w), h: Math.round(arrow.h * 1.36) });
  if (leaf.bridge) {
    const bridgeD = Math.min(box.w * 0.15, box.h * 0.22);
    const bx = box.x + box.w * 0.5;
    const by = cy - bridgeD * 0.55;
    elements.push({ type: "shape", shape: "ellipse", fill: skin.colors.background, stroke: { color: skin.colors.emphasis, widthPt: 1 }, x: Math.round(bx), y: Math.round(by), w: Math.round(bridgeD), h: Math.round(bridgeD) });
    elements.push(text({ x: bx + 4, y: by + Math.round(bridgeD * 0.2), w: bridgeD - 8, h: Math.round(bridgeD * 0.6) }, [
      { text: leaf.bridge, sizePt: Math.max(9, Math.round(bridgeD * 0.12)), color: skin.colors.text, bold: true },
    ], "center"));
  }
  const conclusionSize = Math.min(box.w * 0.16, box.h * 0.56);
  const conclusion = {
    x: box.x + box.w * 0.82,
    y: box.y + (box.h - conclusionSize) / 2,
    w: conclusionSize,
    h: conclusionSize,
  };
  elements.push(ellipse(conclusion, skin.colors.emphasis, true));
  const conclusionTitleY = conclusion.y + Math.round(conclusion.h * (leaf.conclusionBody ? 0.2 : 0.28));
  elements.push(text({ x: conclusion.x + 10, y: conclusionTitleY, w: conclusion.w - 20, h: Math.round(conclusion.h * 0.4) }, [
    { text: leaf.conclusionTitle, sizePt: Math.max(11, Math.round(conclusion.w * 0.075)), color: skin.colors.text, bold: true },
  ], "center"));
  if (leaf.conclusionBody) {
    elements.push(text({ x: conclusion.x + 12, y: conclusionTitleY + Math.round(conclusion.h * 0.32), w: conclusion.w - 24, h: Math.round(conclusion.h * 0.34) }, [
      { text: leaf.conclusionBody, sizePt: Math.max(9, Math.round(conclusion.w * 0.045)), color: skin.colors.muted },
    ], "center"));
  }
  if (leaf.footnote) {
    elements.push(text({ x: frame.x, y: frame.y + frame.h - bottom, w: frame.w, h: bottom - 4 }, [
      { text: leaf.footnote, sizePt: Math.max(9, Math.round(frame.h * 0.022)), color: skin.colors.muted },
    ], "center"));
  }
  return elements;
}

// skin.metrics 的 label 不在局部对象上；用一个稳定回退，避免直接写裸 pt。
function skinLabel(skin: ComponentSkin, reference: number): number {
  return Math.max(9, Math.min(16, Math.round(reference * 0.08)));
}

export interface KpiRow {
  label: string;
  value: string;
  note?: string;
}

export function expandKpiRows(
  rows: KpiRow[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const gap = Math.round(frame.h * 0.035);
  const rowH = Math.floor((frame.h - gap * (rows.length - 1)) / rows.length);
  if (rowH < 28) bad(`${what} KPI 行过密（每行 ${rowH}px）——减少 rows`);
  rows.forEach((row, i) => {
    const y = frame.y + i * (rowH + gap);
    const pillW = Math.round(frame.w * 0.34);
    const pillH = Math.min(rowH - 4, Math.round(rowH * 0.62));
    elements.push({
      type: "shape", shape: "rect", fill: skin.colors.emphasisSoft,
      x: Math.round(frame.x), y: Math.round(y + (rowH - pillH) / 2), w: pillW, h: pillH,
    });
    elements.push(text({ x: frame.x + 8, y: y + Math.round((rowH - singleLineBoxHeight(Math.max(9, Math.round(rowH * 0.25)))) / 2), w: pillW - 16, h: singleLineBoxHeight(Math.max(9, Math.round(rowH * 0.25))) }, [
      { text: row.label, sizePt: Math.max(9, Math.round(rowH * 0.25)), color: skin.colors.emphasis, bold: true },
    ]));
    const valueSize = Math.max(14, Math.round(rowH * 0.52));
    elements.push(text({ x: frame.x + pillW + 12, y: y + Math.round((rowH - singleLineBoxHeight(valueSize)) / 2), w: Math.round(frame.w * 0.3), h: singleLineBoxHeight(valueSize) }, [
      { text: row.value, sizePt: valueSize, color: skin.colors.text, bold: true, ...(skin.fonts.numeral ? { font: skin.fonts.numeral } : {}) },
    ]));
    if (row.note) {
      elements.push(text({ x: frame.x + pillW + Math.round(frame.w * 0.3) + 22, y: y + Math.round((rowH - singleLineBoxHeight(Math.max(9, Math.round(rowH * 0.2)))) / 2), w: frame.w - pillW - Math.round(frame.w * 0.3) - 26, h: singleLineBoxHeight(Math.max(9, Math.round(rowH * 0.2))) }, [
        { text: row.note, sizePt: Math.max(9, Math.round(rowH * 0.2)), color: skin.colors.muted },
      ]));
    }
    if (i < rows.length - 1) {
      elements.push({ type: "shape", shape: "rect", fill: skin.colors.divider, x: Math.round(frame.x), y: Math.round(y + rowH + Math.round(gap / 2)), w: Math.round(frame.w), h: 1 });
    }
  });
  return elements;
}

export interface CategoryCard {
  title: string;
  metric: string;
  note?: string;
  imageUrl?: string;
}

export function expandCategoryCards(
  items: CategoryCard[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const gap = Math.round(frame.w * 0.02);
  const cellW = Math.floor((frame.w - gap * (items.length - 1)) / items.length);
  items.forEach((item, i) => {
    const x = frame.x + i * (cellW + gap);
    const headH = Math.round(frame.h * 0.18);
    const cardH = frame.h;
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x: Math.round(x), y: Math.round(frame.y), w: cellW, h: headH });
    elements.push(text({ x: x + 8, y: frame.y + Math.round((headH - singleLineBoxHeight(Math.max(10, Math.round(headH * 0.3)))) / 2), w: cellW - 16, h: singleLineBoxHeight(Math.max(10, Math.round(headH * 0.3))) }, [
      { text: item.title, sizePt: Math.max(10, Math.round(headH * 0.3)), color: skin.colors.inverse, bold: true },
    ]));
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.card, x: Math.round(x), y: Math.round(frame.y + headH), w: cellW, h: cardH - headH });
    const bodyH = cardH - headH;
    if (item.imageUrl) {
      const imageH = Math.round(bodyH * 0.66);
      elements.push({ type: "image", url: item.imageUrl, fit: "cover", x: Math.round(x), y: Math.round(frame.y + headH), w: cellW, h: imageH });
      if (item.note) {
        elements.push(text({ x: x + 10, y: frame.y + headH + imageH + 6, w: cellW - 20, h: bodyH - imageH - 10 }, [
          { text: item.note, sizePt: Math.max(9, Math.round(bodyH * 0.07)), color: skin.colors.text },
        ]));
      }
    } else {
      const metricSize = Math.max(16, Math.min(30, Math.round(bodyH * 0.16)));
      const metricH = singleLineBoxHeight(metricSize);
      const metricY = frame.y + headH + Math.round(bodyH * 0.18);
      elements.push(text({ x: x + 10, y: metricY, w: cellW - 20, h: metricH }, [
        { text: item.metric, sizePt: metricSize, color: skin.colors.emphasis, bold: true },
      ]));
      if (item.note) {
        const noteY = metricY + metricH + Math.round(bodyH * 0.08);
        const noteH = Math.max(16, frame.y + cardH - noteY - 8);
        elements.push(text({ x: x + 10, y: noteY, w: cellW - 20, h: noteH }, [
          { text: item.note, sizePt: Math.max(9, Math.round(bodyH * 0.075)), color: skin.colors.text },
        ]));
      }
    }
  });
  return elements;
}

export interface FeatureRailInput {
  params: { label: string; value: string }[];
  features: { title: string; text: string }[];
  imageUrl?: string;
}

/** 产品特征页：左侧参数块 + 中间曲线节点 + 右侧说明（对齐参考 p13）。 */
export function expandFeatureRail(
  leaf: FeatureRailInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const footerH = Math.round(frame.h * 0.04);
  const body = { x: frame.x, y: frame.y, w: frame.w, h: frame.h - footerH };
  const paramW = Math.round(body.w * 0.28);
  const featureX = body.x + Math.round(body.w * 0.34);
  const textX = body.x + Math.round(body.w * 0.56);
  const textW = body.w - (textX - body.x);
  const rowH = Math.floor(body.h / leaf.features.length);
  if (rowH < 54) bad(`${what} 特征条目过多（每行 ${rowH}px）——减少 features`);
  const rail = body.x + Math.round(body.w * 0.4);
  const points: { x: number; y: number }[] = leaf.features.map((_, i) => ({
    x: rail,
    y: body.y + Math.round(rowH * (i + 0.5)),
  }));
  if (points.length > 1) {
    let d = `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]!;
      const next = points[i]!;
      const midY = (prev.y + next.y) / 2;
      d += ` C ${(prev.x + 20).toFixed(1)} ${midY.toFixed(1)} ${(next.x + 20).toFixed(1)} ${midY.toFixed(1)} ${next.x.toFixed(1)} ${next.y.toFixed(1)}`;
    }
    elements.push({ type: "path", d, stroke: { color: skin.colors.emphasis, widthPt: 1.6 }, x: Math.round(rail - 20), y: Math.round(body.y), w: 40, h: Math.round(body.h) });
  }
  leaf.features.forEach((feature, i) => {
    const y = body.y + i * rowH;
    const dot = Math.max(10, Math.round(rowH * 0.16));
    elements.push(ellipse({ x: rail - dot / 2, y: y + Math.round(rowH * 0.5) - dot / 2, w: dot, h: dot }, skin.colors.emphasis));
    const pillW = Math.round(body.w * 0.2);
    const pillH = Math.min(rowH - 6, Math.round(rowH * 0.36));
    elements.push({ type: "shape", shape: "roundRect", adj: 50000, fill: skin.colors.emphasis, x: featureX, y: y + Math.round((rowH - pillH) / 2), w: pillW, h: pillH });
    elements.push(text({ x: featureX + 8, y: y + Math.round((rowH - singleLineBoxHeight(Math.max(10, Math.round(pillH * 0.38)))) / 2), w: pillW - 16, h: singleLineBoxHeight(Math.max(10, Math.round(pillH * 0.38))) }, [
      { text: feature.title, sizePt: Math.max(10, Math.round(pillH * 0.38)), color: skin.colors.inverse, bold: true },
    ]));
    const bodySize = Math.max(10, Math.round(rowH * 0.13));
    const needed = textBoxHeight(feature.text, bodySize, textW);
    if (needed > rowH + 4) bad(`${what}「${feature.title}」说明高约 ${Math.round(needed)}px 超过 ${rowH}px——精简 text`);
    elements.push(text({ x: textX, y: y + Math.round((rowH - needed) / 2), w: textW, h: needed }, [
      { text: feature.text, sizePt: bodySize, color: skin.colors.text },
    ]));
  });
  // 左侧媒体 + 参数块：有图时上半图、下半参数；无图时回到纯参数。
  const mediaH = leaf.imageUrl ? Math.round(body.h * 0.46) : 0;
  if (leaf.imageUrl) {
    elements.push({ type: "image", url: leaf.imageUrl, fit: "cover", x: Math.round(body.x), y: Math.round(body.y), w: paramW, h: mediaH });
    // 同心圆只是技术图注记，不挡图。
    const ringR = Math.min(mediaH, paramW) * 0.42;
    const rcx = body.x + paramW / 2;
    const rcy = body.y + mediaH / 2;
    for (const scale of [1, 0.68, 0.36]) {
      const r = ringR * scale;
      elements.push({ type: "shape", shape: "ellipse", fill: "#00000000", stroke: { color: "#45D6FF", widthPt: 0.8 }, x: Math.round(rcx - r), y: Math.round(rcy - r), w: Math.round(r * 2), h: Math.round(r * 2) });
    }
  }
  const paramTop = leaf.imageUrl ? body.y + mediaH + 10 : body.y + Math.round(body.h * 0.08);
  const paramH = leaf.imageUrl ? body.h - mediaH - 18 : body.h - Math.round(body.h * 0.16);
  elements.push({ type: "shape", shape: "roundRect", fill: skin.colors.emphasis, x: body.x, y: paramTop, w: Math.max(24, Math.round(body.w * 0.035)), h: paramH });
  const paramTitleSize = Math.max(11, Math.round(body.h * 0.032));
  const paramTitleH = singleLineBoxHeight(paramTitleSize);
  elements.push(text({ x: body.x + Math.round(body.w * 0.055), y: paramTop, w: paramW, h: paramTitleH }, [
    { text: "基本飞行参数", sizePt: paramTitleSize, color: skin.colors.emphasis, bold: true },
  ]));
  const paramStart = paramTop + paramTitleH + 8;
  const paramRowH = Math.min(28, Math.floor((paramH - paramTitleH - 12) / leaf.params.length));
  leaf.params.forEach((param, i) => {
    const y = paramStart + i * paramRowH;
    const size = Math.max(9, Math.min(14, Math.round(paramRowH * 0.42)));
    elements.push(text({ x: body.x + Math.round(body.w * 0.055), y, w: paramW, h: singleLineBoxHeight(size) }, [
      { text: param.label, sizePt: size, color: skin.colors.muted },
      { text: `  ${param.value}`, sizePt: size, color: skin.colors.text, bold: true },
    ]));
  });
  return elements;
}

export interface AdvantageGridInput {
  pros: { title: string; text: string }[];
  cons: string[];
  conclusion: string;
  prosLabel?: string;
  consLabel?: string;
  caption?: string;
}

/** 优点卡阵 + 缺点列 + 底部结论条（对齐参考 p11）。 */
export function expandAdvantageGrid(
  leaf: AdvantageGridInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const labelH = leaf.prosLabel || leaf.consLabel ? 28 : 0;
  const captionH = leaf.caption ? 22 : 0;
  const bannerH = Math.round(frame.h * 0.15);
  const gridTop = frame.y + labelH + 6;
  const gridH = frame.h - labelH - bannerH - captionH - Math.round(frame.h * 0.07);
  const bannerY = frame.y + frame.h - captionH - bannerH;
  const consW = leaf.cons.length ? Math.round(frame.w * 0.2) : 0;
  const gridW = frame.w - consW - (consW ? Math.round(frame.w * 0.03) : 0);
  const cols = Math.min(3, Math.max(1, leaf.pros.length));
  const rows = Math.ceil(leaf.pros.length / cols);
  const cardW = Math.floor((gridW - (cols - 1) * 12) / cols);
  const cardH = Math.floor((gridH - (rows - 1) * 12) / rows);
  const labelSize = Math.max(11, Math.round(frame.h * 0.045));
  if (leaf.prosLabel) {
    elements.push(text({ x: frame.x, y: frame.y, w: gridW, h: labelH }, [
      { text: leaf.prosLabel, sizePt: labelSize, color: skin.colors.emphasis, bold: true },
    ]));
  }
  if (leaf.consLabel && consW) {
    elements.push(text({ x: frame.x + gridW + Math.round(frame.w * 0.03), y: frame.y, w: consW, h: labelH }, [
      { text: leaf.consLabel, sizePt: labelSize, color: skin.colors.emphasis, bold: true },
    ]));
  }
  leaf.pros.forEach((pro, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = frame.x + col * (cardW + 12);
    const y = gridTop + row * (cardH + 12);
    const headH = Math.round(cardH * 0.28);
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x, y, w: cardW, h: headH });
    elements.push(text({ x: x + 8, y: y + Math.round((headH - singleLineBoxHeight(Math.max(10, Math.round(headH * 0.36)))) / 2), w: cardW - 16, h: singleLineBoxHeight(Math.max(10, Math.round(headH * 0.36))) }, [
      { text: pro.title, sizePt: Math.max(10, Math.round(headH * 0.36)), color: skin.colors.inverse, bold: true },
    ]));
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.card, x, y: y + headH, w: cardW, h: cardH - headH });
    const bodySize = Math.max(9, Math.round(cardH * 0.075));
    elements.push(text({ x: x + 10, y: y + headH + 10, w: cardW - 20, h: cardH - headH - 16 }, [
      { text: pro.text, sizePt: bodySize, color: skin.colors.text },
    ]));
  });
  leaf.cons.forEach((con, i) => {
    const x = frame.x + gridW + Math.round(frame.w * 0.03);
    const y = gridTop + Math.round((i + 0.5) * (gridH / leaf.cons.length)) - 20;
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasisSoft, x, y, w: consW, h: Math.max(30, Math.round(gridH * 0.12)) });
    elements.push(text({ x: x + 8, y: y + 8, w: consW - 16, h: Math.max(16, Math.round(gridH * 0.06)) }, [
      { text: con, sizePt: Math.max(9, Math.round(gridH * 0.035)), color: skin.colors.emphasis, bold: true },
    ]));
  });
  elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x: frame.x, y: bannerY, w: frame.w, h: bannerH });
  elements.push(text({ x: frame.x + 10, y: bannerY + Math.round((bannerH - singleLineBoxHeight(Math.max(11, Math.round(bannerH * 0.32)))) / 2), w: frame.w - 20, h: singleLineBoxHeight(Math.max(11, Math.round(bannerH * 0.32))) }, [
    { text: leaf.conclusion, sizePt: Math.max(11, Math.round(bannerH * 0.32)), color: skin.colors.inverse, bold: true },
  ], "center"));
  if (leaf.caption) {
    elements.push(text({ x: frame.x + 10, y: bannerY + bannerH + 4, w: frame.w - 20, h: captionH - 4 }, [
      { text: leaf.caption, sizePt: Math.max(9, Math.round(frame.h * 0.025)), color: skin.colors.muted },
    ], "center"));
  }
  return elements;
}

export interface SectionHeaderInput {
  title: string;
  subtitle?: string;
  marker?: boolean;
}

/** 参考 BP 的章节头：三枚 chevron + 标题 + 副标题（p2/p3/p5/p6/p7/p11/p13 共用）。 */
export function expandSectionHeader(
  input: SectionHeaderInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const box = frame;
  const markerW = input.marker === false ? 0 : Math.min(76, Math.round(box.h * 0.55));
  const markerH = Math.min(34, Math.round(box.h * 0.28));
  if (markerW > 0) {
    const gap = Math.max(4, Math.round(markerW * 0.08));
    const each = Math.round((markerW - gap * 4) / 3);
    let d = "";
    for (let i = 0; i < 3; i++) {
      const x = box.x + i * (each + gap);
      const y = box.y + Math.round((box.h - markerH) / 2);
      d += `M ${x} ${y} L ${x + each * 0.55} ${y + markerH / 2} L ${x} ${y + markerH} L ${x + each * 0.3} ${y + markerH / 2} Z `;
    }
    elements.push({ type: "path", d, fill: skin.colors.emphasis, x: Math.round(box.x), y: Math.round(box.y + (box.h - markerH) / 2), w: Math.round(markerW), h: Math.round(markerH) });
  }
  const textX = box.x + markerW + (markerW ? Math.round(box.h * 0.12) : 0);
  const textW = box.w - (textX - box.x);
  let titleSize = Math.max(20, Math.min(40, Math.round(box.h * 0.34)));
  while (titleSize > 16 && ([...input.title].length * titleSize * 0.95 > textW * 0.94 || estimateTextWidth(input.title, titleSize) > textW * 0.94)) titleSize -= 1;
  if ([...input.title].length * titleSize * 0.95 > textW) bad(`${what}「${input.title}」章节标题超宽——缩短标题`);
  const titleH = singleLineBoxHeight(titleSize);
  const subtitleSize = Math.max(11, Math.min(18, Math.round(titleSize * 0.42)));
  const subtitleH = input.subtitle ? singleLineBoxHeight(subtitleSize) : 0;
  const total = titleH + (subtitleH ? subtitleH + 6 : 0);
  const top = box.y + Math.max(0, Math.round((box.h - total) / 2));
  elements.push(text({ x: textX, y: top, w: textW, h: titleH }, [
    { text: input.title, sizePt: titleSize, color: skin.colors.text, bold: true, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
  ]));
  if (input.subtitle) {
    elements.push(text({ x: textX, y: top + titleH + 6, w: textW, h: subtitleH }, [
      { text: input.subtitle, sizePt: subtitleSize, color: skin.colors.emphasis },
    ]));
  }
  return elements;
}

export interface SectionBannerInput {
  title: string;
  tone?: "primary" | "soft";
}

/** 参考 p6 的双栏蓝色 banner：整条铺满组件框，标题反白/强调。 */
export function expandSectionBanner(
  input: SectionBannerInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const primary = input.tone !== "soft";
  const fill = primary ? skin.colors.emphasis : skin.colors.emphasisSoft;
  const color = primary ? skin.colors.inverse : skin.colors.text;
  const size = Math.max(11, Math.min(18, Math.round(frame.h * 0.38)));
  return [
    { type: "shape", shape: "rect", fill, x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h) },
    text({ x: frame.x + 10, y: frame.y + Math.round((frame.h - singleLineBoxHeight(size)) / 2), w: frame.w - 20, h: singleLineBoxHeight(size) }, [
      { text: input.title, sizePt: size, color, bold: true },
    ], "center"),
  ];
}


export interface PhotoTriptychInput {
  images: { url: string; label?: string }[];
  overlay?: boolean;
  labelMode?: "overlay" | "none";
}

/** 三张满版图片并排，底部标签压在图上；用于 p8 品牌三联 / p17 生态三联。 */
export function expandPhotoTriptych(
  input: PhotoTriptychInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const gap = Math.round(frame.w * 0.02);
  const cellW = Math.floor((frame.w - gap * 2) / 3);
  const elements: SpecElement[] = [];
  input.images.slice(0, 3).forEach((image, i) => {
    const x = frame.x + i * (cellW + gap);
    elements.push({ type: "image", url: image.url, fit: "cover", x, y: Math.round(frame.y), w: cellW, h: Math.round(frame.h) });
    if (input.overlay) {
      elements.push({ type: "shape", shape: "rect", fill: "#0B0B2A99", x, y: Math.round(frame.y), w: cellW, h: Math.round(frame.h) });
    }
    if (image.label && input.labelMode !== "none") {
      elements.push(text({ x: x + 14, y: frame.y + Math.round(frame.h) - Math.round(frame.h * 0.2), w: cellW - 28, h: Math.round(frame.h * 0.15) }, [
        { text: image.label, sizePt: Math.max(14, Math.round(frame.h * 0.09)), color: "#FFFFFF", bold: true, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
      ]));
    }
  });
  return elements;
}

export interface CompetitorInput {
  name: string;
  imageUrl?: string;
  tags: string[];
  facts: string[];
}

/** 参考 p12 的竞品行：厂商 / 图片 / 特点胶囊 / 市场数据，三行一组。 */
export function expandCompetitorBoard(
  competitors: CompetitorInput[],
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const rows = competitors.slice(0, 3);
  const headerH = Math.round(frame.h * 0.12);
  const gap = Math.round(frame.h * 0.02);
  const rowH = Math.floor((frame.h - headerH - gap * (rows.length - 1) - 8) / rows.length);
  if (rowH < 60) bad(`${what} 竞品行过密（每行 ${rowH}px）——减少 competitors`);
  const nameW = Math.round(frame.w * 0.1);
  const imageW = Math.round(frame.w * 0.23);
  const tagW = Math.round(frame.w * 0.22);
  const imageX = frame.x + nameW;
  const tagX = imageX + imageW + Math.round(frame.w * 0.02);
  const factX = tagX + tagW + Math.round(frame.w * 0.02);
  const factW = frame.w - (factX - frame.x);
  const headerSize = Math.max(10, Math.round(headerH * 0.42));
  const headers = [
    { label: '厂商', x: frame.x, w: nameW - 8 },
    { label: '产品', x: imageX, w: imageW },
    { label: '特点', x: tagX, w: tagW },
    { label: '市场情况', x: factX, w: factW },
  ];
  for (const header of headers) {
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x: Math.round(header.x), y: Math.round(frame.y), w: Math.round(header.w), h: headerH });
    elements.push(text({ x: header.x + 6, y: frame.y + Math.round((headerH - singleLineBoxHeight(headerSize)) / 2), w: header.w - 12, h: singleLineBoxHeight(headerSize) }, [
      { text: header.label, sizePt: headerSize, color: skin.colors.inverse, bold: true },
    ], "center"));
  }
  let y = frame.y + headerH + 6;
  rows.forEach((competitor, i) => {
    const top = y + i * (rowH + gap);
    const nameSize = Math.max(12, Math.min(20, Math.round(rowH * 0.13)));
    elements.push(text({ x: frame.x, y: top + Math.round((rowH - singleLineBoxHeight(nameSize)) / 2), w: nameW - 8, h: singleLineBoxHeight(nameSize) }, [
      { text: competitor.name, sizePt: nameSize, color: skin.colors.emphasis, bold: true },
    ]));
    if (competitor.imageUrl) {
      elements.push({ type: "image", url: competitor.imageUrl, fit: "cover", x: Math.round(imageX), y: Math.round(top), w: imageW, h: Math.round(rowH) });
    }
    const tagSize = Math.max(9, Math.min(13, Math.round(rowH * 0.09)));
    const tagH = Math.max(20, Math.round(rowH * 0.22));
    competitor.tags.forEach((tag, j) => {
      const tagY = top + 4 + j * (tagH + 5);
      elements.push({ type: "shape", shape: "roundRect", adj: 50000, fill: skin.colors.emphasisSoft, x: tagX, y: tagY, w: tagW, h: tagH });
      elements.push(text({ x: tagX + 6, y: tagY + Math.round((tagH - singleLineBoxHeight(tagSize)) / 2), w: tagW - 12, h: singleLineBoxHeight(tagSize) }, [
        { text: tag, sizePt: tagSize, color: skin.colors.emphasis, bold: true },
      ], "center"));
    });
    const factSize = Math.max(10, Math.min(15, Math.round(rowH * 0.1)));
    const factText = competitor.facts.join('\n');
    const needed = textBoxHeight(factText, factSize, factW - 8);
    if (needed > rowH + 2) bad(`${what}「${competitor.name}」市场情况高约 ${Math.round(needed)}px 超过 ${rowH}px——精简 facts`);
    elements.push(text({ x: factX + 4, y: top + 4, w: factW - 8, h: rowH - 8 }, [
      { text: factText, sizePt: factSize, color: skin.colors.text },
    ]));
  });
  return elements;
}

export interface SparkLineInput {
  categories: string[];
  values: number[];
  label?: string;
}

/** 无 0 基线的迷你折线：适合 65-85 万这类高位区间，避免线被压平。 */
export function expandSparkLine(
  input: SparkLineInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const n = input.values.length;
  if (n < 2 || input.categories.length !== n) bad(`${what} sparkLine categories/values 数量必须一致且至少 2 项`);
  const labelH = Math.round(frame.h * 0.2);
  const padTop = Math.round(frame.h * 0.12);
  const padBottom = Math.round(frame.h * 0.28);
  const plot = { x: frame.x + 36, y: frame.y + padTop, w: frame.w - 52, h: frame.h - padTop - padBottom };
  const min = Math.min(...input.values);
  const max = Math.max(...input.values);
  const span = Math.max(1, max - min);
  const elements: SpecElement[] = [];
  const yOf = (v: number) => plot.y + plot.h - ((v - min) / span) * plot.h;
  const xOf = (i: number) => plot.x + (i / (n - 1)) * plot.w;
  for (let i = 0; i <= 2; i++) {
    const y = yOf(min + (span * i) / 2);
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.divider, x: Math.round(plot.x), y: Math.round(y), w: Math.round(plot.w), h: 1 });
  }
  let d = `M ${xOf(0).toFixed(1)} ${yOf(input.values[0]!).toFixed(1)}`;
  for (let i = 1; i < n; i++) d += ` L ${xOf(i).toFixed(1)} ${yOf(input.values[i]!).toFixed(1)}`;
  elements.push({ type: "path", d, stroke: { color: skin.colors.emphasis, widthPt: 1.8 }, fill: "#00000000", x: Math.round(plot.x), y: Math.round(plot.y), w: Math.round(plot.w), h: Math.round(plot.h) });
  input.values.forEach((v, i) => {
    elements.push(text({ x: Math.round(xOf(i) - 30), y: Math.round(plot.y + plot.h + 4), w: 60, h: labelH }, [
      { text: input.categories[i] ?? "", sizePt: 9, color: skin.colors.muted },
    ], "center"));
  });

  return elements;
}

export interface MiniBarItem { label: string; value: number; }
export interface MiniBarsInput { items: MiniBarItem[]; unit?: string; }

/** 无坐标轴的小柱组：给“机场分布 / 全球玩家”这类小证据位。 */
export function expandMiniBars(
  input: MiniBarsInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const items = input.items.slice(0, 5);
  if (items.length < 2) bad(`${what} miniBars 至少 2 项`);
  const labelH = Math.round(frame.h * 0.28);
  const plot = { x: frame.x, y: frame.y + 4, w: frame.w, h: frame.h - labelH - 8 };
  const max = Math.max(...items.map((item) => item.value), 1);
  const gap = Math.round(frame.w * 0.022);
  const cellW = Math.floor((plot.w - gap * (items.length - 1)) / items.length);
  const elements: SpecElement[] = [];
  items.forEach((item, i) => {
    const h = Math.max(4, Math.round(plot.h * (item.value / max)));
    const x = plot.x + i * (cellW + gap);
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x, y: Math.round(plot.y + plot.h - h), w: cellW, h });
    elements.push(text({ x, y: Math.round(frame.y + frame.h - labelH), w: cellW, h: labelH }, [
      { text: item.label, sizePt: 8, color: skin.colors.muted },
    ], "center"));
  });
  return elements;
}

export interface MarketBoardInput {
  leftBanner: string;
  rightBanner: string;
  kpis: KpiRow[];
  trend: { categories: string[]; values: number[]; label?: string };
  miniBars: { items: MiniBarItem[]; unit?: string };
  leftFooter?: string;
  rightFooter?: string;
}

/** 双栏市场板：左 banner + KPI 行，右 banner + 聚焦折线 + 迷你柱组。 */
export function expandMarketBoard(
  input: MarketBoardInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  const elements: SpecElement[] = [];
  const gap = Math.round(frame.w * 0.035);
  const leftW = Math.round((frame.w - gap) * 0.49);
  const rightX = frame.x + leftW + gap;
  const rightW = frame.w - leftW - gap;
  const bannerH = Math.round(frame.h * 0.09);
  elements.push(...expandSectionBanner({ title: input.leftBanner }, { x: frame.x, y: frame.y, w: leftW, h: bannerH }, theme, what, skin));
  elements.push(...expandSectionBanner({ title: input.rightBanner, tone: "soft" }, { x: rightX, y: frame.y, w: rightW, h: bannerH }, theme, what, skin));
  const kpiFrame = { x: frame.x, y: frame.y + bannerH + 8, w: leftW, h: Math.round(frame.h * 0.66) };
  elements.push(...expandKpiRows(input.kpis, kpiFrame, theme, what, skin));
  const rightTop = frame.y + bannerH + 8;
  const trendFrame = { x: rightX, y: rightTop, w: rightW, h: Math.round(frame.h * 0.5) };
  elements.push(...expandSparkLine(input.trend, trendFrame, theme, what, skin));
  const barsFrame = { x: rightX, y: rightTop + trendFrame.h + 4, w: rightW, h: Math.round(frame.h * 0.2) };
  elements.push(...expandMiniBars(input.miniBars, barsFrame, theme, what, skin));
  const footerSize = Math.max(9, Math.round(frame.h * 0.022));
  if (input.leftFooter) {
    elements.push(text({ x: frame.x, y: frame.y + frame.h - 18, w: leftW, h: 18 }, [
      { text: input.leftFooter, sizePt: footerSize, color: skin.colors.muted },
    ]));
  }
  if (input.rightFooter) {
    elements.push(text({ x: rightX, y: frame.y + frame.h - 18, w: rightW, h: 18 }, [
      { text: input.rightFooter, sizePt: footerSize, color: skin.colors.muted },
    ]));
  }
  return elements;
}

export interface FullBleedQuoteInput {
  imageUrl: string;
  kicker?: string;
  titleLines: string[];
  subtitle?: string;
  caption?: string;
  overlay?: boolean;
}

/** 满版图片 + 居中大字：视觉页只由这一颗组件负责文字位置。 */
export function expandFullBleedQuote(
  input: FullBleedQuoteInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  elements.push({ type: "image", url: input.imageUrl, fit: "cover", x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h) });
  if (input.overlay !== false) {
    elements.push({ type: "shape", shape: "rect", fill: withAlpha(skin.colors.text, 0.55), x: Math.round(frame.x), y: Math.round(frame.y), w: Math.round(frame.w), h: Math.round(frame.h) });
  }
  const titleW = Math.round(frame.w * 0.72);
  const titleX = frame.x + Math.round((frame.w - titleW) / 2);
  let size = Math.max(28, Math.min(58, Math.round(frame.h * 0.085)));
  const longest = Math.max(...input.titleLines.map((line) => estimateTextWidth(line, size)));
  while (size > 24 && longest * (size / Math.max(28, Math.min(58, Math.round(frame.h * 0.085)))) > titleW) size -= 2;
  const lineHeight = Math.round(size * 1.7);
  const totalH = lineHeight * input.titleLines.length;
  const top = frame.y + Math.round(frame.h * 0.34) - Math.round(totalH / 2);
  input.titleLines.forEach((line, i) => {
    elements.push(text({ x: titleX, y: top + i * lineHeight, w: titleW, h: singleLineBoxHeight(size) }, [
      { text: line, sizePt: size, color: skin.colors.inverse, bold: true, ...(skin.fonts.heading ? { font: skin.fonts.heading } : {}) },
    ], "center"));
  });
  if (input.kicker) {
    elements.push(text({ x: frame.x + 40, y: frame.y + 40, w: frame.w - 80, h: 20 }, [
      { text: input.kicker, sizePt: 10, color: skin.colors.inverseMuted },
    ], "center"));
  }
  if (input.subtitle) {
    elements.push(text({ x: titleX, y: top + totalH + Math.round(frame.h * 0.06), w: titleW, h: Math.round(frame.h * 0.08) }, [
      { text: input.subtitle, sizePt: Math.max(13, Math.round(size * 0.32)), color: skin.colors.inverseMuted },
    ], "center"));
  }
  if (input.caption) {
    elements.push(text({ x: titleX, y: frame.y + frame.h - 42, w: titleW, h: 18 }, [
      { text: input.caption, sizePt: 9, color: skin.colors.inverseMuted },
    ], "center"));
  }
  return elements;
}


export interface FinancialBoardInput {
  columns: string[];
  rows: string[][];
  chart: { categories: string[]; values: number[]; label?: string };
  funding: { label: string; value: string }[];
  caption?: string;
}

/** 财务页：左财务表 + 右销量柱 + 底部资金用途，文本位置全部由组件锁住。 */
export function expandFinancialBoard(
  input: FinancialBoardInput,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  void theme;
  const elements: SpecElement[] = [];
  const gap = Math.round(frame.w * 0.025);
  const tableW = Math.round((frame.w - gap) * 0.62);
  const rightX = frame.x + tableW + gap;
  const rightW = frame.w - tableW - gap;
  const fundingH = Math.round(frame.h * 0.2);
  const tableH = frame.h - fundingH - 18;
  // 财务表作为一个真实 table 元素，避免几十个散落文本。
  const tableRows = [
    input.columns.map((text) => ({ text, bold: true, fill: skin.colors.emphasis, color: skin.colors.inverse, align: "center" as const })),
    ...input.rows.map((row) => row.map((text, j) => ({ text, align: (j === 0 ? "left" : "center") as "left" | "center" }))),
  ];
  elements.push({
    type: "table",
    x: frame.x,
    y: frame.y,
    w: tableW,
    h: tableH,
    rows: tableRows,
    fontSize: 9,
    borderColor: skin.colors.divider,
    horizontalBordersOnly: true,
    zebra: skin.colors.card,
  });
  // 右侧销量柱
  const max = Math.max(...input.chart.values, 1);
  const chartH = Math.round(tableH * 0.68);
  const chartW = rightW;
  const barGap = Math.round(chartW * 0.03);
  const barW = Math.floor((chartW - barGap * (input.chart.values.length - 1)) / input.chart.values.length);
  input.chart.values.forEach((value, i) => {
    const h = Math.max(4, Math.round(chartH * value / max));
    const x = rightX + i * (barW + barGap);
    const y = frame.y + chartH - h;
    elements.push({ type: "shape", shape: "rect", fill: skin.colors.emphasis, x, y, w: barW, h });
    elements.push(text({ x: x - 2, y: frame.y + chartH + 4, w: barW + 4, h: 16 }, [
      { text: input.chart.categories[i] ?? "", sizePt: 8, color: skin.colors.muted },
    ], "center"));
  });

  // 底部资金用途
  const fundY = frame.y + frame.h - fundingH;
  elements.push({ type: "shape", shape: "rect", fill: skin.colors.card, x: frame.x, y: fundY, w: frame.w, h: fundingH });
  const cellW = Math.floor(frame.w / input.funding.length);
  input.funding.forEach((item, i) => {
    const x = frame.x + i * cellW;
    elements.push(text({ x: x + 10, y: fundY + 8, w: cellW - 20, h: 16 }, [
      { text: item.label, sizePt: 9, color: skin.colors.muted },
    ]));
    elements.push(text({ x: x + 10, y: fundY + Math.round(fundingH * 0.45), w: cellW - 20, h: 24 }, [
      { text: item.value, sizePt: 16, color: skin.colors.emphasis, bold: true },
    ]));
  });

  return elements;
}


/** 实验原子升级为生产通用组件的白名单；字段由各 expand 函数做运行时兜底。 */
export const ATOM_NAMES = [
  "founderProfile", "radialFunnel", "kpiRows", "categoryCards", "featureRail",
  "sectionHeader", "photoTriptych", "competitorBoard", "fullBleedQuote", "financialBoard",
] as const;

export type AtomName = (typeof ATOM_NAMES)[number];

export function isAtomName(name: string): name is AtomName {
  return (ATOM_NAMES as readonly string[]).includes(name);
}

export function expandAtomLeaf(
  name: AtomName,
  leaf: Record<string, unknown>,
  frame: Frame,
  theme: ResolvedTheme,
  what: string,
  skin: ComponentSkin,
): SpecElement[] {
  switch (name) {
    case "founderProfile": return expandFounderProfile(leaf as unknown as FounderProfileInput, frame, theme, what, skin);
    case "radialFunnel": return expandRadialFunnel(leaf as unknown as RadialFunnelInput, frame, theme, what, skin);
    case "kpiRows": return expandKpiRows(leaf.rows as unknown as KpiRow[], frame, theme, what, skin);
    case "categoryCards": return expandCategoryCards(leaf.items as unknown as CategoryCard[], frame, theme, what, skin);
    case "featureRail": return expandFeatureRail(leaf as unknown as FeatureRailInput, frame, theme, what, skin);
    case "sectionHeader": return expandSectionHeader(leaf as unknown as SectionHeaderInput, frame, theme, what, skin);
    case "photoTriptych": return expandPhotoTriptych(leaf as unknown as PhotoTriptychInput, frame, theme, what, skin);
    case "competitorBoard": return expandCompetitorBoard(leaf.competitors as unknown as CompetitorInput[], frame, theme, what, skin);
    case "fullBleedQuote": return expandFullBleedQuote(leaf as unknown as FullBleedQuoteInput, frame, theme, what, skin);
    case "financialBoard": return expandFinancialBoard(leaf as unknown as FinancialBoardInput, frame, theme, what, skin);
  }
}
