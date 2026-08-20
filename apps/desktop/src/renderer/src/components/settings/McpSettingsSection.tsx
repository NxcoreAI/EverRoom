import { LoaderCircle, Plug, PlugZap, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { showToast } from '@/state/toast'
import type { McpServerDefinition, McpServersSnapshot } from '../../../../shared/mcp'

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
      setLoadError(error instanceof Error ? error.message : 'MCP 配置加载失败。')
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  const persist = async (servers: McpServersSnapshot['servers'], successTitle: string) => {
    if (!window.nxcore?.mcp) return
    setBusy(true)
    try {
      setSnapshot(await window.nxcore.mcp.saveServers(servers))
      showToast({ title: successTitle, message: '新配置对新会话生效。' })
    } catch (error) {
      showToast({ title: '保存失败', message: error instanceof Error ? error.message : '请检查输入后重试。' })
    } finally {
      setBusy(false)
    }
  }

  const entries = snapshot ? Object.entries(snapshot.servers) : []

  const submitDraft = () => {
    if (!draft || !snapshot) return
    const name = draft.name.trim()
    if (!name) {
      showToast({ title: '请填写服务器名称', message: '名称用于在对话中引用该 MCP 服务器。' })
      return
    }
    if (name !== editingKey && snapshot.servers[name]) {
      showToast({ title: '名称已存在', message: '请换一个服务器名称。' })
      return
    }
    if (draft.transport === 'http' && !draft.url.trim()) {
      showToast({ title: '请填写 URL', message: 'HTTP 服务器需要提供 MCP 端点地址。' })
      return
    }
    if (draft.transport === 'stdio' && !draft.command.trim()) {
      showToast({ title: '请填写命令', message: 'stdio 服务器需要提供启动命令。' })
      return
    }
    const env = parseEnv(draft.env)
    if (env === null) {
      showToast({ title: '环境变量格式错误', message: 'env 需要是 JSON 对象，例如 {"KEY":"value"}。' })
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
    void persist(servers, editingKey ? 'MCP 服务器已更新' : 'MCP 服务器已添加')
  }

  const toggleDisabled = (name: string, definition: McpServerDefinition) => {
    if (!snapshot) return
    const servers = { ...snapshot.servers }
    if (definition.disabled) delete servers[name]!.disabled
    else servers[name] = { ...definition, disabled: true }
    void persist(servers, definition.disabled ? 'MCP 服务器已启用' : 'MCP 服务器已停用')
  }

  const removeServer = (name: string) => {
    if (!snapshot) return
    const servers = { ...snapshot.servers }
    delete servers[name]
    void persist(servers, 'MCP 服务器已删除')
  }

  return (
    <section className="reality-settings-section mcp-settings-section" aria-labelledby="mcp-settings-title">
      <header>
        <span><PlugZap aria-hidden="true" /></span>
        <div>
          <h2 id="mcp-settings-title">MCP 服务器</h2>
          <p>为 Agent 接入外部工具（数据库、浏览器、API 等），改动对新会话生效。</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy || snapshot === null}
          onClick={() => { setEditingKey(null); setDraft({ ...EMPTY_DRAFT }) }}
        >
          <Plug aria-hidden="true" />添加服务器
        </button>
      </header>

      {draft ? (
        <div className="mcp-server-form">
          <label className="mcp-form-field">
            <span>名称</span>
            <input
              value={draft.name}
              placeholder="例如 notion"
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label className="mcp-form-field">
            <span>传输方式</span>
            <div className="segmented-control" aria-label="MCP 传输方式">
              <button type="button" data-active={String(draft.transport === 'stdio')} onClick={() => setDraft({ ...draft, transport: 'stdio' })}>本地 stdio</button>
              <button type="button" data-active={String(draft.transport === 'http')} onClick={() => setDraft({ ...draft, transport: 'http' })}>HTTP</button>
            </div>
          </label>
          {draft.transport === 'stdio' ? (
            <>
              <label className="mcp-form-field">
                <span>命令</span>
                <input
                  value={draft.command}
                  placeholder="例如 npx"
                  onChange={(event) => setDraft({ ...draft, command: event.target.value })}
                />
              </label>
              <label className="mcp-form-field">
                <span>参数（空格分隔）</span>
                <input
                  value={draft.args}
                  placeholder="例如 -y @modelcontextprotocol/server-github"
                  onChange={(event) => setDraft({ ...draft, args: event.target.value })}
                />
              </label>
              <label className="mcp-form-field">
                <span>环境变量（JSON，可选）</span>
                <input
                  value={draft.env}
                  placeholder='例如 {"GITHUB_TOKEN":"ghp_…"}'
                  onChange={(event) => setDraft({ ...draft, env: event.target.value })}
                />
              </label>
            </>
          ) : (
            <label className="mcp-form-field">
              <span>URL</span>
              <input
                value={draft.url}
                placeholder="例如 https://mcp.example.com/mcp"
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </label>
          )}
          <div className="mcp-form-actions">
            <button className="primary-button" type="button" disabled={busy} onClick={submitDraft}>
              {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
              {editingKey ? '保存修改' : '添加'}
            </button>
            <button className="secondary-button" type="button" disabled={busy} onClick={() => { setDraft(null); setEditingKey(null) }}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {loadError ? (
        <div className="mcp-server-empty"><small>{loadError}</small></div>
      ) : snapshot === null ? (
        <div className="mcp-server-empty" aria-busy="true"><small>正在加载 MCP 配置…</small></div>
      ) : entries.length === 0 ? (
        <div className="mcp-server-empty">
          <strong>还没有配置 MCP 服务器</strong>
          <small>添加后 Agent 可通过 mcp 工具按需调用外部能力。</small>
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
                  aria-label={`启用 ${name}`}
                  aria-checked={!definition.disabled}
                  data-active={String(!definition.disabled)}
                  disabled={busy}
                  onClick={() => toggleDisabled(name, definition)}
                >
                  <span aria-hidden="true" />
                  {!definition.disabled ? '已启用' : '已停用'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={busy}
                  onClick={() => { setEditingKey(name); setDraft(toDraft(name, definition)) }}
                >
                  编辑
                </button>
                <button
                  className="secondary-button mcp-delete-button"
                  type="button"
                  disabled={busy}
                  aria-label={`删除 ${name}`}
                  onClick={() => removeServer(name)}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {snapshot ? <small className="mcp-config-path">配置文件：{snapshot.configPath}</small> : null}
    </section>
  )
}
