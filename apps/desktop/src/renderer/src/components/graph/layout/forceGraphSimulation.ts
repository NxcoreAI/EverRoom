import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

import type { ForceGraphEdge, ForceGraphNode, ForceGraphOptions } from './forceGraphProtocol'

interface SimulationNode extends SimulationNodeDatum {
  degree: number
  id: string
  radius: number
}

interface SimulationEdge extends SimulationLinkDatum<SimulationNode> {
  source: string | SimulationNode
  target: string | SimulationNode
}

/** 布局世界矩形：minX/minY 可为负（向左/上拖拽扩张时不平移坐标系）。 */
interface WorldRect {
  maxX: number
  maxY: number
  minX: number
  minY: number
}

function nodeBounds(node: SimulationNode, world: WorldRect, padding: number) {
  const width = world.maxX - world.minX
  const height = world.maxY - world.minY
  const xMargin = Math.min(node.radius + padding, width / 2)
  const yMargin = Math.min(node.radius + padding, height / 2)
  return {
    maxX: world.maxX - xMargin,
    maxY: world.maxY - yMargin,
    minX: world.minX + xMargin,
    minY: world.minY + yMargin,
  }
}

function createBoundsForce(
  getWorld: () => WorldRect,
  padding: number,
) {
  let simulationNodes: SimulationNode[] = []
  const force = () => {
    const world = getWorld()
    for (const node of simulationNodes) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue
      const { maxX, maxY, minX, minY } = nodeBounds(node, world, padding)
      const projectedX = node.x! + (node.vx ?? 0)
      const projectedY = node.y! + (node.vy ?? 0)
      if (projectedX < minX) {
        node.vx = minX - node.x!
      } else if (projectedX > maxX) {
        node.vx = maxX - node.x!
      }
      if (projectedY < minY) {
        node.vy = minY - node.y!
      } else if (projectedY > maxY) {
        node.vy = maxY - node.y!
      }
    }
  }
  force.initialize = (nodes: SimulationNode[]) => {
    simulationNodes = nodes
  }
  return force
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
  const degreeById = new Map(nodes.map((node) => [node.id, 0]))
  for (const edge of edges) {
    degreeById.set(edge.source, (degreeById.get(edge.source) ?? 0) + 1)
    degreeById.set(edge.target, (degreeById.get(edge.target) ?? 0) + 1)
  }
  const simulationNodes: SimulationNode[] = nodes.map((node, index) => {
    const fallback = initialPosition(index, nodes.length, options.width, options.height)
    return {
      degree: degreeById.get(node.id) ?? 0,
      id: node.id,
      radius: node.radius ?? 18,
      x: Number.isFinite(node.x) ? node.x : fallback.x,
      y: Number.isFinite(node.y) ? node.y : fallback.y,
    }
  })
  const simulationEdges: SimulationEdge[] = edges.map((edge) => ({ ...edge }))
  const nodeById = new Map(simulationNodes.map((node) => [node.id, node]))

  const world: WorldRect = { minX: 0, minY: 0, maxX: options.width, maxY: options.height }

  const centerX = forceX<SimulationNode>((world.minX + world.maxX) / 2)
    .strength(options.centerStrength)
  const centerY = forceY<SimulationNode>((world.minY + world.maxY) / 2)
    .strength(options.centerStrength)
  const edgeDegree = (edge: SimulationEdge) => {
    const source = typeof edge.source === 'string' ? degreeById.get(edge.source) ?? 0 : edge.source.degree
    const target = typeof edge.target === 'string' ? degreeById.get(edge.target) ?? 0 : edge.target.degree
    return Math.max(1, source, target)
  }
  const links = forceLink<SimulationNode, SimulationEdge>(simulationEdges)
    .id((node) => node.id)
    .distance((edge) => options.linkDistance * (
      1 + Math.min(0.65, Math.log2(edgeDegree(edge) + 1) * 0.14) * options.degreeBias
    ))
    .strength((edge) => options.linkStrength / Math.pow(edgeDegree(edge), options.degreeBias * 0.5))

  let simulation: Simulation<SimulationNode, SimulationEdge>
  simulation = forceSimulation<SimulationNode>(simulationNodes)
    .velocityDecay(options.velocityDecay)
    .force('charge', forceManyBody<SimulationNode>().strength((node) => (
      options.manyBodyStrength * (
        1 + Math.min(1.4, Math.log2(node.degree + 1) * 0.32) * options.degreeBias
      )
    )))
    .force('collide', forceCollide<SimulationNode>()
      .radius((node) => node.radius + options.collisionPadding)
      .strength(options.collisionStrength)
      .iterations(2))
    .force('link', links)
    .force('center-x', centerX)
    .force('center-y', centerY)
    .force('bounds', createBoundsForce(() => world, options.collisionPadding))
    .on('tick', () => publish(simulationNodes))
    .on('end', settled)

  publish(simulationNodes)

  return {
    drag(id, x, y) {
      const node = nodeById.get(id)
      if (!node || !Number.isFinite(x) || !Number.isFinite(y)) return
      // 拖出当前世界：扩张世界矩形以容纳落点（含半径与碰撞边距），不再钳制。
      // 中心力换到新世界中心，其余节点随斥力在更大空间里铺开，缓解拥挤。
      const margin = node.radius + options.collisionPadding
      const nextMinX = Math.min(world.minX, x - margin)
      const nextMinY = Math.min(world.minY, y - margin)
      const nextMaxX = Math.max(world.maxX, x + margin)
      const nextMaxY = Math.max(world.maxY, y + margin)
      if (nextMinX !== world.minX || nextMinY !== world.minY
        || nextMaxX !== world.maxX || nextMaxY !== world.maxY) {
        world.minX = nextMinX
        world.minY = nextMinY
        world.maxX = nextMaxX
        world.maxY = nextMaxY
        centerX.x((world.minX + world.maxX) / 2)
        centerY.y((world.minY + world.maxY) / 2)
      }
      node.fx = x
      node.fy = y
      node.x = x
      node.y = y
      simulation.alphaTarget(0.08).restart()
    },
    release(id) {
      const node = nodeById.get(id)
      if (!node) return
      node.fx = null
      node.fy = null
      simulation.alphaTarget(0).alpha(Math.max(simulation.alpha(), 0.12)).restart()
    },
    reheat(alpha = 0.5) {
      simulation.alpha(Math.max(0, Math.min(1, alpha))).restart()
    },
    resize(nextWidth, nextHeight) {
      // 基准矩形 [0,w]×[0,h] 与当前世界取并：面板/自适应尺寸只抬高空间下限，
      // 不收回拖拽已扩张（或更大面板已给过）的空间，避免节点群被拉回挤压。
      const baseWidth = Math.max(1, nextWidth)
      const baseHeight = Math.max(1, nextHeight)
      const nextMinX = Math.min(world.minX, 0)
      const nextMinY = Math.min(world.minY, 0)
      const nextMaxX = Math.max(world.maxX, baseWidth)
      const nextMaxY = Math.max(world.maxY, baseHeight)
      if (nextMinX === world.minX && nextMinY === world.minY
        && nextMaxX === world.maxX && nextMaxY === world.maxY) return
      world.minX = nextMinX
      world.minY = nextMinY
      world.maxX = nextMaxX
      world.maxY = nextMaxY
      centerX.x((world.minX + world.maxX) / 2)
      centerY.y((world.minY + world.maxY) / 2)
      simulation.alpha(Math.max(simulation.alpha(), 0.08)).restart()
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
