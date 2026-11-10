import { BrowserWindow } from 'electron'

import {
  OFFICE_PREVIEW_REQUEST_CHANNEL,
  type OfficePreviewKind,
  type OfficePreviewRequest,
} from '../../shared/sources'

/**
 * 主进程自己建好了预览实例之后，通知主窗口渲染端「去开个标签」。
 *
 * 应用内所有 Office 预览实例的可见性都由渲染端驱动：标签页决定 activePage，
 * App 再据此调 setActiveInstance + 上报 workspace 矩形，视图才真正显示出来。
 * 主进程单方面 open() 只会得到一个 setVisible(false) 的 WebContentsView——
 * 也就是用户眼里的「点了预览完全没反应」。凡是主进程发起的打开（排版面板
 * 👁 预览模版原文件、Agent 生成产物后自动打开等），都必须补这条通知。
 *
 * 返回 false = 没有存活窗口可通知（调用方不必当作失败：文档本身已经建好）。
 */
export function notifyPreviewRequested(request: OfficePreviewRequest): boolean {
  const target = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!target) return false
  target.webContents.send(OFFICE_PREVIEW_REQUEST_CHANNEL, request)
  return true
}

/** 从 openFileInAppPreview 的结果里挑出可显示的实例；非 Office 形态（交给系统应用）返回 null。 */
export function previewRequestFromOpenResult(result: {
  openedWith: 'office' | 'external'
  instanceId?: string
  kind?: OfficePreviewKind
  title?: string
}): OfficePreviewRequest | null {
  if (result.openedWith !== 'office') return null
  if (!result.instanceId || !result.kind || !result.title) return null
  return { instanceId: result.instanceId, title: result.title, kind: result.kind }
}
