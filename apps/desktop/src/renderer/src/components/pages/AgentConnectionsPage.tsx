import { useState } from 'react'
import { LoaderCircle, PlugZap, RefreshCw, Settings2 } from 'lucide-react'
import type { AgentAccessCreateInput, AgentAccessSettingsDto, AgentConnectionDto } from '../../../../shared/agent-access'
import { useLocale } from '@/i18n/LocaleContext'
import { AgentConnectionCard } from './AgentConnectionCard'
import { AgentConnectionCreateForm, type CreateFormRoomsLoader } from './AgentConnectionCreateForm'
import { PageHeader } from './PageHeader'
import './AgentConnectionsPage.css'

const LOAD_TIMEOUT_MS = 15_000

/** IPC 卡死兜底：任何调用超过 15s 转为可读错误，不无限转圈。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs = LOAD_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('LOAD_TIMEOUT')), timeoutMs)
    }),
  ])
}

export function AgentConnectionsPage() {
  const { t, locale } = useLocale()
  const [connections, setConnections] = useState<AgentConnectionDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [tokenPanel, setTokenPanel] = useState<{ connectionId: string; token: string } | null>(null)
  const [settings, setSettings] = useState<AgentAccessSettingsDto | null>(null)
  const [portDraft, setPortDraft] = useState('')
  const [portBusy, setPortBusy] = useState(false)
  const [portMessage, setPortMessage] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setError(null)
    try {
      const [list, settingsSnapshot] = await Promise.all([
        withTimeout(window.nxcore!.agentAccess.listConnections()),
        withTimeout(window.nxcore!.agentAccess.settingsGet()),
      ])
      setConnections(list.connections)
      setSettings(settingsSnapshot)
      setPortDraft(settingsSnapshot.fixedPort === null ? '' : String(settingsSnapshot.fixedPort))
    } catch (err) {
      setError(err instanceof Error && err.message === 'LOAD_TIMEOUT'
        ? t('surface:agentConnections.loadTimeout')
        : err instanceof Error ? err.message : t('surface:agentConnections.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  const loadRooms: CreateFormRoomsLoader = async () => {
    const response = await window.nxcore!.knowledge.listRooms()
    return response.items.map((room) => ({ id: room.id, title: room.title }))
  }

  const applyPort = async (port: number | null) => {
    setPortBusy(true); setPortMessage(null)
    try {
      await window.nxcore!.agentAccess.setFixedPort(port)
      setPortMessage(t('surface:agentConnections.portNeedsRestart'))
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('surface:agentConnections.actionFailed'))
    } finally {
      setPortBusy(false)
    }
  }

  const restartGateway = async () => {
    setPortBusy(true); setPortMessage(null)
    try {
      await window.nxcore!.agentAccess.restartGateway()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('surface:agentConnections.actionFailed'))
    } finally {
      setPortBusy(false)
    }
  }

  const onCreated = (connection: AgentConnectionDto, token: string) => {
    setConnections((items) => [connection, ...items])
    setCreating(false)
    setTokenPanel({ connectionId: connection.id, token })
  }

  return <div className="page agent-connections-page">
    <PageHeader
      title={t('surface:agentConnections.title')}
      action={t('surface:agentConnections.newConnection')}
      extraAction={(
        <button
          className="icon-button"
          title={t('surface:agentConnections.refresh')}
          aria-label={t('surface:agentConnections.refresh')}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      )}
      onAction={() => setCreating(true)}
    />
    <p className="agent-connections-subtitle"><PlugZap aria-hidden="true" /> {t('surface:agentConnections.subtitle')}</p>

    {error ? <div className="agent-connections-error" role="alert">{error}</div> : null}

    <section className="agent-connections-port">
      <div className="agent-connections-port-copy">
        <h2><Settings2 aria-hidden="true" /> {t('surface:agentConnections.portTitle')}</h2>
        <p>{t('surface:agentConnections.portDesc')}</p>
        <small>
          {t('surface:agentConnections.portCurrent')}：
          {settings ? (settings.currentPort === null ? '—' : String(settings.currentPort)) : '—'}
          {settings?.fixedPort === null ? ` · ${t('surface:agentConnections.portRandom')}` : ''}
          {settings?.fixedPort !== null && settings?.currentPort !== settings?.fixedPort
            ? ` · ${t('surface:agentConnections.portNeedsRestart')}`
            : ''}
        </small>
      </div>
      <div className="agent-connections-port-controls">
        <input
          inputMode="numeric"
          placeholder="e.g. 8790"
          value={portDraft}
          aria-label={t('surface:agentConnections.portTitle')}
          onChange={(event) => setPortDraft(event.target.value.replace(/[^0-9]/g, ''))}
        />
        <button
          className="secondary-button"
          disabled={portBusy || portDraft === ''}
          onClick={() => void applyPort(Number(portDraft))}
        >
          {portBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
          {t('surface:agentConnections.portApply')}
        </button>
        {settings?.fixedPort !== null ? (
          <button className="secondary-button" disabled={portBusy} onClick={() => void applyPort(null)}>
            {t('surface:agentConnections.portDisable')}
          </button>
        ) : null}
        {settings?.fixedPort !== null && settings?.currentPort !== settings?.fixedPort ? (
          <button className="primary-button" disabled={portBusy} onClick={() => void restartGateway()}>
            {portBusy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
            {t('surface:agentConnections.restartGateway')}
          </button>
        ) : null}
        {portMessage ? <small className="agent-connections-port-message">{portMessage}</small> : null}
      </div>
    </section>

    {creating ? (
      <AgentConnectionCreateForm
        loadRooms={loadRooms}
        onCancel={() => setCreating(false)}
        onCreated={onCreated}
      />
    ) : null}

    <section className="agent-connections-list">
      {loading ? (
        <div className="agent-connections-empty"><LoaderCircle className="spin" aria-hidden="true" /></div>
      ) : connections.map((connection) => (
        <AgentConnectionCard
          key={connection.id}
          connection={connection}
          locale={locale}
          tokenOnce={tokenPanel?.connectionId === connection.id ? tokenPanel.token : null}
          onTokenDismissed={() => setTokenPanel(null)}
          onChanged={(next) => setConnections((items) => items.map((item) => item.id === next.id ? next : item))}
          onRemoved={(id) => setConnections((items) => items.filter((item) => item.id !== id))}
          onActionError={(message) => setError(message)}
        />
      ))}
      {!loading && connections.length === 0 ? (
        <div className="agent-connections-empty">
          <p>{t('surface:agentConnections.empty')}</p>
          <small>{t('surface:agentConnections.emptyHint')}</small>
        </div>
      ) : null}
    </section>
  </div>
}
