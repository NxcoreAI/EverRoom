import { createRequire } from 'node:module'

import type * as SentryApi from '@sentry/electron/main'

import type { CloudAccountStatus } from '../../shared/sources'
import { redactDesktopSecrets } from '../security/secret-redaction'

const require = createRequire(import.meta.url)
const Sentry = process.versions.electron
  ? require('@sentry/electron/main') as typeof SentryApi
  : null

const PRODUCTION_DSN = 'https://a5e0b3306fef49aa9103551d4b492868@logs.everroom.vyitec.com/2'

let configured = false
let enabledUntil = 0
let currentAccount: CloudAccountStatus | null = null

const LOCAL_ONLY_LOG_MODULES = new Set(['document-cursor-completion'])
export const redactSentryPayload = redactDesktopSecrets

export function isSentryLogModuleAllowed(module: string): boolean {
  return !LOCAL_ONLY_LOG_MODULES.has(module)
}

export function isRemoteDebugEligible(account: CloudAccountStatus, now = Date.now()): boolean {
  const subscription = account.subscription
  if (!account.authenticated || !account.user || !subscription) return false
  if (subscription.status !== 'active' || subscription.planCode.toLowerCase() === 'free') return false
  return Date.parse(subscription.periodEnd) > now
}

function isRemoteDebugActive(): boolean {
  return Date.now() < enabledUntil
}

export function isSentryRemoteDebugEnabled(): boolean {
  return isRemoteDebugActive()
}

export function configureSentry(version: string, packaged: boolean): void {
  if (!Sentry) return
  const dsn = process.env.NXCORE_SENTRY_DSN?.trim() || (packaged ? PRODUCTION_DSN : '')
  if (!dsn) return

  try {
    Sentry.init({
      dsn,
      release: `everroom@${version}`,
      environment: packaged ? 'production' : 'development',
      enableLogs: true,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      integrations: (defaults) => defaults.filter(
        ({ name }) => name !== 'MainProcessSession' && name !== 'SentryMinidump',
      ),
      beforeBreadcrumb: (breadcrumb) => isRemoteDebugActive() ? redactSentryPayload(breadcrumb) : null,
      beforeSend: (event) => isRemoteDebugActive() ? redactSentryPayload(event) : null,
      beforeSendLog: (log) => isRemoteDebugActive() ? redactSentryPayload(log) : null,
    })
    configured = true
    if (currentAccount) applyAccountScope(currentAccount)
  } catch (error) {
    process.stderr.write(`[desktop][sentry] ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function applyAccountScope(account: CloudAccountStatus): void {
  if (!configured || !Sentry) return
  const eligible = isRemoteDebugEligible(account)
  Sentry.getCurrentScope().clearBreadcrumbs()
  if (eligible) {
    const email = account.user!.email
    Sentry.setUser(email ? { id: account.user!.id, email } : { id: account.user!.id })
    Sentry.setTags({
      plan: account.subscription!.planCode,
      subscription_status: account.subscription!.status,
    })
  } else {
    Sentry.setUser(null)
  }
}

export function syncSentryAccount(account: CloudAccountStatus): void {
  currentAccount = account
  if (isRemoteDebugEligible(account)) {
    enabledUntil = Date.parse(account.subscription!.periodEnd)
  } else if (account.authenticated && !account.subscription) {
    // 订阅拉取失败（瞬时网络/服务端故障）时保留上次判定，避免整个会话静默；
    // 明确 free/未激活/登出才关闸。
  } else {
    enabledUntil = 0
  }
  applyAccountScope(account)
}

export function captureSentryLog(
  module: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  event: Record<string, unknown>,
): void {
  if (!isSentryLogModuleAllowed(module)) return
  if (!configured || !Sentry || !Sentry.isInitialized() || !isRemoteDebugActive()) return
  const message = typeof event.event === 'string' ? event.event : `${module}.${level}`
  // debug 本地已默认丢弃，远端同样不上报，避免轮询类日志刷屏。
  if (level === 'debug') return
  Sentry.logger[level](message, redactDesktopSecrets({ source: 'desktop', module, ...event }))
}
