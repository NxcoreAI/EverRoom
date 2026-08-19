export interface GraphCanvasNode {
  fill: string
  id: string
  label: string
  radius: number
  stroke: string
}

export interface GraphCanvasEdge {
  label?: string
  source: number
  target: number
}

export interface GraphCanvasTransform {
  offsetX: number
  offsetY: number
  scale: number
}

const MIN_SCALE = 0.2
const MAX_SCALE = 4

export function boundedGraphScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))
}

export function graphPoint(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  canvas: HTMLCanvasElement,
  transform: GraphCanvasTransform,
) {
  const bounds = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left - transform.offsetX) / transform.scale,
    y: (event.clientY - bounds.top - transform.offsetY) / transform.scale,
  }
}

export function hitGraphNode(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  canvas: HTMLCanvasElement,
  transform: GraphCanvasTransform,
  nodes: readonly GraphCanvasNode[],
  positions: Float32Array,
) {
  const point = graphPoint(event, canvas, transform)
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const x = positions[index * 2]
    const y = positions[index * 2 + 1]
    const radius = nodes[index]!.radius + 5 / transform.scale
    if (Number.isFinite(x) && Number.isFinite(y)
      && Math.hypot(point.x - x, point.y - y) <= radius) return nodes[index]!
  }
  return null
}

export function fitGraphTransform(
  nodes: readonly GraphCanvasNode[],
  positions: Float32Array,
  width: number,
  height: number,
): GraphCanvasTransform | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  nodes.forEach((node, index) => {
    const x = positions[index * 2]
    const y = positions[index * 2 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x - node.radius)
    minY = Math.min(minY, y - node.radius)
    maxX = Math.max(maxX, x + node.radius)
    maxY = Math.max(maxY, y + node.radius + 24)
  })
  if (!Number.isFinite(minX)) return null
  const contentWidth = Math.max(1, maxX - minX)
  const contentHeight = Math.max(1, maxY - minY)
  const scale = boundedGraphScale(Math.min(
    (Math.max(1, width) - 48) / contentWidth,
    (Math.max(1, height) - 48) / contentHeight,
  ))
  return {
    scale,
    offsetX: (width - (minX + maxX) * scale) / 2,
    offsetY: (height - (minY + maxY) * scale) / 2,
  }
}

function labelText(value: string) {
  return value.length > 18 ? `${value.slice(0, 17)}…` : value
}

export function drawGraphCanvas({
  activeId,
  context,
  edges,
  height,
  nodes,
  positions,
  transform,
  width,
}: {
  activeId: string | null
  context: CanvasRenderingContext2D
  edges: readonly GraphCanvasEdge[]
  height: number
  nodes: readonly GraphCanvasNode[]
  positions: Float32Array
  transform: GraphCanvasTransform
  width: number
}) {
  context.clearRect(0, 0, width, height)
  const activeIndex = nodes.findIndex((node) => node.id === activeId)
  const neighbors = new Set<number>()
  if (activeIndex >= 0) {
    edges.forEach((edge) => {
      if (edge.source === activeIndex) neighbors.add(edge.target)
      if (edge.target === activeIndex) neighbors.add(edge.source)
    })
  }

  context.save()
  context.translate(transform.offsetX, transform.offsetY)
  context.scale(transform.scale, transform.scale)
  edges.forEach((edge) => {
    const sourceX = positions[edge.source * 2]
    const sourceY = positions[edge.source * 2 + 1]
    const targetX = positions[edge.target * 2]
    const targetY = positions[edge.target * 2 + 1]
    if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) return
    const adjacent = activeIndex < 0 || edge.source === activeIndex || edge.target === activeIndex
    context.globalAlpha = adjacent ? 0.85 : 0.12
    context.strokeStyle = adjacent && activeIndex >= 0 ? '#3d6ff6' : '#b9c0ca'
    context.lineWidth = (adjacent && activeIndex >= 0 ? 2 : 1.2) / transform.scale
    context.beginPath()
    context.moveTo(sourceX, sourceY)
    context.lineTo(targetX, targetY)
    context.stroke()
    if (edge.label && transform.scale >= 0.55) {
      context.globalAlpha = adjacent ? 0.9 : 0.18
      context.fillStyle = '#7b8491'
      context.font = `${10 / transform.scale}px sans-serif`
      context.textAlign = 'center'
      context.fillText(edge.label, (sourceX + targetX) / 2, (sourceY + targetY) / 2 - 4)
    }
  })

  nodes.forEach((node, index) => {
    const x = positions[index * 2]
    const y = positions[index * 2 + 1]
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const active = index === activeIndex
    const related = activeIndex < 0 || active || neighbors.has(index)
    context.globalAlpha = related ? 1 : 0.28
    context.fillStyle = node.fill
    context.strokeStyle = active ? '#3d6ff6' : node.stroke
    context.lineWidth = (active ? 3 : 2) / transform.scale
    context.beginPath()
    context.arc(x, y, node.radius, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    context.fillStyle = '#374151'
    context.font = `${active ? 600 : 500} ${11 / transform.scale}px sans-serif`
    context.textAlign = 'center'
    context.textBaseline = 'top'
    context.fillText(labelText(node.label), x, y + node.radius + 7 / transform.scale)
  })
  context.restore()
  context.globalAlpha = 1
}
