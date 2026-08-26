import { findNearestGraphEdge, findNearestGraphNode } from './pixiForceGraphHitTesting'
import { createPixiForceGraphLabelManager } from './pixiForceGraphLabels'
import { createPixiForceGraphEdgeLabelManager } from './pixiForceGraphEdgeLabels'
import type {
  PixiForceGraphDependencies,
  PixiForceGraphRenderer,
  PixiForceGraphRendererOptions,
  PixiPointerEvent,
  PixiRenderer,
  PixiSprite,
  PixiTexture,
} from './pixiForceGraphTypes'

export type * from './pixiForceGraphTypes'

function positiveDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function createSolidCircleTexture(
  dependencies: PixiForceGraphDependencies,
  renderer: PixiRenderer,
  radius: number,
  color: number | string,
  resolution: number,
): PixiTexture {
  const graphics = new dependencies.Graphics()
  graphics.beginFill(color)
  graphics.drawCircle(radius, radius, radius)
  graphics.endFill()
  const texture = renderer.generateTexture(graphics, { resolution })
  graphics.destroy()
  return texture
}

function setSpritePosition(sprite: PixiSprite, x: number, y: number): void {
  sprite.x = Number.isFinite(x) ? x : 0
  sprite.y = Number.isFinite(y) ? y : 0
}

/**
 * PIXI renderer for a force-layout graph. Layout ownership stays outside this
 * class: the shared Float32Array is read directly by the shared ticker.
 */
export function createPixiForceGraphRenderer(
  options: PixiForceGraphRendererOptions,
): PixiForceGraphRenderer {
  const {
    dependencies,
    edges,
    host,
    nodes,
    positions,
  } = options
  const nodeRadius = positiveDimension(options.nodeRadius ?? 18, 18)
  const textureRadius = nodes.reduce(
    (largest, node) => Math.max(largest, positiveDimension(node.radius ?? nodeRadius, nodeRadius)),
    nodeRadius,
  )
  const width = positiveDimension(host.clientWidth, 640)
  const height = positiveDimension(host.clientHeight, 420)
  const renderResolution = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  const app = new dependencies.Application({
    antialias: true,
    autoDensity: true,
    autoStart: true,
    backgroundAlpha: 0,
    height,
    resolution: renderResolution,
    sharedTicker: true,
    width,
  })
  const view = app.canvas ?? app.view
  if (view !== undefined) host.appendChild(view)

  const viewport = new dependencies.Viewport({
    screenWidth: width,
    screenHeight: height,
    worldWidth: width,
    worldHeight: height,
    events: app.renderer.events,
  })
  app.stage.addChild(viewport)

  const edgeGraphics = new dependencies.Graphics()
  const particleContainer = new dependencies.ParticleContainer(
    Math.max(1, nodes.length),
    { position: true, tint: true },
    16384,
    true,
  )
  viewport.addChild(edgeGraphics)
  viewport.addChild(particleContainer)
  const labelManager = createPixiForceGraphLabelManager({
    baseResolution: renderResolution,
    dependencies,
    maxLabels: Math.max(1, Math.floor(options.maxVisibleLabels ?? 250)),
    nodes,
    positions,
    scaleThreshold: positiveDimension(options.labelScaleThreshold ?? 0.75, 0.75),
    viewport,
  })
  const edgeLabelManager = createPixiForceGraphEdgeLabelManager({
    baseResolution: renderResolution,
    dependencies,
    edges,
    maxLabels: Math.max(1, Math.floor(options.maxVisibleEdgeLabels ?? 180)),
    positions,
    scaleThreshold: positiveDimension(options.edgeLabelScaleThreshold ?? 0.85, 0.85),
    viewport,
  })
  viewport.addChild(labelManager.layer)
  viewport.addChild(edgeLabelManager.layer)

  // One generated texture is shared by every node sprite. Per-node radii use
  // sprite scale so texture generation remains constant regardless of graph size.
  const texture = createSolidCircleTexture(
    dependencies,
    app.renderer,
    textureRadius,
    0xffffff,
    Math.min(4, renderResolution * 2),
  )
  const normalColors = nodes.map((node) => node.color ?? options.nodeColor ?? 0x3d6ff6)
  const selectedColor = options.selectedColor ?? 0x244dcc
  let selectedIndex = options.selectedIndex !== null
    && options.selectedIndex !== undefined
    && nodes[options.selectedIndex]
    ? options.selectedIndex
    : null
  let selectedEdgeId = options.selectedEdgeId ?? null
  const sprites = nodes.map((node, index) => {
    const sprite = new dependencies.Sprite(texture)
    sprite.anchor?.set(0.5)
    sprite.tint = index === selectedIndex ? selectedColor : normalColors[index]
    const radius = positiveDimension(node.radius ?? nodeRadius, nodeRadius)
    sprite.scale?.set(radius / textureRadius)
    setSpritePosition(sprite, positions[index * 2] ?? 0, positions[index * 2 + 1] ?? 0)
    particleContainer.addChild(sprite)
    return sprite
  })

  const edgeColor = options.edgeColor ?? 0xb9c0ca
  const highlightEdgeColor = options.highlightEdgeColor ?? 0x3d6ff6
  const edgeWidth = positiveDimension(options.edgeWidth ?? 1.2, 1.2)
  const edgeAlpha = Number.isFinite(options.edgeAlpha) ? options.edgeAlpha! : 0.8
  let hoveredIndex: number | null = null
  let dragIndex: number | null = null
  let dragStart: { x: number; y: number } | null = null
  let dragMoved = false
  let lastSelectedAt = 0
  let lastSelectedIndex: number | null = null
  let destroyed = false
  let screenWidth = width
  let screenHeight = height
  const nodeAlphaTargets = new Float32Array(sprites.length)
  nodeAlphaTargets.fill(1)
  const focusAlpha = 0.16
  const alphaLerp = 0.22

  const drawEdge = (edge: (typeof edges)[number], arrow = edge.directed) => {
    const sourceX = positions[edge.source * 2]
    const sourceY = positions[edge.source * 2 + 1]
    const targetX = positions[edge.target * 2]
    const targetY = positions[edge.target * 2 + 1]
    if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) return
    edgeGraphics.moveTo(sourceX!, sourceY!)
    edgeGraphics.lineTo(targetX!, targetY!)
    if (arrow) {
      const angle = Math.atan2(targetY! - sourceY!, targetX! - sourceX!)
      const targetRadius = positiveDimension(nodes[edge.target]?.radius ?? nodeRadius, nodeRadius)
      const tipX = targetX! - Math.cos(angle) * (targetRadius + 2)
      const tipY = targetY! - Math.sin(angle) * (targetRadius + 2)
      const size = 7 / Math.max(0.65, viewport.scale?.x ?? 1)
      edgeGraphics.beginFill(edge.color ?? edgeColor)
      edgeGraphics.drawPolygon([
        tipX, tipY,
        tipX - Math.cos(angle - Math.PI / 5) * size, tipY - Math.sin(angle - Math.PI / 5) * size,
        tipX - Math.cos(angle + Math.PI / 5) * size, tipY - Math.sin(angle + Math.PI / 5) * size,
      ])
      edgeGraphics.endFill()
    }
  }

  const setHoveredIndex = (nextIndex: number | null) => {
    const normalized = nextIndex !== null && sprites[nextIndex] ? nextIndex : null
    if (destroyed || normalized === hoveredIndex) return
    hoveredIndex = normalized
    if (hoveredIndex === null) {
      nodeAlphaTargets.fill(1)
      viewport.cursor = 'grab'
    } else {
      nodeAlphaTargets.fill(focusAlpha)
      nodeAlphaTargets[hoveredIndex] = 1
      for (const edge of edges) {
        if (edge.source === hoveredIndex || edge.target === hoveredIndex) {
          if (sprites[edge.source]) nodeAlphaTargets[edge.source] = 1
          if (sprites[edge.target]) nodeAlphaTargets[edge.target] = 1
        }
      }
      viewport.cursor = 'pointer'
    }
    particleContainer.update?.()
    options.onNodeHover?.(hoveredIndex)
  }

  const worldPoint = (event: PixiPointerEvent) => (
    viewport.toWorld?.(event.global.x, event.global.y) ?? event.global
  )
  const hitTest = (x: number, y: number) => findNearestGraphNode({
    nodes,
    positions,
    revision: options.revision,
    scale: viewport.scale?.x ?? 1,
    x,
    y,
  })
  const onPointerMove = (event: PixiPointerEvent) => {
    const point = worldPoint(event)
    if (dragIndex !== null) {
      if (dragStart && Math.hypot(point.x - dragStart.x, point.y - dragStart.y) > 3) dragMoved = true
      if (dragMoved) options.onNodeDrag?.(dragIndex, point.x, point.y)
      return
    }
    const hit = hitTest(point.x, point.y)
    if (hit !== undefined) setHoveredIndex(hit)
  }
  const onPointerDown = (event: PixiPointerEvent) => {
    if (event.button !== undefined && event.button !== 0) return
    const point = worldPoint(event)
    const hit = hitTest(point.x, point.y)
    if (hit === undefined) return
    if (hit === null) {
      const edgeIndex = findNearestGraphEdge({
        edges,
        positions,
        revision: options.revision,
        scale: viewport.scale?.x ?? 1,
        x: point.x,
        y: point.y,
      })
      if (edgeIndex !== null && edgeIndex !== undefined) {
        const edgeId = edges[edgeIndex]?.id
        if (edgeId) {
          selectedEdgeId = edgeId
          options.onEdgeSelect?.(edgeId)
          event.stopImmediatePropagation?.()
        }
      }
      return
    }
    dragIndex = hit
    dragStart = point
    dragMoved = false
    viewport.plugins?.pause('drag')
    event.stopImmediatePropagation?.()
    setHoveredIndex(hit)
    viewport.cursor = 'grabbing'
  }
  const releaseDrag = () => {
    if (dragIndex === null) return
    const releasedIndex = dragIndex
    dragIndex = null
    dragStart = null
    viewport.plugins?.resume('drag')
    viewport.cursor = hoveredIndex === null ? 'grab' : 'pointer'
    if (dragMoved) options.onNodeRelease?.(releasedIndex)
    if (!dragMoved) {
      const selectedAt = Date.now()
      options.onNodeSelect?.(releasedIndex)
      if (releasedIndex === lastSelectedIndex && selectedAt - lastSelectedAt <= 350) {
        options.onNodeOpen?.(releasedIndex)
        lastSelectedAt = 0
        lastSelectedIndex = null
      } else {
        lastSelectedAt = selectedAt
        lastSelectedIndex = releasedIndex
      }
    }
    dragMoved = false
  }
  const onPointerLeave = () => {
    releaseDrag()
    setHoveredIndex(null)
  }
  viewport.on?.('pointerdown', onPointerDown)
  viewport.on?.('pointermove', onPointerMove)
  viewport.on?.('pointerup', releaseDrag)
  viewport.on?.('pointerupoutside', releaseDrag)
  viewport.on?.('pointercancel', releaseDrag)
  viewport.on?.('pointerleave', onPointerLeave)
  // Claim node presses before the drag plugin handles subsequent movement.
  viewport.drag().wheel().pinch()

  const drawFrame = () => {
    if (destroyed) return
    const startRevision = options.revision?.() ?? 0
    if ((startRevision & 1) === 1) return
    for (let index = 0; index < sprites.length; index += 1) {
      setSpritePosition(sprites[index]!, positions[index * 2] ?? 0, positions[index * 2 + 1] ?? 0)
      const sprite = sprites[index]!
      const targetAlpha = nodeAlphaTargets[index] ?? 1
      const nextAlpha = (sprite.alpha ?? 1) + (targetAlpha - (sprite.alpha ?? 1)) * alphaLerp
      sprite.alpha = Math.abs(targetAlpha - nextAlpha) < 0.01 ? targetAlpha : nextAlpha
    }
    edgeGraphics.clear()
    for (const edge of edges) {
      const selected = Boolean(edge.id && edge.id === selectedEdgeId)
      edgeGraphics.lineStyle(
        selected ? Math.max(edgeWidth * 2.2, edge.width ?? 0) : edge.width ?? edgeWidth,
        selected ? highlightEdgeColor : edge.color ?? edgeColor,
        selected ? 1 : (hoveredIndex === null ? edge.alpha ?? edgeAlpha : 0.08),
      )
      drawEdge(edge)
    }
    if (hoveredIndex !== null) {
      edgeGraphics.lineStyle(edgeWidth * 1.7, highlightEdgeColor, 1)
      for (const edge of edges) {
        if (edge.source === hoveredIndex || edge.target === hoveredIndex) drawEdge(edge)
      }
    }
    labelManager.update(hoveredIndex)
    edgeLabelManager.update(hoveredIndex, selectedEdgeId)
    const endRevision = options.revision?.() ?? startRevision
    if (startRevision !== endRevision || (endRevision & 1) === 1) return
    // A concurrent Worker tick may invalidate this read. Keep the most recent
    // frame on screen and retry instead of flashing the whole graph invisible.
    particleContainer.renderable = true
    edgeGraphics.renderable = true
    labelManager.layer.renderable = true
  }
  dependencies.Ticker.shared.add(drawFrame)
  drawFrame()

  const fitView = () => {
    if (destroyed || nodes.length === 0) return
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    nodes.forEach((node, index) => {
      const x = positions[index * 2]
      const y = positions[index * 2 + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) return
      const radius = positiveDimension(node.radius ?? nodeRadius, nodeRadius)
      minX = Math.min(minX, x! - radius)
      minY = Math.min(minY, y! - radius)
      maxX = Math.max(maxX, x! + radius)
      maxY = Math.max(maxY, y! + radius + 24)
    })
    if (!Number.isFinite(minX)) return
    const scale = Math.min(4, Math.max(0.2, Math.min(
      Math.max(1, screenWidth - 48) / Math.max(1, maxX - minX),
      Math.max(1, screenHeight - 48) / Math.max(1, maxY - minY),
    )))
    viewport.setZoom?.(scale, false)
    viewport.moveCenter?.((minX + maxX) / 2, (minY + maxY) / 2)
  }

  return {
    app,
    edgeGraphics,
    labelLayer: labelManager.layer,
    particleContainer,
    viewport,
    sprites,
    activeLabelCount: () => labelManager.activeCount(),
    createdLabelCount: () => labelManager.createdCount(),
    fitView,
    hitTest,
    resize(nextWidth, nextHeight) {
      if (destroyed) return
      const safeWidth = positiveDimension(nextWidth, width)
      const safeHeight = positiveDimension(nextHeight, height)
      screenWidth = safeWidth
      screenHeight = safeHeight
      app.renderer.resize?.(safeWidth, safeHeight)
      viewport.resize?.(safeWidth, safeHeight, safeWidth, safeHeight)
    },
    setSelectedIndex(nextIndex) {
      if (destroyed || nextIndex === selectedIndex) return
      if (selectedIndex !== null && sprites[selectedIndex]) {
        sprites[selectedIndex]!.tint = normalColors[selectedIndex]
      }
      selectedIndex = nextIndex !== null && sprites[nextIndex] ? nextIndex : null
      if (selectedIndex !== null) sprites[selectedIndex]!.tint = selectedColor
      particleContainer.update?.()
    },
    setSelectedEdgeId(nextId) {
      selectedEdgeId = nextId
    },
    setHoveredIndex,
    destroy() {
      if (destroyed) return
      destroyed = true
      dependencies.Ticker.shared.remove(drawFrame)
      dragMoved = true
      releaseDrag()
      viewport.off?.('pointerdown', onPointerDown)
      viewport.off?.('pointermove', onPointerMove)
      viewport.off?.('pointerup', releaseDrag)
      viewport.off?.('pointerupoutside', releaseDrag)
      viewport.off?.('pointercancel', releaseDrag)
      viewport.off?.('pointerleave', onPointerLeave)
      for (const sprite of sprites) {
        particleContainer.removeChild?.(sprite)
        sprite.destroy()
      }
      viewport.removeChild?.(edgeGraphics)
      viewport.removeChild?.(particleContainer)
      viewport.removeChild?.(labelManager.layer)
      viewport.removeChild?.(edgeLabelManager.layer)
      particleContainer.destroy({ children: false })
      edgeGraphics.destroy()
      labelManager.destroy()
      edgeLabelManager.destroy()
      app.stage.removeChild?.(viewport)
      viewport.destroy({ children: false })
      texture.destroy(true)
      app.destroy(true, { children: true })
    },
  }
}
