import type { PixiForceGraphNode } from './pixiForceGraphTypes'

/** Undefined means the shared array changed while it was being inspected. */
export function findNearestGraphNode({
  nodes,
  positions,
  revision,
  scale,
  x,
  y,
}: {
  nodes: readonly PixiForceGraphNode[]
  positions: Float32Array
  revision?: () => number
  scale: number
  x: number
  y: number
}): number | null | undefined {
  const startRevision = revision?.() ?? 0
  if ((startRevision & 1) === 1) return undefined
  let nearest: number | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  const minimumWorldRadius = 5 / Math.max(0.05, scale)

  for (let index = 0; index < nodes.length; index += 1) {
    const nodeX = positions[index * 2]
    const nodeY = positions[index * 2 + 1]
    if (!Number.isFinite(nodeX) || !Number.isFinite(nodeY)) continue
    const radius = Math.max(nodes[index]?.radius ?? 18, minimumWorldRadius)
    const distance = (x - nodeX!) ** 2 + (y - nodeY!) ** 2
    if (distance <= radius ** 2 && distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  }

  const endRevision = revision?.() ?? startRevision
  return endRevision === startRevision && (endRevision & 1) === 0 ? nearest : undefined
}
