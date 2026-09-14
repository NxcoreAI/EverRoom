// 临时入口：纯浏览器单挂登录卡形态的 QrLoginPanel，验证扫码专注模式
// （其他登录方式收起/恢复）与各阶段动效；window.__qr.set(...) 脚本化驱动阶段。
import { useState } from 'react'
import { createRoot } from 'react-dom/client'

import { QrLoginPanel } from './components/account/QrLoginPanel'
import { LocaleProvider } from './i18n/LocaleContext'
import type { CloudAccountStatus, QrLoginStatusPayload } from '../../shared/sources'
import '@/styles/tokens.css'
import './styles.css'

const presentation = {
  qrLoginSessionId: 'sess-mock-1',
  qrScanToken: 'tok-mock',
  qrPayload: 'https://saas.example.com/qr-login?token=mock-token-for-preview',
  confirmationCode: '482913',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  status: 'pending_scan' as const,
}

const confirmedAccount = { userId: 'u-1', displayName: '王小明', identifierHint: 'wxm@example.com' }

const exchanged: CloudAccountStatus = {
  authenticated: true,
  apiBaseUrl: 'https://saas.example.com',
  user: { id: 'u-1', tenantId: 't-1', email: 'wxm@example.com', name: '王小明' },
  device: { id: 'd-1', name: 'MacBook Pro', platform: 'darwin' },
}

let stage: 'pending_scan' | 'scanned' | 'confirmed' | 'expired' = 'pending_scan'

const statusFor = (): QrLoginStatusPayload => {
  const expiresAt = presentation.expiresAt
  if (stage === 'scanned') return { status: 'scanned', expiresAt, confirmationCode: presentation.confirmationCode }
  if (stage === 'confirmed') return { status: 'confirmed', expiresAt, confirmationCode: presentation.confirmationCode, account: confirmedAccount }
  if (stage === 'expired') return { status: 'expired' }
  return { status: 'pending_scan', expiresAt }
}

const original = window.nxcore as unknown as Record<string, unknown>
window.nxcore = new Proxy(original, {
  get(target, prop) {
    if (prop === 'account') {
      return {
        ...((target.account as object) ?? {}),
        createQrLoginSession: async () => presentation,
        getQrLoginStatus: async () => statusFor(),
        exchangeQrLoginSession: async () => exchanged,
        cancelQrLoginSession: async () => {},
        replaceDeviceAdmission: async () => exchanged,
        dismissDeviceAdmission: async () => ({ dismissed: true }),
        onAdmissionRequired: () => () => {},
      }
    }
    return target[prop as string]
  },
}) as unknown as typeof window.nxcore

;(window as unknown as { __qr: { set: (next: typeof stage) => void } }).__qr = {
  set: (next) => { stage = next },
}

function LoginCard() {
  const [qrActive, setQrActive] = useState(false)
  return (
    <div className="mock-login-card">
      <h1>登录 EverRoom</h1>
      {!qrActive ? (
        <div className="qr-login-methods" key="methods">
          <div className="mock-social-row">
            <button type="button" className="mock-social apple"> Apple 登录</button>
            <button type="button" className="mock-social google"> Google 登录</button>
          </div>
          <p className="mock-note">在浏览器中安全完成登录</p>
        </div>
      ) : null}
      <QrLoginPanel
        account={null}
        onAccountChanged={() => undefined}
        onActiveChange={setQrActive}
      />
    </div>
  )
}

createRoot(document.getElementById('mock-root')!).render(
  <LocaleProvider>
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <LoginCard />
    </div>
  </LocaleProvider>,
)
