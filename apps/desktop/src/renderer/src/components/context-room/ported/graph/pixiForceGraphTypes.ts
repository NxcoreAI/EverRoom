export interface PixiTicker {
  add(callback: () => void, context?: unknown): void
  remove(callback: () => void, context?: unknown): void
}

export interface PixiTexture {
  destroy(destroySource?: boolean): void
}

export interface PixiGraphics {
  beginFill(color: number | string): PixiGraphics
  drawCircle(x: number, y: number, radius: number): PixiGraphics
  endFill(): PixiGraphics
  clear(): PixiGraphics
  lineStyle(width: number, color: number | string, alpha?: number): PixiGraphics
  moveTo(x: number, y: number): PixiGraphics
  lineTo(x: number, y: number): PixiGraphics
  destroy(options?: unknown): void
  renderable?: boolean
}

export interface PixiSprite {
  x: number
  y: number
  alpha?: number
  tint?: number | string
  visible?: boolean
  anchor?: { set(x: number, y?: number): void }
  scale?: { set(x: number, y?: number): void }
  destroy(options?: unknown): void
}

export interface PixiText extends PixiSprite {
  text: string
}

export interface PixiDisplayList {
  addChild(child: unknown): void
  removeChild?(child: unknown): void
}

export interface PixiContainer extends PixiDisplayList {
  visible?: boolean
  renderable?: boolean
  interactiveChildren?: boolean
  destroy(options?: unknown): void
}

export interface PixiParticleContainer extends PixiContainer {
  addChild(child: PixiSprite): void
  removeChild?(child: PixiSprite): void
  removeChildren?(): void
  update?(): void
}

export interface PixiRenderer {
  events?: unknown
  generateTexture(graphics: PixiGraphics): PixiTexture
  resize?(width: number, height: number): void
}

export interface PixiApplication {
  renderer: PixiRenderer
  stage: PixiDisplayList
  canvas?: unknown
  view?: unknown
  destroy(removeView?: boolean, options?: unknown): void
}

export interface PixiApplicationConstructor {
  new (options?: Record<string, unknown>): PixiApplication
}

export interface PixiPointerEvent {
  button?: number
  pointerId?: number
  global: { x: number; y: number }
  stopImmediatePropagation?(): void
}

export interface PixiViewport extends PixiContainer {
  cursor?: string
  scale?: { x: number; y: number }
  plugins?: {
    pause(name: string): void
    resume(name: string): void
  }
  drag(): PixiViewport
  wheel(): PixiViewport
  pinch(): PixiViewport
  resize?(screenWidth: number, screenHeight: number, worldWidth?: number, worldHeight?: number): PixiViewport
  getVisibleBounds?(): { x: number; y: number; width: number; height: number }
  toWorld?(x: number, y: number): { x: number; y: number }
  on?(event: string, callback: (event: PixiPointerEvent) => void): void
  off?(event: string, callback: (event: PixiPointerEvent) => void): void
}

export interface PixiViewportConstructor {
  new (options: {
    screenWidth: number
    screenHeight: number
    worldWidth: number
    worldHeight: number
    events?: unknown
  }): PixiViewport
}

export interface PixiForceGraphDependencies {
  Application: PixiApplicationConstructor
  Container: new () => PixiContainer
  Graphics: new () => PixiGraphics
  Sprite: new (texture: PixiTexture) => PixiSprite
  Text: new (text?: string, style?: Record<string, unknown>) => PixiText
  ParticleContainer: new (
    maxSize?: number,
    properties?: { position: boolean; tint?: boolean },
    batchSize?: number,
    autoResize?: boolean,
  ) => PixiParticleContainer
  Ticker: { shared: PixiTicker }
  Viewport: PixiViewportConstructor
}

export interface PixiForceGraphNode {
  color?: number | string
  label?: string
  radius?: number
}

export interface PixiForceGraphEdge {
  source: number
  target: number
}

export interface PixiForceGraphRendererOptions {
  host: {
    clientWidth: number
    clientHeight: number
    appendChild(child: unknown): void
  }
  positions: Float32Array
  nodes: readonly PixiForceGraphNode[]
  edges: readonly PixiForceGraphEdge[]
  dependencies: PixiForceGraphDependencies
  nodeRadius?: number
  nodeColor?: number | string
  edgeColor?: number | string
  edgeWidth?: number
  edgeAlpha?: number
  highlightEdgeColor?: number | string
  labelScaleThreshold?: number
  maxVisibleLabels?: number
  revision?: () => number
  selectedColor?: number | string
  selectedIndex?: number | null
  onNodeDrag?: (index: number, x: number, y: number) => void
  onNodeHover?: (index: number | null) => void
  onNodeRelease?: (index: number) => void
  onNodeSelect?: (index: number) => void
}

export interface PixiForceGraphRenderer {
  readonly app: PixiApplication
  readonly viewport: PixiViewport
  readonly particleContainer: PixiParticleContainer
  readonly edgeGraphics: PixiGraphics
  readonly labelLayer: PixiContainer
  readonly sprites: readonly PixiSprite[]
  activeLabelCount(): number
  createdLabelCount(): number
  hitTest(x: number, y: number): number | null | undefined
  resize(width: number, height: number): void
  setHoveredIndex(index: number | null): void
  setSelectedIndex(index: number | null): void
  destroy(): void
}
