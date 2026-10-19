import { useCallback, useEffect, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'
import { ScreenRecordingPermissionCard } from '@/components/settings/ScreenRecordingPermissionCard'
import type { ScreenMemorySettingsDto, ScreenMemoryStatusDto, ScreenMemoryStorageDto } from '../../../../shared/sources'

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function ScreenMemorySettingsSection() {
  const { t } = useLocale()
  const [settings, setSettings] = useState<ScreenMemorySettingsDto | null>(null)
  const [status, setStatus] = useState<ScreenMemoryStatusDto | null>(null)
  const [storage, setStorage] = useState<ScreenMemoryStorageDto | null>(null)
  const [busy, setBusy] = useState(false)
  const [manualBundleId, setManualBundleId] = useState('')
  const [backfillFrom, setBackfillFrom] = useState('')
  const [backfillTo, setBackfillTo] = useState('')
  const [backfillEstimateCount, setBackfillEstimateCount] = useState<number | null>(null)
  const [backfillSummary, setBackfillSummary] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!window.nxcore) return
    const [nextSettings, nextStatus, nextStorage] = await Promise.all([
      window.nxcore.screenMemory.settings().catch(() => null),
      window.nxcore.screenMemory.status().catch(() => null),
      window.nxcore.screenMemory.storage().catch(() => null),
    ])
    if (nextSettings) setSettings(nextSettings)
    if (nextStatus) setStatus(nextStatus)
    if (nextStorage) setStorage(nextStorage)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const patch = useCallback(async (input: Partial<ScreenMemorySettingsDto>) => {
    if (!window.nxcore) return
    setBusy(true)
    try {
      const next = await window.nxcore.screenMemory.updateSettings(input)
      setSettings(next)
      await reload()
    } finally {
      setBusy(false)
    }
  }, [reload])

  const addAllowedApp = useCallback(async (bundleId: string) => {
    const trimmed = bundleId.trim()
    if (!trimmed || !settings || settings.allowedApps.includes(trimmed)) return
    await patch({ allowedApps: [...settings.allowedApps, trimmed] })
    setManualBundleId('')
  }, [settings, patch])

  const addCurrentApp = useCallback(async () => {
    if (!window.nxcore) return
    const frontmost = await window.nxcore.screenMemory.frontmost().catch(() => null)
    if (frontmost?.bundleId) await addAllowedApp(frontmost.bundleId)
  }, [addAllowedApp])

  const estimateBackfill = useCallback(async () => {
    if (!window.nxcore || !backfillFrom || !backfillTo) return
    const result = await window.nxcore.screenMemory.backfillEstimate({ from: backfillFrom, to: backfillTo }).catch(() => null)
    setBackfillEstimateCount(result?.count ?? 0)
  }, [backfillFrom, backfillTo])

  const runBackfill = useCallback(async () => {
    if (!window.nxcore || !backfillFrom || !backfillTo) return
    setBusy(true)
    setBackfillSummary(null)
    try {
      const summary = await window.nxcore.screenMemory.backfillRun({
        from: backfillFrom,
        to: backfillTo,
        maxItems: Math.min(500, backfillEstimateCount ?? 50),
      })
      setBackfillSummary(t('surface:screenMemory.backfillDone', {
        processed: summary.processed,
        intervals: summary.intervals,
        keyframes: summary.keyframes,
      }))
      await reload()
    } finally {
      setBusy(false)
    }
  }, [backfillFrom, backfillTo, backfillEstimateCount, t, reload])

  return (
    <section id="settings-screen-memory" className="reality-settings-section settings-anchor-section" aria-labelledby="screen-memory-settings-title">
      <header>
        <div>
          <h2 id="screen-memory-settings-title">{t('surface:screenMemory.title')}</h2>
        </div>
      </header>
      <div className="reality-setting-row">
        <div><strong>{t('surface:screenMemory.enable')}</strong></div>
        <button
          className="settings-toggle"
          type="button"
          role="switch"
          aria-checked={Boolean(settings?.enabled)}
          disabled={busy || settings === null}
          data-active={String(Boolean(settings?.enabled))}
          onClick={() => void patch({ enabled: !settings?.enabled })}
        >
          <span aria-hidden="true" />
          {t(settings?.enabled ? 'surface:settings.on' : 'surface:settings.off')}
        </button>
      </div>
      <div className="reality-setting-row">
        <div><strong>{t('surface:screenMemory.paused')}</strong></div>
        <button
          className="settings-toggle"
          type="button"
          role="switch"
          aria-checked={Boolean(settings?.paused)}
          disabled={busy || settings === null || !settings.enabled}
          data-active={String(Boolean(settings?.paused))}
          onClick={() => void patch({ paused: !settings?.paused })}
        >
          <span aria-hidden="true" />
          {t(settings?.paused ? 'surface:settings.on' : 'surface:settings.off')}
        </button>
      </div>
      <ScreenRecordingPermissionCard permission={status?.permission} />
      {status?.running ? (
        <div className="reality-setting-row">
          <div>
            <strong>{t('surface:screenMemory.currentApp')}</strong>
            <span className="settings-value-text">{status.currentAppName ?? '—'}</span>
          </div>
        </div>
      ) : null}
      <div className="reality-setting-row">
        <div><strong>{t('surface:screenMemory.scope')}</strong></div>
        <div className="screen-memory-scope-switch">
          {([['all', 'surface:screenMemory.scopeAll'], ['allowlist', 'surface:screenMemory.scopeAllowlist']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={busy || settings === null}
              data-active={String(settings?.scopeMode === value)}
              onClick={() => void patch({ scopeMode: value })}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {settings?.scopeMode === 'allowlist' ? (
      <div className="reality-setting-row">
        <div>
          <strong>{t('surface:screenMemory.allowedApps')}</strong>
          <ul className="screen-memory-app-list">
            {settings?.allowedApps.map((bundleId) => (
              <li key={bundleId}>
                <span>{bundleId}</span>
                <button type="button" disabled={busy} onClick={() => void patch({ allowedApps: settings.allowedApps.filter((item) => item !== bundleId) })}>
                  {t('surface:screenMemory.remove')}
                </button>
              </li>
            ))}
          </ul>
          <div className="screen-memory-app-add">
            <input
              value={manualBundleId}
              placeholder="com.apple.Safari"
              onChange={(event) => setManualBundleId(event.target.value)}
            />
            <button type="button" disabled={busy} onClick={() => void addAllowedApp(manualBundleId)}>
              {t('surface:screenMemory.add')}
            </button>
            <button type="button" disabled={busy} onClick={() => void addCurrentApp()}>
              {t('surface:screenMemory.addCurrent')}
            </button>
          </div>
        </div>
      </div>
      ) : null}
      <div className="reality-setting-row">
        <div>
          <strong>{t('surface:screenMemory.excludedApps')}</strong>
          <ul className="screen-memory-app-list">
            {settings?.excludedApps.map((bundleId) => (
              <li key={bundleId}>
                <span>{bundleId}</span>
                <button type="button" disabled={busy} onClick={() => void patch({ excludedApps: settings.excludedApps.filter((item) => item !== bundleId) })}>
                  {t('surface:screenMemory.remove')}
                </button>
              </li>
            ))}
          </ul>
          <div className="screen-memory-app-add">
            <input
              value={settings?.excludedApps.includes(manualBundleId) ? '' : manualBundleId}
              placeholder="com.bank.app"
              onChange={(event) => setManualBundleId(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || manualBundleId.trim().length === 0}
              onClick={() => {
                if (!settings) return
                void patch({ excludedApps: [...new Set([...settings.excludedApps, manualBundleId.trim()])] })
                setManualBundleId('')
              }}
            >
              {t('surface:screenMemory.add')}
            </button>
          </div>
        </div>
      </div>
      <div className="reality-setting-row">
        <div>
          <strong>{t('surface:screenMemory.backfill')}</strong>
          <div className="screen-memory-app-add">
            <input type="date" value={backfillFrom} onChange={(event) => setBackfillFrom(event.target.value)} />
            <input type="date" value={backfillTo} onChange={(event) => setBackfillTo(event.target.value)} />
            <button type="button" disabled={busy || !backfillFrom || !backfillTo} onClick={() => void estimateBackfill()}>
              {t('surface:screenMemory.backfillEstimate')}
            </button>
            <button type="button" disabled={busy || !backfillFrom || !backfillTo || backfillEstimateCount === 0} onClick={() => void runBackfill()}>
              {t('surface:screenMemory.backfillRun')}
            </button>
          </div>
          {backfillEstimateCount !== null ? (
            <span className="settings-value-text">{t('surface:screenMemory.backfillCount', { count: backfillEstimateCount })}</span>
          ) : null}
          {backfillSummary ? <span className="settings-value-text">{backfillSummary}</span> : null}
        </div>
      </div>
      <div className="reality-setting-row">
        <div>
          <strong>{t('surface:screenMemory.storage')}</strong>
          <span className="settings-value-text">
            {storage ? formatBytes(storage.imagesBytes) : '—'}
          </span>
        </div>
      </div>
    </section>
  )
}
