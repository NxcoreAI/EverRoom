import { Check, RefreshCw, RotateCcw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RuntimeConfigSnapshot } from '../../../../shared/sources'

function pretty(value: Record<string, unknown>): string { return `${JSON.stringify(value, null, 2)}\n` }

export function RuntimeConfigSettingsSection() {
  const [snapshot, setSnapshot] = useState<RuntimeConfigSnapshot | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = async () => {
    if (!window.nxcore) return
    const next = await window.nxcore.runtimeConfig.get()
    setSnapshot(next)
    setText(pretty(next.config))
  }
  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : '无法读取运行时配置')) }, [])

  const save = async () => {
    setBusy(true); setMessage(null)
    try {
      const parsed = JSON.parse(text) as unknown
      const next = await window.nxcore?.runtimeConfig.saveUser(parsed)
      if (next) { setSnapshot(next); setText(pretty(next.config)); setMessage('本地配置已保存') }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'JSON 配置无效') }
    finally { setBusy(false) }
  }
  const clear = async () => { setBusy(true); setMessage(null); try { const next = await window.nxcore?.runtimeConfig.clearUser(); if (next) { setSnapshot(next); setText(pretty(next.config)) }; setMessage('已恢复 SaaS 或默认配置') } catch (error) { setMessage(error instanceof Error ? error.message : '清除失败') } finally { setBusy(false) } }
  const refresh = async () => { setBusy(true); setMessage(null); try { const next = await window.nxcore?.runtimeConfig.refreshSaas(); if (next) { setSnapshot(next); setText(pretty(next.config)) }; setMessage('SaaS 配置已刷新') } catch (error) { setMessage(error instanceof Error ? error.message : '刷新失败') } finally { setBusy(false) } }
  const selectSource = async (source: 'user' | 'saas' | 'default') => { setBusy(true); setMessage(null); try { const next = await window.nxcore?.runtimeConfig.selectSource(source); if (next) { setSnapshot(next); setText(pretty(next.config)) }; setMessage(source === 'user' ? '已切换为本地配置' : source === 'saas' ? '已切换为 SaaS 配置' : '已切换为默认配置') } catch (error) { setMessage(error instanceof Error ? error.message : '切换配置来源失败') } finally { setBusy(false) } }

  return <section id="settings-runtime-config" className="reality-settings-section settings-anchor-section" aria-labelledby="runtime-config-title">
    <header><span><ShieldCheck aria-hidden="true" /></span><div><h2 id="runtime-config-title">运行时 AI 配置</h2><p>登录后使用 SaaS 分配的配置；本地覆盖保存在此设备的 SQLite 中。</p></div></header>
    <div className="runtime-config-meta"><span>来源：{snapshot?.source ?? '读取中'}</span><span>版本：{snapshot?.configVersion ?? '--'}</span><span>更新时间：{snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleString() : '--'}</span></div>
    <div className="runtime-config-source-selector" role="group" aria-label="选择 AI 配置来源">
      <span>使用配置：</span>
      {([['user', '本地配置'], ['saas', 'SaaS 配置'], ['default', '默认配置']] as const).map(([source, label]) => <button key={source} type="button" className={snapshot?.selectedSource === source ? 'active' : ''} disabled={busy || (source !== 'default' && !snapshot?.availableSources.includes(source))} onClick={() => void selectSource(source)}>{label}{source !== 'default' && !snapshot?.availableSources.includes(source) ? '（未配置）' : ''}</button>)}
    </div>
    <textarea className="runtime-config-editor" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false} aria-label="运行时 AI JSON 配置" />
    <div className="runtime-config-actions"><button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}><RefreshCw aria-hidden="true" />重新读取</button><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={busy}><RotateCcw aria-hidden="true" />刷新 SaaS</button><button type="button" className="secondary-button" onClick={() => void clear()} disabled={busy}><Trash2 aria-hidden="true" />清除本地覆盖</button><button type="button" className="primary-button" onClick={() => void save()} disabled={busy}><Save aria-hidden="true" />保存 JSON</button></div>
    {message ? <p className="runtime-config-message"><Check aria-hidden="true" />{message}</p> : null}
  </section>
}
