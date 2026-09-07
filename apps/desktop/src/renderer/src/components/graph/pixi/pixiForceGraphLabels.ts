import type {
  PixiContainer,
  PixiForceGraphDependencies,
  PixiForceGraphNode,
  PixiText,
  PixiViewport,
} from './pixiForceGraphTypes'

export interface PixiForceGraphLabelManager {
  readonly layer: PixiContainer
  activeCount(): number
  createdCount(): number
  destroy(): void
  /**
   * @param related 悬停聚焦时的关联节点集（悬停节点 + 其连线邻居）：
   * 提供时只显示关联节点的标签，其余节点标签隐藏（聚焦虚化语义）；
   * 悬停为 null 或未提供时按缩放阈值显示视口内全部标签。
   */
  update(hoveredIndex: number | null, related?: ReadonlySet<number> | null): void
}

const LABEL_STYLE: Record<string, unknown> = {
  fill: 0x374151,
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 12,
  fontWeight: '500',
  padding: 2,
}

/** 标签分档样式（labelTier 越小越醒目）；每档独立对象，创建时整体应用。 */
const LABEL_TIER_STYLES: Array<Record<string, unknown>> = [
  { ...LABEL_STYLE, fill: 0x111827, fontSize: 15, fontWeight: '700' },
  { ...LABEL_STYLE, fill: 0x1f2937, fontSize: 13, fontWeight: '600' },
  { ...LABEL_STYLE },
]

function labelTierOf(node: PixiForceGraphNode | undefined): number {
  const tier = node?.labelTier
  if (!Number.isFinite(tier as number) || (tier as number) < 0) return LABEL_TIER_STYLES.length - 1
  return Math.min(LABEL_TIER_STYLES.length - 1, Math.floor(tier as number))
}

function textResolution(baseResolution: number, scale: number): number {
  const scaled = baseResolution * Math.max(1, scale)
  return Math.min(4, Math.ceil(scaled * 2) / 2)
}

export function createPixiForceGraphLabelManager({
  dependencies,
  baseResolution,
  maxLabels,
  nodes,
  positions,
  scaleThreshold,
  viewport,
}: {
  dependencies: PixiForceGraphDependencies
  baseResolution: number
  maxLabels: number
  nodes: readonly PixiForceGraphNode[]
  positions: Float32Array
  scaleThreshold: number
  viewport: PixiViewport
}): PixiForceGraphLabelManager {
  const layer = new dependencies.Container()
  layer.interactiveChildren = false
  const active = new Map<number, PixiText>()
  // 按档分池：池内文本样式固定，跨档复用会闪错样式，换池即换档。
  const pools = new Map<number, PixiText[]>()
  const poolFor = (tier: number): PixiText[] => {
    let pool = pools.get(tier)
    if (!pool) {
      pool = []
      pools.set(tier, pool)
    }
    return pool
  }
  const desired: number[] = []
  const desiredMarks = new Uint32Array(nodes.length)
  // 标签常显节点（labelPinned）：聚焦模式下仍显示，作为高层结构锚点。
  const pinnedIndexes: number[] = []
  nodes.forEach((node, index) => {
    if (node.labelPinned && node.label) pinnedIndexes.push(index)
  })
  let mark = 0
  let created = 0
  let currentResolution = textResolution(baseResolution, viewport.scale?.x ?? 1)

  const addDesired = (index: number) => {
    if (!nodes[index]?.label || desiredMarks[index] === mark || desired.length >= maxLabels) return
    desiredMarks[index] = mark
    desired.push(index)
  }

  const acquire = (index: number) => {
    const tier = labelTierOf(nodes[index])
    let label = poolFor(tier).pop()
    if (!label) {
      if (created >= maxLabels) return null
      label = new dependencies.Text('', LABEL_TIER_STYLES[tier]!)
      label.resolution = currentResolution
      label.roundPixels = true
      label.anchor?.set(0.5, 0)
      layer.addChild(label)
      created += 1
    }
    label.text = nodes[index]?.label ?? ''
    label.visible = true
    active.set(index, label)
    return label
  }

  return {
    layer,
    activeCount: () => active.size,
    createdCount: () => created,
    update(hoveredIndex, related) {
      if (mark === 0xffffffff) {
        desiredMarks.fill(0)
        mark = 1
      } else {
        mark += 1
      }
      desired.length = 0
      if (hoveredIndex !== null) addDesired(hoveredIndex)

      const scale = viewport.scale?.x ?? 1
      const nextResolution = textResolution(baseResolution, scale)
      if (nextResolution !== currentResolution) {
        currentResolution = nextResolution
        for (const label of active.values()) label.resolution = currentResolution
      }
      if (hoveredIndex !== null && related) {
        // 聚焦模式：只保留关联节点（悬停 + 连线邻居）与常显节点的标签。
        for (const index of related) addDesired(index)
        for (const index of pinnedIndexes) addDesired(index)
      } else {
        const bounds = viewport.getVisibleBounds?.()
        if (scale >= scaleThreshold && bounds) {
          const right = bounds.x + bounds.width
          const bottom = bounds.y + bounds.height
          for (let index = 0; index < nodes.length && desired.length < maxLabels; index += 1) {
            const x = positions[index * 2]
            const y = positions[index * 2 + 1]
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue
            const radius = nodes[index]?.radius ?? 18
            if (x! + radius >= bounds.x && x! - radius <= right
              && y! + radius >= bounds.y && y! - radius <= bottom) {
              addDesired(index)
            }
          }
        }
      }

      for (const [index, label] of active) {
        if (desiredMarks[index] === mark) continue
        active.delete(index)
        label.visible = false
        poolFor(labelTierOf(nodes[index])).push(label)
      }
      for (const index of desired) {
        const label = active.get(index) ?? acquire(index)
        if (!label) continue
        label.x = positions[index * 2] ?? 0
        label.y = (positions[index * 2 + 1] ?? 0) + (nodes[index]?.radius ?? 18) + 4
      }
      layer.visible = active.size > 0
    },
    destroy() {
      active.clear()
      for (const pool of pools.values()) pool.length = 0
      layer.destroy({ children: true })
    },
  }
}
