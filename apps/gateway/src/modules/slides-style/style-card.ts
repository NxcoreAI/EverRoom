/**
 * 风格卡载荷：给前端进度的全量快照（广播 details 的形状）。
 *
 * 用户面纪律：只含效果语言与数据渲染图——色块、字号表、线框 SVG、
 * 演示页图、效果文案；不出现聚类/置信度/来源。候选与演示页图用
 * everroom-material://<hash> 寻址（桌面主进程协议回源网关）。
 */

import type { SlidesStyleSessionData, StyleParams } from "./types.js";
import { presetThumbnails, type ThumbnailRole } from "./preset-thumbnails.js";

function materialUrl(hash: string): string {
  return `everroom-material://${hash}`;
}

export interface StyleCardSwatch {
  hex: string;
  label: string;
}

export interface StyleCardTypographyRow {
  label: string;
  value: string;
}

export interface StyleCardWireframe {
  role: ThumbnailRole;
  /** 预设标签（如「封面 P1a」）——真实版式编号，随构图家族变化。 */
  label: string;
  svg: string;
}

export interface StyleImagesPayload {
  stage: "style_images_ready";
  styleSessionId: string;
  title?: string | undefined;
  generation: number;
  candidates: Array<{ url: string; label?: string; generation: number }>;
}

export interface StyleCardDetail {
  label: string;
  value: string;
}

export interface StyleCardPayload {
  stage: "style_card_ready";
  styleSessionId: string;
  title?: string | undefined;
  generation: number;
  swatches: StyleCardSwatch[];
  typography: StyleCardTypographyRow[];
  /** 机器字段的人话摘要（构图/明暗/母题/卡面/分隔/图片/字号），和 agent 拿到的 token 对齐。 */
  details: StyleCardDetail[];
  wireframes: StyleCardWireframe[];
  demoImageUrl: string | null;
  effectLines: string[];
  warnings?: string[] | undefined;
}

/** 色板上的标量色键（chartSeries 是数组，不进色块条）。 */
type SwatchKey = "background" | "primary" | "accent" | "surface" | "text" | "textMuted";

const SWATCH_LABELS: Array<{ key: SwatchKey; label: string }> = [
  { key: "background", label: "底色" },
  { key: "primary", label: "主色" },
  { key: "accent", label: "强调" },
  { key: "surface", label: "卡片底" },
  { key: "text", label: "正文" },
  { key: "textMuted", label: "次级文字" },
];

export function styleImagesPayload(session: SlidesStyleSessionData, title?: string): StyleImagesPayload {
  return {
    stage: "style_images_ready",
    styleSessionId: session.id,
    title,
    generation: session.generation,
    candidates: session.overviewImages.map((image) => ({
      url: materialUrl(image.contentHash),
      ...(image.label ? { label: image.label } : {}),
      generation: image.generation,
    })),
  };
}

const COMPOSITION_LABELS: Record<string, string> = {
  swiss: "瑞士网格",
  editorial: "编辑杂志",
  poster: "海报大字",
  immersive: "沉浸大图",
};

const MOTIF_LABELS: Record<string, string> = {
  none: "无",
  "ghost-number": "幽灵大数字",
  "ghost-word": "幽灵大字",
  "color-band": "色带",
  "corner-accent": "角落色块",
};

/** 风格卡机器字段 → 用户可读摘要；与 layouter styleTokens 同源，避免「卡上看不到、组件里却生效」。 */
function styleCardDetails(params: StyleParams | null): StyleCardDetail[] {
  if (!params) return [];
  const decoration = params.decoration;
  const cardParts = [
    decoration.cardStroke ? `描边 ${decoration.cardStroke.toUpperCase()}` : "无描边",
    decoration.cardShadow === "none" ? "无阴影" : `阴影 ${decoration.cardShadow}`,
    `圆角 ${String(params.spacing.cornerRadius)}px`,
  ];
  const typeScale = params.typography.typeScale;
  const display = typeScale?.display ?? params.typography.sizes.coverTitle;
  const body = typeScale?.body ?? params.typography.sizes.body;
  return [
    { label: "构图", value: COMPOSITION_LABELS[params.composition ?? "editorial"] ?? "编辑杂志" },
    { label: "明暗", value: params.darkCover ? "封面/章节深底" : "全篇浅底" },
    { label: "母题", value: MOTIF_LABELS[params.motif.kind] ?? "无" },
    { label: "卡面", value: cardParts.join(" · ") },
    { label: "分隔", value: decoration.divider === "none" ? "无分隔线" : "发丝线" },
    { label: "图片", value: decoration.imageFit === "contain" ? "完整呈现" : "裁切填满" },
    { label: "视觉字号", value: `大标题 ${String(display)}pt · 正文 ${String(body)}pt` },
  ];
}

export function styleCardPayload(
  session: SlidesStyleSessionData,
  title?: string,
  options: { warnings?: string[] } = {},
): StyleCardPayload {
  const params = session.styleParams;
  const swatches: StyleCardSwatch[] = params
    ? SWATCH_LABELS.map(({ key, label }) => ({ hex: params.palette[key], label }))
    : [];
  const typography: StyleCardTypographyRow[] = params
    ? [
      { label: "封面标题", value: `${String(params.typography.sizes.coverTitle)}pt` },
      { label: "页标题", value: `${String(params.typography.sizes.pageTitle)}pt` },
      { label: "正文", value: `${String(params.typography.sizes.body)}pt` },
      { label: "注释", value: `${String(params.typography.sizes.caption)}pt` },
      { label: "字体", value: params.typography.fontHeading },
    ]
    : [];
  // 版式缩略图按构图家族出真实预设（封面/内容/数据三张），直接展示用户挑中的构图方向。
  const wireframes: StyleCardWireframe[] = presetThumbnails(params).map(({ role, label, svg }) => ({
    role,
    label,
    svg,
  }));
  return {
    stage: "style_card_ready",
    styleSessionId: session.id,
    title,
    generation: session.generation,
    swatches,
    typography,
    details: styleCardDetails(params),
    wireframes,
    demoImageUrl: session.demoImageHash ? materialUrl(session.demoImageHash) : null,
    effectLines: params?.effectLines ?? [],
    warnings: options.warnings,
  };
}
