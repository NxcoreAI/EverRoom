import { ChevronDown, Server } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { navigationSectionsForMode, type PageId } from '@/data/navigation'
import { useAccount } from '@/state/AccountContext'
import type { GatewayState, GatewayStatus } from '../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import { MemoryPipelineStatus } from './MemoryPipelineStatus'

const INITIAL_GATEWAY_STATUS: GatewayStatus = {
  state: 'starting',
  pid: null,
  baseUrl: null,
  version: null,
  message: null,
}

function gatewayStatusLabel(status: GatewayStatus, t: (message: string, values?: Record<string, string | number>) => string): string {
  switch (status.state) {
    case 'ready':
      return status.pid ? t('surface:sidebar.runningPidPid', { pid: status.pid }) : t('surface:sidebar.running')
    case 'starting':
      return t('surface:sidebar.starting')
    case 'error':
      return t('surface:sidebar.connectionError')
    case 'stopped':
      return t('surface:sidebar.notRunning')
  }
}

export function Sidebar({
  activePage,
  onNavigate,
}: {
  activePage: PageId
  onNavigate: (page: PageId) => void
}) {
  const { t, formatNumber } = useLocale()
  const pageMode = window.nxcore?.pageMode ?? 'sources'
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => new Set())
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>(INITIAL_GATEWAY_STATUS)
  const [runtimeConfigStatus, setRuntimeConfigStatus] = useState<'checking' | 'testing' | null>(null)
  const gatewayStateRef = useRef<GatewayState>(INITIAL_GATEWAY_STATUS.state)
  const { account } = useAccount()

  useEffect(() => {
    let disposed = false

    const applyStatus = (status: GatewayStatus) => {
      gatewayStateRef.current = status.state
      setGatewayStatus(status)
    }

    const refreshGatewayStatus = async () => {
      if (!window.nxcore) {
        if (!disposed) {
          applyStatus({
            state: 'stopped',
            pid: null,
            baseUrl: null,
            version: null,
            message: t('surface:sidebar.gatewayIsOnlyAvailableInTheEverroomDesktop'),
          })
        }
        return
      }
      try {
        const status = await window.nxcore.gateway.status()
        if (!disposed) applyStatus(status)
      } catch (error) {
        if (!disposed) {
          applyStatus({
            state: 'error',
            pid: null,
            baseUrl: null,
            version: null,
            message: error instanceof Error ? error.message : t('surface:sidebar.unableToReadGatewayStatus'),
          })
        }
      }
    }

    void refreshGatewayStatus()
    // 启动中更密集地轮询(1s),让转圈尽快切换到就绪状态;就绪后降频(3s)。
    let timeout = 0
    const scheduleNext = () => {
      timeout = window.setTimeout(
        () => {
          void refreshGatewayStatus().finally(scheduleNext)
        },
        gatewayStateRef.current === 'ready' ? 3_000 : 1_000,
      )
    }
    scheduleNext()
    return () => {
      disposed = true
      window.clearTimeout(timeout)
    }
  }, [t])

  useEffect(() => {
    const onRuntimeConfigStatus = (event: Event) => {
      const status = (event as CustomEvent<string>).detail
      setRuntimeConfigStatus(status === 'checking' || status === 'testing' ? status : null)
    }
    window.addEventListener('everroom-runtime-config-status', onRuntimeConfigStatus)
    return () => window.removeEventListener('everroom-runtime-config-status', onRuntimeConfigStatus)
  }, [])

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(sectionId)) next.delete(sectionId)
      else next.add(sectionId)
      return next
    })
  }

  const accountName = account?.authenticated
    ? account.user?.email || account.user?.name || account.user?.phone || t('surface:sidebar.everroomUser')
    : account === null ? t('surface:sidebar.checking') : t('surface:sidebar.localUser')
  const accountDescription = account?.authenticated
    ? account.subscription?.planName ? t('surface:sidebar.planPlan', { plan: account.subscription.planName }) : t('surface:sidebar.everroomSaasConnected')
    : account === null ? t('surface:sidebar.accountStatus') : t('surface:sidebar.localMode')
  const subscription = account?.authenticated ? account.subscription : undefined
  const remainingQuotaMinutes = subscription ? formatNumber(Math.ceil(Math.max(0, subscription.remainingSeconds) / 60)) : null

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav" aria-label={t('surface:sidebar.mainNavigation')}>
        {navigationSectionsForMode(pageMode, window.nxcore?.office.testAvailable === true).map((section) => (
          <section
            key={section.id}
            className="nav-section"
            data-collapsed={String(collapsedSections.has(section.id))}
          >
            <button
              type="button"
              className="nav-section-title"
              aria-expanded={!collapsedSections.has(section.id)}
              onClick={() => toggleSection(section.id)}
            >
              <ChevronDown aria-hidden="true" />
              <span>{t(section.label)}</span>
            </button>
            <div className="nav-items" hidden={collapsedSections.has(section.id)}>
              {section.items.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    className="nav-item"
                    data-active={String(item.id === activePage)}
                    data-nav-tone={item.tone}
                    aria-current={item.id === activePage ? 'page' : undefined}
                    onClick={() => onNavigate(item.id)}
                  >
                    <span className="nav-item-icon" aria-hidden="true">
                      <Icon strokeWidth={1.8} />
                    </span>
                    <span className="nav-item-label">{t(item.label)}</span>
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </nav>

      <MemoryPipelineStatus onNavigate={onNavigate} />
      {/* Gateway 正常运行时保持安静，只在启动/异常/停止时提示。 */}
      {gatewayStatus.state !== 'ready' || runtimeConfigStatus ? (
      <div
        className="gateway-status"
        data-state={gatewayStatus.state}
        role="status"
        aria-live="polite"
        title={gatewayStatus.message ?? gatewayStatus.baseUrl ?? 'Everroom Gateway'}
      >
        <Server aria-hidden="true" />
        <span>
          <strong>Gateway</strong>
          <small>{runtimeConfigStatus === 'checking'
            ? t('surface:sidebar.runtimeConfigChecking')
            : runtimeConfigStatus === 'testing'
              ? t('surface:sidebar.runtimeConfigTesting')
              : gatewayStatusLabel(gatewayStatus, t)}</small>
        </span>
        <i className="gateway-status-dot" aria-hidden="true" />
      </div>
      ) : null}
      <button type="button" className="account-row" onClick={() => onNavigate('settings')}>
        <span className="account-avatar" aria-hidden="true">{accountName.slice(0, 1).toUpperCase()}</span>
        <span className="account-copy">
          <strong>{accountName}</strong>
          <small>{accountDescription}</small>
          {subscription ? (
            <span className="account-quota">
              <span>{t('surface:sidebar.minutesMinutesRemaining', { minutes: remainingQuotaMinutes! })}</span>
              <progress
                aria-label={t('surface:sidebar.minutesTranscriptionMinutesRemaining', { minutes: remainingQuotaMinutes! })}
                max={Math.max(1, subscription.quotaSeconds)}
                value={Math.min(Math.max(0, subscription.remainingSeconds), subscription.quotaSeconds)}
              />
            </span>
          ) : null}
        </span>
      </button>
    </aside>
  )
}
