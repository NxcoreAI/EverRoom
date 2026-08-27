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
  update(hoveredIndex: number | null): void
}

const LABEL_STYLE: Record<string, unknown> = {
  fill: 0x374151,
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 12,
  fontWeight: '500',
  padding: 2,
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
  const pool: PixiText[] = []
  const desired: number[] = []
  const desiredMarks = new Uint32Array(nodes.length)
  let mark = 0
  let created = 0
  let currentResolution = textResolution(baseResolution, viewport.scale?.x ?? 1)

  const addDesired = (index: number) => {
    if (!nodes[index]?.label || desiredMarks[index] === mark || desired.length >= maxLabels) return
    desiredMarks[index] = mark
    desired.push(index)
  }

  const acquire = (index: number) => {
    let label = pool.pop()
    if (!label) {
      if (created >= maxLabels) return null
      label = new dependencies.Text('', LABEL_STYLE)
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
    update(hoveredIndex) {
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

      for (const [index, label] of active) {
        if (desiredMarks[index] === mark) continue
        active.delete(index)
        label.visible = false
        pool.push(label)
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
      pool.length = 0
      layer.destroy({ children: true })
    },
  }
}
