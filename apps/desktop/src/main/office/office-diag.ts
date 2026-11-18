import type { BrowserWindow, WebContentsView } from 'electron'

import { logDesktop } from '../logging/desktop-logger'

// TEMP DIAG：「首次打开（访达双击）文档只显示 Office 预览占位界面」定因用，查完删除。
// 只读状态、不参与显隐；任何取状态失败都吞掉，避免诊断本身把打开流程带崩。
export function logOfficeDiag(event: string, payload: Record<string, unknown> = {}): void {
  logDesktop('office', 'info', { event, ...payload })
}

export function logOfficeViewState(
  event: string,
  view: WebContentsView,
  window: BrowserWindow,
  extra: Record<string, unknown> = {},
): void {
  try {
    const wc = view.webContents
    const destroyed = wc.isDestroyed()
    const windowGone = window.isDestroyed()
    logOfficeDiag(event, {
      wcId: destroyed ? null : wc.id,
      wcDestroyed: destroyed,
      wcLoading: destroyed ? null : wc.isLoading(),
      viewVisible: view.getVisible(),
      viewBounds: view.getBounds(),
      windowVisible: windowGone ? null : window.isVisible(),
      windowFocused: windowGone ? null : window.isFocused(),
      windowMinimized: windowGone ? null : window.isMinimized(),
      ...extra,
    })
  } catch {
    // 诊断失败不影响显隐。
  }
}

export function wireOfficeViewDiag(view: WebContentsView, window: BrowserWindow): void {
  const state = (event: string, extra: Record<string, unknown> = {}) =>
    logOfficeViewState(event, view, window, extra)
  view.webContents.on('dom-ready', () => state('office.diag.dom-ready'))
  view.webContents.on('did-finish-load', () => state('office.diag.did-finish-load'))
  view.webContents.once('did-fail-load', (_event, code, description, url, isMainFrame) =>
    state('office.diag.did-fail-load', { code, description, url, isMainFrame }))
  view.webContents.once('render-process-gone', (_event, details) =>
    state('office.diag.render-process-gone', { reason: details.reason, exitCode: details.exitCode }))
}
