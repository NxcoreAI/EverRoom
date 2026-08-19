import {
  ForceGraphControlIndex,
  ForceGraphStatus,
  type ForceGraphInitializeMessage,
  type ForceGraphWorkerRequest,
  type ForceGraphWorkerResponse,
} from './forceGraphProtocol'
import { createForceGraphSimulation, type ForceGraphSimulation } from './forceGraphSimulation'

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ForceGraphWorkerRequest>) => void) | null
  postMessage(message: ForceGraphWorkerResponse): void
}

let simulation: ForceGraphSimulation | null = null
let control: Int32Array | null = null

function fail(error: unknown) {
  if (control) Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Error)
  workerScope.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
}

function initialize(message: ForceGraphInitializeMessage) {
  simulation?.stop()
  const positions = new Float32Array(message.positionsBuffer)
  const nextControl = new Int32Array(message.controlBuffer)
  if (positions.length !== message.nodes.length * 2) {
    throw new Error('Shared coordinate buffer does not match the graph node count')
  }
  if (nextControl.length < 4) {
    throw new Error('Shared control buffer is too small')
  }
  control = nextControl
  Atomics.store(control, ForceGraphControlIndex.NodeCount, message.nodes.length)
  Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Running)

  simulation = createForceGraphSimulation({
    nodes: message.nodes,
    edges: message.edges,
    options: message.options,
    publish: (nodes) => {
      Atomics.add(nextControl, ForceGraphControlIndex.Revision, 1)
      for (let index = 0; index < nodes.length; index += 1) {
        positions[index * 2] = Number.isFinite(nodes[index]?.x) ? nodes[index]!.x! : 0
        positions[index * 2 + 1] = Number.isFinite(nodes[index]?.y) ? nodes[index]!.y! : 0
      }
      Atomics.add(nextControl, ForceGraphControlIndex.TickCount, 1)
      Atomics.add(nextControl, ForceGraphControlIndex.Revision, 1)
      Atomics.notify(nextControl, ForceGraphControlIndex.Revision)
    },
    settled: () => {
      Atomics.store(nextControl, ForceGraphControlIndex.Status, ForceGraphStatus.Stable)
    },
  })
  workerScope.postMessage({ type: 'ready', nodeCount: message.nodes.length })
}

workerScope.onmessage = (event) => {
  try {
    const message = event.data
    if (message.type === 'initialize') {
      initialize(message)
      return
    }
    if (message.type === 'resize') {
      simulation?.resize(message.width, message.height)
      if (control) Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Running)
      return
    }
    if (message.type === 'reheat') {
      simulation?.reheat(message.alpha)
      if (control) Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Running)
      return
    }
    if (message.type === 'DRAG') {
      simulation?.drag(message.id, message.x, message.y)
      if (control) Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Running)
      return
    }
    if (message.type === 'RELEASE') {
      simulation?.release(message.id)
      if (control) Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Running)
      return
    }
    simulation?.stop()
    simulation = null
    if (control) Atomics.store(control, ForceGraphControlIndex.Status, ForceGraphStatus.Stopped)
  } catch (error) {
    fail(error)
  }
}
