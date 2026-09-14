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

/** ElectronNet 自动埋点把每个 Electron 网络请求记成 info 日志（轮询请求 5s 一条，
 *  线上 48 小时刷 5 万条）。集成层过滤在部分构建上未生效（原因未定位），这里按
 *  origin 在出口处兜底丢弃，不依赖 SDK 集成生命周期。我们自己的 axios 日志
 *  （module=axios，带 url/method/status）覆盖同一信息，无损失。 */
export function isSdkAutoNetLog(log: { attributes?: Record<string, unknown> }): boolean {
  const origin = log.attributes?.['sentry.origin']
  return typeof origin === 'string' && origin.startsWith('auto.electron.net')
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
        // ElectronNet：enableLogs 下它把每个 Electron 网络请求记成 info 日志，
        // 轮询类请求曾 48 小时刷 5 万条垃圾（origin=auto.electron.net）。
        // Console：desktop-logger 已带阈值/脱敏/模块标签捕获，SDK 自带版本无
        // 阈值，会造成重复与刷屏。
        ({ name }) => name !== 'MainProcessSession' && name !== 'SentryMinidump'
          && name !== 'ElectronNet' && name !== 'Console',
      ),
      beforeBreadcrumb: (breadcrumb) => isRemoteDebugActive() ? redactSentryPayload(breadcrumb) : null,
      beforeSend: (event) => isRemoteDebugActive() ? redactSentryPayload(event) : null,
      beforeSendLog: (log) => {
        if (!isRemoteDebugActive() || isSdkAutoNetLog(log)) return null
        return redactSentryPayload(log)
      },
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
