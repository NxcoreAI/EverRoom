import type { WalkHop, WalkStation } from './walkModel';

export interface Box { width: number; height: number; }
export interface Point { x: number; y: number; }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

// 尺寸是布局唯一数据源：CSS 只管配色/字体/边框，不参与定位
// （emergence-graph 样式块与这里互相引用，改尺寸两处同步）。
export const NODE_SIZES = {
  walkCurrent: { width: 178, height: 96 },
  walkPrev: { width: 152, height: 84 },
  walkNext: { width: 152, height: 84 },
} as const;

export const GAPS = {
  walkH: 56,
  walkV: 16,
} as const;

export interface TreeLayout {
  positions: Map<string, Point>;
  bbox: BBox;
}

function emptyBBox(): BBox {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

function accumulate(bbox: BBox, point: Point, size: Box): void {
  bbox.minX = Math.min(bbox.minX, point.x);
  bbox.minY = Math.min(bbox.minY, point.y);
  bbox.maxX = Math.max(bbox.maxX, point.x + size.width);
  bbox.maxY = Math.max(bbox.maxY, point.y + size.height);
}

/**
 * 漫步步进链：当前驻足在原点；走过的站向左一列列排（与当前同轴）；
 * 下一跳候选在右侧一列，垂直居中于当前卡轴线。
 * （聚焦导图已改用 G6 引擎，见 g6FocusGraph.ts。）
 */
export function layoutWalkJourney(log: WalkStation[], hops: WalkHop[]): TreeLayout {
  const positions = new Map<string, Point>();
  const bbox = emptyBBox();
  if (log.length === 0) return { positions, bbox };

  const currentSize = NODE_SIZES.walkCurrent;
  positions.set(currentStationRef(log), { x: 0, y: 0 });
  accumulate(bbox, { x: 0, y: 0 }, currentSize);

  const walkedY = (currentSize.height - NODE_SIZES.walkPrev.height) / 2;
  for (let i = log.length - 2; i >= 0; i -= 1) {
    const columnsAway = log.length - 1 - i;
    const x = -(GAPS.walkH + NODE_SIZES.walkPrev.width) * columnsAway;
    positions.set(log[i].nodeRef, { x, y: walkedY });
    accumulate(bbox, { x, y: walkedY }, NODE_SIZES.walkPrev);
  }

  if (hops.length > 0) {
    const hopsTotal = NODE_SIZES.walkNext.height * hops.length + GAPS.walkV * (hops.length - 1);
    let y = currentSize.height / 2 - hopsTotal / 2;
    const hopX = currentSize.width + GAPS.walkH;
    for (const hop of hops) {
      positions.set(hop.nodeRef, { x: hopX, y });
      accumulate(bbox, { x: hopX, y }, NODE_SIZES.walkNext);
      y += NODE_SIZES.walkNext.height + GAPS.walkV;
    }
  }

  return { positions, bbox };
}

function currentStationRef(log: WalkStation[]): string {
  return log[log.length - 1].nodeRef;
}
