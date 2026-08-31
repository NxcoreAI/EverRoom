import ForceGraphWorker from './forceGraph.worker?worker&inline'

import {
  DEFAULT_FORCE_GRAPH_OPTIONS,
  ForceGraphControlIndex,
  type ForceGraphEdge,
  type ForceGraphNode,
  type ForceGraphOptions,
  type ForceGraphWorkerRequest,
  type ForceGraphWorkerResponse,
  createForceGraphSharedMemory,
} from './forceGraphProtocol'

export interface ForceGraphWorkerLike {
  onerror: ((event: ErrorEvent) => void) | null
  onmessage: ((event: MessageEvent<ForceGraphWorkerResponse>) => void) | null
  postMessage(message: ForceGraphWorkerRequest): void
  terminate(): void
}

export interface ForceGraphLayoutSnapshot {
  control: Int32Array
  nodeIds: readonly string[]
  positions: Float32Array
}

function defaultWorkerFactory(): ForceGraphWorkerLike {
  // 内联（blob URL）Worker：打包后的应用从 file:// 加载，且主进程为启用
  // SharedArrayBuffer 注入了 COOP/COEP；此时 file:// Worker 脚本会被 CORP
  // 拦截（module/classic 均失败，Worker 异步 error），blob URL 则两端可用。
  return new ForceGraphWorker({ name: 'force-graph-layout' }) as ForceGraphWorkerLike
}

export class ForceGraphLayoutController {
  readonly snapshot: ForceGraphLayoutSnapshot
  readonly ready: Promise<void>

  private readonly worker: ForceGraphWorkerLike
  private disposed = false

  constructor({
    nodes,
    edges,
    options,
    workerFactory = defaultWorkerFactory,
    onFatal,
  }: {
    nodes: ForceGraphNode[]
    edges: ForceGraphEdge[]
    options?: Partial<ForceGraphOptions>
    workerFactory?: () => ForceGraphWorkerLike
    /**
     * Worker 致命错误回调（脚本加载失败、初始化抛错或运行中崩溃），
     * ready 被拒与 ready 之后的 onerror 都会触发，至多一次。
     * 共享坐标缓冲此后不再更新（保持全 0），宿主应回落静态布局。
     */
    onFatal?: (error: Error) => void
  }) {
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('SharedArrayBuffer is unavailable; enable COOP/COEP cross-origin isolation')
    }
    const nodeIds = nodes.map((node) => node.id)
    if (new Set(nodeIds).size !== nodeIds.length) {
      throw new Error('Force graph node IDs must be unique')
    }
    const shared = createForceGraphSharedMemory(nodes.length)
    this.snapshot = {
      control: shared.control,
      nodeIds,
      positions: shared.positions,
    }
    this.worker = workerFactory()
    let fatalNotified = false
    const notifyFatal = (error: Error) => {
      if (fatalNotified || this.disposed) return
      fatalNotified = true
      onFatal?.(error)
    }
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (event) => {
        if (event.data.type === 'ready') resolve()
        else {
          const error = new Error(event.data.message)
          reject(error)
          notifyFatal(error)
        }
      }
      this.worker.onerror = (event) => {
        const error = new Error(event.message || 'Force graph worker failed')
        reject(error)
        notifyFatal(error)
      }
    })
    this.worker.postMessage({
      type: 'initialize',
      nodes,
      edges,
      options: { ...DEFAULT_FORCE_GRAPH_OPTIONS, ...options },
      positionsBuffer: shared.positionsBuffer,
      controlBuffer: shared.controlBuffer,
    })
  }

  revision(): number {
    return Atomics.load(this.snapshot.control, ForceGraphControlIndex.Revision)
  }

  resize(width: number, height: number): void {
    if (this.disposed || width <= 0 || height <= 0) return
    this.worker.postMessage({ type: 'resize', width, height })
  }

  reheat(alpha?: number): void {
    if (this.disposed) return
    this.worker.postMessage({ type: 'reheat', ...(alpha === undefined ? {} : { alpha }) })
  }

  drag(id: string, x: number, y: number): void {
    if (this.disposed || !Number.isFinite(x) || !Number.isFinite(y)) return
    this.worker.postMessage({ type: 'DRAG', id, x, y })
  }

  release(id: string): void {
    if (this.disposed) return
    this.worker.postMessage({ type: 'RELEASE', id })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.worker.postMessage({ type: 'stop' })
    this.worker.terminate()
  }
}
