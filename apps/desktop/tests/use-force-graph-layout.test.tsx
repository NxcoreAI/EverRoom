import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ForceGraphWorkerLike } from '../src/renderer/src/components/graph/layout/forceGraphLayout'
import {
  ForceGraphControlIndex,
  type ForceGraphWorkerRequest,
  type ForceGraphWorkerResponse,
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

function ForceGraphLayoutProbe({ nodes, edges, options, label, workerFactory, canvasRef, settleFit }: UseForceGraphLayoutInput) {
  latest = useForceGraphLayout({ nodes, edges, options, label, workerFactory, canvasRef, settleFit })
  return null
}

/** 浏览器 rAF 语义的最小桩：handle 取消后回调不再触发，pump 按 FIFO 执行。 */
function stubRequestAnimationFrame() {
  const pending = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = nextHandle
    nextHandle += 1
    pending.set(handle, callback)
    return handle
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    pending.delete(handle)
  })
  return {
    pumpFrame() {
      const oldest = pending.entries().next().value
      if (!oldest) return
      pending.delete(oldest[0])
      oldest[1](0)
    },
  }
}

afterEach(() => {
  latest = null
  vi.unstubAllGlobals()
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

    act(() => {
      latest?.resize(300, 200)
      latest?.resize(1000, 700)
    })
    // 布局世界有自然下限（缺省 640×420）：面板小于自然世界时只收窄视口，
    // 世界保持自然尺寸；面板更大时世界随之放大（与原行为一致）。
    expect(created[1]!.posted.slice(4)).toEqual([
      { type: 'resize', width: 640, height: 420 },
      { type: 'resize', width: 1000, height: 700 },
    ])

    await act(async () => { renderer.unmount() })
    expect(created[1]!.terminated).toBe(true)
  })

  it('uses the options world size as the natural floor for resize', async () => {
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }
    const options = { width: 900, height: 700 }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe
          nodes={[{ id: 'a' }]}
          edges={[]}
          options={options}
          label="Test graph"
          workerFactory={workerFactory}
        />,
      )
    })

    act(() => { latest?.resize(500, 400) })
    expect(created[0]!.posted.at(-1)).toEqual({ type: 'resize', width: 900, height: 700 })

    await act(async () => { renderer.unmount() })
  })

  it('re-fits the view through the canvas handle when positions go live or the world changes', async () => {
    vi.useFakeTimers()
    try {
      const created: FakeForceGraphWorker[] = []
      const workerFactory = () => {
        const worker = new FakeForceGraphWorker()
        created.push(worker)
        return worker
      }
      const fitView = vi.fn()
      const canvasRef = { current: { fitView } }
      const settleFit = { minScale: 1, delayMs: 400 }

      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(
          <ForceGraphLayoutProbe
            nodes={[{ id: 'a' }]}
            edges={[]}
            label="Test graph"
            workerFactory={workerFactory}
            canvasRef={canvasRef}
            settleFit={settleFit}
          />,
        )
      })

      // 布局坐标就绪（挂载）即安排对准：一次在延时后，一次在 3 倍延时后补迁移尾巴。
      expect(fitView).not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(fitView).toHaveBeenCalledTimes(1)
      expect(fitView).toHaveBeenCalledWith(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(800) })
      expect(fitView).toHaveBeenCalledTimes(2)

      // 世界尺寸变化（超出自然下限）→ 重新安排对准。
      act(() => { latest?.resize(900, 700) })
      expect(created[0]!.posted.at(-1)).toEqual({ type: 'resize', width: 900, height: 700 })
      await act(async () => { await vi.advanceTimersByTimeAsync(400) })
      expect(fitView).toHaveBeenCalledTimes(3)

      // 世界从 900×700 收回 640×420 也是一次尺寸变化（节点群会迁回世界中心），
      // 上一轮未触发的补对准被清掉，换新一轮两次对准。
      act(() => { latest?.resize(300, 200) })
      expect(created[0]!.posted.at(-1)).toEqual({ type: 'resize', width: 640, height: 420 })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(fitView).toHaveBeenCalledTimes(5)

      // 卸载清掉待触发的对准。
      act(() => { latest?.resize(1000, 800) })
      await act(async () => { renderer.unmount() })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(fitView).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops following the content once the user drags a node', async () => {
    const raf = stubRequestAnimationFrame()
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }
    const fitView = vi.fn()
    const canvasRef = { current: { fitView } }
    const settleFit = { minScale: 1, follow: true }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe
          nodes={[{ id: 'a' }]}
          edges={[]}
          label="Test graph"
          workerFactory={workerFactory}
          canvasRef={canvasRef}
          settleFit={settleFit}
        />,
      )
    })
    const initialize = created[0]!.posted[0]
    if (initialize?.type !== 'initialize') throw new Error('worker not initialized')
    const control = new Int32Array(initialize.controlBuffer)
    const bumpRevision = () => { Atomics.add(control, ForceGraphControlIndex.Revision, 2) }

    // Worker 每帧发布新坐标（revision 前进）→ 相机逐帧 fitView 跟随。
    bumpRevision()
    await act(async () => { raf.pumpFrame() })
    expect(fitView).toHaveBeenCalledWith(1)
    expect(fitView.mock.calls.length).toBeGreaterThanOrEqual(1)

    // 用户拖动节点 → 立即停止跟随（之后 revision 再前进也不再 fitView）。
    act(() => { latest?.drag('a', 5, 5) })
    const countAfterDrag = fitView.mock.calls.length
    bumpRevision()
    await act(async () => {
      raf.pumpFrame()
      raf.pumpFrame()
    })
    expect(fitView.mock.calls.length).toBe(countAfterDrag)

    await act(async () => { renderer.unmount() })
  })

  it('stops following once the layout stops publishing new positions', async () => {
    const raf = stubRequestAnimationFrame()
    const created: FakeForceGraphWorker[] = []
    const workerFactory = () => {
      const worker = new FakeForceGraphWorker()
      created.push(worker)
      return worker
    }
    const fitView = vi.fn()
    const canvasRef = { current: { fitView } }
    const settleFit = { minScale: 1, follow: true }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <ForceGraphLayoutProbe
          nodes={[{ id: 'a' }]}
          edges={[]}
          label="Test graph"
          workerFactory={workerFactory}
          canvasRef={canvasRef}
          settleFit={settleFit}
        />,
      )
    })
    const initialize = created[0]!.posted[0]
    if (initialize?.type !== 'initialize') throw new Error('worker not initialized')
    const control = new Int32Array(initialize.controlBuffer)
    Atomics.add(control, ForceGraphControlIndex.Revision, 2)

    await act(async () => { raf.pumpFrame() })
    expect(fitView.mock.calls.length).toBeGreaterThanOrEqual(1)

    // revision 不再前进：跟随循环连续若干帧无变化后自行停止。
    for (let frame = 0; frame < 20; frame += 1) {
      await act(async () => { raf.pumpFrame() })
    }
    const settledCount = fitView.mock.calls.length
    Atomics.add(control, ForceGraphControlIndex.Revision, 2)
    await act(async () => { raf.pumpFrame() })
    expect(fitView.mock.calls.length).toBe(settledCount)

    await act(async () => { renderer.unmount() })
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
