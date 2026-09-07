export interface PixiTicker {
  add(callback: () => void, context?: unknown): void
  remove(callback: () => void, context?: unknown): void
}

export interface PixiTexture {
  destroy(destroySource?: boolean): void
}

export interface PixiGraphics {
  beginFill(color: number | string, alpha?: number): PixiGraphics
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
  /** 节点 id（锚点父引用、选中态查找用）；画布层节点必带。 */
  id?: string
  color?: number | string
  /** 图标名，含义由使用面定义；渲染层只负责按名取纹理（见 PixiForceGraphIconTextureFactory）。 */
  icon?: string
  /**
   * 标签常显：聚焦模式（悬停时只显示关联节点标签）下不隐藏该节点标签——
   * 用于高层结构节点（如 Room 根、文档主节点），悬停其卫星节点时仍作上下文锚点。
   */
  labelPinned?: boolean
  /**
   * 标签层级（0 最醒目，越大越弱；缺省 2）：控制字号/字重/颜色分档，
   * 表达节点的结构等级（如 0=Room 根、1=文档主节点、2=块/记忆）。
   */
  labelTier?: number
  label?: string
  radius?: number
  /**
   * 节点背景场：以节点为圆心绘制半透明圆（如文档节点的"轨道场"），画在
   * 连线与节点之下。仅视觉，不参与布局碰撞（碰撞半径仍用 radius + 传给
   * 布局器的物理半径）。
   */
  field?: {
    radius: number
    color?: number | string
    alpha?: number
  }
  /**
   * 锚点节点（如文档轨道场内的卫星块）：不进力导向模拟，位置每帧解析为
   * 父节点位置 + 偏移。父节点必须在同一节点表内。拖拽锚点只改偏移，并被
   * maxDistance 钳制（不会脱离父节点的场）。positions 传布局（非锚点）
   * 坐标缓冲，锚点槽位由渲染层写入。
   */
  anchor?: {
    parentId: string
    dx: number
    dy: number
    /** 偏移半径上限（场的半径），拖拽钳制用；缺省不钳制。 */
    maxDistance?: number
  }
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
  /**
   * 布局坐标缓冲（Worker/静态布局写入，按"非锚点节点"的次序索引）。存在
   * 锚点节点时必传：渲染层按非锚点次序映射到 positions 的全量表槽位，
   * 并把锚点槽位解析为 父节点位置 + 偏移。无锚点时省略（positions 即布局缓冲）。
   */
  layoutPositions?: Float32Array
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
