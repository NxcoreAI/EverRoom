/**
 * 风格卡载荷：给前端进度的全量快照（广播 details 的形状）。
 *
 * 用户面纪律：只含效果语言与数据渲染图——色块、字号表、线框 SVG、
 * 演示页图、效果文案；不出现聚类/置信度/来源。候选与演示页图用
 * everroom-material://<hash> 寻址（桌面主进程协议回源网关）。
 */

import type { SlidesStyleSessionData } from "./types.js";
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

export interface StyleCardPayload {
  stage: "style_card_ready";
  styleSessionId: string;
  title?: string | undefined;
  generation: number;
  swatches: StyleCardSwatch[];
  typography: StyleCardTypographyRow[];
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
    wireframes,
    demoImageUrl: session.demoImageHash ? materialUrl(session.demoImageHash) : null,
    effectLines: params?.effectLines ?? [],
    warnings: options.warnings,
  };
}
