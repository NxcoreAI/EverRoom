import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ForceGraphLayoutController, type ForceGraphWorkerLike } from './layout/forceGraphLayout'
import {
  DEFAULT_FORCE_GRAPH_OPTIONS,
  type ForceGraphEdge,
  type ForceGraphNode,
  type ForceGraphOptions,
} from './layout/forceGraphProtocol'

/** 只依赖 fitView 的画布句柄（结构类型，PixiForceGraphCanvasHandle 天然满足）。 */
export interface ForceGraphViewportHandle {
  fitView(minScale?: number): void
}

export interface ForceGraphSettleFitOptions {
  /** fitView 的最小缩放；1 = 只居中不缩小（紧凑面板），缺省 = 整体适配。 */
  minScale?: number
  /** 世界变化到第一次对准的延时（毫秒），默认 500；第二次补对准在 3 倍延时后。 */
  delayMs?: number
  /**
   * 布局收敛期间相机逐帧跟随内容（每帧 fitView）。首帧坐标只是初始站位，
   * 节点群随后会收拢/迁移，视野固定不动就会出现「首帧 vs 稳定后」的跳变；
   * 跟随让相机随内容平滑移动，布局稳定（约 200ms 无坐标更新）、超时 3 秒
   * 或用户接管画布（拖节点 / 平移 / 缩放，见 cancelAutoFit）后停止。
   */
  follow?: boolean
}

export interface UseForceGraphLayoutInput {
  /** 布局节点输入；身份变化（useMemo）会触发布局重建。 */
  nodes: ForceGraphNode[]
  /** 布局边输入（字符串 id）；身份变化会触发布局重建。 */
  edges: ForceGraphEdge[]
  /** 力导向参数；须为稳定引用（模块常量或 useMemo），内联字面量会导致每次渲染重建布局。 */
  options?: Partial<ForceGraphOptions>
  /** 日志标签，拼进初始化/Worker 失败日志以区分是哪个图谱。 */
  label: string
  /** 测试注入假 Worker 用；生产路径缺省走 forceGraph.worker。 */
  workerFactory?: () => ForceGraphWorkerLike
  /** 画布句柄；settleFit 触发时调用其 fitView 重新对准视野。 */
  canvasRef?: { current: ForceGraphViewportHandle | null }
  /**
   * 布局稳定后自动把视野对准内容。Worker 坐标首次就绪或布局世界尺寸变化时，
   * 节点群会被力导向拉向新的平衡位置（世界中心），视野若停在原处就会一直
   * 偏在聚集区的左上方；本策略在稳定后延时调用 fitView 纠正。须为稳定引用。
   */
  settleFit?: ForceGraphSettleFitOptions
}

export interface UseForceGraphLayoutResult {
  /** 布局控制器；Worker 不可用（如 SharedArrayBuffer 缺失）时为 null。 */
  readonly controller: ForceGraphLayoutController | null
  /** Worker 写入的共享坐标；控制器未就绪时为 null，调用方回落静态坐标。 */
  readonly positions: Float32Array | null
  /** 供渲染层轮询 revision 的稳定回调；控制器未就绪时为 undefined。 */
  readonly revision: (() => number) | undefined
  /** 调整布局世界尺寸；以自然世界（初始 options 的 width/height）为下限，不会随面板缩小。 */
  resize(width: number, height: number): void
  /**
   * 用户以任意手势接管画布（平移/缩放）后调用：停掉相机跟随并清掉待触发
   * 的延时对准，视野交给用户。拖节点路径自动触发，无需重复调用。
   */
  cancelAutoFit(): void
  drag(id: string, x: number, y: number): void
  release(id: string): void
}

/**
 * 三个图谱画布共同的布局生命周期：创建 Worker 控制器、暴露稳定回调、
 * 卸载时释放。任一输入身份变化即整体重建，等价于原先各画布内联的 effect。
 */
export function useForceGraphLayout({
  nodes,
  edges,
  options,
  label,
  workerFactory,
  canvasRef,
  settleFit,
}: UseForceGraphLayoutInput): UseForceGraphLayoutResult {
  const [controller, setController] = useState<ForceGraphLayoutController | null>(null)
  const settleTimersRef = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const followRafRef = useRef<number | null>(null)
  const worldRef = useRef({ height: 0, width: 0 })

  // 画布（布局世界）有自然下限：初始化 options 的 width/height（缺省 640×420）。
  // 宿主面板再小也只收窄视口（平移/缩放浏览），布局世界不随面板压缩，
  // 节点不会被硬塞进面板矩形；面板更大时世界随之放大（行为与原先一致）。
  const naturalWorldWidth = options?.width ?? DEFAULT_FORCE_GRAPH_OPTIONS.width
  const naturalWorldHeight = options?.height ?? DEFAULT_FORCE_GRAPH_OPTIONS.height

  const clearSettleTimers = useCallback(() => {
    for (const timer of settleTimersRef.current) clearTimeout(timer)
    settleTimersRef.current = []
  }, [])

  const scheduleSettleFit = useCallback(() => {
    if (!settleFit || !canvasRef) return
    clearSettleTimers()
    const { delayMs = 500, minScale } = settleFit
    const fit = () => canvasRef.current?.fitView(minScale)
    // resize 重热温和（alpha 0.08），节点群向新世界中心的迁移持续 1~2 秒：
    // 延时一次后，在 3 倍延时再补一次，覆盖迁移尾巴。
    settleTimersRef.current = [
      setTimeout(fit, delayMs),
      setTimeout(fit, delayMs * 3),
    ]
  }, [canvasRef, clearSettleTimers, settleFit])

  useEffect(() => {
    let next: ForceGraphLayoutController
    try {
      next = new ForceGraphLayoutController({
        nodes,
        edges,
        options,
        ...(workerFactory ? { workerFactory } : {}),
      })
    } catch (error) {
      console.error(`Failed to initialize ${label} layout`, error)
      setController(null)
      return
    }
    worldRef.current = { height: naturalWorldHeight, width: naturalWorldWidth }
    setController(next)
    void next.ready.catch((error) => {
      console.error(`${label} worker failed`, error)
    })
    return () => next.dispose()
  }, [edges, label, naturalWorldHeight, naturalWorldWidth, nodes, options, workerFactory])

  const positions = controller?.snapshot.positions ?? null
  const revision = useMemo(
    () => (controller ? () => controller.revision() : undefined),
    [controller],
  )

  // Worker 坐标首次就绪（布局开跑）后补一次对准：初始站位会被力导向拉向
  // 平衡位置，视野需要等稳定后再对准内容。
  useEffect(() => {
    if (!positions) return
    scheduleSettleFit()
    if (!settleFit?.follow || !canvasRef || !controller) return
    const { minScale } = settleFit
    const stableFrames = 12 // ~200ms @60fps 无坐标更新视为布局已稳定
    const maxDurationMs = 3000
    const startedAt = Date.now()
    let lastRevision = controller.revision()
    let unchangedFrames = 0
    let raf = 0
    const step = () => {
      const revisionNow = controller.revision()
      unchangedFrames = revisionNow === lastRevision ? unchangedFrames + 1 : 0
      lastRevision = revisionNow
      if (unchangedFrames >= stableFrames || Date.now() - startedAt > maxDurationMs) {
        followRafRef.current = null
        return
      }
      canvasRef.current?.fitView(minScale)
      raf = requestAnimationFrame(step)
      followRafRef.current = raf
    }
    raf = requestAnimationFrame(step)
    followRafRef.current = raf
    return () => {
      cancelAnimationFrame(raf)
      if (followRafRef.current === raf) followRafRef.current = null
    }
  }, [positions, scheduleSettleFit, settleFit, canvasRef, controller])

  useEffect(() => clearSettleTimers, [clearSettleTimers])
  const resize = useCallback((width: number, height: number) => {
    if (!controller) return
    const worldWidth = Math.max(width, naturalWorldWidth)
    const worldHeight = Math.max(height, naturalWorldHeight)
    controller.resize(worldWidth, worldHeight)
    if (worldRef.current.width === worldWidth && worldRef.current.height === worldHeight) return
    // 世界尺寸变化：中心力换到新世界中心，节点群随后迁移，安排稳定后对准。
    worldRef.current = { height: worldHeight, width: worldWidth }
    scheduleSettleFit()
  }, [controller, naturalWorldHeight, naturalWorldWidth, scheduleSettleFit])
  // 用户以任意手势接管画布（拖节点/平移/缩放）后停掉相机自动化：
  // 取消跟随循环、清掉待触发的延时对准，视野完全交给用户。
  const cancelAutoFit = useCallback(() => {
    if (followRafRef.current !== null) {
      cancelAnimationFrame(followRafRef.current)
      followRafRef.current = null
    }
    clearSettleTimers()
  }, [clearSettleTimers])
  const drag = useCallback((id: string, x: number, y: number) => {
    cancelAutoFit()
    controller?.drag(id, x, y)
  }, [cancelAutoFit, controller])
  const release = useCallback((id: string) => controller?.release(id), [controller])

  return { controller, positions, revision, resize, cancelAutoFit, drag, release }
}
