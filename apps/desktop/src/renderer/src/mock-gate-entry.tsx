// 临时入口：纯浏览器挂载 RuntimeConfigGate + AccountProvider，验证启动中间页
// （配合 /@mock/nxcore.js；?delay=ms 控制账号态延迟，?authed=1 模拟登录有效，
// ?ready=0 模拟 gateway 重启后槽位未重灌——primaryConfigured=false 的竞态，
// ?blocked=1 模拟凭据在但网络验证失败（authenticated:false + authBlocked），
// ?admission=1 模拟启动期设备额度挑战（authenticated:false + admission））。
import { createRoot } from 'react-dom/client'

import { AccountProvider } from './state/AccountContext'
import { RuntimeConfigGate } from './components/onboarding/RuntimeConfigGate'
import { LocaleProvider } from './i18n/LocaleContext'
import '@/styles/tokens.css'
import './styles.css'

const params = new URLSearchParams(window.location.search)
const delayMs = Number(params.get('delay') ?? '4000')
const authed = params.get('authed') === '1'
const ready = params.has('ready') ? params.get('ready') === '1' : authed
const blocked = params.get('blocked') === '1'

const state = {
  authed,
  admission: params.get('admission') === '1' ? {
    reason: 'device_limit',
    maxDevices: 3,
    admissionToken: 'mock-admission-token',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    devices: [
      { id: 'd1', name: 'MacBook Pro', platform: 'darwin', appVersion: '0.5.0', status: 'online', lastSeenAt: new Date().toISOString() },
      { id: 'd2', name: 'iPhone 17', platform: 'ios', appVersion: '1.2.0', status: 'online', lastSeenAt: new Date().toISOString() },
    ],
  } : null,
}

const accountStatus = () => ({
  authenticated: state.authed,
  apiBaseUrl: 'https://saas.example.com',
  ...(state.authed ? {} : blocked ? { authBlocked: 'network' } : {}),
  ...(state.authed || !state.admission ? {} : { admission: state.admission }),
})

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'account') {
      return new Proxy({ ...((target.account as object) ?? {}) }, {
        get(face, key) {
          if (key === 'status') {
            return async () => {
              await new Promise((resolve) => setTimeout(resolve, delayMs))
              return accountStatus()
            }
          }
          if (key === 'replaceDeviceAdmission') {
            return async () => {
              state.authed = true
              state.admission = null
              return accountStatus()
            }
          }
          if (key === 'dismissDeviceAdmission') {
            return async () => {
              state.admission = null
              return { dismissed: true }
            }
          }
          if (key === 'onAdmissionRequired') return () => () => {}
          const value = (face as Record<string | symbol, unknown>)[key]
          return typeof value === 'undefined' ? async () => null : value
        },
      })
    }
    if (prop === 'runtimeConfig') {
      return {
        ...((target.runtimeConfig as object) ?? {}),
        // primaryConfigured 随登录态联动：默认源要靠中转重写槽位才算配置就绪。
        get: async () => ({
          config: {},
          source: 'default',
          selectedSource: 'default',
          availableSources: ['default'],
          configVersion: 1,
          updatedAt: new Date().toISOString(),
          primaryConfigured: ready || state.authed,
          webSearchCredential: { configured: false, source: 'none' },
        }),
        relayReady: async () => null,
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
