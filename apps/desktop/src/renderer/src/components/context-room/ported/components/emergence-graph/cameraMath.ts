import type { BBox, Point } from './treeLayout';

/** 相机：内容坐标系 → 视口坐标的 translate+scale（origin 0 0）。 */
export interface CamTransform {
  x: number;
  y: number;
  scale: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export const SCALE_MIN = 0.3;
export const SCALE_MAX = 2.5;

const finiteOr = (value: number, fallback: number): number => (Number.isFinite(value) ? value : fallback);

/** 把内容点 (mx,my) 钉在视口 (sx,sy) 上的变换（NaN 输入安全兜底）。 */
export function pinTransform(mx: number, my: number, sx: number, sy: number, scale: number): CamTransform {
  const s = finiteOr(clampScale(scale), 1);
  return {
    x: finiteOr(sx, 0) - s * finiteOr(mx, 0),
    y: finiteOr(sy, 0) - s * finiteOr(my, 0),
    scale: s,
  };
}

/** 内容点在当前相机下的视口位置（pinTransform 的逆）。 */
export function screenOf(mx: number, my: number, cam: CamTransform): Point {
  const s = finiteOr(cam.scale, 1);
  return {
    x: finiteOr(cam.x, 0) + s * finiteOr(mx, 0),
    y: finiteOr(cam.y, 0) + s * finiteOr(my, 0),
  };
}

export function clampScale(scale: number, min: number = SCALE_MIN, max: number = SCALE_MAX): number {
  const s = finiteOr(scale, 1);
  return Math.min(max, Math.max(min, s));
}

/** bbox 居中放入视口（含 padding），缩放不超过 maxScale。 */
export function fitTransform(bbox: BBox, viewport: ViewportSize, padding = 28, maxScale = 1.15): CamTransform {
  const vw = Math.max(1, finiteOr(viewport.width, 0));
  const vh = Math.max(1, finiteOr(viewport.height, 0));
  const bw = finiteOr(bbox.maxX - bbox.minX, 0);
  const bh = finiteOr(bbox.maxY - bbox.minY, 0);
  if (bw <= 0 || bh <= 0) return { x: 0, y: 0, scale: 1 };
  // 全局下限 SCALE_MIN 同样约束 fit：极端溢出时宁可裁切也不缩成蚁群
  const scale = clampScale(Math.min((vw - padding * 2) / bw, (vh - padding * 2) / bh, maxScale), SCALE_MIN, maxScale);
  return pinTransform((bbox.minX + bbox.maxX) / 2, (bbox.minY + bbox.maxY) / 2, vw / 2, vh / 2, scale);
}

/** cubic-horizontal 贝塞尔 t=0.5 的中点（边标签定位用）。 */
export function bezierMid(p0: Point, c1: Point, c2: Point, p1: Point): Point {
  return {
    x: (p0.x + 3 * c1.x + 3 * c2.x + p1.x) / 8,
    y: (p0.y + 3 * c1.y + 3 * c2.y + p1.y) / 8,
  };
}

/** 卡片边中点 → 卡片边中点的水平 cubic 路径 + t=0.5 中点；dx 随行进方向取号（回程框在左时向左张开）。 */
export function cubicEdgeGeometry(from: Point, to: Point, curvature = 40): { d: string; mid: Point } {
  const dir = to.x >= from.x ? 1 : -1;
  const dx = dir * Math.max(8, Math.min(curvature, Math.abs(to.x - from.x) / 2));
  const c1 = { x: from.x + dx, y: from.y };
  const c2 = { x: to.x - dx, y: to.y };
  return {
    d: `M ${from.x} ${from.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${to.x} ${to.y}`,
    mid: bezierMid(from, c1, c2, to),
  };
}

export function cubicHorizontalPath(from: Point, to: Point, curvature = 40): string {
  return cubicEdgeGeometry(from, to, curvature).d;
}
