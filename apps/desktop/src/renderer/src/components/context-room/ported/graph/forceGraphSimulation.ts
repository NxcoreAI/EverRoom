import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

import type { ForceGraphEdge, ForceGraphNode, ForceGraphOptions } from './forceGraphProtocol'

interface SimulationNode extends SimulationNodeDatum {
  id: string
  radius: number
}

interface SimulationEdge extends SimulationLinkDatum<SimulationNode> {
  source: string | SimulationNode
  target: string | SimulationNode
}

export interface ForceGraphSimulation {
  drag(id: string, x: number, y: number): void
  release(id: string): void
  reheat(alpha?: number): void
  resize(width: number, height: number): void
  step(iterations?: number): void
  stop(): void
}

function initialPosition(index: number, count: number, width: number, height: number) {
  if (count <= 1) return { x: width / 2, y: height / 2 }
  const angle = index * Math.PI * (3 - Math.sqrt(5))
  const distance = Math.min(width, height) * 0.32 * Math.sqrt(index / Math.max(1, count - 1))
  return {
    x: width / 2 + Math.cos(angle) * distance,
    y: height / 2 + Math.sin(angle) * distance,
  }
}

export function createForceGraphSimulation({
  nodes,
  edges,
  options,
  publish,
  settled,
}: {
  nodes: ForceGraphNode[]
  edges: ForceGraphEdge[]
  options: ForceGraphOptions
  publish: (nodes: ReadonlyArray<SimulationNode>) => void
  settled: () => void
}): ForceGraphSimulation {
  const nodeIds = new Set(nodes.map((node) => node.id))
  const invalidEdge = edges.find((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))
  if (invalidEdge) {
    throw new Error(`Force graph edge references an unknown node: ${invalidEdge.source} -> ${invalidEdge.target}`)
  }
  const simulationNodes: SimulationNode[] = nodes.map((node, index) => {
    const fallback = initialPosition(index, nodes.length, options.width, options.height)
    return {
      id: node.id,
      radius: node.radius ?? 18,
      x: Number.isFinite(node.x) ? node.x : fallback.x,
      y: Number.isFinite(node.y) ? node.y : fallback.y,
    }
  })
  const simulationEdges: SimulationEdge[] = edges.map((edge) => ({ ...edge }))
  const nodeById = new Map(simulationNodes.map((node) => [node.id, node]))

  let width = options.width
  let height = options.height
  let simulation: Simulation<SimulationNode, SimulationEdge>

  const center = forceCenter<SimulationNode>(width / 2, height / 2)
    .strength(options.centerStrength)
  const links = forceLink<SimulationNode, SimulationEdge>(simulationEdges)
    .id((node) => node.id)
    .distance(options.linkDistance)
    .strength(options.linkStrength)

  simulation = forceSimulation<SimulationNode>(simulationNodes)
    .velocityDecay(options.velocityDecay)
    .force('charge', forceManyBody<SimulationNode>().strength(options.manyBodyStrength))
    .force('collide', forceCollide<SimulationNode>()
      .radius((node) => node.radius + options.collisionPadding)
      .strength(options.collisionStrength)
      .iterations(2))
    .force('link', links)
    .force('center', center)
    .on('tick', () => publish(simulationNodes))
    .on('end', settled)

  publish(simulationNodes)

  return {
    drag(id, x, y) {
      const node = nodeById.get(id)
      if (!node || !Number.isFinite(x) || !Number.isFinite(y)) return
      node.fx = x
      node.fy = y
      node.x = x
      node.y = y
      simulation.alphaTarget(0.3).restart()
    },
    release(id) {
      const node = nodeById.get(id)
      if (!node) return
      node.fx = null
      node.fy = null
      simulation.alphaTarget(0).alpha(Math.max(simulation.alpha(), 0.3)).restart()
    },
    reheat(alpha = 0.5) {
      simulation.alpha(Math.max(0, Math.min(1, alpha))).restart()
    },
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth)
      height = Math.max(1, nextHeight)
      center.x(width / 2).y(height / 2)
      simulation.alpha(0.35).restart()
    },
    step(iterations = 1) {
      simulation.stop().tick(Math.max(1, iterations))
      publish(simulationNodes)
    },
    stop() {
      simulation.stop()
    },
  }
}
