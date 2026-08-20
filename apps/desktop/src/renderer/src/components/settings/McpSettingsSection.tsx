import { LoaderCircle, Plug, PlugZap, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { showToast } from '@/state/toast'
import type { McpServerDefinition, McpServersSnapshot } from '../../../../shared/mcp'
import { useLocale } from '@/i18n/LocaleContext'

/** 编辑表单的平铺形态（args/env 转成易输入的文本）。 */
interface McpDraft {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string
  url: string
  env: string
}

const EMPTY_DRAFT: McpDraft = { name: '', transport: 'stdio', command: '', args: '', url: '', env: '' }

function toDraft(name: string, definition: McpServerDefinition): McpDraft {
  return {
    name,
    transport: definition.url ? 'http' : 'stdio',
    command: definition.command ?? '',
    args: (definition.args ?? []).join(' '),
    url: definition.url ?? '',
    env: definition.env ? JSON.stringify(definition.env, null, 0) : '',
  }
}

function parseEnv(raw: string): Record<string, string> | null {
  const text = raw.trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)]),
    )
  } catch {
    return null
  }
}

function transportSummary(definition: McpServerDefinition): string {
  if (definition.url) return definition.url
  return [definition.command, ...(definition.args ?? [])].filter(Boolean).join(' ')
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
  }, [])

  useEffect(() => { void reload() }, [reload])

  const persist = async (servers: McpServersSnapshot['servers'], successTitle: string) => {
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
    if (!name) {
      showToast({ title: t('surface:mcpSettings.enterServerName'), message: t('surface:mcpSettings.serverNameHint') })
      return
    }
    if (name !== editingKey && snapshot.servers[name]) {
      showToast({ title: t('surface:mcpSettings.nameExists'), message: t('surface:mcpSettings.chooseAnotherName') })
      return
    }
    if (draft.transport === 'http' && !draft.url.trim()) {
      showToast({ title: t('surface:mcpSettings.enterUrl'), message: t('surface:mcpSettings.httpEndpointRequired') })
      return
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      showToast({ title: t('surface:mcpSettings.enterCommand'), message: t('surface:mcpSettings.stdioCommandRequired') })
      return
    }
    const env = parseEnv(draft.env)
    if (env === null) {
      showToast({ title: t('surface:mcpSettings.invalidEnvironmentVariables'), message: t('surface:mcpSettings.environmentVariablesJsonHint') })
      return
    }
    const definition: McpServerDefinition = draft.transport === 'http'
      ? { url: draft.url.trim() }
      : {
          command: draft.command.trim(),
          ...(draft.args.trim() ? { args: draft.args.trim().split(/\s+/) } : {}),
          ...(Object.keys(env).length > 0 ? { env } : {}),
        }
    const servers: McpServersSnapshot['servers'] = {}
    for (const [key, value] of entries) {
      if (key !== editingKey) servers[key] = value
    }
    servers[name] = definition
    setDraft(null)
    setEditingKey(null)
    void persist(servers, editingKey ? 'surface:mcpSettings.serverUpdated' : 'surface:mcpSettings.serverAdded')
  }

  const toggleDisabled = (name: string, definition: McpServerDefinition) => {
    if (!snapshot) return
    const servers = { ...snapshot.servers }
    if (definition.disabled) delete servers[name]!.disabled
    else servers[name] = { ...definition, disabled: true }
    void persist(servers, definition.disabled ? 'surface:mcpSettings.serverEnabled' : 'surface:mcpSettings.serverDisabled')
  }

  const removeServer = (name: string) => {
    if (!snapshot) return
    const servers = { ...snapshot.servers }
    delete servers[name]
    void persist(servers, 'surface:mcpSettings.serverDeleted')
  }

  return (
    <section className="reality-settings-section mcp-settings-section" aria-labelledby="mcp-settings-title">
      <header>
        <span><PlugZap aria-hidden="true" /></span>
        <div>
          <h2 id="mcp-settings-title">{t('surface:mcpSettings.mcpServers')}</h2>
          <p>{t('surface:mcpSettings.description')}</p>
        </div>
        <button
          className="secondary-button mcp-add-button"
          type="button"
          disabled={busy || snapshot === null}
          onClick={() => { setEditingKey(null); setDraft({ ...EMPTY_DRAFT }) }}
        >
          <Plug aria-hidden="true" />{t('surface:mcpSettings.addServer')}
        </button>
      </header>

      {draft ? (
        <div className="mcp-server-form">
          <label className="mcp-form-field">
            <span>{t('surface:mcpSettings.name')}</span>
            <input
              value={draft.name}
              placeholder={t('surface:mcpSettings.namePlaceholder')}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="mcp-form-field">
            <span>{t('surface:mcpSettings.transport')}</span>
            <div className="segmented-control" aria-label={t('surface:mcpSettings.transport')}>
              <button type="button" data-active={String(draft.transport === 'stdio')} onClick={() => setDraft({ ...draft, transport: 'stdio' })}>{t('surface:mcpSettings.localStdio')}</button>
              <button type="button" data-active={String(draft.transport === 'http')} onClick={() => setDraft({ ...draft, transport: 'http' })}>HTTP</button>
            </div>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label className="mcp-form-field">
                <span>{t('surface:mcpSettings.command')}</span>
                <input
                  value={draft.command}
                  placeholder={t('surface:mcpSettings.commandPlaceholder')}
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </label>
              <label className="mcp-form-field">
                <span>{t('surface:mcpSettings.arguments')}</span>
                <input
                  value={draft.args}
                  placeholder={t('surface:mcpSettings.argumentsPlaceholder')}
                  onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                />
              </label>
              <label className="mcp-form-field mcp-form-field--wide">
                <span>{t('surface:mcpSettings.environmentVariables')}</span>
                <input
                  value={draft.env}
                  placeholder={t('surface:mcpSettings.environmentVariablesPlaceholder')}
                  onChange={(event) => setDraft({ ...draft, env: event.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="mcp-form-field mcp-form-field--wide">
              <span>URL</span>
              <input
                value={draft.url}
                placeholder={t('surface:mcpSettings.urlPlaceholder')}
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </label>
          )}
          <div className="mcp-form-actions">
            <button className="primary-button" type="button" disabled={busy} onClick={submitDraft}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
              {t(editingKey ? 'surface:mcpSettings.saveChanges' : 'surface:mcpSettings.add')}
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => { setDraft(null); setEditingKey(null) }}>
              {t('surface:mcpSettings.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {loadError ? (
        <div className="mcp-server-empty"><small>{loadError}</small></div>
      ) : snapshot === null ? (
        <div className="mcp-server-empty" aria-busy="true"><small>{t('surface:mcpSettings.loading')}</small></div>
      ) : entries.length === 0 ? (
        <div className="mcp-server-empty">
          <strong>{t('surface:mcpSettings.noServers')}</strong>
          <small>{t('surface:mcpSettings.noServersHint')}</small>
        </div>
      ) : (
        <div className="mcp-server-list">
          {entries.map(([name, definition]) => (
            <div key={name} className="mcp-server-row" data-disabled={String(Boolean(definition.disabled))}>
              <div className="mcp-server-info">
                <strong>{name}</strong>
                <small title={transportSummary(definition)}>{transportSummary(definition)}</small>
              </div>
              <div className="mcp-server-actions">
                <button
                  className="settings-toggle"
                  type="button"
                  role="switch"
                  aria-label={t('surface:mcpSettings.enableName', { name })}
                  aria-checked={!definition.disabled}
                  data-active={String(!definition.disabled)}
                  disabled={busy}
                  onClick={() => toggleDisabled(name, definition)}
                >
                  <span aria-hidden="true" />
                  {t(!definition.disabled ? 'surface:mcpSettings.enabled' : 'surface:mcpSettings.disabled')}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => { setEditingKey(name); setDraft(toDraft(name, definition)) }}
                >
                  {t('surface:mcpSettings.edit')}
                </button>
                <button
                  className="secondary-button mcp-delete-button"
                  type="button"
                  disabled={busy}
                  aria-label={t('surface:mcpSettings.deleteName', { name })}
                  onClick={() => removeServer(name)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {snapshot ? <small className="mcp-config-path" title={snapshot.configPath}>{t('surface:mcpSettings.configFilePath', { path: snapshot.configPath })}</small> : null}
    </section>
  )
}
