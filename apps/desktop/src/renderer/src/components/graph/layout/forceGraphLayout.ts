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
  return new Worker(new URL('./forceGraph.worker.ts', import.meta.url), {
    name: 'force-graph-layout',
    type: 'module',
  })
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
  }: {
    nodes: ForceGraphNode[]
    edges: ForceGraphEdge[]
    options?: Partial<ForceGraphOptions>
    workerFactory?: () => ForceGraphWorkerLike
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
    this.ready = new Promise<void>((resolve, reject) => {
      this.worker.onmessage = (event) => {
        if (event.data.type === 'ready') resolve()
        else reject(new Error(event.data.message))
      }
      this.worker.onerror = (event) => reject(new Error(event.message || 'Force graph worker failed'))
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
