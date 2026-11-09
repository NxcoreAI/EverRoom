import { useCallback, useRef } from 'react'

import type { AgentSpaceDetectResult } from '@nxcore/agent-contract'

import { workbenchApi } from '../api'
import { useWorkbenchStore } from '../state/store'
import { workbenchToast } from '../shell/toast'

/**
 * 一步式新建项目空间。
 *
 * 没有「填名称/描述/目标」的表单，也没有创建后的引导弹窗：点「新建项目空间」
 * 直接弹系统目录选择器，选中的目录就地成为项目空间（只新增 `.everoffice/`
 * 元数据，原有文件原样保留），空间名取目录名（之后随时可在空间卡片/概览改名）。
 *
 * 目录已经是项目空间时不再报错：已注册就直接打开，未注册就接管（adopt），
 * 用户永远不会被「请改用打开已有项目空间」这类提示打断。
 */

/** 空间名与后端一致的上限（agent_workspaces.name 的 120 字符限制）。 */
const NAME_MAX_LENGTH = 120

/** 选中根目录等极端输入时的兜底名。 */
const FALLBACK_NAME = '新建项目空间'

/**
 * 目录路径 → 项目空间名（取最后一段，兼容正/反斜杠与结尾分隔符）。
 * 纯函数，单测覆盖。
 */
export function directoryToSpaceName(dir: string): string {
  const segments = dir.replace(/\\/gu, '/').split('/').filter(Boolean)
  const name = (segments[segments.length - 1] ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[.\s]+$/u, '')
    .slice(0, NAME_MAX_LENGTH)
    .trim()
  return name || FALLBACK_NAME
}

/** 已在运行的一次流程（防抖：原生选择器关闭后的重复触发直接忽略）。 */
let flowInFlight = false

/** 创建/接管成功后把目录里的既有文件收进资料库；失败静默（资料页仍可手动对账）。 */
function indexExistingFilesInBackground(workspaceId: string): void {
  void workbenchApi.reconcileLibrary(workspaceId)
    .then((report) => {
      if (report.added.length > 0) {
        workbenchToast(`已把「${report.added.length}」份目录内文件收进资料`)
      }
    })
    .catch(() => undefined)
}

/**
 * 启动一步式创建流程的 hook。
 *
 * 返回的回调本身不抛错：取消静默返回；失败写 store.error（外壳错误条展示）。
 */
export function useCreateSpaceFlow(): () => Promise<void> {
  const inFlightRef = useRef(false)
  return useCallback(async () => {
    if (flowInFlight || inFlightRef.current) return
    flowInFlight = true
    inFlightRef.current = true
    try {
      await runCreateSpaceFlow()
    } finally {
      flowInFlight = false
      inFlightRef.current = false
    }
  }, [])
}

async function runCreateSpaceFlow(): Promise<void> {
  const store = useWorkbenchStore.getState()

  // ① 直接弹原生目录选择器（无桥的浏览器预览环境静默放弃）。
  const picked = await window.nxcore?.workspace?.pickDirectory().catch(() => null) ?? null
  if (!picked) return

  // ② 探测：目录里已有空间标记时走「打开/接管」，否则就地新建。
  const detected = await workbenchApi.detectSpace(picked)
  if (detected?.status === 'space') {
    const registered = useWorkbenchStore.getState().workspaces.find((workspace) =>
      workspace.id === detected.spaceId || workspace.path === detected.root)
    if (registered) {
      store.openWorkspaceTab(registered.id)
      workbenchToast(`「${registered.name}」已是项目空间，已为你打开`)
      return
    }
    const adopted = await store.adoptWorkspace({ dir: picked })
    if (adopted) {
      workbenchToast(`已接管目录为项目空间「${adopted.name}」`)
      indexExistingFilesInBackground(adopted.id)
    }
    return
  }

  // ③ 常规路径：以目录名为空间名就地创建（external 模式）。
  const created = await store.createWorkspace({
    name: directoryToSpaceName(picked),
    path: picked,
  })
  if (created) {
    workbenchToast(`已创建项目空间「${created.name}」，可随时改名`)
    indexExistingFilesInBackground(created.id)
  }
}

/** 单测用：探测结果 → 是否走「打开已有」分支的判定。 */
export function isRegisteredSpace(
  detected: AgentSpaceDetectResult | null,
  workspaces: ReadonlyArray<{ id: string; path: string | null }>,
): boolean {
  return Boolean(detected?.status === 'space' && workspaces.some((workspace) =>
    workspace.id === detected.spaceId || workspace.path === detected.root))
}
