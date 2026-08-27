import type {
  PixiContainer,
  PixiForceGraphDependencies,
  PixiForceGraphEdge,
  PixiText,
  PixiViewport,
} from './pixiForceGraphTypes'

export interface PixiForceGraphEdgeLabelManager {
  readonly layer: PixiContainer
  activeCount(): number
  createdCount(): number
  destroy(): void
  update(hoveredIndex: number | null, selectedEdgeId: string | null): void
}

const DEFAULT_EDGE_LABEL_COLOR = 0x566171

const EDGE_LABEL_STYLE: Record<string, unknown> = {
  fill: DEFAULT_EDGE_LABEL_COLOR,
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 10,
  fontWeight: '500',
  padding: 2,
}

function textResolution(baseResolution: number, scale: number): number {
  return Math.min(4, Math.ceil(baseResolution * Math.max(1, scale) * 2) / 2)
}

/** Relationship labels are pooled and capped so large graphs remain cheap to render. */
export function createPixiForceGraphEdgeLabelManager({
  dependencies,
  baseResolution,
  edges,
  maxLabels,
  positions,
  scaleThreshold,
  viewport,
}: {
  dependencies: PixiForceGraphDependencies
  baseResolution: number
  edges: readonly PixiForceGraphEdge[]
  maxLabels: number
  positions: Float32Array
  scaleThreshold: number
  viewport: PixiViewport
}): PixiForceGraphEdgeLabelManager {
  const layer = new dependencies.Container()
  layer.interactiveChildren = false
  const active = new Map<number, PixiText>()
  const pool: PixiText[] = []
  let created = 0
  let currentResolution = textResolution(baseResolution, viewport.scale?.x ?? 1)

  const acquire = (index: number): PixiText | null => {
    let label = pool.pop()
    if (!label) {
      if (created >= maxLabels) return null
      label = new dependencies.Text('', EDGE_LABEL_STYLE)
      label.resolution = currentResolution
      label.roundPixels = true
      label.anchor?.set(0.5, 0.5)
      layer.addChild(label)
      created += 1
    }
    label.text = edges[index]?.label ?? ''
    label.tint = edges[index]?.labelColor ?? edges[index]?.color ?? DEFAULT_EDGE_LABEL_COLOR
    label.resolution = currentResolution
    label.visible = true
    active.set(index, label)
    return label
  }

  return {
    layer,
    activeCount: () => active.size,
    createdCount: () => created,
    update(hoveredIndex, selectedEdgeId) {
      const desired = new Set<number>()
      const scale = viewport.scale?.x ?? 1
      const bounds = viewport.getVisibleBounds?.()
      const visible = bounds
        ? (x: number, y: number) => x >= bounds.x && x <= bounds.x + bounds.width
          && y >= bounds.y && y <= bounds.y + bounds.height
        : () => true

      edges.forEach((edge, index) => {
        if (!edge.label) return
        if (edge.id === selectedEdgeId || edge.source === hoveredIndex || edge.target === hoveredIndex) desired.add(index)
      })

      if (hoveredIndex === null && scale >= scaleThreshold && bounds) {
        for (let index = 0; index < edges.length && desired.size < maxLabels; index += 1) {
          const edge = edges[index]
          if (!edge?.label) continue
          const sourceX = positions[edge.source * 2]
          const sourceY = positions[edge.source * 2 + 1]
          const targetX = positions[edge.target * 2]
          const targetY = positions[edge.target * 2 + 1]
          if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) continue
          const midpointX = (sourceX! + targetX!) / 2
          const midpointY = (sourceY! + targetY!) / 2
          if (visible(midpointX, midpointY)) desired.add(index)
        }
      }

      const nextResolution = textResolution(baseResolution, scale)
      if (nextResolution !== currentResolution) {
        currentResolution = nextResolution
        for (const label of active.values()) label.resolution = currentResolution
      }

      for (const [index, label] of active) {
        if (desired.has(index)) continue
        active.delete(index)
        label.visible = false
        pool.push(label)
      }
      for (const index of desired) {
        const edge = edges[index]
        if (!edge) continue
        const label = active.get(index) ?? acquire(index)
        if (!label) continue
        const sourceX = positions[edge.source * 2] ?? 0
        const sourceY = positions[edge.source * 2 + 1] ?? 0
        const targetX = positions[edge.target * 2] ?? 0
        const targetY = positions[edge.target * 2 + 1] ?? 0
        label.x = (sourceX + targetX) / 2
        label.y = (sourceY + targetY) / 2
      }
      layer.visible = active.size > 0
    },
    destroy() {
      active.clear()
      pool.length = 0
      layer.destroy({ children: true })
    },
  }
}
