// 临时入口：纯浏览器预览屏幕录制授权引导步骤（配合样式调整）。
import { createRoot } from 'react-dom/client'

import { OnboardingFlowChrome } from './components/onboarding/OnboardingFlowChrome'
import { ScreenRecordingPermissionOnboarding } from './components/onboarding/ScreenRecordingPermissionOnboarding'
import { LocaleProvider } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <LocaleProvider>
    <OnboardingFlowChrome stage="screen" onStageChange={() => undefined}>
      <div className="app-shell">APP SHELL（此区块在 screen 阶段必须不可见）</div>
      <ScreenRecordingPermissionOnboarding onFinished={() => undefined} />
    </OnboardingFlowChrome>
  </LocaleProvider>,
)
