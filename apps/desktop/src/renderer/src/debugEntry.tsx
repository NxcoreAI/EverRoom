/**
 * 「Agent 调试」独立窗口入口（debug.html）。
 *
 * 面板本身复用 office-proto/AgentDebugView：数据走同一套 preload
 * （window.nxcore.agentDebug / agentAccess / agent），只是宿主从应用外壳里的
 * 覆盖层换成了主进程创建的独立 BrowserWindow。
 * 标题栏沿用窗口拖拽区约定：macOS 让出系统红绿灯，Windows 由 WindowControls 自绘。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'

// 与主窗口相同的全局样式顺序，让面板拿到 .op-root 的 Apple token 覆盖。
import '@/styles/tokens.css'
import '@/styles/themes.css'
import '@/styles/legacy-ui.css'
import '@/office-proto/office-proto.css'
// body margin 复位 / 窗口高度与字体渲染微调（与主窗口同一适配层）。
import '@/desktop-frame.css'

import { LocaleProvider } from '@/i18n/LocaleContext'
import { initAppearanceTheme } from '@/state/appearanceSettings'
import { AgentDebugView } from '@/office-proto/AgentDebugView'

// 窗口按钮/拖拽区按平台切换（主进程用 hiddenInset / hidden 标题栏）。
initAppearanceTheme()
document.documentElement.dataset.desktop = window.desktop?.platform ?? 'darwin'

/** 关闭当前窗口：走 preload 的窗口 API（主进程按 sender 定位窗口）；浏览器预览时退回 window.close。 */
function closeWindow(): void {
  const api = window.nxcore?.window
  if (api) {
    void api.close()
    return
  }
  window.close()
}

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <LocaleProvider>
        <div className="op-root op-debug-window-root">
          <AgentDebugView onClose={closeWindow} />
        </div>
      </LocaleProvider>
    </React.StrictMode>,
  )
}