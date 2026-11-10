/**
 * deck 布局契约：全篇不变的常量，从 styleParams 确定性派生。
 * 布局代理只出结构与比例；边距、标题带、字号档、下限、上限全部在这里定。
 */

import type { Frame } from "../grid.js";
import { CANVAS_W, CANVAS_H, CONTENT_TOP, CONTENT_BOTTOM, TITLE_Y, TITLE_MAX_BOTTOM, contentFrame } from "../grid.js";
import { resolveScene } from "../scene.js";
import { resolveTheme, type ResolvedTheme, type StyleParamsInput } from "../theme.js";

export type TextVariant = "display" | "heading" | "subtitle" | "body" | "caption";

export interface LayoutContract {
  theme: ResolvedTheme;
  canvas: { w: number; h: number };
  titleBand: { y: number; maxBottom: number };
  contentFrame: Frame;
  /** 各文字变体的字号下限（pt）——降档兜底到此为止。 */
  fontFloors: Record<TextVariant, number>;
  /** 叶子区域最小尺寸（px），低于此计缺陷。 */
  minLeaf: { w: number; h: number };
  /** 引擎上限（genoffice page-spec：48 元素/8 图/4 path）。 */
  caps: { elements: number; images: number; paths: number; children: number };
  /** contain 模式下框与图长宽比相对偏差超过此值计缺陷。 */
  imageArTolerance: number;
}

/**
 * 字号下限由场景决定（见 slides-layout/scene.ts）：投影档 body 18 / caption 12，
 * 研读档 body 14 / caption 10。旧的全局常量（caption 9）已废弃——它让降档兜底
 * 一路掉到 9pt，是"满屏无意义小字"的直接来源。
 */
export function contractFromStyleParams(styleParams?: StyleParamsInput | null, scene?: string | null): LayoutContract {
  const profile = resolveScene(scene);
  const theme = resolveTheme(styleParams, scene);
  return {
    theme,
    canvas: { w: CANVAS_W, h: CANVAS_H },
    titleBand: { y: TITLE_Y, maxBottom: TITLE_MAX_BOTTOM },
    contentFrame: contentFrame(theme.spacing.margin),
    fontFloors: { ...profile.fontFloors },
    minLeaf: { w: 96, h: 64 },
    caps: { elements: 48, images: 8, paths: 4, children: 12 },
    imageArTolerance: 0.25,
  };
}

/** 内容区底边（与 grid.ts 常量一致，单独导出便于断言）。 */
export const CONTRACT_CONTENT_BOTTOM = CONTENT_BOTTOM;
export const CONTRACT_CONTENT_TOP = CONTENT_TOP;
