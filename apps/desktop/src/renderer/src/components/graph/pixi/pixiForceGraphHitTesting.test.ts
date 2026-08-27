import { describe, expect, it } from 'vitest'

import { findNearestGraphEdge, findNearestGraphNode } from './pixiForceGraphHitTesting'

describe('force graph hit testing', () => {
  it('selects nodes before nearby relation edges', () => {
    const positions = new Float32Array([0, 0, 100, 0])
    const nodes = [{ radius: 20 }, { radius: 20 }]
    const edges = [{ id: 'relation-1', source: 0, target: 1 }]
    expect(findNearestGraphNode({ nodes, positions, scale: 1, x: 5, y: 0 })).toBe(0)
    expect(findNearestGraphEdge({ edges, positions, scale: 1, x: 50, y: 4 })).toBe(0)
    expect(findNearestGraphEdge({ edges, positions, scale: 1, x: 50, y: 20 })).toBeNull()
  })

  it('handles 1,000 nodes and 5,000 edges without truncating the hit-test input', () => {
    const nodeCount = 1_000
    const edgeCount = 5_000
    const positions = new Float32Array(nodeCount * 2)
    positions[(nodeCount - 2) * 2] = 0
    positions[(nodeCount - 2) * 2 + 1] = 100
    positions[(nodeCount - 1) * 2] = 100
    positions[(nodeCount - 1) * 2 + 1] = 100
    const edges = Array.from({ length: edgeCount }, (_, index) => ({
      id: `relation-${index}`,
      source: index === edgeCount - 1 ? nodeCount - 2 : 0,
      target: index === edgeCount - 1 ? nodeCount - 1 : 0,
    }))
    const selected = findNearestGraphEdge({ edges, positions, scale: 1, x: 50, y: 100 })
    expect(selected).toBe(edgeCount - 1)
    expect(edges).toHaveLength(5_000)
  })
})
