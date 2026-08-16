import * as Sentry from '@sentry/electron/main'

import type { CloudAccountStatus } from '../../shared/sources'

const PRODUCTION_DSN = 'https://a5e0b3306fef49aa9103551d4b492868@logs.everroom.vyitec.com/2'

let configured = false
let enabledUntil = 0
let currentAccount: CloudAccountStatus | null = null

export function isRemoteDebugEligible(account: CloudAccountStatus, now = Date.now()): boolean {
  const subscription = account.subscription
  if (!account.authenticated || !account.user || !subscription) return false
  if (subscription.status !== 'active' || subscription.planCode.toLowerCase() === 'free') return false
  return Date.parse(subscription.periodEnd) > now
}

function isRemoteDebugActive(): boolean {
  return Date.now() < enabledUntil
}

export function configureSentry(version: string, packaged: boolean): void {
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
      beforeBreadcrumb: (breadcrumb) => isRemoteDebugActive() ? breadcrumb : null,
      beforeSend: (event) => isRemoteDebugActive() ? event : null,
      beforeSendLog: (log) => isRemoteDebugActive() ? log : null,
    })
    configured = true
    if (currentAccount) applyAccountScope(currentAccount)
  } catch (error) {
    process.stderr.write(`[desktop][sentry] ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

function applyAccountScope(account: CloudAccountStatus): void {
  if (!configured) return
  const eligible = isRemoteDebugEligible(account)
  Sentry.getCurrentScope().clearBreadcrumbs()
  Sentry.setUser(eligible ? { id: account.user!.id } : null)
  if (eligible) {
    Sentry.setTags({
      plan: account.subscription!.planCode,
      subscription_status: account.subscription!.status,
    })
  }
}

export function syncSentryAccount(account: CloudAccountStatus): void {
  currentAccount = account
  enabledUntil = isRemoteDebugEligible(account) ? Date.parse(account.subscription!.periodEnd) : 0
  applyAccountScope(account)
}

export function captureSentryLog(
  module: string,
  level: 'info' | 'warn' | 'error',
  event: Record<string, unknown>,
): void {
  if (!configured || !Sentry.isInitialized() || !isRemoteDebugActive()) return
  const message = typeof event.event === 'string' ? event.event : `${module}.${level}`
  Sentry.logger[level](message, { source: 'desktop', module, ...event })
}
