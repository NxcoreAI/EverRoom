import { useState } from 'react'
import {
  CirclePause,
  CirclePlay,
  ClipboardCopy,
  Download,
  FlaskConical,
  KeyRound,
  LoaderCircle,
  Search,
  ShieldOff,
  Wrench,
} from 'lucide-react'
import type {
  AgentAccessInstallOutcomeDto,
  AgentAccessSelftestDto,
  AgentConnectionDto,
} from '../../../../shared/agent-access'
import { useLocale } from '@/i18n/LocaleContext'

type ExampleResult = {
  query: string
  result: { status: string; message?: string; data?: { hits?: Array<Record<string, unknown>> } }
}

const STATUS_TONE: Record<string, string> = {
  ok: 'ok',
  empty: 'muted',
  stale: 'warn',
  duplicate: 'warn',
  pending_review: 'warn',
  no_permission: 'error',
  source_lost: 'error',
  parse_failed: 'error',
  invalid_input: 'error',
}

function statusTone(status: string): string {
  return STATUS_TONE[status] ?? 'muted'
}

function hitTitle(hit: Record<string, unknown>): string {
  return typeof hit.title === 'string' && hit.title ? hit.title
    : typeof hit.snippet === 'string' ? hit.snippet.slice(0, 60)
      : String(hit.objectId ?? '')
}

export function AgentConnectionCard({
  connection,
  locale,
  tokenOnce,
  onTokenDismissed,
  onChanged,
  onRemoved,
  onActionError,
}: {
  connection: AgentConnectionDto
  locale: string
  tokenOnce: string | null
  onTokenDismissed: () => void
  onChanged: (connection: AgentConnectionDto) => void
  onRemoved: (id: string) => void
  onActionError: (message: string) => void
}) {
  const { t } = useLocale()
  const [busy, setBusy] = useState<string | null>(null)
  const [rotateTokenPanel, setRotateTokenPanel] = useState<string | null>(null)
  const [selftest, setSelftest] = useState<AgentAccessSelftestDto | null>(null)
  const [example, setExample] = useState<ExampleResult | null>(null)
  const [install, setInstall] = useState<AgentAccessInstallOutcomeDto | null>(null)
  const [debugOpen, setDebugOpen] = useState(false)
  const [debugData, setDebugData] = useState<{
    submissions: Array<Record<string, unknown>>
    events: Array<Record<string, unknown>>
  } | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); onActionError('')
    try {
      await action()
    } catch (err) {
      onActionError(err instanceof Error ? err.message : t('surface:agentConnections.actionFailed'))
    } finally {
      setBusy(null)
    }
  }

  const setStatus = (status: 'active' | 'paused') =>
    run('status', async () => {
      const next = await window.nxcore!.agentAccess.updateConnection(connection.id, { status })
      onChanged(next.connection)
    })

  const rotateToken = () =>
    run('rotate', async () => {
      const next = await window.nxcore!.agentAccess.rotateToken(connection.id)
      onChanged(next.connection)
      setRotateTokenPanel(next.token)
    })

  const revoke = () =>
    run('revoke', async () => {
      if (!window.confirm(t('surface:agentConnections.confirmRevoke'))) return
      const next = await window.nxcore!.agentAccess.revokeConnection(connection.id)
      onChanged(next.connection)
    })

  const runSelftest = () =>
    run('selftest', async () => {
      setExample(null); setInstall(null)
      setSelftest(await window.nxcore!.agentAccess.selftest(connection.id))
    })

  const runExampleQuery = () =>
    run('example', async () => {
      setSelftest(null); setInstall(null)
      setExample(await window.nxcore!.agentAccess.exampleQuery(connection.id))
    })

  const runInstall = () =>
    run('install', async () => {
      // token 只在创建/换发时可见：手头没有就先换发（旧配置随新安装一并覆写）。
      let token = tokenOnce ?? rotateTokenPanel
      if (!token) {
        const rotated = await window.nxcore!.agentAccess.rotateToken(connection.id)
        onChanged(rotated.connection)
        token = rotated.token
        setRotateTokenPanel(token)
      }
      const result = await window.nxcore!.agentAccess.install(connection.id, connection.tool, token)
      setInstall(result.outcome)
    })

  const runUninstall = () =>
    run('uninstall', async () => {
      await window.nxcore!.agentAccess.uninstall(connection.tool)
      setInstall(null)
    })

  const toggleDebug = () =>
    run('debug', async () => {
      if (debugOpen) {
        setDebugOpen(false)
        return
      }
      const [submissions, events] = await Promise.all([
        window.nxcore!.agentAccess.submissions(connection.id),
        window.nxcore!.agentAccess.events(connection.id),
      ])
      setDebugData({ submissions: submissions.submissions, events: events.events })
      setDebugOpen(true)
    })

  const copyToken = async (token: string) => {
    try {
      // Electron 渲染进程的 navigator.clipboard 因焦点判定经常失败，优先走主进程。
      if (window.nxcore?.clipboard) {
        await window.nxcore.clipboard.writeText(token)
      } else {
        await navigator.clipboard.writeText(token)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    } catch {
      onActionError(t('surface:agentConnections.actionFailed'))
    }
  }

  const roomsSummary = connection.scopes.roomIds === 'all'
    ? t('surface:agentConnections.allRooms')
    : t('surface:agentConnections.selectedRooms', { count: connection.scopes.roomIds.length })
  const statusLabel = connection.status === 'active'
    ? t('surface:agentConnections.statusActive')
    : connection.status === 'paused'
      ? t('surface:agentConnections.statusPaused')
      : t('surface:agentConnections.statusRevoked')

  return <article className="agent-connections-card" data-status={connection.status}>
    <div className="agent-connections-card-copy">
      <div className="agent-connections-card-title">
        <h2>{connection.name}</h2>
        <span className="agent-connections-badge">{connection.tool}</span>
        <span className={`agent-connections-status status-${connection.status}`}>{statusLabel}</span>
      </div>
      <p>
        {roomsSummary} · {connection.scopes.capabilities.length} 项能力
        {connection.scopes.writebackRoomId ? ` · ${t('surface:agentConnections.writeback')}: ${connection.scopes.writebackRoomId}` : ''}
      </p>
      <small>
        <code>{connection.tokenPrefix}…</code>
        {' · '}
        {t('surface:agentConnections.lastSeen')}：
        {connection.lastSeenAt ? new Date(connection.lastSeenAt).toLocaleString(locale) : t('surface:agentConnections.never')}
      </small>
    </div>

    <div className="agent-connections-card-actions">
      {connection.status === 'active' ? (
        <button className="secondary-button agent-connections-action" disabled={busy !== null} onClick={() => void setStatus('paused')}>
          <CirclePause aria-hidden="true" />{t('surface:agentConnections.pause')}
        </button>
      ) : connection.status === 'paused' ? (
        <button className="secondary-button agent-connections-action" disabled={busy !== null} onClick={() => void setStatus('active')}>
          <CirclePlay aria-hidden="true" />{t('surface:agentConnections.resume')}
        </button>
      ) : null}
      <button className="secondary-button agent-connections-action" disabled={busy !== null || connection.status === 'revoked'} onClick={() => void rotateToken()}>
        {busy === 'rotate' ? <LoaderCircle className="spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
        {t('surface:agentConnections.rotate')}
      </button>
      <button className="secondary-button agent-connections-action" disabled={busy !== null} onClick={() => void runSelftest()}>
        {busy === 'selftest' ? <LoaderCircle className="spin" aria-hidden="true" /> : <FlaskConical aria-hidden="true" />}
        {t('surface:agentConnections.selftest')}
      </button>
      <button className="secondary-button agent-connections-action" disabled={busy !== null} onClick={() => void runExampleQuery()}>
        {busy === 'example' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}
        {t('surface:agentConnections.exampleQuery')}
      </button>
      <button className="secondary-button agent-connections-action" disabled={busy !== null || connection.status !== 'active'} onClick={() => void runInstall()}>
        {busy === 'install' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
        {t('surface:agentConnections.install')}
      </button>
      <button className="secondary-button agent-connections-action" disabled={busy !== null} onClick={() => void toggleDebug()}>
        {busy === 'debug' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
        {t('surface:agentConnections.debug')}
      </button>
      <button className="secondary-button agent-connections-action danger" disabled={busy !== null || connection.status === 'revoked'} onClick={() => void revoke()}>
        <ShieldOff aria-hidden="true" />{t('surface:agentConnections.revoke')}
      </button>
    </div>

    {tokenOnce !== null || rotateTokenPanel !== null ? (
      <div className="agent-connections-token" role="status">
        <strong>{t('surface:agentConnections.tokenOnceTitle')}</strong>
        <small>{t('surface:agentConnections.tokenOnceHint')}</small>
        <div className="agent-connections-token-row">
          <code>{tokenOnce ?? rotateTokenPanel}</code>
          <button className="secondary-button" onClick={() => void copyToken(tokenOnce ?? rotateTokenPanel ?? '')}>
            <ClipboardCopy aria-hidden="true" />
            {copied ? t('surface:agentConnections.copied') : t('surface:agentConnections.copy')}
          </button>
        </div>
      </div>
    ) : null}

    {selftest ? (
      <div className="agent-connections-panel">
        <h3>{t('surface:agentConnections.selftest')}</h3>
        <ul className="agent-connections-steps">
          {([['list', 'selftestList'], ['search', 'selftestSearch'], ['fetch', 'selftestFetch'], ['submit', 'selftestSubmit']] as const).map(([key, labelKey]) => {
            const step = selftest.steps[key]
            return <li key={key} data-tone={statusTone(step.status)}>
              <span>{t(`surface:agentConnections.${labelKey}`)}</span>
              <code>{step.status}</code>
              {step.message ? <small>{step.message}</small> : null}
            </li>
          })}
        </ul>
      </div>
    ) : null}

    {example ? (
      <div className="agent-connections-panel">
        <h3>{t('surface:agentConnections.exampleQuery')}：{example.query}</h3>
        {example.result.data?.hits?.length ? (
          <ul className="agent-connections-hits">
            {example.result.data.hits.slice(0, 5).map((hit, index) => (
              <li key={index}>
                <span className="agent-connections-hit-kind">{String(hit.kind ?? '')}</span>
                <span>{hitTitle(hit)}</span>
                {typeof hit.uri === 'string' ? <code>{hit.uri}</code> : null}
                {typeof hit.version === 'string' && hit.version ? <small>{hit.version}</small> : null}
              </li>
            ))}
          </ul>
        ) : (
          <small data-tone={statusTone(example.result.status)}>
            {example.result.message ?? t('surface:agentConnections.exampleEmpty')}
          </small>
        )}
      </div>
    ) : null}

    {install ? (
      <div className="agent-connections-panel">
        <h3>{t('surface:agentConnections.install')}</h3>
        {install.writtenFiles.length > 0 ? (
          <div>
            <strong>{t('surface:agentConnections.installWritten')}</strong>
            <ul className="agent-connections-files">
              {install.writtenFiles.map((file) => <li key={file}><code>{file}</code></li>)}
            </ul>
          </div>
        ) : null}
        {install.manualSteps.map((step) => (
          <div key={step.title}>
            <strong>{t('surface:agentConnections.installManual')}：{step.title}</strong>
            <pre><code>{step.content}</code></pre>
          </div>
        ))}
        {install.notes.length > 0 ? <ul className="agent-connections-notes">{install.notes.map((note) => <li key={note}>{note}</li>)}</ul> : null}
        <button className="secondary-button" disabled={busy !== null} onClick={() => void runUninstall()}>
          {t('surface:agentConnections.uninstall')}
        </button>
      </div>
    ) : null}

    {debugOpen && debugData ? (
      <div className="agent-connections-panel">
        <h3>{t('surface:agentConnections.debug')}</h3>
        <strong>{t('surface:agentConnections.debugSubmissions')}</strong>
        {debugData.submissions.length === 0 ? <small>{t('surface:agentConnections.debugEmpty')}</small> : (
          <ul className="agent-connections-hits">
            {debugData.submissions.slice(0, 10).map((item, index) => (
              <li key={index}>
                <code>{String(item.clientSubmissionId ?? '')}</code>
                <span>{String(item.status ?? '')}</span>
                <small>{String(item.duplicateCount ?? 0)} replays</small>
              </li>
            ))}
          </ul>
        )}
        <strong>{t('surface:agentConnections.debugEvents')}</strong>
        {debugData.events.length === 0 ? <small>{t('surface:agentConnections.debugEmpty')}</small> : (
          <ul className="agent-connections-hits">
            {debugData.events.slice(0, 10).map((item, index) => (
              <li key={index}>
                <span>{String(item.kind ?? '')}{item.tool ? ` · ${String(item.tool)}` : ''}</span>
                <code>{String(item.status ?? '')}</code>
                <small>{item.createdAt ? new Date(String(item.createdAt)).toLocaleString(locale) : ''}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    ) : null}
  </article>
}
