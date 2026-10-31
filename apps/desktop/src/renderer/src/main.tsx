import * as Sentry from '@sentry/electron/renderer'
import React from 'react'
import { createRoot } from 'react-dom/client'

// 全局样式顺序：设计 token → 旧组件兼容层 → 原型外壳。组件自身的 CSS 由下方
// 模块导入时追加，因此局部规则总是覆盖兼容层里的通用类（.page/.primary-button…）。
import '@/styles/tokens.css'
import '@/styles/themes.css'
import '@/styles/legacy-ui.css'
import '@/office-proto/office-proto.css'
import '@/desktop-frame.css'

import { RuntimeConfigGate } from '@/components/onboarding/RuntimeConfigGate'
import { initAppearanceTheme } from '@/state/appearanceSettings'
import { LocaleProvider } from '@/i18n/LocaleContext'
import { AccountProvider } from '@/state/AccountContext'
import { Workbench } from '@/workbench/shell/Workbench'
import '@/workbench/styles/workbench.css'

// 读取并应用全局外观（index.html 里的内联脚本已在首帧前设置一次，这里兜底）。
initAppearanceTheme()

Sentry.init({ beforeBreadcrumb: () => null })

// 平台标记:desktop-frame.css 据此在 macOS 上隐藏原型的假红绿灯、给系统红绿灯让位
document.documentElement.dataset.desktop = window.desktop?.platform ?? 'darwin'

const el = document.getElementById('root')
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      {/* 登录/运行时配置门控（旧桌面端启动 gate）：未登录且 AI 运行时配置未就绪时
          先走登录，通过后才渲染原型外壳；已登录用户直接进入应用。 */}
      <LocaleProvider>
        <AccountProvider>
          <RuntimeConfigGate>
            <Workbench />
          </RuntimeConfigGate>
        </AccountProvider>
      </LocaleProvider>
    </React.StrictMode>,
  )
}
