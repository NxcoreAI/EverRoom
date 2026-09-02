import { DEFAULT_FORCE_GRAPH_OPTIONS, type ForceGraphOptions } from './forceGraphProtocol'

/**
 * 按节点数缩放布局世界：面积 = max(1, nodeCount) × spacing²，保持内核默认世界
 * （640×420）的宽高比，下限为默认世界、上限封顶防失控。面板只是视口——世界
 * 随内容规模长大，节点多时不被塞进固定矩形里互相挤压。
 *
 * spacing 为每个节点分配的正方形活动边长（约等于最小中心距的期望值），
 * 按图谱的节点半径量级选择：小节点（r≈6~12）取 90~100，常规节点（r≈18~28）
 * 取 110~130。
 */
export function scaleForceGraphWorld(nodeCount: number, options?: {
  spacing?: number
  maxWidth?: number
  maxHeight?: number
}): Pick<ForceGraphOptions, 'height' | 'width'> {
  const spacing = options?.spacing ?? 110
  const aspectRatio = DEFAULT_FORCE_GRAPH_OPTIONS.width / DEFAULT_FORCE_GRAPH_OPTIONS.height
  const targetArea = Math.max(1, nodeCount) * spacing * spacing
  const targetWidth = Math.sqrt(targetArea * aspectRatio)
  return {
    height: Math.min(options?.maxHeight ?? 1600, Math.max(DEFAULT_FORCE_GRAPH_OPTIONS.height, Math.round(targetWidth / aspectRatio))),
    width: Math.min(options?.maxWidth ?? 2400, Math.max(DEFAULT_FORCE_GRAPH_OPTIONS.width, Math.round(targetWidth))),
  }
}
