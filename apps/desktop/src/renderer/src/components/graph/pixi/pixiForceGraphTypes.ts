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
  drawPolygon(points: number[]): PixiGraphics
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
  resolution?: number
  roundPixels?: boolean
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
  generateTexture(graphics: PixiGraphics, options?: { resolution?: number }): PixiTexture
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
  /** 视口平移位置（Pixi Container 的 x/y）：脏检查用——平移改变可视矩形与箭头尺寸，需要重画。 */
  x?: number
  y?: number
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
  moveCenter?(x: number, y: number): PixiViewport
  setZoom?(scale: number, center?: boolean): PixiViewport
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

/**
 * 图标纹理工厂：按 icon 名生成纹理，返回 null 表示该图标无纹理（节点不画图标）。
 * 渲染层内置一套默认图标；使用面注入自定义工厂即可扩展图标词表，无需改内核。
 */
export type PixiForceGraphIconTextureFactory = (
  icon: string,
  dependencies: PixiForceGraphDependencies,
  renderer: PixiRenderer,
  resolution: number,
) => PixiTexture | null

export interface PixiForceGraphDependencies {
  Application: PixiApplicationConstructor
  Container: new () => PixiContainer
  Graphics: new () => PixiGraphics
  Sprite: new (texture: PixiTexture) => PixiSprite
  Text: new (text?: string, style?: Record<string, unknown>) => PixiText
  ParticleContainer: new (
    maxSize?: number,
    properties?: { position: boolean; alpha?: boolean; scale?: boolean; tint?: boolean },
    batchSize?: number,
    autoResize?: boolean,
  ) => PixiParticleContainer
  Ticker: { shared: PixiTicker }
  Viewport: PixiViewportConstructor
}

export interface PixiForceGraphNode {
  color?: number | string
  /** 图标名，含义由使用面定义；渲染层只负责按名取纹理（见 PixiForceGraphIconTextureFactory）。 */
  icon?: string
  label?: string
  radius?: number
}

export interface PixiForceGraphEdge {
  id?: string
  label?: string
  labelColor?: number | string
  source: number
  target: number
  directed?: boolean
  color?: number | string
  width?: number
  alpha?: number
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
  createIconTexture?: PixiForceGraphIconTextureFactory
  /** 面板只作视口时：创建后把视野对准内容包围盒中心（保持原始缩放，拖拽平移浏览）。 */
  centerOnMount?: boolean
  nodeRadius?: number
  nodeColor?: number | string
  edgeColor?: number | string
  edgeWidth?: number
  edgeAlpha?: number
  highlightEdgeColor?: number | string
  labelScaleThreshold?: number
  maxVisibleLabels?: number
  edgeLabelScaleThreshold?: number
  maxVisibleEdgeLabels?: number
  revision?: () => number
  selectedColor?: number | string
  selectedIndex?: number | null
  selectedEdgeId?: string | null
  onEdgeSelect?: (id: string) => void
  onNodeDrag?: (index: number, x: number, y: number) => void
  onNodeHover?: (index: number | null) => void
  onNodeOpen?: (index: number) => void
  onNodeRelease?: (index: number) => void
  onNodeSelect?: (index: number) => void
}

export interface PixiForceGraphRenderer {
  readonly app: PixiApplication
  readonly viewport: PixiViewport
  readonly particleContainer: PixiParticleContainer
  readonly iconParticleContainers: readonly PixiParticleContainer[]
  readonly edgeGraphics: PixiGraphics
  readonly labelLayer: PixiContainer
  readonly sprites: readonly PixiSprite[]
  activeLabelCount(): number
  createdLabelCount(): number
  /** 缩放至内容恰好入屏；minScale 为缩放下限（如 1 = 只居中不缩小）。 */
  fitView(minScale?: number): void
  hitTest(x: number, y: number): number | null | undefined
  resize(width: number, height: number): void
  setHoveredIndex(index: number | null): void
  setSelectedIndex(index: number | null): void
  setSelectedEdgeId(id: string | null): void
  destroy(): void
}
