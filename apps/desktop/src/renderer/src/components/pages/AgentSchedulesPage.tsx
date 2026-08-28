import { CalendarClock, Check, LoaderCircle, Play, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentScheduledTask } from '../../../../shared/sources'
import { useLocale } from '@/i18n/LocaleContext'
import './AgentSchedulesPage.css'

type Draft = { agentId: string; name: string; description: string; prompt: string; localTime: string; timezone: string }
const EMPTY: Draft = { agentId: 'primary', name: '', description: '', prompt: '', localTime: '09:00', timezone: 'Asia/Shanghai' }

export function AgentSchedulesPage() {
  const { locale, t } = useLocale()
  const [tasks, setTasks] = useState<AgentScheduledTask[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setError(null)
    try { setTasks(await window.nxcore!.agentSchedules.list()) }
    catch (err) { setError(err instanceof Error ? err.message : t('surface:schedules.loadFailed')) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (window.nxcore) void load() }, [])

  const create = async () => {
    if (!draft.name.trim() || !draft.prompt.trim()) return
    setBusy('new'); setError(null)
    try { const task = await window.nxcore!.agentSchedules.create(draft); setTasks((items) => [...items, task]); setDraft(EMPTY); setCreating(false) }
    catch (err) { setError(err instanceof Error ? err.message : t('surface:schedules.createFailed')) }
    finally { setBusy(null) }
  }
  const update = async (task: AgentScheduledTask, enabled: boolean) => {
    setBusy(task.id)
    try { const next = await window.nxcore!.agentSchedules.update(task.id, { enabled, configVersion: task.configVersion }); setTasks((items) => items.map((item) => item.id === next.id ? next : item)) }
    catch (err) { setError(err instanceof Error ? err.message : t('surface:schedules.saveFailed')) }
    finally { setBusy(null) }
  }
  const run = async (task: AgentScheduledTask) => {
    setBusy(task.id)
    try { await window.nxcore!.agentSchedules.runNow(task.id); await load() }
    catch (err) { setError(err instanceof Error ? err.message : t('surface:schedules.runFailed')) }
    finally { setBusy(null) }
  }
  const remove = async (task: AgentScheduledTask) => {
    if (task.builtin || !window.confirm(t('surface:schedules.confirmDelete'))) return
    setBusy(task.id)
    try { await window.nxcore!.agentSchedules.remove(task.id); setTasks((items) => items.filter((item) => item.id !== task.id)) }
    catch (err) { setError(err instanceof Error ? err.message : t('surface:schedules.deleteFailed')) }
    finally { setBusy(null) }
  }

  return <div className="page schedules-page">
    <header className="schedules-page-header">
      <div><span className="eyebrow"><CalendarClock aria-hidden="true" /> {t('surface:navigation.execution')}</span><h1>{t('surface:schedules.title')}</h1></div>
      <div className="schedules-actions"><button className="icon-button" title={t('surface:schedules.refresh')} aria-label={t('surface:schedules.refresh')} onClick={() => void load()} disabled={loading}><RefreshCw aria-hidden="true" /></button><button className="primary-button" onClick={() => setCreating(true)}><Plus aria-hidden="true" />{t('surface:schedules.newTask')}</button></div>
    </header>
    {error ? <div className="schedules-error">{error}</div> : null}
    {creating ? <section className="schedule-form"><div className="schedule-form-header"><h2>{t('surface:schedules.newTask')}</h2><button className="icon-button" onClick={() => setCreating(false)} aria-label={t('surface:schedules.cancel')}><X aria-hidden="true" /></button></div><div className="schedule-form-grid"><label>{t('surface:schedules.name')}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>{t('surface:schedules.agent')}<input value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })} /></label><label>{t('surface:schedules.time')}<input type="time" value={draft.localTime} onChange={(e) => setDraft({ ...draft, localTime: e.target.value })} /></label><label>{t('surface:schedules.timezone')}<input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></label><label className="schedule-form-wide">{t('surface:schedules.descriptionLabel')}<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label><label className="schedule-form-wide">{t('surface:schedules.prompt')}<textarea rows={4} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} /></label></div><div className="schedule-form-actions"><button className="secondary-button" onClick={() => setCreating(false)}>{t('surface:schedules.cancel')}</button><button className="primary-button" disabled={busy === 'new' || !draft.name.trim() || !draft.prompt.trim()} onClick={() => void create()}>{busy === 'new' ? <LoaderCircle className="spin" /> : <Check />}{t('surface:schedules.save')}</button></div></section> : null}
    <section className="schedule-list">{loading ? <div className="schedules-empty"><LoaderCircle className="spin" />{t('surface:schedules.loading')}</div> : tasks.map((task) => <article className="schedule-card" key={task.id}><div className="schedule-card-copy"><div className="schedule-card-title"><h2>{task.name}</h2>{task.builtin ? <span className="schedule-badge">{t('surface:schedules.builtin')}</span> : null}<code>{task.agentId}</code></div><p>{task.description || task.prompt || t('surface:schedules.noDescription')}</p><small>{task.lastRunAt ? `${t('surface:schedules.lastRun')} ${new Date(task.lastRunAt).toLocaleString(locale)}` : t('surface:schedules.neverRun')}{task.lastError ? ` · ${task.lastError}` : ''}</small></div><div className="schedule-card-actions"><span>{task.localTime} · {task.timezone}</span><button className="icon-button" title={t('surface:schedules.runNow')} aria-label={t('surface:schedules.runNow')} disabled={busy === task.id} onClick={() => void run(task)}>{busy === task.id ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}</button><button className="settings-toggle" role="switch" aria-checked={task.enabled} data-active={String(task.enabled)} disabled={busy === task.id} onClick={() => void update(task, !task.enabled)}><span aria-hidden="true" />{task.enabled ? t('surface:settings.on') : t('surface:settings.off')}</button><button className="icon-button danger" title={task.builtin ? t('surface:schedules.builtinCannotDelete') : t('surface:schedules.delete')} aria-label={t('surface:schedules.delete')} disabled={task.builtin || busy === task.id} onClick={() => void remove(task)}><Trash2 aria-hidden="true" /></button></div></article>)}{!loading && tasks.length === 0 ? <div className="schedules-empty">{t('surface:schedules.empty')}</div> : null}</section>
  </div>
}
