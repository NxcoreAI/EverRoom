import {
  Activity,
  Cable,
  Clock3,
  Globe2,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { showToast } from '@/state/toast'
import type {
  ExternalCallAudit,
  ExternalCallEnforcement,
  ExternalCallPage,
  ExternalCallPeriod,
  ExternalCallPolicy,
  ExternalCallService,
  ExternalCallUsage,
} from '../../../../shared/external-calls'

const SERVICES = ['WEB_SEARCH', 'MCP', 'CONNECTOR'] as const
const PERIODS = ['UTC_DAY', 'UTC_MONTH'] as const
const RANGE_MS = { '24h': 86_400_000, '7d': 604_800_000, '30d': 2_592_000_000 } as const
const EMPTY_AUDITS: ExternalCallPage<ExternalCallAudit> = { items: [], limit: 50, offset: 0, total: 0 }

interface PolicyDraft {
  enabled: boolean
  id?: string
  limit: string
  warning: string
  enforcement: ExternalCallEnforcement
}

const key = (service: ExternalCallService, period: ExternalCallPeriod) => `${service}:${period}`

function currentPeriodStart(period: ExternalCallPeriod): string {
  const now = new Date()
  return period === 'UTC_DAY'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}

function nextReset(period: ExternalCallPeriod): Date {
  const now = new Date()
  return period === 'UTC_DAY'
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

function serviceIcon(service: ExternalCallService) {
  if (service === 'WEB_SEARCH') return <Globe2 aria-hidden="true" />
  if (service === 'MCP') return <Cable aria-hidden="true" />
  return <Activity aria-hidden="true" />
}

export function ExternalCallBudgetSettingsSection() {
  const { locale, t } = useLocale()
  const [view, setView] = useState<'overview' | 'policies' | 'audits'>('overview')
  const [policies, setPolicies] = useState<ExternalCallPolicy[]>([])
  const [usage, setUsage] = useState<ExternalCallUsage[]>([])
  const [drafts, setDrafts] = useState<Record<string, PolicyDraft>>({})
  const [audits, setAudits] = useState(EMPTY_AUDITS)
  const [range, setRange] = useState<keyof typeof RANGE_MS>('7d')
  const [serviceFilter, setServiceFilter] = useState<ExternalCallService | 'ALL'>('ALL')
  const [offset, setOffset] = useState(0)
  const [budgetLoading, setBudgetLoading] = useState(true)
  const [auditLoading, setAuditLoading] = useState(true)
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const [auditError, setAuditError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const loadBudgets = useCallback(async () => {
    const api = window.nxcore?.externalCalls
    if (!api) return
    setBudgetLoading(true)
    try {
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString()
      const [policyPage, usagePage] = await Promise.all([
        api.listPolicies({ subjectScope: 'service', limit: 50 }),
        api.listUsage({ subjectScope: 'service', from: monthStart, limit: 200 }),
      ])
      const localPolicies = policyPage.items.filter((policy) => policy.subjectScope === 'service')
      setPolicies(localPolicies)
      setUsage(usagePage.items)
      setDrafts(Object.fromEntries(SERVICES.flatMap((service) => PERIODS.map((period) => {
        const policy = localPolicies.find((item) => item.service === service && item.period === period)
        return [key(service, period), policy ? {
          enabled: true,
          id: policy.id,
          limit: String(policy.limit),
          warning: policy.warningThreshold === policy.limit ? '' : String(policy.warningThreshold),
          enforcement: policy.enforcement,
        } : { enabled: false, limit: '', warning: '', enforcement: 'AUDIT_ONLY' as const }]
      }))))
      setBudgetError(null)
    } catch (error) {
      setBudgetError(error instanceof Error ? error.message : t('surface:settings.externalCallsLoadFailed'))
    } finally {
      setBudgetLoading(false)
    }
  }, [t])

  const loadAudits = useCallback(async () => {
    const api = window.nxcore?.externalCalls
    if (!api) return
    setAuditLoading(true)
    try {
      const page = await api.listAudits({
        from: new Date(Date.now() - RANGE_MS[range]).toISOString(),
        ...(serviceFilter === 'ALL' ? {} : { service: serviceFilter }),
        limit: 50,
        offset,
      })
      setAudits(page)
      setAuditError(null)
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : t('surface:settings.externalCallsLoadFailed'))
    } finally {
      setAuditLoading(false)
    }
  }, [offset, range, serviceFilter, t])

  useEffect(() => { void loadBudgets() }, [loadBudgets])
  useEffect(() => { void loadAudits() }, [loadAudits])

  const activeUsage = useMemo(() => policies.map((policy) => ({
    policy,
    usage: usage.find((item) => item.policyId === policy.id && item.periodStart === currentPeriodStart(policy.period)),
  })), [policies, usage])

  const updateDraft = (slot: string, patch: Partial<PolicyDraft>) => {
    setDrafts((current) => ({ ...current, [slot]: { ...current[slot]!, ...patch } }))
  }

  const savePolicy = async (service: ExternalCallService, period: ExternalCallPeriod) => {
    const api = window.nxcore?.externalCalls
    const slot = key(service, period)
    const draft = drafts[slot]
    if (!api || !draft) return
    const limit = Number(draft.limit)
    const warning = draft.warning.trim() ? Number(draft.warning) : limit
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(warning) || warning < 0 || warning > limit) {
      showToast({ title: t('surface:settings.externalCallsInvalidPolicy'), message: t('surface:settings.externalCallsInvalidPolicyHint') })
      return
    }
    setBusyKey(slot)
    try {
      await api.savePolicy({
        ...(draft.id ? { id: draft.id } : {}),
        subjectScope: 'service',
        subjectId: service,
        service,
        period,
        limit,
        warningThreshold: warning,
        enforcement: draft.enforcement,
      })
      showToast({ title: t('surface:settings.externalCallsPolicySaved'), message: t('surface:settings.externalCallsPolicySavedHint') })
      await loadBudgets()
    } catch (error) {
      showToast({ title: t('surface:settings.externalCallsSaveFailed'), message: error instanceof Error ? error.message : t('surface:settings.externalCallsSaveFailed') })
    } finally {
      setBusyKey(null)
    }
  }

  const disablePolicy = async (service: ExternalCallService, period: ExternalCallPeriod) => {
    const api = window.nxcore?.externalCalls
    const slot = key(service, period)
    const draft = drafts[slot]
    if (!api || !draft) return
    if (!draft.id) {
      updateDraft(slot, { enabled: false, limit: '', warning: '' })
      return
    }
    if (!window.confirm(t('surface:settings.externalCallsDisableConfirm'))) return
    setBusyKey(slot)
    try {
      await api.deletePolicy(draft.id)
      showToast({ title: t('surface:settings.externalCallsPolicyDisabled'), message: t('surface:settings.externalCallsAuditRetained') })
      await loadBudgets()
    } catch (error) {
      showToast({ title: t('surface:settings.externalCallsSaveFailed'), message: error instanceof Error ? error.message : t('surface:settings.externalCallsSaveFailed') })
    } finally {
      setBusyKey(null)
    }
  }

  const serviceLabel = (service: ExternalCallService) => t(`surface:settings.externalCallsService${service === 'WEB_SEARCH' ? 'Search' : service === 'MCP' ? 'Mcp' : 'Connector'}`)
  const outcomeLabel = (outcome: ExternalCallAudit['outcome']) => t(`surface:settings.externalCallsOutcome${outcome[0]}${outcome.slice(1).toLowerCase()}`)
  const formatTime = (value: string) => new Date(value).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })

  return <section className="reality-settings-section external-calls-settings" aria-labelledby="external-calls-settings-title">
    <header>
      <span><ShieldAlert aria-hidden="true" /></span>
      <div><h2 id="external-calls-settings-title">{t('surface:settings.externalCalls')}</h2><p>{t('surface:settings.externalCallsDescription')}</p></div>
      <button className="cloud-account-refresh external-calls-refresh" type="button" title={t('surface:settings.refreshUsage')} aria-label={t('surface:settings.refreshUsage')} onClick={() => void Promise.all([loadBudgets(), loadAudits()])} disabled={budgetLoading || auditLoading}><RefreshCw aria-hidden="true" /></button>
    </header>

    <div className="external-calls-toolbar">
      <div className="segmented-control" aria-label={t('surface:settings.externalCalls')}>
        {(['overview', 'policies', 'audits'] as const).map((item) => <button key={item} type="button" data-active={String(view === item)} onClick={() => setView(item)}>{t(`surface:settings.externalCallsTab${item[0]!.toUpperCase()}${item.slice(1)}`)}</button>)}
      </div>
      {(view === 'overview' || view === 'audits') ? <div className="external-calls-filters">
        <select aria-label={t('surface:settings.externalCallsRange')} value={range} onChange={(event) => { setRange(event.target.value as keyof typeof RANGE_MS); setOffset(0) }}>
          <option value="24h">{t('surface:settings.last24Hours')}</option><option value="7d">{t('surface:settings.last7Days')}</option><option value="30d">{t('surface:settings.last30Days')}</option>
        </select>
        <select aria-label={t('surface:settings.externalCallsService')} value={serviceFilter} onChange={(event) => { setServiceFilter(event.target.value as ExternalCallService | 'ALL'); setOffset(0) }}>
          <option value="ALL">{t('surface:settings.externalCallsAllServices')}</option>{SERVICES.map((service) => <option key={service} value={service}>{serviceLabel(service)}</option>)}
        </select>
      </div> : null}
    </div>

    {budgetError || auditError ? <div className="external-calls-error" role="alert">{budgetError ?? auditError}</div> : null}

    {view === 'overview' ? <div className="external-calls-overview" aria-busy={budgetLoading || auditLoading}>
      <div className="external-calls-metrics">
        <div><span>{t('surface:settings.externalCallsRangeTotal')}</span><strong>{audits.total.toLocaleString(locale)}</strong></div>
        <div><span>{t('surface:settings.externalCallsActivePolicies')}</span><strong>{policies.length.toLocaleString(locale)}</strong></div>
        <div><span>{t('surface:settings.externalCallsProtectedServices')}</span><strong>{new Set(policies.map((policy) => policy.service)).size.toLocaleString(locale)}</strong></div>
      </div>
      <div className="external-calls-subsection">
        <div className="external-calls-subheading"><div><strong>{t('surface:settings.externalCallsCurrentUsage')}</strong><small>{t('surface:settings.externalCallsCurrentUsageHint')}</small></div></div>
        {budgetLoading ? <div className="external-calls-empty">{t('surface:settings.loading')}</div> : activeUsage.length === 0 ? <div className="external-calls-empty"><ShieldAlert aria-hidden="true" /><span><strong>{t('surface:settings.externalCallsNoPolicies')}</strong><small>{t('surface:settings.externalCallsNoPoliciesHint')}</small></span></div> : <div className="external-calls-progress-list">{activeUsage.map(({ policy, usage: item }) => {
          const used = (item?.consumedCalls ?? 0) + (item?.reservedCalls ?? 0)
          const percent = policy.limit === 0 ? 100 : Math.min(100, (used / policy.limit) * 100)
          return <div className="external-calls-progress-row" key={policy.id} data-state={item?.atLimit ? 'limit' : item?.nearLimit ? 'warning' : 'normal'}>
            <span className="external-calls-service-icon">{serviceIcon(policy.service)}</span>
            <div><div><strong>{serviceLabel(policy.service)}</strong><small>{t(policy.period === 'UTC_DAY' ? 'surface:settings.externalCallsDaily' : 'surface:settings.externalCallsMonthly')}</small><b>{t('surface:settings.externalCallsUsedOfLimit', { used, limit: policy.limit })}</b></div><span className="external-calls-progress"><i style={{ width: `${percent}%` }} /></span></div>
          </div>
        })}</div>}
      </div>
      <AuditList items={audits.items.slice(0, 5)} loading={auditLoading} serviceLabel={serviceLabel} outcomeLabel={outcomeLabel} formatTime={formatTime} empty={t('surface:settings.externalCallsNoRecords')} />
    </div> : null}

    {view === 'policies' ? <div className="external-calls-policies" aria-busy={budgetLoading}>
      <div className="external-calls-policy-note"><ShieldAlert aria-hidden="true" /><span><strong>{t('surface:settings.externalCallsDefaultOff')}</strong><small>{t('surface:settings.externalCallsDefaultOffHint')}</small></span></div>
      {SERVICES.map((service) => <div className="external-calls-service-band" key={service}>
        <div className="external-calls-service-heading"><span className="external-calls-service-icon">{serviceIcon(service)}</span><div><strong>{serviceLabel(service)}</strong><small>{t(`surface:settings.externalCallsService${service === 'WEB_SEARCH' ? 'Search' : service === 'MCP' ? 'Mcp' : 'Connector'}Hint`)}</small></div></div>
        {PERIODS.map((period) => {
          const slot = key(service, period)
          const draft = drafts[slot] ?? { enabled: false, limit: '', warning: '', enforcement: 'AUDIT_ONLY' as const }
          return <div className="external-calls-policy-row" key={period} data-enabled={String(draft.enabled)}>
            <div className="external-calls-period"><Clock3 aria-hidden="true" /><span><strong>{t(period === 'UTC_DAY' ? 'surface:settings.externalCallsDaily' : 'surface:settings.externalCallsMonthly')}</strong><small>{t('surface:settings.externalCallsResetsAt', { time: nextReset(period).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) })}</small></span></div>
            {!draft.enabled ? <button className="secondary-button" type="button" onClick={() => updateDraft(slot, { enabled: true })}>{t('surface:settings.externalCallsEnablePolicy')}</button> : <>
              <label><span>{t('surface:settings.externalCallsLimit')}</span><input type="number" min="1" step="1" value={draft.limit} onChange={(event) => updateDraft(slot, { limit: event.target.value })} /></label>
              <label><span>{t('surface:settings.externalCallsWarning')}</span><input type="number" min="0" step="1" placeholder={draft.limit || '--'} value={draft.warning} onChange={(event) => updateDraft(slot, { warning: event.target.value })} /></label>
              <div className="segmented-control external-calls-mode" aria-label={t('surface:settings.externalCallsMode')}>{(['AUDIT_ONLY', 'BLOCK'] as const).map((mode) => <button key={mode} type="button" data-active={String(draft.enforcement === mode)} onClick={() => updateDraft(slot, { enforcement: mode })}>{t(mode === 'AUDIT_ONLY' ? 'surface:settings.externalCallsAuditOnly' : 'surface:settings.externalCallsBlock')}</button>)}</div>
              <div className="external-calls-policy-actions"><button className="primary-button" type="button" title={t('surface:settings.save')} aria-label={t('surface:settings.save')} disabled={busyKey === slot} onClick={() => void savePolicy(service, period)}><Save aria-hidden="true" /></button><button className="secondary-button external-calls-delete" type="button" title={t('surface:settings.externalCallsDisablePolicy')} aria-label={t('surface:settings.externalCallsDisablePolicy')} disabled={busyKey === slot} onClick={() => void disablePolicy(service, period)}><Trash2 aria-hidden="true" /></button></div>
            </>}
          </div>
        })}
      </div>)}
    </div> : null}

    {view === 'audits' ? <div className="external-calls-audits" aria-busy={auditLoading}>
      <AuditList items={audits.items} loading={auditLoading} serviceLabel={serviceLabel} outcomeLabel={outcomeLabel} formatTime={formatTime} empty={t('surface:settings.externalCallsNoRecords')} />
      <div className="external-calls-pagination"><span>{t('surface:settings.externalCallsPageStatus', { start: audits.total ? audits.offset + 1 : 0, end: Math.min(audits.offset + audits.items.length, audits.total), total: audits.total })}</span><div><button className="secondary-button" type="button" disabled={audits.offset === 0 || auditLoading} onClick={() => setOffset(Math.max(0, offset - 50))}>{t('surface:settings.previous')}</button><button className="secondary-button" type="button" disabled={audits.offset + audits.items.length >= audits.total || auditLoading} onClick={() => setOffset(offset + 50)}>{t('surface:settings.next')}</button></div></div>
    </div> : null}
  </section>
}

function AuditList({ items, loading, serviceLabel, outcomeLabel, formatTime, empty }: {
  items: ExternalCallAudit[]
  loading: boolean
  serviceLabel: (service: ExternalCallService) => string
  outcomeLabel: (outcome: ExternalCallAudit['outcome']) => string
  formatTime: (value: string) => string
  empty: string
}) {
  const { t } = useLocale()
  if (loading) return <div className="external-calls-empty">{t('surface:settings.loading')}</div>
  if (!items.length) return <div className="external-calls-empty">{empty}</div>
  return <div className="external-calls-table-wrap"><table className="external-calls-table"><thead><tr><th>{t('surface:settings.externalCallsService')}</th><th>{t('surface:settings.externalCallsTool')}</th><th>{t('surface:settings.externalCallsResult')}</th><th>{t('surface:settings.externalCallsDuration')}</th><th>{t('surface:settings.externalCallsTime')}</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{serviceLabel(item.service)}</td><td><code>{item.tool}</code></td><td><span className="external-calls-outcome" data-outcome={item.outcome}>{outcomeLabel(item.outcome)}</span></td><td>{item.durationMs.toLocaleString()} ms</td><td>{formatTime(item.occurredAt)}</td></tr>)}</tbody></table></div>
}
