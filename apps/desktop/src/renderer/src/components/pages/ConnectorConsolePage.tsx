import {
  Braces,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Play,
  PlugZap,
  RefreshCw,
  Search,
  Square,
  TerminalSquare,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  OpenConnectorActionSchema,
  OpenConnectorActionSummary,
  OpenConnectorCommandEvent,
  OpenConnectorCommandResult,
  OpenConnectorConnectionSummary,
  OpenConnectorStatus,
} from '../../../../shared/open-connector'
import { PageHeader } from './PageHeader'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import './ConnectorConsolePage.css'

type ConsoleEntry = OpenConnectorCommandEvent & { key: string }

function actionId(action: Pick<OpenConnectorActionSummary, 'service' | 'name'>): string {
  return `${action.service}.${action.name}`
}

function asActions(value: unknown): OpenConnectorActionSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const action = item as Partial<OpenConnectorActionSummary>
    if (typeof action.service !== 'string' || typeof action.name !== 'string') return []
    return [{
      service: action.service,
      name: action.name,
      description: typeof action.description === 'string' ? action.description : '',
      authenticated: action.authenticated === true,
    }]
  })
}

function asSchema(value: unknown): OpenConnectorActionSchema | null {
  if (!value || typeof value !== 'object') return null
  const schema = value as Partial<OpenConnectorActionSchema>
  if (typeof schema.service !== 'string' || typeof schema.name !== 'string') return null
  return {
    service: schema.service,
    name: schema.name,
    description: typeof schema.description === 'string' ? schema.description : '',
    inputSchema: schema.inputSchema && typeof schema.inputSchema === 'object'
      ? schema.inputSchema as Record<string, unknown>
      : {},
    outputSchema: schema.outputSchema && typeof schema.outputSchema === 'object'
      ? schema.outputSchema as Record<string, unknown>
      : {},
  }
}

function asConnections(value: unknown): OpenConnectorConnectionSummary[] {
  return Array.isArray(value) ? value as OpenConnectorConnectionSummary[] : []
}

function statusText(status: OpenConnectorStatus | null, t: Translate): string {
  if (!status) return t('surface:connectorConsole.detecting')
  if (status.gatewayState === 'starting') return t('surface:connectorConsole.startingLocalGateway')
  if (status.gatewayState !== 'ready') return t('surface:connectorConsole.gatewayUnavailable')
  if (status.cliState !== 'ready') return t('surface:connectorConsole.cliUnavailable')
  return t('surface:connectorConsole.ready')
}

export function ConnectorConsolePage({ embedded = false }: { embedded?: boolean } = {}) {
  const { locale, t } = useLocale()
  const [status, setStatus] = useState<OpenConnectorStatus | null>(null)
  const [query, setQuery] = useState('')
  const [actions, setActions] = useState<OpenConnectorActionSummary[]>([])
  const [selected, setSelected] = useState<OpenConnectorActionSummary | null>(null)
  const [schema, setSchema] = useState<OpenConnectorActionSchema | null>(null)
  const [connections, setConnections] = useState<OpenConnectorConnectionSummary[]>([])
  const [connectionName, setConnectionName] = useState('')
  const [input, setInput] = useState('{}')
  const [result, setResult] = useState<unknown>(null)
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const ready = status?.gatewayState === 'ready' && status.cliState === 'ready'
  const activeActionId = selected ? actionId(selected) : null
  const formattedResult = useMemo(() => result == null ? '' : JSON.stringify(result, null, 2), [result])

  const refreshStatus = useCallback(async () => {
    if (!window.nxcore) return
    setError(null)
    try {
      setStatus(await window.nxcore.openConnector.status())
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : t('surface:connectorConsole.unableToReadConnectorStatus'))
    }
  }, [t])

  useEffect(() => {
    void refreshStatus()
    if (!window.nxcore) return
    return window.nxcore.openConnector.onEvent((event) => {
      setEntries((current) => [
        ...current.slice(-199),
        { ...event, key: `${event.requestId}:${event.type}:${event.timestamp}:${current.length}` },
      ])
    })
  }, [refreshStatus])

  useEffect(() => {
    if (ready) return
    const interval = window.setInterval(() => void refreshStatus(), 2_000)
    return () => window.clearInterval(interval)
  }, [ready, refreshStatus])

  const execute = async <T,>(command: Parameters<NonNullable<typeof window.nxcore>['openConnector']['execute']>[0]['command']) => {
    if (!window.nxcore) throw new Error(t('surface:connectorConsole.theConnectorConsoleIsAvailableOnlyInThe'))
    const requestId = crypto.randomUUID()
    setBusyRequestId(requestId)
    setError(null)
    try {
      return await window.nxcore.openConnector.execute({ requestId, command }) as OpenConnectorCommandResult<T>
    } catch (commandError) {
      setError(commandError instanceof Error ? commandError.message : t('surface:connectorConsole.ooCliExecutionFailed'))
      throw commandError
    } finally {
      setBusyRequestId(null)
    }
  }

  const searchActions = async () => {
    const normalized = query.trim()
    if (!normalized) return
    const response = await execute<OpenConnectorActionSummary[]>({ kind: 'search', query: normalized })
    const nextActions = asActions(response.data)
    setActions(nextActions)
    if (nextActions.length === 0) {
      setSelected(null)
      setSchema(null)
    }
  }

  const inspectAction = async (action: OpenConnectorActionSummary) => {
    setSelected(action)
    setResult(null)
    const schemaResponse = await execute<OpenConnectorActionSchema>({
      kind: 'schema',
      actionId: actionId(action),
    })
    const nextSchema = asSchema(schemaResponse.data)
    setSchema(nextSchema)
    const appsResponse = await execute<OpenConnectorConnectionSummary[]>({
      kind: 'apps',
      service: action.service,
    })
    const nextConnections = asConnections(appsResponse.data)
    setConnections(nextConnections)
    setConnectionName(nextConnections.find((item) => item.isDefault)?.connectionName ?? '')
    setInput('{}')
  }

  const runAction = async (dryRun = false) => {
    if (!selected) return
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      setError(t('surface:connectorConsole.inputIsNotValidJson'))
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError(t('surface:connectorConsole.actionInputMustBeAJsonObject'))
      return
    }
    const response = await execute({
      kind: 'run',
      service: selected.service,
      action: selected.name,
      input: parsed as Record<string, unknown>,
      ...(connectionName ? { connectionName } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    })
    setResult(response.data)
  }

  return (
    <div className={embedded ? 'connector-console-page connector-console-embedded' : 'page connector-console-page'}>
      {!embedded ? <PageHeader
        title={t('surface:connectorConsole.connectorConsole')}
        description={t('surface:connectorConsole.securelyConnectAgentToTheOpenconnectorGatewayThrough')}
        extraAction={(
          <button type="button" className="secondary-button" onClick={() => void refreshStatus()}>
            <RefreshCw aria-hidden="true" />{t('surface:connectorConsole.refreshStatus')}
          </button>
        )}
      /> : null}

      <section className="connector-runtime-card" data-ready={String(ready)}>
        <div className="connector-runtime-icon"><PlugZap aria-hidden="true" /></div>
        <div className="connector-runtime-copy">
          <strong>{statusText(status, t)}</strong>
          <span>
            {status?.baseUrl ?? t('surface:connectorConsole.readingGatewayAddress')}
            {status ? ` · ${t(status.managed ? 'surface:connectorConsole.locallyManaged' : 'surface:connectorConsole.externalService')}${status.gatewayPid ? ` · PID ${status.gatewayPid}` : ''}` : ''}
          </span>
        </div>
        <div className="connector-runtime-facts">
          <span>{status?.gatewayState === 'ready' ? <CheckCircle2 /> : status?.gatewayState === 'starting' ? <LoaderCircle className="spin" /> : <CircleAlert />} Gateway {status?.gatewayVersion ?? ''}</span>
          <span>{status?.cliState === 'ready' ? <CheckCircle2 /> : <CircleAlert />} oo {status?.cliVersion ?? t('surface:connectorConsole.notDetected')}</span>
          <span><TerminalSquare /> Token {t(status?.runtimeTokenConfigured ? 'surface:connectorConsole.isolated' : 'surface:connectorConsole.notConfigured')}</span>
        </div>
        <button type="button" className="secondary-button" onClick={() => void window.nxcore?.openConnector.openConsole()}>
          {t('surface:connectorConsole.webConsole')}<ExternalLink aria-hidden="true" />
        </button>
      </section>

      {(error || status?.gatewayMessage || status?.cliMessage) ? (
        <div className="connector-alert" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{error || status?.gatewayMessage || status?.cliMessage}</span>
        </div>
      ) : null}

      <div className="connector-console-grid">
        <section className="connector-pane connector-discovery-pane">
          <header><div><Search /><span><strong>{t('surface:connectorConsole.actionDiscovery')}</strong><small>{t('surface:connectorConsole.searchTheGatewayCatalog')}</small></span></div></header>
          <form className="connector-search" onSubmit={(event) => {
            event.preventDefault()
            void searchActions().catch(() => undefined)
          }}>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('surface:connectorConsole.forExampleSendEmailCreateAnEvent')} />
            <button type="submit" className="primary-button" disabled={!ready || Boolean(busyRequestId) || !query.trim()}>
              {busyRequestId ? <LoaderCircle className="spin" /> : <Search />}{t('surface:connectorConsole.search')}
            </button>
          </form>
          <div className="connector-action-list">
            {actions.length === 0 ? (
              <div className="connector-empty">{t('surface:connectorConsole.useNaturalLanguageToFindActionsAgentCan')}</div>
            ) : actions.map((action) => (
              <button
                type="button"
                key={actionId(action)}
                data-active={String(activeActionId === actionId(action))}
                disabled={Boolean(busyRequestId)}
                onClick={() => void inspectAction(action).catch(() => undefined)}
              >
                <span><strong>{action.name}</strong><small>{action.description || t('surface:connectorConsole.noDescription')}</small></span>
                <i data-authenticated={String(action.authenticated)}>{t(action.authenticated ? 'surface:connectorConsole.connected' : 'surface:connectorConsole.connectionRequired')}</i>
                <code>{action.service}</code>
              </button>
            ))}
          </div>
        </section>

        <section className="connector-pane connector-execution-pane">
          <header><div><Braces /><span><strong>{t('surface:connectorConsole.schemaExecution')}</strong><small>{activeActionId ?? t('surface:connectorConsole.chooseAnAction')}</small></span></div></header>
          {!schema || !selected ? <div className="connector-empty">{t('surface:connectorConsole.chooseAnActionInspectItsContractAndEnter')}</div> : (
            <div className="connector-action-workbench">
              <p>{schema.description || t('surface:connectorConsole.thisActionHasNoDescription')}</p>
              <details open><summary>{t('surface:connectorConsole.inputSchema')}</summary><pre>{JSON.stringify(schema.inputSchema, null, 2)}</pre></details>
              <label>
                <span>{t('surface:connectorConsole.connectedAccount')}</span>
                <select value={connectionName} onChange={(event) => setConnectionName(event.target.value)}>
                  <option value="">{t('surface:connectorConsole.defaultConnection')}</option>
                  {connections.filter((connection) => connection.connectionName).map((connection) => (
                    <option key={connection.connectionName!} value={connection.connectionName!}>{connection.displayName}</option>
                  ))}
                </select>
              </label>
              <label><span>{t('surface:connectorConsole.jsonInput')}</span><textarea spellCheck={false} value={input} onChange={(event) => setInput(event.target.value)} /></label>
              <div className="connector-run-actions">
                <button type="button" className="secondary-button" disabled={Boolean(busyRequestId)} onClick={() => void runAction(true).catch(() => undefined)}>
                  <CheckCircle2 />{t('surface:connectorConsole.validateOnly')}
                </button>
                {busyRequestId ? (
                  <button type="button" className="danger-button" onClick={() => void window.nxcore?.openConnector.cancel(busyRequestId)}><Square />{t('surface:connectorConsole.cancel')}</button>
                ) : (
                  <button type="button" className="primary-button" onClick={() => void runAction(false).catch(() => undefined)}><Play />{t('surface:connectorConsole.runAction')}</button>
                )}
              </div>
              {formattedResult ? <><h3>{t('surface:connectorConsole.result')}</h3><pre className="connector-result">{formattedResult}</pre></> : null}
            </div>
          )}
        </section>
      </div>

      <section className="connector-log-pane">
        <header><div><TerminalSquare /><span><strong>{t('surface:connectorConsole.cliSessionLog')}</strong><small>{t('surface:connectorConsole.tokensAndActionInputsAreHiddenFromCommand')}</small></span></div><button type="button" onClick={() => setEntries([])}>{t('surface:connectorConsole.clear')}</button></header>
        <div className="connector-log-output">
          {entries.length === 0 ? <span className="connector-log-empty">{t('surface:connectorConsole.waitingForACommand')}</span> : entries.map((entry) => (
            <div key={entry.key} data-stream={entry.type === 'output' ? entry.stream : entry.type}>
              <time>{new Date(entry.timestamp).toLocaleTimeString(locale, { hour12: false })}</time>
              <code>{entry.type === 'started' ? `$ ${entry.command}` : entry.type === 'finished' ? t('surface:connectorConsole.processEndedExitCodeDurationMs', { code: entry.exitCode, duration: entry.durationMs }) : entry.text.trimEnd()}</code>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
