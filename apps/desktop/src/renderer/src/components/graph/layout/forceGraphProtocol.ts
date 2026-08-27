export interface ForceGraphNode {
  id: string
  radius?: number
  x?: number
  y?: number
}

export interface ForceGraphEdge {
  source: string
  target: string
}

export interface ForceGraphOptions {
  centerStrength: number
  collisionPadding: number
  collisionStrength: number
  degreeBias: number
  height: number
  linkDistance: number
  linkStrength: number
  manyBodyStrength: number
  velocityDecay: number
  width: number
}

export const DEFAULT_FORCE_GRAPH_OPTIONS: ForceGraphOptions = {
  centerStrength: 0.06,
  collisionPadding: 12,
  collisionStrength: 0.95,
  degreeBias: 0,
  height: 420,
  linkDistance: 140,
  linkStrength: 0.35,
  manyBodyStrength: -320,
  velocityDecay: 0.4,
  width: 640,
}

export const FORCE_GRAPH_CONTROL_LENGTH = 4

export const enum ForceGraphControlIndex {
  Revision = 0,
  Status = 1,
  NodeCount = 2,
  TickCount = 3,
}

export const enum ForceGraphStatus {
  Idle = 0,
  Running = 1,
  Stable = 2,
  Stopped = 3,
  Error = 4,
}

export interface ForceGraphInitializeMessage {
  type: 'initialize'
  nodes: ForceGraphNode[]
  edges: ForceGraphEdge[]
  options: ForceGraphOptions
  positionsBuffer: SharedArrayBuffer
  controlBuffer: SharedArrayBuffer
}

export interface ForceGraphResizeMessage {
  type: 'resize'
  width: number
  height: number
}

export interface ForceGraphReheatMessage {
  type: 'reheat'
  alpha?: number
}

export interface ForceGraphDragMessage {
  type: 'DRAG'
  id: string
  x: number
  y: number
}

export interface ForceGraphReleaseMessage {
  type: 'RELEASE'
  id: string
}

export interface ForceGraphStopMessage {
  type: 'stop'
}

export type ForceGraphWorkerRequest =
  | ForceGraphInitializeMessage
  | ForceGraphResizeMessage
  | ForceGraphReheatMessage
  | ForceGraphDragMessage
  | ForceGraphReleaseMessage
  | ForceGraphStopMessage

export type ForceGraphWorkerResponse =
  | { type: 'ready'; nodeCount: number }
  | { type: 'error'; message: string }

export function forceGraphPositionByteLength(nodeCount: number): number {
  return nodeCount * 2 * Float32Array.BYTES_PER_ELEMENT
}

export function createForceGraphSharedMemory(nodeCount: number): {
  control: Int32Array
  controlBuffer: SharedArrayBuffer
  positions: Float32Array
  positionsBuffer: SharedArrayBuffer
} {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0) {
    throw new RangeError('Force graph node count must be a non-negative integer')
  }
  const positionsBuffer = new SharedArrayBuffer(forceGraphPositionByteLength(nodeCount))
  const controlBuffer = new SharedArrayBuffer(
    FORCE_GRAPH_CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT,
  )
  const positions = new Float32Array(positionsBuffer)
  const control = new Int32Array(controlBuffer)
  Atomics.store(control, ForceGraphControlIndex.NodeCount, nodeCount)
  Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Idle)
  return { control, controlBuffer, positions, positionsBuffer }
}
