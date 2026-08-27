import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ForceGraphWorkerLike } from '../src/renderer/src/components/graph/layout/forceGraphLayout'
import type {
  ForceGraphWorkerRequest,
  ForceGraphWorkerResponse,
} from '../src/renderer/src/components/graph/layout/forceGraphProtocol'
import {
  useForceGraphLayout,
  type UseForceGraphLayoutInput,
  type UseForceGraphLayoutResult,
} from '../src/renderer/src/components/graph/useForceGraphLayout'

class FakeForceGraphWorker implements ForceGraphWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessage: ((event: MessageEvent<ForceGraphWorkerResponse>) => void) | null = null
  posted: ForceGraphWorkerRequest[] = []
  terminated = false

  postMessage(message: ForceGraphWorkerRequest): void {
    this.posted.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  emitReady(nodeCount: number): void {
    this.onmessage?.({ data: { type: 'ready', nodeCount } } as MessageEvent<ForceGraphWorkerResponse>)
  }

  emitError(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }
}

let latest: UseForceGraphLayoutResult | null = null

function ForceGraphLayoutProbe({ nodes, edges, options, label, workerFactory }: UseForceGraphLayoutInput) {
  latest = useForceGraphLayout({ nodes, edges, options, label, workerFactory })
  return null
}

afterEach(() => {
  latest = null
  vi.restoreAllMocks()
})

describe('useForceGraphLayout', () => {
  it('passes nodes, edges and merged options to the layout worker', async () => {
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }
    const nodes = [{ id: 'room-a', radius: 22 }, { id: 'room-b' }]
    const edges = [{ source: 'room-a', target: 'room-b' }]

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe
          nodes={nodes}
          edges={edges}
          options={{ linkDistance: 82 }}
          label="Test graph"
          workerFactory={workerFactory}
        />,
      )
    })

    expect(created).toHaveLength(1)
    const initialize = created[0]!.posted[0]
    expect(initialize?.type).toBe('initialize')
    if (initialize?.type !== 'initialize') return
    expect(initialize.nodes).toEqual(nodes)
    expect(initialize.edges).toEqual(edges)
    // 选项在控制器内与默认值合并：显式项覆盖、其余保持默认。
    expect(initialize.options.linkDistance).toBe(82)
    expect(initialize.options.width).toBe(640)
    expect(latest?.positions).toBeInstanceOf(Float32Array)
    expect(latest?.positions).toHaveLength(4)
    expect(typeof latest?.revision).toBe('function')
    expect(latest?.revision?.()).toBe(0)

    await act(async () => { renderer.unmount() })
    expect(created[0]!.terminated).toBe(true)
  })

  it('rebuilds on input identity change and stays put across re-renders', async () => {
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }
    const nodes = [{ id: 'a' }, { id: 'b' }]
    const nextNodes = [...nodes, { id: 'c' }]
    const edges: Array<{ source: string; target: string }> = []
    const options = { linkDistance: 100 }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe nodes={nodes} edges={edges} options={options} label="Test graph" workerFactory={workerFactory} />,
      )
    })
    await act(async () => {
      renderer.update(
        <ForceGraphLayoutProbe nodes={nodes} edges={edges} options={options} label="Test graph" workerFactory={workerFactory} />,
      )
    })
    expect(created).toHaveLength(1)

    await act(async () => {
      renderer.update(
        <ForceGraphLayoutProbe nodes={nextNodes} edges={edges} options={options} label="Test graph" workerFactory={workerFactory} />,
      )
    })
    expect(created).toHaveLength(2)
    expect(created[0]!.terminated).toBe(true)
    expect(created[0]!.posted.at(-1)?.type).toBe('stop')
    expect(created[1]!.posted[0]?.type).toBe('initialize')

    act(() => {
      latest?.resize(800, 600)
      latest?.drag('a', 12, 34)
      latest?.release('a')
    })
    expect(created[1]!.posted.slice(1)).toEqual([
      { type: 'resize', width: 800, height: 600 },
      { type: 'DRAG', id: 'a', x: 12, y: 34 },
      { type: 'RELEASE', id: 'a' },
    ])

    await act(async () => { renderer.unmount() })
    expect(created[1]!.terminated).toBe(true)
  })

  it('surfaces worker errors through ready and keeps the binding usable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe nodes={[{ id: 'a' }]} edges={[]} label="Test graph" workerFactory={workerFactory} />,
      )
    })

    // ready 只结算一次：初始化阶段就失败（未先 ready）才会走 ready.catch 日志。
    created[0]!.emitError('boom')
    await act(async () => {})
    expect(console.error).toHaveBeenCalledWith('Test graph worker failed', expect.objectContaining({
      message: 'boom',
    }))
    // Worker 失败后绑定仍可安全调用（控制器还在，只是 ready 已 reject）。
    expect(() => {
      latest?.resize(100, 100)
      latest?.drag('a', 1, 2)
      latest?.release('a')
    }).not.toThrow()

    await act(async () => { renderer.unmount() })
  })

  it('falls back to a null controller when initialization fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe
          nodes={[{ id: 'dup' }, { id: 'dup' }]}
          edges={[]}
          label="Broken graph"
          workerFactory={workerFactory}
        />,
      )
    })

    expect(created).toHaveLength(0)
    expect(latest?.controller).toBeNull()
    expect(latest?.positions).toBeNull()
    expect(latest?.revision).toBeUndefined()
    expect(() => {
      latest?.resize(10, 10)
      latest?.drag('dup', 1, 2)
      latest?.release('dup')
    }).not.toThrow()
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to initialize Broken graph layout',
      expect.objectContaining({ message: 'Force graph node IDs must be unique' }),
    )

    await act(async () => { renderer.unmount() })
  })
})
