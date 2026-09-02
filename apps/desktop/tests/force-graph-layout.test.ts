import { afterEach, describe, expect, it, vi } from 'vitest'

import { ForceGraphLayoutController } from '../src/renderer/src/components/graph/layout/forceGraphLayout'
import {
  DEFAULT_FORCE_GRAPH_OPTIONS,
  ForceGraphControlIndex,
  ForceGraphStatus,
  createForceGraphSharedMemory,
  type ForceGraphWorkerRequest,
  type ForceGraphWorkerResponse,
} from '../src/renderer/src/components/graph/layout/forceGraphProtocol'
import { createForceGraphSimulation } from '../src/renderer/src/components/graph/layout/forceGraphSimulation'
import { scaleForceGraphWorld } from '../src/renderer/src/components/graph/layout/forceGraphWorld'
import {
  roomGraphLayoutDimensions,
  roomGraphLayoutOptions,
} from '../src/renderer/src/components/context-room/ported/components/roomGraphVisuals'

afterEach(() => {
  vi.unstubAllGlobals()
})

class FakeWorker {
  messages: ForceGraphWorkerRequest[] = []
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent<ForceGraphWorkerResponse>) => void) | null = null
  terminated = false

  postMessage(message: ForceGraphWorkerRequest) {
    this.messages.push(message)
    if (message.type === 'initialize') {
      queueMicrotask(() => this.onmessage?.({
        data: { type: 'ready', nodeCount: message.nodes.length },
      } as MessageEvent<ForceGraphWorkerResponse>))
    }
  }

  terminate() {
    this.terminated = true
  }
}

describe('force graph shared layout', () => {
  it('allocates interleaved Float32 coordinates and a separate atomic control block', () => {
    const memory = createForceGraphSharedMemory(3)

    expect(memory.positions).toBeInstanceOf(Float32Array)
    expect(memory.positions).toHaveLength(6)
    expect(memory.positions.buffer).toBe(memory.positionsBuffer)
    expect(memory.control.buffer).toBe(memory.controlBuffer)
    expect(Atomics.load(memory.control, ForceGraphControlIndex.NodeCount)).toBe(3)
    expect(Atomics.load(memory.control, ForceGraphControlIndex.Status)).toBe(ForceGraphStatus.Idle)
  })

  it('sends graph JSON once and keeps later synchronization messages small', async () => {
    const worker = new FakeWorker()
    const controller = new ForceGraphLayoutController({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
      workerFactory: () => worker,
    })
    await controller.ready

    const initialized = worker.messages[0]
    expect(initialized).toMatchObject({
      type: 'initialize',
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
    })
    expect(initialized?.type === 'initialize' && initialized.positionsBuffer)
      .toBe(controller.snapshot.positions.buffer)

    if (initialized?.type === 'initialize') {
      new Float32Array(initialized.positionsBuffer).set([10, 20, 30, 40])
    }
    expect([...controller.snapshot.positions]).toEqual([10, 20, 30, 40])

    controller.resize(800, 600)
    controller.reheat(0.7)
    controller.drag('a', 120, 140)
    controller.release('a')
    controller.dispose()
    expect(worker.messages.slice(1)).toEqual([
      { type: 'resize', width: 800, height: 600 },
      { type: 'reheat', alpha: 0.7 },
      { type: 'DRAG', id: 'a', x: 120, y: 140 },
      { type: 'RELEASE', id: 'a' },
      { type: 'stop' },
    ])
    expect(worker.messages.slice(1).every((message) => !('nodes' in message) && !('edges' in message)))
      .toBe(true)
    expect(worker.terminated).toBe(true)
  })

  it('pins a dragged d3 node and releases it back to the simulation', () => {
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: [{ id: 'a' }, { id: 'b' }],
      edges: [{ source: 'a', target: 'b' }],
      options: DEFAULT_FORCE_GRAPH_OPTIONS,
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })

    simulation.drag('a', 123, 234)
    simulation.step(5)
    expect(latest.slice(0, 2)).toEqual([123, 234])

    simulation.release('a')
    simulation.step(20)
    expect(latest.slice(0, 2)).not.toEqual([123, 234])
    simulation.stop()
  })

  it('keeps node circles separated with collision padding', () => {
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: [
        { id: 'a', radius: 28, x: 300, y: 200 },
        { id: 'b', radius: 28, x: 301, y: 200 },
      ],
      edges: [{ source: 'a', target: 'b' }],
      options: DEFAULT_FORCE_GRAPH_OPTIONS,
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })

    simulation.step(80)
    simulation.stop()
    expect(Math.hypot(latest[0]! - latest[2]!, latest[1]! - latest[3]!))
      .toBeGreaterThanOrEqual(78)
  })

  it('expands the simulation world when a drag reaches beyond its bounds', () => {
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: [
        { id: 'a', radius: 20, x: 100, y: 100 },
        { id: 'b', radius: 20, x: 300, y: 200 },
      ],
      edges: [{ source: 'a', target: 'b' }],
      options: { ...DEFAULT_FORCE_GRAPH_OPTIONS, width: 640, height: 420 },
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })
    simulation.step(60)

    // 拖出世界（640×420 矩形之外、含负坐标方向）：不再钳制，节点钉在指针落点。
    simulation.drag('a', 2000, -500)
    simulation.step(10)
    expect(latest.slice(0, 2)).toEqual([2000, -500])

    // 扩张是持久的：松手演化后，把另一个节点拖到原世界外同样不再被钳回。
    simulation.release('a')
    simulation.step(40)
    simulation.drag('b', 1900, -400)
    simulation.step(10)
    expect(latest.slice(2, 4)).toEqual([1900, -400])
    expect(latest.every(Number.isFinite)).toBe(true)
    simulation.stop()
  })

  it('does not shrink the world back when the panel reports a smaller size', () => {
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: [
        { id: 'a', radius: 20, x: 100, y: 100 },
        { id: 'b', radius: 20, x: 300, y: 200 },
      ],
      edges: [{ source: 'a', target: 'b' }],
      options: { ...DEFAULT_FORCE_GRAPH_OPTIONS, width: 640, height: 420 },
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })
    simulation.step(60)

    // 拖拽把世界扩到原界外；随后面板缩小触发的 resize 只抬下限、不收回空间。
    simulation.drag('a', 1600, 300)
    simulation.step(5)
    simulation.release('a')
    simulation.step(20)
    simulation.resize(500, 400)
    simulation.step(5)
    // 世界仍容纳扩张：节点仍可被钉在原界外（若空间被收回，落点会被钳回 608 内）。
    simulation.drag('a', 1600, 300)
    simulation.step(5)
    expect(latest.slice(0, 2)).toEqual([1600, 300])
    simulation.stop()
  })

  it('keeps a small drag local instead of scattering the surrounding graph', () => {
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: [
        { id: 'a', x: 250, y: 210 },
        { id: 'b', x: 390, y: 210 },
        { id: 'c', x: 320, y: 120 },
        { id: 'd', x: 320, y: 300 },
      ],
      edges: [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
      ],
      options: {
        ...DEFAULT_FORCE_GRAPH_OPTIONS,
        linkDistance: 118,
        linkStrength: 0.24,
        manyBodyStrength: -135,
        velocityDecay: 0.54,
      },
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })

    simulation.step(240)
    const settled = [...latest]
    simulation.drag('a', settled[0]! + 8, settled[1]! + 5)
    simulation.step(12)
    simulation.release('a')
    simulation.step(80)
    simulation.stop()

    const surroundingNodeShifts = [1, 2, 3].map((index) => Math.hypot(
      latest[index * 2]! - settled[index * 2]!,
      latest[index * 2 + 1]! - settled[index * 2 + 1]!,
    ))
    expect(Math.max(...surroundingNodeShifts)).toBeLessThan(15)
  })

  it('does not translate every other node opposite to a dragged node', () => {
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: [
        { id: 'a', x: 200, y: 200 },
        { id: 'b', x: 300, y: 200 },
        { id: 'c', x: 400, y: 200 },
      ],
      edges: [],
      options: {
        ...DEFAULT_FORCE_GRAPH_OPTIONS,
        collisionStrength: 0,
        manyBodyStrength: 0,
      },
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })

    simulation.step(240)
    const settled = [...latest]
    simulation.drag('a', settled[0]! + 120, settled[1]!)
    simulation.step(20)
    simulation.stop()

    const untouchedNodeShift = Math.hypot(
      latest[2]! - settled[2]!,
      latest[3]! - settled[3]!,
    )
    expect(untouchedNodeShift).toBeLessThan(2)
  })

  it('keeps a highly connected Room hub and its neighbors well separated', () => {
    const nodeCount = 13
    const relationCount = nodeCount - 1
    const dimensions = roomGraphLayoutDimensions({
      compact: false,
      nodeCount,
      relationCount,
      screenHeight: 420,
      screenWidth: 640,
    })
    let latest: number[] = []
    const simulation = createForceGraphSimulation({
      nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `node-${String(index)}`, radius: 29 })),
      edges: Array.from({ length: relationCount }, (_, index) => ({
        source: 'node-0',
        target: `node-${String(index + 1)}`,
      })),
      options: {
        ...DEFAULT_FORCE_GRAPH_OPTIONS,
        ...roomGraphLayoutOptions({ compact: false, nodeCount, relationCount }),
        ...dimensions,
      },
      publish: (nodes) => {
        latest = nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])
      },
      settled: vi.fn(),
    })

    simulation.step(500)
    simulation.stop()
    const hubDistances = Array.from({ length: relationCount }, (_, index) => Math.hypot(
      latest[(index + 1) * 2]! - latest[0]!,
      latest[(index + 1) * 2 + 1]! - latest[1]!,
    ))
    let minimumNodeDistance = Number.POSITIVE_INFINITY
    for (let left = 0; left < nodeCount; left += 1) {
      for (let right = left + 1; right < nodeCount; right += 1) {
        minimumNodeDistance = Math.min(minimumNodeDistance, Math.hypot(
          latest[left * 2]! - latest[right * 2]!,
          latest[left * 2 + 1]! - latest[right * 2 + 1]!,
        ))
      }
    }

    expect(hubDistances.reduce((sum, distance) => sum + distance, 0) / hubDistances.length)
      .toBeGreaterThan(260)
    expect(minimumNodeDistance).toBeGreaterThan(105)
  })

  it('runs d3-force with link, charge, and centering forces', () => {
    const frames: number[][] = []
    const simulation = createForceGraphSimulation({
      nodes: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 600, y: 0 },
      ],
      edges: [{ source: 'a', target: 'b' }],
      options: {
        ...DEFAULT_FORCE_GRAPH_OPTIONS,
        centerStrength: 0.2,
        height: 400,
        linkDistance: 80,
        manyBodyStrength: -20,
        width: 600,
      },
      publish: (nodes) => frames.push(nodes.flatMap((node) => [node.x ?? 0, node.y ?? 0])),
      settled: vi.fn(),
    })

    simulation.step(160)
    simulation.stop()
    const positions = frames.at(-1)!
    expect(positions.every(Number.isFinite)).toBe(true)
    expect(Math.hypot(positions[0]! - positions[2]!, positions[1]! - positions[3]!)).toBeLessThan(150)
    expect((positions[0]! + positions[2]!) / 2).toBeCloseTo(300, 0)
    expect((positions[1]! + positions[3]!) / 2).toBeCloseTo(200, 0)
  })

  it('notifies onFatal exactly once for worker errors before or after ready', async () => {
    const worker = new FakeWorker()
    const onFatal = vi.fn()
    const controller = new ForceGraphLayoutController({
      nodes: [{ id: 'a' }],
      edges: [],
      workerFactory: () => worker,
      onFatal,
    })
    await controller.ready

    // ready 之后的运行期崩溃也要通知（onerror 路径）。
    worker.onerror?.({ message: 'died' } as ErrorEvent)
    expect(onFatal).toHaveBeenCalledTimes(1)
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ message: 'died' }))

    // 幂等：同一 Worker 的后续 error 不重复通知。
    worker.onerror?.({ message: 'died again' } as ErrorEvent)
    expect(onFatal).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('rejects edges that cannot be linked to initialized nodes', () => {
    expect(() => createForceGraphSimulation({
      nodes: [{ id: 'known' }],
      edges: [{ source: 'known', target: 'missing' }],
      options: DEFAULT_FORCE_GRAPH_OPTIONS,
      publish: vi.fn(),
      settled: vi.fn(),
    })).toThrow('known -> missing')
  })

  it('scales the layout world with node count between the default floor and caps', () => {
    // 少量节点：不低于内核默认世界 640×420（面板只是视口，小面板不压世界）。
    expect(scaleForceGraphWorld(2)).toEqual({ height: 420, width: 640 })
    expect(scaleForceGraphWorld(0, { spacing: 96 })).toEqual({ height: 420, width: 640 })
    // 节点增多：面积 = 节点数 × spacing²，保持默认宽高比，超出默认世界。
    const scaled = scaleForceGraphWorld(48, { spacing: 96 })
    expect(scaled.width).toBeGreaterThan(640)
    expect(scaled.height).toBeGreaterThan(420)
    expect(scaled.width / scaled.height).toBeCloseTo(640 / 420, 0)
    // 海量节点：封顶防失控。
    expect(scaleForceGraphWorld(5000, { spacing: 96 })).toEqual({ height: 1600, width: 2400 })
    // 自定义上限生效。
    expect(scaleForceGraphWorld(5000, { spacing: 120, maxWidth: 3200, maxHeight: 2100 }).width)
      .toBe(3200)
  })

  it('publishes worker ticks through shared memory without coordinate messages', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('postMessage', postMessage)
    await import('../src/renderer/src/components/graph/layout/forceGraph.worker')
    const memory = createForceGraphSharedMemory(2)
    const handler = globalThis.onmessage
    expect(handler).toBeTypeOf('function')

    handler?.({
      data: {
        type: 'initialize',
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ source: 'a', target: 'b' }],
        options: DEFAULT_FORCE_GRAPH_OPTIONS,
        positionsBuffer: memory.positionsBuffer,
        controlBuffer: memory.controlBuffer,
      },
    } as MessageEvent)
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready', nodeCount: 2 })
    expect(Atomics.load(memory.control, ForceGraphControlIndex.TickCount)).toBeGreaterThan(0)
    expect(Atomics.load(memory.control, ForceGraphControlIndex.Revision) % 2).toBe(0)
    expect([...memory.positions].every(Number.isFinite)).toBe(true)

    handler?.({ data: { type: 'DRAG', id: 'a', x: 120, y: 140 } } as MessageEvent)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect([...memory.positions.slice(0, 2)]).toEqual([120, 140])
    handler?.({ data: { type: 'RELEASE', id: 'a' } } as MessageEvent)

    handler?.({ data: { type: 'stop' } } as MessageEvent)
  })
})
