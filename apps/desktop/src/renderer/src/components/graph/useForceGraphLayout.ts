import { useCallback, useEffect, useMemo, useState } from 'react'

import { ForceGraphLayoutController, type ForceGraphWorkerLike } from './layout/forceGraphLayout'
import type { ForceGraphEdge, ForceGraphNode, ForceGraphOptions } from './layout/forceGraphProtocol'

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
}

export interface UseForceGraphLayoutResult {
  /** 布局控制器；Worker 不可用（如 SharedArrayBuffer 缺失）时为 null。 */
  readonly controller: ForceGraphLayoutController | null
  /** Worker 写入的共享坐标；控制器未就绪时为 null，调用方回落静态坐标。 */
  readonly positions: Float32Array | null
  /** 供渲染层轮询 revision 的稳定回调；控制器未就绪时为 undefined。 */
  readonly revision: (() => number) | undefined
  resize(width: number, height: number): void
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
}: UseForceGraphLayoutInput): UseForceGraphLayoutResult {
  const [controller, setController] = useState<ForceGraphLayoutController | null>(null)

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
    setController(next)
    void next.ready.catch((error) => {
      console.error(`${label} worker failed`, error)
    })
    return () => next.dispose()
  }, [edges, label, nodes, options, workerFactory])

  const positions = controller?.snapshot.positions ?? null
  const revision = useMemo(
    () => (controller ? () => controller.revision() : undefined),
    [controller],
  )
  const resize = useCallback(
    (width: number, height: number) => controller?.resize(width, height),
    [controller],
  )
  const drag = useCallback(
    (id: string, x: number, y: number) => controller?.drag(id, x, y),
    [controller],
  )
  const release = useCallback((id: string) => controller?.release(id), [controller])

  return { controller, positions, revision, resize, drag, release }
}
