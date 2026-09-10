// 临时入口：纯浏览器挂载 RuntimeConfigGate + AccountProvider，验证启动中间页
// （配合 /@mock/nxcore.js；?delay=ms 控制账号态延迟，?authed=1 模拟登录有效）。
import { createRoot } from 'react-dom/client'

import { AccountProvider } from './state/AccountContext'
import { RuntimeConfigGate } from './components/onboarding/RuntimeConfigGate'
import { LocaleProvider } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const delayMs = Number(params.get('delay') ?? '4000')
const authed = params.get('authed') === '1'

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'account') {
      return new Proxy({ ...((target.account as object) ?? {}) }, {
        get(face, key) {
          if (key === 'status') {
            return async () => {
              await new Promise((resolve) => setTimeout(resolve, delayMs))
              return { authenticated: authed, apiBaseUrl: 'https://saas.example.com' }
            }
          }
          const value = (face as Record<string | symbol, unknown>)[key]
          return typeof value === 'undefined' ? async () => null : value
        },
      })
    }
    if (prop === 'runtimeConfig') {
      return {
        ...((target.runtimeConfig as object) ?? {}),
        get: async () => ({
          config: {},
          source: 'saas',
          selectedSource: 'saas',
          availableSources: ['saas'],
          configVersion: 1,
          updatedAt: new Date().toISOString(),
          primaryConfigured: true,
          webSearchCredential: { configured: false, source: 'none' },
        }),
      }
    }
    return target[prop as string]
  },
}) as unknown as typeof window.nxcore

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <AccountProvider>
      <RuntimeConfigGate>
        <div style={{ padding: 48, fontSize: 28, fontWeight: 700 }}>CONSOLE</div>
      </RuntimeConfigGate>
    </AccountProvider>
  </LocaleProvider>,
)
