import { Bot, Download, History, LoaderCircle, RefreshCw, TerminalSquare } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { LocalAgentInstallation } from '../../../../shared/local-agents'
import { useLocale } from '@/i18n/LocaleContext'

function statusKey(agent: LocalAgentInstallation): string {
  if (agent.invocationSupported) return 'surface:localAgentSettings.ready'
  if (agent.callable) return 'surface:localAgentSettings.adapterPending'
  if (agent.historyAvailable) return 'surface:localAgentSettings.historyOnly'
  return 'surface:localAgentSettings.unavailable'
}

export function LocalAgentSettingsSection() {
  const { t } = useLocale()
  const [agents, setAgents] = useState<LocalAgentInstallation[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<string | null>(null)

  const scan = useCallback(async () => {
    if (!window.nxcore?.agent) return
    setBusy(true)
    try {
      setAgents(await window.nxcore.agent.discoverLocalAgents())
      setError(null)
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : t('surface:localAgentSettings.scanFailed'))
    } finally {
      setBusy(false)
    }
  }, [t])

  useEffect(() => { void scan() }, [scan])

  const importHistory = async (agent: LocalAgentInstallation) => {
    setImportingId(agent.id)
    setError(null)
    setImportResult(null)
    try {
      const result = await window.nxcore!.agent.importLocalAgentHistory(agent.id)
      setImportResult(t('surface:localAgentSettings.importComplete', {
        sessions: result.sessionsImported,
        messages: result.messagesImported,
      }))
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : t('surface:localAgentSettings.importFailed'))
    } finally {
      setImportingId(null)
    }
  }

  return (
    <section className="reality-settings-section local-agent-settings-section" aria-labelledby="local-agent-settings-title">
      <header>
        <span><Bot aria-hidden="true" /></span>
        <div>
          <h2 id="local-agent-settings-title">{t('surface:localAgentSettings.title')}</h2>
          <p>{t('surface:localAgentSettings.description')}</p>
        </div>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void scan()}>
          {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          {t('surface:localAgentSettings.rescan')}
        </button>
      </header>
      {error ? <div className="local-agent-empty"><small>{error}</small></div> : null}
      {importResult ? <div className="local-agent-import-result"><small>{importResult}</small></div> : null}
      {!error && agents === null ? <div className="local-agent-empty"><small>{t('surface:localAgentSettings.scanning')}</small></div> : null}
      {!error && agents?.length === 0 ? (
        <div className="local-agent-empty"><strong>{t('surface:localAgentSettings.none')}</strong><small>{t('surface:localAgentSettings.noneHint')}</small></div>
      ) : null}
      {agents?.length ? (
        <div className="local-agent-list">
          {agents.map((agent) => (
            <div key={agent.id} className="local-agent-row" data-ready={String(agent.invocationSupported)}>
              <span className="local-agent-provider"><TerminalSquare aria-hidden="true" /></span>
              <div>
                <strong>{agent.displayName}</strong>
                <small title={agent.executablePath ?? agent.historyPaths.join('\n')}>{agent.version ?? t('surface:localAgentSettings.notInstalled')}</small>
              </div>
              {agent.historyAvailable ? <History aria-label={t('surface:localAgentSettings.historyFound')} /> : null}
              <span className="local-agent-status">{t(statusKey(agent))}</span>
              {(agent.provider === 'codex' || agent.provider === 'claude') && agent.historyAvailable ? (
                <button
                  className="local-agent-import-button"
                  type="button"
                  disabled={importingId !== null}
                  onClick={() => void importHistory(agent)}
                >
                  {importingId === agent.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                  {t('surface:localAgentSettings.importHistory')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}
