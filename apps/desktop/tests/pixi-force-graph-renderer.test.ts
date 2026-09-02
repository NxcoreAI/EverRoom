import { describe, expect, it, vi } from 'vitest'

import {
  createPixiForceGraphRenderer,
  type PixiApplication,
  type PixiContainer,
  type PixiForceGraphDependencies,
  type PixiGraphics,
  type PixiParticleContainer,
  type PixiSprite,
  type PixiTexture,
  type PixiTicker,
  type PixiText,
  type PixiViewport,
} from '../src/renderer/src/components/graph/pixi/PixiForceGraphRenderer'

class FakeTicker implements PixiTicker {
  readonly callbacks = new Set<() => void>()

  add(callback: () => void) {
    this.callbacks.add(callback)
  }

  remove(callback: () => void) {
    this.callbacks.delete(callback)
  }

  tick() {
    for (const callback of this.callbacks) callback()
  }
}

class FakeTexture implements PixiTexture {
  destroyed = false

  destroy() {
    this.destroyed = true
  }
}

class FakeGraphics implements PixiGraphics {
  readonly operations: string[] = []
  destroyed = false
  generated = false
  renderable = true

  beginFill(color: number | string) {
    this.operations.push(`beginFill:${String(color)}`)
    return this
  }

  drawCircle(x: number, y: number, radius: number) {
    this.operations.push(`drawCircle:${String(x)},${String(y)},${String(radius)}`)
    return this
  }

  drawPolygon(points: number[]) {
    this.operations.push(`drawPolygon:${points.join(',')}`)
    return this
  }

  endFill() {
    this.operations.push('endFill')
    return this
  }

  clear() {
    this.operations.push('clear')
    return this
  }

  lineStyle(width: number, color: number | string, alpha?: number) {
    this.operations.push(`lineStyle:${String(width)},${String(color)},${String(alpha)}`)
    return this
  }

  moveTo(x: number, y: number) {
    this.operations.push(`moveTo:${String(x)},${String(y)}`)
    return this
  }

  lineTo(x: number, y: number) {
    this.operations.push(`lineTo:${String(x)},${String(y)}`)
    return this
  }

  destroy() {
    this.destroyed = true
  }
}

class FakeSprite implements PixiSprite {
  alpha = 1
  x = 0
  y = 0
  tint: number | string = 0xffffff
  readonly anchor = { set: vi.fn() }
  readonly scale = { set: vi.fn() }
  destroyed = false
  visible = true

  constructor(readonly texture: PixiTexture) {}

  destroy() {
    this.destroyed = true
  }
}

class FakeContainer implements PixiContainer {
  readonly children: unknown[] = []
  destroyed = false
  interactiveChildren = true
  renderable = true
  visible = true

  addChild(child: unknown) {
    this.children.push(child)
  }

  removeChild(child: unknown) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
  }

  destroy() {
    this.destroyed = true
  }
}

class FakeText extends FakeSprite implements PixiText {
  resolution = 1
  roundPixels = false

  constructor(public text = '') {
    super(new FakeTexture())
  }
}

class FakeParticleContainer implements PixiParticleContainer {
  readonly children: PixiSprite[] = []
  readonly update = vi.fn()
  destroyed = false
  renderable = true

  constructor(readonly options: {
    maxSize?: number
    properties?: { position: boolean; alpha?: boolean; scale?: boolean; tint?: boolean }
    batchSize?: number
    autoResize?: boolean
  }) {}

  addChild(child: PixiSprite) {
    this.children.push(child)
  }

  removeChild(child: PixiSprite) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
  }

  destroy() {
    this.destroyed = true
  }
}

class FakeViewport extends FakeContainer implements PixiViewport {
  readonly calls: string[] = []
  readonly handlers = new Map<string, Array<(event: any) => void>>()
  readonly scale = { x: 1, y: 1 }
  panStarts = 0
  readonly plugins = {
    pause: vi.fn((name: string) => this.calls.push(`pause:${name}`)),
    resume: vi.fn((name: string) => this.calls.push(`resume:${name}`)),
  }
  cursor = 'grab'
  visibleBounds = { x: 0, y: 0, width: 640, height: 420 }

  constructor(readonly options: { screenWidth: number; screenHeight: number; worldWidth: number; worldHeight: number; events?: unknown }) {
    super()
  }

  drag() {
    this.calls.push('drag')
    this.on('pointerdown', () => {
      this.panStarts += 1
    })
    return this
  }

  wheel() {
    this.calls.push('wheel')
    return this
  }

  pinch() {
    this.calls.push('pinch')
    return this
  }

  resize(width: number, height: number) {
    this.calls.push(`resize:${String(width)},${String(height)}`)
    return this
  }

  getVisibleBounds() {
    return this.visibleBounds
  }

  moveCenter(x: number, y: number) {
    this.calls.push(`moveCenter:${String(x)},${String(y)}`)
    return this
  }

  setZoom(scale: number) {
    this.scale.x = scale
    this.scale.y = scale
    this.calls.push(`setZoom:${String(scale)}`)
    return this
  }

  toWorld(x: number, y: number) {
    return { x, y }
  }

  on(event: string, callback: (event: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback])
  }

  off(event: string, callback: (event: any) => void) {
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((item) => item !== callback))
  }

  emitEvent(event: string, value: any) {
    let propagationStopped = false
    const originalStopImmediatePropagation = value.stopImmediatePropagation
    const emittedValue = {
      ...value,
      stopImmediatePropagation: () => {
        propagationStopped = true
        originalStopImmediatePropagation?.()
      },
    }
    for (const callback of this.handlers.get(event) ?? []) {
      callback(emittedValue)
      if (propagationStopped) break
    }
  }
}

function createFakes() {
  const ticker = new FakeTicker()
  const textures: FakeTexture[] = []
  const graphics: FakeGraphics[] = []
  const particles: FakeParticleContainer[] = []
  const containers: FakeContainer[] = []
  const texts: FakeText[] = []
  const viewports: FakeViewport[] = []
  const appDestroy = vi.fn()
  const renderer = {
    events: {},
    generateTexture: vi.fn((source: FakeGraphics, _options?: { resolution?: number }) => {
      source.generated = true
      const texture = new FakeTexture()
      textures.push(texture)
      return texture
    }),
    resize: vi.fn(),
  }
  const view = {}
  const stage = {
    addChild: vi.fn(),
    removeChild: vi.fn(),
  }
  const app: PixiApplication = {
    renderer,
    stage,
    canvas: view,
    destroy: appDestroy,
  }
  const dependencies: PixiForceGraphDependencies = {
    Application: class {
      constructor() {
        return app
      }
    } as unknown as PixiForceGraphDependencies['Application'],
    Container: class extends FakeContainer {
      constructor() {
        super()
        containers.push(this)
      }
    },
    Graphics: class extends FakeGraphics {
      constructor() {
        super()
        graphics.push(this)
      }
    },
    Sprite: class extends FakeSprite {},
    Text: class extends FakeText {
      constructor(text = '') {
        super(text)
        texts.push(this)
      }
    },
    ParticleContainer: class extends FakeParticleContainer {
      constructor(
        maxSize?: number,
        properties?: { position: boolean; alpha?: boolean; scale?: boolean; tint?: boolean },
        batchSize?: number,
        autoResize?: boolean,
      ) {
        super({ maxSize, properties, batchSize, autoResize })
        particles.push(this)
      }
    },
    Ticker: { shared: ticker },
    Viewport: class extends FakeViewport {
      constructor(options: { screenWidth: number; screenHeight: number; worldWidth: number; worldHeight: number; events?: unknown }) {
        super(options)
        viewports.push(this)
      }
    },
  }
  return { appDestroy, containers, dependencies, graphics, particles, renderer, texts, textures, ticker, view, viewports }
}

function createHost() {
  const children: unknown[] = []
  return {
    clientWidth: 640,
    clientHeight: 420,
    children,
    appendChild: (child: unknown) => children.push(child),
    removeChild: (child: unknown) => {
      const index = children.indexOf(child)
      if (index >= 0) children.splice(index, 1)
    },
  }
}

describe('PixiForceGraphRenderer', () => {
  it('creates one texture, one sprite per node, and enables dynamic positions', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [{ source: 0, target: 1 }],
      host: createHost(),
      nodes: [{ radius: 12 }, { radius: 20 }],
      positions: new Float32Array([10, 20, 30, 40]),
    })

    expect(fakes.textures).toHaveLength(1)
    expect(renderer.sprites).toHaveLength(2)
    expect((renderer.sprites[0] as FakeSprite).texture).toBe((renderer.sprites[1] as FakeSprite).texture)
    expect(fakes.particles[0]?.options).toEqual({
      maxSize: 2,
      properties: { position: true, tint: true },
      batchSize: 16384,
      autoResize: true,
    })
    expect(fakes.viewports[0]?.options.events).toBe(fakes.renderer.events)
    expect(fakes.viewports[0]?.calls).toEqual(['drag', 'wheel', 'pinch'])
    expect(fakes.graphics.filter((item) => item.generated)).toHaveLength(1)
    expect(fakes.graphics.find((item) => item.generated)?.operations).toContain('drawCircle:20,20,20')
    expect(fakes.renderer.generateTexture).toHaveBeenCalledWith(expect.any(FakeGraphics), { resolution: 2 })
    expect((renderer.sprites[0] as FakeSprite).scale.set).toHaveBeenCalledWith(0.6)
    expect((renderer.sprites[1] as FakeSprite).scale.set).toHaveBeenCalledWith(1)
    expect(renderer.sprites.every((sprite) => !('interactive' in sprite))).toBe(true)
  })

  it('performs centralized hit testing and highlights only the hovered neighborhood', async () => {
    const fakes = createFakes()
    const hover = vi.fn()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [{ source: 0, target: 1 }],
      host: createHost(),
      nodes: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      positions: new Float32Array([10, 10, 40, 10, 100, 100]),
      onNodeHover: hover,
    })
    const viewport = fakes.viewports[0]!
    viewport.scale.x = 0.2
    viewport.emitEvent('pointermove', { global: { x: 11, y: 10 } })
    fakes.ticker.tick()

    expect(renderer.hitTest(11, 10)).toBe(0)
    expect(renderer.sprites[0]?.alpha).toBe(1)
    expect(renderer.sprites[1]?.alpha).toBe(1)
    expect(renderer.sprites[2]?.alpha).toBeCloseTo(0.8152, 4)
    for (let frame = 0; frame < 24; frame += 1) fakes.ticker.tick()
    expect(renderer.sprites[0]?.alpha).toBe(1)
    expect(renderer.sprites[1]?.alpha).toBe(1)
    expect(renderer.sprites[2]?.alpha).toBeCloseTo(0.16, 2)
    expect(hover).toHaveBeenCalledWith(0)
    expect(renderer.activeLabelCount()).toBe(1)
    expect(renderer.createdLabelCount()).toBe(3)
    expect(fakes.texts.every((label) => label.resolution === 1)).toBe(true)
    expect(fakes.texts.every((label) => label.roundPixels)).toBe(true)
    expect(fakes.graphics.find((graphics) => !graphics.generated)?.operations)
      .toContain('lineStyle:2.04,4026358,1')
  })

  it('renders Room type icons with one shared texture per icon type', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [
        { icon: 'target', radius: 29 },
        { icon: 'target', radius: 29 },
        { icon: 'book', radius: 22 },
      ],
      positions: new Float32Array([20, 30, 80, 90, 140, 150]),
    })

    expect(fakes.textures).toHaveLength(3)
    expect(renderer.iconParticleContainers).toEqual([fakes.particles[1], fakes.particles[2]])
    expect(fakes.particles[1]?.children).toHaveLength(2)
    expect(fakes.particles[2]?.children).toHaveLength(1)
    expect((fakes.particles[1]?.children[0] as FakeSprite).texture)
      .toBe((fakes.particles[1]?.children[1] as FakeSprite).texture)
    expect((fakes.particles[2]?.children[0] as FakeSprite).texture)
      .not.toBe((fakes.particles[1]?.children[0] as FakeSprite).texture)
    expect(fakes.particles.slice(1).flatMap((container) => container.children).map((sprite) => [sprite.x, sprite.y])).toEqual([
      [20, 30],
      [80, 90],
      [140, 150],
    ])
  })

  it('uses an injected icon texture factory and skips unknown icon names', async () => {
    const fakes = createFakes()
    const customTexture = new FakeTexture()
    const createIconTexture = vi.fn((icon: string) => (
      icon === 'attribute' || icon === 'relation' ? customTexture : null
    ))
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      createIconTexture,
      edges: [],
      host: createHost(),
      nodes: [
        { icon: 'attribute' },
        { icon: 'relation' },
        { icon: 'attribute' },
        { icon: 'no-such-icon' },
      ],
      positions: new Float32Array([0, 0, 10, 0, 20, 0, 30, 0]),
    })

    // 三种图标名各建一个容器；未知名容器存在但没有 sprite，同名共享同一纹理。
    expect(renderer.iconParticleContainers).toHaveLength(3)
    expect(fakes.particles[1]?.children).toHaveLength(2)
    expect(fakes.particles[2]?.children).toHaveLength(1)
    expect(fakes.particles[3]?.children).toHaveLength(0)
    expect((fakes.particles[1]?.children[0] as FakeSprite).texture).toBe(customTexture)
    expect((fakes.particles[1]?.children[1] as FakeSprite).texture).toBe(customTexture)
    expect((fakes.particles[2]?.children[0] as FakeSprite).texture).toBe(customTexture)
    // 负缓存：4 个节点 3 种图标名，工厂只调用 3 次（未知名也只问一次）。
    expect(createIconTexture).toHaveBeenCalledTimes(3)
    expect([...new Set(createIconTexture.mock.calls.map(([icon]) => icon))].sort())
      .toEqual(['attribute', 'no-such-icon', 'relation'])

    renderer.destroy()
    expect(customTexture.destroyed).toBe(true)
  })

  it('raises label texture resolution in stable steps while zooming in', async () => {
    const fakes = createFakes()
    await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ label: 'Readable label' }],
      positions: new Float32Array([10, 20]),
    })
    const viewport = fakes.viewports[0]!
    fakes.ticker.tick()
    expect(fakes.texts[0]?.resolution).toBe(1)

    viewport.scale.x = 1.6
    fakes.ticker.tick()
    expect(fakes.texts[0]?.resolution).toBe(2)

    viewport.scale.x = 8
    fakes.ticker.tick()
    expect(fakes.texts[0]?.resolution).toBe(4)
  })

  it('renders relationship labels with the provided text and falls back to none when absent', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [
        { id: 'manual-edge', source: 0, target: 1, label: 'Depends on', labelColor: 0xac7629 },
        { id: 'unlabeled-edge', source: 1, target: 2 },
      ],
      host: createHost(),
      nodes: [{}, {}, {}],
      positions: new Float32Array([10, 20, 80, 20, 150, 20]),
    })

    expect(fakes.texts.map((label) => label.text)).toEqual(['Depends on'])
    expect(fakes.texts[0]?.tint).toBe(0xac7629)
    expect(renderer.activeLabelCount()).toBe(0)
  })

  it('limits edge labels and keeps only selected or hovered relationships at low zoom', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: Array.from({ length: 4 }, (_, index) => ({
        id: `edge-${String(index)}`,
        source: index,
        target: index + 1,
        label: `Relation ${String(index)}`,
      })),
      host: createHost(),
      maxVisibleEdgeLabels: 2,
      nodes: Array.from({ length: 5 }, () => ({})),
      positions: new Float32Array([10, 20, 80, 20, 150, 20, 220, 20, 290, 20]),
    })

    expect(fakes.texts.map((label) => label.text)).toEqual(['Relation 0', 'Relation 1'])

    const viewport = fakes.viewports[0]!
    viewport.scale.x = 0.5
    renderer.setSelectedEdgeId('edge-3')
    fakes.ticker.tick()

    expect(fakes.texts.filter((label) => label.visible).map((label) => label.text)).toEqual(['Relation 3'])
  })

  it('hides unrelated relationship labels while a node is hovered at high zoom', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [
        { id: 'edge-0', source: 0, target: 1, label: 'Focused relation' },
        { id: 'edge-1', source: 2, target: 3, label: 'Unrelated relation' },
      ],
      host: createHost(),
      nodes: Array.from({ length: 4 }, () => ({})),
      positions: new Float32Array([10, 20, 80, 20, 150, 20, 220, 20]),
    })

    const viewport = fakes.viewports[0]!
    viewport.scale.x = 2
    viewport.visibleBounds = { x: 0, y: 0, width: 300, height: 100 }
    fakes.ticker.tick()
    expect(fakes.texts.filter((label) => label.visible).map((label) => label.text))
      .toEqual(['Focused relation', 'Unrelated relation'])

    renderer.setHoveredIndex(0)
    fakes.ticker.tick()
    expect(fakes.texts.filter((label) => label.visible).map((label) => label.text))
      .toEqual(['Focused relation'])

    renderer.setHoveredIndex(null)
    fakes.ticker.tick()
    expect(fakes.texts.filter((label) => label.visible).map((label) => label.text))
      .toEqual(['Focused relation', 'Unrelated relation'])
  })

  it('culls labels to visible nodes and never grows the reusable text pool past its cap', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      maxVisibleLabels: 2,
      nodes: Array.from({ length: 20 }, (_, index) => ({ label: `Node ${String(index)}` })),
      positions: new Float32Array(Array.from({ length: 40 }, (_, index) => index * 5)),
    })
    const viewport = fakes.viewports[0]!
    // 可视矩形只随相机变换变化（真实 Viewport 由 transform 推导 bounds）：
    // 每次裁剪变化伴随 scale 变化，帧脏检查据此触发重画。
    viewport.scale.x = 0.9
    viewport.visibleBounds = { x: 0, y: 0, width: 500, height: 500 }
    fakes.ticker.tick()
    expect(renderer.activeLabelCount()).toBe(2)
    expect(renderer.createdLabelCount()).toBe(2)

    viewport.scale.x = 1
    viewport.visibleBounds = { x: 1000, y: 1000, width: 10, height: 10 }
    fakes.ticker.tick()
    expect(renderer.activeLabelCount()).toBe(0)
    expect(renderer.createdLabelCount()).toBe(2)
  })

  it('pauses viewport panning and emits node-level drag/release messages', async () => {
    const fakes = createFakes()
    const drag = vi.fn()
    const release = vi.fn()
    const select = vi.fn()
    await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ label: 'A' }],
      positions: new Float32Array([10, 20]),
      onNodeDrag: drag,
      onNodeRelease: release,
      onNodeSelect: select,
    })
    const viewport = fakes.viewports[0]!
    const stopImmediatePropagation = vi.fn()
    viewport.emitEvent('pointerdown', { button: 0, global: { x: 10, y: 20 }, stopImmediatePropagation })
    viewport.emitEvent('pointermove', { global: { x: 20, y: 30 } })
    viewport.emitEvent('pointermove', { global: { x: 25, y: 35 } })
    viewport.emitEvent('pointerup', { global: { x: 25, y: 35 } })

    expect(stopImmediatePropagation).toHaveBeenCalled()
    expect(viewport.plugins.pause).toHaveBeenCalledWith('drag')
    expect(viewport.plugins.resume).toHaveBeenCalledWith('drag')
    expect(viewport.panStarts).toBe(0)
    expect(drag).toHaveBeenCalledTimes(2)
    expect(drag).toHaveBeenLastCalledWith(0, 25, 35)
    expect(release).toHaveBeenCalledWith(0)
    expect(select).not.toHaveBeenCalled()
  })

  it('selects a hit node when the pointer is released without dragging', async () => {
    const fakes = createFakes()
    const drag = vi.fn()
    const release = vi.fn()
    const select = vi.fn()
    await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ label: 'A' }],
      positions: new Float32Array([10, 20]),
      onNodeDrag: drag,
      onNodeRelease: release,
      onNodeSelect: select,
    })
    const viewport = fakes.viewports[0]!

    viewport.emitEvent('pointerdown', { button: 0, global: { x: 10, y: 20 } })
    viewport.emitEvent('pointerup', { global: { x: 10, y: 20 } })

    expect(select).toHaveBeenCalledOnce()
    expect(select).toHaveBeenCalledWith(0)
    expect(drag).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('opens a node when the same node is clicked twice', async () => {
    const fakes = createFakes()
    const open = vi.fn()
    await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ label: 'A' }],
      positions: new Float32Array([10, 20]),
      onNodeOpen: open,
    })
    const viewport = fakes.viewports[0]!

    for (let click = 0; click < 2; click += 1) {
      viewport.emitEvent('pointerdown', { button: 0, global: { x: 10, y: 20 } })
      viewport.emitEvent('pointerup', { global: { x: 10, y: 20 } })
    }

    expect(open).toHaveBeenCalledOnce()
    expect(open).toHaveBeenCalledWith(0)
  })

  it('keeps viewport panning enabled when pressing outside a node', async () => {
    const fakes = createFakes()
    await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ label: 'A' }],
      positions: new Float32Array([10, 20]),
    })
    const viewport = fakes.viewports[0]!

    viewport.emitEvent('pointerdown', { button: 0, global: { x: 200, y: 200 } })

    expect(viewport.panStarts).toBe(1)
    expect(viewport.plugins.pause).not.toHaveBeenCalled()
  })

  it('keeps one node texture, one particle container, and two Graphics objects for 10,000 nodes without icons', async () => {
    const fakes = createFakes()
    const nodeCount = 10_000
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      maxVisibleLabels: 100,
      nodes: Array.from({ length: nodeCount }, (_, index) => ({ label: `Node ${String(index)}` })),
      positions: new Float32Array(nodeCount * 2),
    })

    expect(renderer.sprites).toHaveLength(nodeCount)
    expect(fakes.particles).toHaveLength(1)
    expect(fakes.particles[0]?.children).toHaveLength(nodeCount)
    expect(fakes.graphics).toHaveLength(2)
    expect(fakes.textures).toHaveLength(1)
    expect(fakes.texts).toHaveLength(100)
  })

  it('reads shared coordinates when the revision advances and strokes all edges once', async () => {
    const fakes = createFakes()
    const positions = new Float32Array([10, 20, 30, 40, 50, 60])
    let revision = 0
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }],
      host: createHost(),
      nodes: [{}, {}, {}],
      positions,
      revision: () => revision,
    })
    const edgeGraphics = fakes.graphics.find((item) => !item.generated)!
    edgeGraphics.operations.length = 0
    positions.set([11, 22, 33, 44, 55, 66])
    revision = 2
    fakes.ticker.tick()

    expect(renderer.sprites.map((sprite) => [sprite.x, sprite.y])).toEqual([
      [11, 22],
      [33, 44],
      [55, 66],
    ])
    expect(edgeGraphics.operations).toEqual([
      'clear',
      'lineStyle:1.2,12173514,0.8',
      'moveTo:11,22',
      'lineTo:33,44',
      'lineStyle:1.2,12173514,0.8',
      'moveTo:33,44',
      'lineTo:55,66',
    ])
  })

  it('skips redrawing while coordinates, camera and hover state are unchanged', async () => {
    const fakes = createFakes()
    const positions = new Float32Array([10, 20, 30, 40, 50, 60])
    let revision = 2
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [{ source: 0, target: 1 }, { source: 1, target: 2 }],
      host: createHost(),
      nodes: [{}, {}, {}],
      positions,
      revision: () => revision,
    })
    const edgeGraphics = fakes.graphics.find((item) => !item.generated)!
    edgeGraphics.operations.length = 0

    // 静止帧：revision、悬停、相机均无变化，整段重画被跳过。
    fakes.ticker.tick()
    expect(edgeGraphics.operations).toEqual([])
    // 坐标原地改动但没有 revision 前进（共享内存未发布）：同样跳过，不读过期值。
    positions.set([11, 22, 33, 44, 55, 66])
    fakes.ticker.tick()
    expect(renderer.sprites.map((sprite) => [sprite.x, sprite.y])).toEqual([
      [10, 20],
      [30, 40],
      [50, 60],
    ])
    expect(edgeGraphics.operations).toEqual([])

    // revision 前进（Worker 发布新坐标）：恢复重画，精灵与边都更新。
    revision = 4
    fakes.ticker.tick()
    expect(renderer.sprites.map((sprite) => [sprite.x, sprite.y])).toEqual([
      [11, 22],
      [33, 44],
      [55, 66],
    ])
    expect(edgeGraphics.operations).toContain('clear')
  })

  it('skips an in-progress shared-memory revision and updates on the next stable revision', async () => {
    const fakes = createFakes()
    const positions = new Float32Array([10, 20])
    let revision = 0
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{}],
      positions,
      revision: () => revision,
    })

    positions.set([30, 40])
    revision = 1
    fakes.ticker.tick()
    expect([renderer.sprites[0]?.x, renderer.sprites[0]?.y]).toEqual([10, 20])

    revision = 2
    fakes.ticker.tick()
    expect([renderer.sprites[0]?.x, renderer.sprites[0]?.y]).toEqual([30, 40])
  })

  it('keeps the last graph visible when shared coordinates change during a frame', async () => {
    const fakes = createFakes()
    const positions = new Float32Array([10, 20])
    let revisions = [2, 2]
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ label: 'Node' }],
      positions,
      revision: () => revisions.shift() ?? 2,
    })

    positions.set([30, 40])
    revisions = [4, 6]
    fakes.ticker.tick()

    expect(renderer.particleContainer.renderable).toBe(true)
    expect(renderer.edgeGraphics.renderable).toBe(true)
    expect(renderer.labelLayer.renderable).toBe(true)
  })

  it('updates only static node tint state without replacing sprites or texture', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{ color: 0x111111 }, { color: 0x222222 }],
      positions: new Float32Array(4),
      selectedIndex: 0,
    })

    const texture = (renderer.sprites[0] as FakeSprite).texture
    renderer.setSelectedIndex(1)
    expect(renderer.sprites.map((sprite) => sprite.tint)).toEqual([0x111111, 0x244dcc])
    expect((renderer.sprites[1] as FakeSprite).texture).toBe(texture)
    expect(fakes.particles[0]?.update).toHaveBeenCalledTimes(1)
  })

  it('centers the initial view on content at natural zoom when centerOnMount is set', async () => {
    const fakes = createFakes()
    await createPixiForceGraphRenderer({
      centerOnMount: true,
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{}, {}],
      positions: new Float32Array([100, 200, 300, 240]),
    })
    const viewport = fakes.viewports[0]!
    // 内容包围盒（含半径 18 与标签预留 24）：(82,182)-(318,282)，中心 (200,232)。
    // 只居中、不缩放：世界大于面板时通过视口平移浏览，而不是压进面板。
    expect(viewport.calls).toContain('moveCenter:200,232')
    expect(viewport.calls.some((call) => call.startsWith('setZoom:'))).toBe(false)
  })

  it('re-centers once when the host reports its real size after mounting hidden', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      centerOnMount: true,
      dependencies: fakes.dependencies,
      edges: [],
      host: { ...createHost(), clientWidth: 0, clientHeight: 0 },
      nodes: [{}, {}],
      positions: new Float32Array([100, 200, 300, 240]),
    })
    const viewport = fakes.viewports[0]!
    // 宿主 0×0（隐藏 tab / 入场动画容器）：构造时按 640×420 兜底居中一次。
    expect(viewport.calls.filter((call) => call.startsWith('moveCenter:'))).toEqual(['moveCenter:200,232'])

    // 真实尺寸到来 → 补居中一次；之后的面板微调不再抢用户的平移。
    renderer.resize(400, 300)
    expect(viewport.calls.filter((call) => call.startsWith('moveCenter:'))).toHaveLength(2)
    renderer.resize(380, 280)
    expect(viewport.calls.filter((call) => call.startsWith('moveCenter:'))).toHaveLength(2)
  })

  it('waits for the first worker frame before centering when the shared buffer is still empty', async () => {
    const fakes = createFakes()
    const positions = new Float32Array(4)
    let revision = 0
    await createPixiForceGraphRenderer({
      centerOnMount: true,
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{}, {}],
      positions,
      revision: () => revision,
    })
    const viewport = fakes.viewports[0]!
    // 渲染器可能在 Worker 首次 publish 前创建（共享坐标缓冲全 0）：
    // 不能按全 0 坐标居中——那会把视野钉在世界原点（左上角）。
    fakes.ticker.tick()
    expect(viewport.calls.some((call) => call.startsWith('moveCenter:'))).toBe(false)

    // Worker 首帧坐标写入（revision 为偶数）后，下一帧对准内容中心。
    positions.set([100, 200, 300, 240])
    revision = 2
    fakes.ticker.tick()
    expect(viewport.calls).toContain('moveCenter:200,232')
    // 只补一次：后续帧不再重复居中。
    fakes.ticker.tick()
    expect(viewport.calls.filter((call) => call.startsWith('moveCenter:'))).toHaveLength(1)
  })

  it('honors the fitView minimum scale when content is larger than the screen', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{}, {}],
      positions: new Float32Array([0, 0, 2000, 1400]),
    })
    const viewport = fakes.viewports[0]!

    renderer.fitView(1)
    // minScale 1：内容超出屏幕时保持原始缩放、只居中（紧凑面板语义）。
    expect(viewport.scale.x).toBe(1)
    expect(viewport.calls).toContain('moveCenter:1000,712')

    renderer.fitView()
    // 缺省 minScale 0.2：整体可见优先，允许缩小到内容入屏。
    expect(viewport.scale.x).toBeGreaterThan(0.2)
    expect(viewport.scale.x).toBeLessThan(1)
  })

  it('caps the zoom at 1 when every node is stacked at a single point', async () => {
    const fakes = createFakes()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host: createHost(),
      nodes: [{}, {}, {}],
      // 共享坐标缓冲全 0（Worker 失败/未就绪）：所有节点叠在世界原点。
      positions: new Float32Array(6),
    })
    const viewport = fakes.viewports[0]!

    renderer.fitView()
    // 不把这叠节点放大成满屏重叠大饼：只居中、缩放收敛到 ≤1。
    expect(viewport.calls).toContain('setZoom:1')
    expect(viewport.calls).toContain('moveCenter:0,12')
  })

  it('resizes viewport and releases ticker, texture, viewport, sprites, and app resources', async () => {
    const fakes = createFakes()
    const host = createHost()
    const renderer = await createPixiForceGraphRenderer({
      dependencies: fakes.dependencies,
      edges: [],
      host,
      nodes: [{}, {}],
      positions: new Float32Array([10, 20, 30, 40]),
    })
    renderer.resize(800, 600)
    expect(fakes.renderer.resize).toHaveBeenCalledWith(800, 600)
    expect(fakes.viewports[0]?.calls).toContain('resize:800,600')

    renderer.fitView()
    // 两节点近距重叠（56×80 包围盒）属退化内容：只居中、不放大。
    expect(fakes.viewports[0]?.calls).toContain('setZoom:1')
    expect(fakes.viewports[0]?.calls).toContain('moveCenter:20,42')

    renderer.destroy()
    renderer.destroy()
    expect(fakes.ticker.callbacks.size).toBe(0)
    expect(fakes.textures[0]?.destroyed).toBe(true)
    expect(fakes.viewports[0]?.destroyed).toBe(true)
    expect(fakes.particles[0]?.destroyed).toBe(true)
    expect(renderer.sprites.every((sprite) => (sprite as FakeSprite).destroyed)).toBe(true)
    expect(fakes.appDestroy).toHaveBeenCalledTimes(1)
    expect(fakes.appDestroy).toHaveBeenCalledWith(true, { children: true })
  })
})
