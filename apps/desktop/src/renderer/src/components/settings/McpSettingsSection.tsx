import { LoaderCircle, Plug, PlugZap, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { showToast } from '@/state/toast'
import type {
  McpSecretMutation,
  McpServerDefinition,
  McpServerMutation,
  McpServersMutation,
  McpServersSnapshot,
} from '../../../../shared/mcp'
import { useLocale } from '@/i18n/LocaleContext'

interface SecretRow {
  id: string
  key: string
  value: string
  configured: boolean
  deleted?: boolean
}

interface McpDraft {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  env: SecretRow[]
  headers: SecretRow[]
}

let nextRowId = 0
const row = (key = '', configured = false): SecretRow => ({ id: `secret-${nextRowId++}`, key, value: '', configured })
const EMPTY_DRAFT = (): McpDraft => ({ name: '', transport: 'stdio', command: '', args: '', url: '', env: [], headers: [] })

function toDraft(name: string, definition: McpServerDefinition): McpDraft {
  return {
    name,
    transport: definition.url ? 'http' : 'stdio',
    command: definition.command ?? '',
    args: (definition.args ?? []).join(' '),
    url: definition.url ?? '',
    env: Object.keys(definition.env ?? {}).map((key) => row(key, true)),
    headers: Object.keys(definition.headers ?? {}).map((key) => row(key, true)),
  }
}

function secretMutations(rows: SecretRow[]): Record<string, McpSecretMutation> {
  const result: Record<string, McpSecretMutation> = {}
  for (const item of rows) {
    const key = item.key.trim()
    if (!key) continue
    if (result[key]) throw new Error('duplicate_secret_key')
    if (item.deleted) result[key] = { operation: 'delete' }
    else if (item.value) result[key] = { operation: 'set', value: item.value }
    else if (item.configured) result[key] = { operation: 'keep' }
  }
  return result
}

function toMutation(definition: McpServerDefinition): McpServerMutation {
  const { env, headers, ...fields } = definition
  return {
    ...fields,
    ...(env ? { env: Object.fromEntries(Object.keys(env).map((key) => [key, { operation: 'keep' }])) } : {}),
    ...(headers ? { headers: Object.fromEntries(Object.keys(headers).map((key) => [key, { operation: 'keep' }])) } : {}),
  }
}

function allMutations(snapshot: McpServersSnapshot): McpServersMutation {
  return Object.fromEntries(Object.entries(snapshot.servers).map(([name, definition]) => [name, toMutation(definition)]))
}

function transportSummary(definition: McpServerDefinition): string {
  if (definition.url) return definition.url
  return [definition.command, ...(definition.args ?? [])].filter(Boolean).join(' ')
}

function SecretRows({
  label,
  rows,
  onChange,
  configuredText,
}: {
  label: string
  rows: SecretRow[]
  onChange: (rows: SecretRow[]) => void
  configuredText: string
}) {
  const visible = rows.filter((item) => !item.deleted)
  return <div className="mcp-secret-group">
    <div className="mcp-secret-group-title">
      <span>{label}</span>
      <button type="button" className="secondary-button" onClick={() => onChange([...rows, row()])}>
        <Plus aria-hidden="true" />
      </button>
    </div>
    {visible.map((item) => <div className="mcp-secret-row" key={item.id}>
      <input value={item.key} placeholder="KEY" disabled={item.configured} onChange={(event) => onChange(rows.map((candidate) => candidate.id === item.id ? { ...candidate, key: event.target.value } : candidate))} />
      <input type="password" value={item.value} placeholder={item.configured ? configuredText : ''} onChange={(event) => onChange(rows.map((candidate) => candidate.id === item.id ? { ...candidate, value: event.target.value } : candidate))} />
      {item.configured && !item.value ? <small>{configuredText}</small> : null}
      <button type="button" className="secondary-button mcp-delete-button" aria-label={`Delete ${item.key}`} onClick={() => onChange(item.configured ? rows.map((candidate) => candidate.id === item.id ? { ...candidate, deleted: true } : candidate) : rows.filter((candidate) => candidate.id !== item.id))}>
        <Trash2 aria-hidden="true" />
      </button>
    </div>)}
  </div>
}

export function McpSettingsSection() {
  const { t } = useLocale()
  const [snapshot, setSnapshot] = useState<McpServersSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<McpDraft | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!window.nxcore?.mcp) return
    try {
      setSnapshot(await window.nxcore.mcp.listServers())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('surface:mcpSettings.loadFailed'))
    }
  }, [t])

  useEffect(() => { void reload() }, [reload])

  const persist = async (servers: McpServersMutation, successTitle: string) => {
    if (!window.nxcore?.mcp) return
    setBusy(true)
    try {
      setSnapshot(await window.nxcore.mcp.saveServers(servers))
      showToast({ title: t(successTitle), message: t('surface:mcpSettings.newSessionsOnly') })
    } catch (error) {
      showToast({ title: t('surface:mcpSettings.saveFailed'), message: error instanceof Error ? error.message : t('surface:mcpSettings.checkInputAndRetry') })
    } finally {
      setBusy(false)
    }
  }

  const entries = snapshot ? Object.entries(snapshot.servers) : []

  const submitDraft = () => {
    if (!draft || !snapshot) return
    const name = draft.name.trim()
    if (!name) return showToast({ title: t('surface:mcpSettings.enterServerName'), message: t('surface:mcpSettings.serverNameHint') })
    if (name !== editingKey && snapshot.servers[name]) return showToast({ title: t('surface:mcpSettings.nameExists'), message: t('surface:mcpSettings.chooseAnotherName') })
    if (draft.transport === 'http' && !draft.url.trim()) return showToast({ title: t('surface:mcpSettings.enterUrl'), message: t('surface:mcpSettings.httpEndpointRequired') })
    if (draft.transport === 'stdio' && !draft.command.trim()) return showToast({ title: t('surface:mcpSettings.enterCommand'), message: t('surface:mcpSettings.stdioCommandRequired') })
    try {
      const env = secretMutations(draft.env)
      const headers = secretMutations(draft.headers)
      const definition: McpServerMutation = draft.transport === 'http'
        ? { url: draft.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) }
        : {
            command: draft.command.trim(),
            ...(draft.args.trim() ? { args: draft.args.trim().split(/\s+/) } : {}),
            ...(Object.keys(env).length ? { env } : {}),
          }
      const servers = allMutations(snapshot)
      if (editingKey) delete servers[editingKey]
      servers[name] = { ...definition, ...(editingKey ? { previousName: editingKey } : {}) }
      setDraft(null)
      setEditingKey(null)
      void persist(servers, editingKey ? 'surface:mcpSettings.serverUpdated' : 'surface:mcpSettings.serverAdded')
    } catch {
      showToast({ title: t('surface:mcpSettings.invalidSecretRows'), message: t('surface:mcpSettings.secretRowsHint') })
    }
  }

  const toggleDisabled = (name: string, definition: McpServerDefinition) => {
    if (!snapshot) return
    const servers = allMutations(snapshot)
    if (definition.disabled) delete servers[name]!.disabled
    else servers[name] = { ...servers[name], disabled: true }
    void persist(servers, definition.disabled ? 'surface:mcpSettings.serverEnabled' : 'surface:mcpSettings.serverDisabled')
  }

  const removeServer = (name: string) => {
    if (!snapshot) return
    const servers = allMutations(snapshot)
    delete servers[name]
    void persist(servers, 'surface:mcpSettings.serverDeleted')
  }

  return <section className="reality-settings-section mcp-settings-section" aria-labelledby="mcp-settings-title">
    <header><span><PlugZap aria-hidden="true" /></span><div><h2 id="mcp-settings-title">{t('surface:mcpSettings.mcpServers')}</h2><p>{t('surface:mcpSettings.description')}</p></div>
      <button className="secondary-button mcp-add-button" type="button" disabled={busy || snapshot === null} onClick={() => { setEditingKey(null); setDraft(EMPTY_DRAFT()) }}><Plug aria-hidden="true" />{t('surface:mcpSettings.addServer')}</button>
    </header>

    {draft ? <div className="mcp-server-form">
      <label className="mcp-form-field"><span>{t('surface:mcpSettings.name')}</span><input value={draft.name} placeholder={t('surface:mcpSettings.namePlaceholder')} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="mcp-form-field"><span>{t('surface:mcpSettings.transport')}</span><div className="segmented-control" aria-label={t('surface:mcpSettings.transport')}>
        <button type="button" data-active={String(draft.transport === 'stdio')} onClick={() => setDraft({ ...draft, transport: 'stdio' })}>{t('surface:mcpSettings.localStdio')}</button>
        <button type="button" data-active={String(draft.transport === 'http')} onClick={() => setDraft({ ...draft, transport: 'http' })}>HTTP</button>
      </div></label>
      {draft.transport === 'stdio' ? <>
        <label className="mcp-form-field"><span>{t('surface:mcpSettings.command')}</span><input value={draft.command} placeholder={t('surface:mcpSettings.commandPlaceholder')} onChange={(event) => setDraft({ ...draft, command: event.target.value })} /></label>
        <label className="mcp-form-field"><span>{t('surface:mcpSettings.arguments')}</span><input value={draft.args} placeholder={t('surface:mcpSettings.argumentsPlaceholder')} onChange={(event) => setDraft({ ...draft, args: event.target.value })} /></label>
        <SecretRows label={t('surface:mcpSettings.environmentVariables')} rows={draft.env} onChange={(env) => setDraft({ ...draft, env })} configuredText={t('surface:mcpSettings.configured')} />
      </> : <>
        <label className="mcp-form-field"><span>URL</span><input value={draft.url} placeholder={t('surface:mcpSettings.urlPlaceholder')} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
        <SecretRows label={t('surface:mcpSettings.headers')} rows={draft.headers} onChange={(headers) => setDraft({ ...draft, headers })} configuredText={t('surface:mcpSettings.configured')} />
      </>}
      <div className="mcp-form-actions"><button className="primary-button" type="button" disabled={busy} onClick={submitDraft}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}{t(editingKey ? 'surface:mcpSettings.saveChanges' : 'surface:mcpSettings.add')}</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => { setDraft(null); setEditingKey(null) }}>{t('surface:mcpSettings.cancel')}</button></div>
    </div> : null}

    {loadError ? <div className="mcp-server-empty"><small>{loadError}</small></div> : snapshot === null ? <div className="mcp-server-empty" aria-busy="true"><small>{t('surface:mcpSettings.loading')}</small></div> : entries.length === 0 ? <div className="mcp-server-empty"><strong>{t('surface:mcpSettings.noServers')}</strong><small>{t('surface:mcpSettings.noServersHint')}</small></div> : <div className="mcp-server-list">
      {entries.map(([name, definition]) => <div key={name} className="mcp-server-row" data-disabled={String(Boolean(definition.disabled))}>
        <div className="mcp-server-info"><strong>{name}</strong><small title={transportSummary(definition)}>{transportSummary(definition)}</small></div>
        <div className="mcp-server-actions"><button className="settings-toggle" type="button" role="switch" aria-label={t('surface:mcpSettings.enableName', { name })} aria-checked={!definition.disabled} data-active={String(!definition.disabled)} disabled={busy} onClick={() => toggleDisabled(name, definition)}><span aria-hidden="true" />{t(!definition.disabled ? 'surface:mcpSettings.enabled' : 'surface:mcpSettings.disabled')}</button>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => { setEditingKey(name); setDraft(toDraft(name, definition)) }}>{t('surface:mcpSettings.edit')}</button>
          <button className="secondary-button mcp-delete-button" type="button" disabled={busy} aria-label={t('surface:mcpSettings.deleteName', { name })} onClick={() => removeServer(name)}><Trash2 aria-hidden="true" /></button></div>
      </div>)}
    </div>}
    {snapshot ? <small className="mcp-config-path" title={snapshot.configPath}>{t('surface:mcpSettings.configFilePath', { path: snapshot.configPath })}</small> : null}
  </section>
}
