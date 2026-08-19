import { findNearestGraphNode } from './pixiForceGraphHitTesting'
import { createPixiForceGraphLabelManager } from './pixiForceGraphLabels'
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
): PixiTexture {
  const graphics = new dependencies.Graphics()
  graphics.beginFill(color)
  graphics.drawCircle(radius, radius, radius)
  graphics.endFill()
  const texture = renderer.generateTexture(graphics)
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
  const width = positiveDimension(host.clientWidth, 640)
  const height = positiveDimension(host.clientHeight, 420)
  const app = new dependencies.Application({
    antialias: true,
    autoDensity: true,
    autoStart: true,
    backgroundAlpha: 0,
    height,
    resolution: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
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
    dependencies,
    maxLabels: Math.max(1, Math.floor(options.maxVisibleLabels ?? 250)),
    nodes,
    positions,
    scaleThreshold: positiveDimension(options.labelScaleThreshold ?? 0.75, 0.75),
    viewport,
  })
  viewport.addChild(labelManager.layer)

  // One generated texture is shared by every node sprite. Per-node radii use
  // sprite scale so texture generation remains constant regardless of graph size.
  const texture = createSolidCircleTexture(
    dependencies,
    app.renderer,
    nodeRadius,
    0xffffff,
  )
  const normalColors = nodes.map((node) => node.color ?? options.nodeColor ?? 0x3d6ff6)
  const selectedColor = options.selectedColor ?? 0x244dcc
  let selectedIndex = options.selectedIndex !== null
    && options.selectedIndex !== undefined
    && nodes[options.selectedIndex]
    ? options.selectedIndex
    : null
  const sprites = nodes.map((node, index) => {
    const sprite = new dependencies.Sprite(texture)
    sprite.anchor?.set(0.5)
    sprite.tint = index === selectedIndex ? selectedColor : normalColors[index]
    const radius = positiveDimension(node.radius ?? nodeRadius, nodeRadius)
    sprite.scale?.set(radius / nodeRadius)
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
  let destroyed = false
  const nodeAlphaTargets = new Float32Array(sprites.length)
  nodeAlphaTargets.fill(1)
  const focusAlpha = 0.16
  const alphaLerp = 0.22

  const drawEdge = (edge: (typeof edges)[number]) => {
    const sourceX = positions[edge.source * 2]
    const sourceY = positions[edge.source * 2 + 1]
    const targetX = positions[edge.target * 2]
    const targetY = positions[edge.target * 2 + 1]
    if (![sourceX, sourceY, targetX, targetY].every(Number.isFinite)) return
    edgeGraphics.moveTo(sourceX!, sourceY!)
    edgeGraphics.lineTo(targetX!, targetY!)
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
      options.onNodeDrag?.(dragIndex, point.x, point.y)
      return
    }
    const hit = hitTest(point.x, point.y)
    if (hit !== undefined) setHoveredIndex(hit)
  }
  const onPointerDown = (event: PixiPointerEvent) => {
    if (event.button !== undefined && event.button !== 0) return
    const point = worldPoint(event)
    const hit = hitTest(point.x, point.y)
    if (hit === null || hit === undefined) return
    dragIndex = hit
    dragStart = point
    dragMoved = false
    viewport.plugins?.pause('drag')
    event.stopImmediatePropagation?.()
    setHoveredIndex(hit)
    viewport.cursor = 'grabbing'
    options.onNodeDrag?.(hit, point.x, point.y)
  }
  const releaseDrag = () => {
    if (dragIndex === null) return
    const releasedIndex = dragIndex
    dragIndex = null
    dragStart = null
    viewport.plugins?.resume('drag')
    viewport.cursor = hoveredIndex === null ? 'grab' : 'pointer'
    options.onNodeRelease?.(releasedIndex)
    if (!dragMoved) options.onNodeSelect?.(releasedIndex)
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
    edgeGraphics.lineStyle(edgeWidth, edgeColor, hoveredIndex === null ? edgeAlpha : 0.08)
    for (const edge of edges) drawEdge(edge)
    if (hoveredIndex !== null) {
      edgeGraphics.lineStyle(edgeWidth * 1.7, highlightEdgeColor, 1)
      for (const edge of edges) {
        if (edge.source === hoveredIndex || edge.target === hoveredIndex) drawEdge(edge)
      }
    }
    labelManager.update(hoveredIndex)
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

  return {
    app,
    edgeGraphics,
    labelLayer: labelManager.layer,
    particleContainer,
    viewport,
    sprites,
    activeLabelCount: () => labelManager.activeCount(),
    createdLabelCount: () => labelManager.createdCount(),
    hitTest,
    resize(nextWidth, nextHeight) {
      if (destroyed) return
      const safeWidth = positiveDimension(nextWidth, width)
      const safeHeight = positiveDimension(nextHeight, height)
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
      particleContainer.destroy({ children: false })
      edgeGraphics.destroy()
      labelManager.destroy()
      app.stage.removeChild?.(viewport)
      viewport.destroy({ children: false })
      texture.destroy(true)
      app.destroy(true, { children: true })
    },
  }
}
