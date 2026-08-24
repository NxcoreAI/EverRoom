import { Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type { IngestFilterRulesDto } from '../../../../../shared/ingest'
import { MemoryMarkdown } from './MemoryMarkdown'
import { formatDate, useAsyncData } from './useMemoryData'

/**
 * 过滤规则文档（ingest-filter-agent-plan §4.3，记忆页入口）：
 * 用户偏好段可编辑（保存 = PUT 只重写该段）；系统洞察段只读展示
 * （洞察 job 每小时基于记忆/wiki 自动重写，手改会被覆盖）。
 */
export function FilterRulesPane() {
  const { locale, t } = useLocale()
  const { data, failure, loading, refresh } = useAsyncData<IngestFilterRulesDto>(
    () => window.nxcore!.ingest.getFilterRules(),
  )
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (data && !editing) setDraft(data.preference)
  }, [data, editing])

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.ingest.updateFilterPreference(content)
      setEditing(false)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:filterRules.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="mem-loading">{t('memory:filterRules.loading')}</p>
  if (failure) return <div className="mem-pane-error">{t('memory:filterRules.unavailable')}</div>

  return (
    <div className="mem-core">
      <div className="mem-toolbar">
        <span className="mem-count">
          {data?.updatedAt ? t('memory:filterRules.updatedTime', { time: formatDate(data.updatedAt, locale) }) : ''}
        </span>
        {editing ? (
          <span className="mem-toolbar-actions">
            <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={save}>{t('memory:filterRules.save')}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>{t('memory:filterRules.cancel')}</button>
          </span>
        ) : (
          <span className="mem-toolbar-actions">
            <button type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" strokeWidth={1.7} />{t('memory:filterRules.editPreference')}</button>
          </span>
        )}
      </div>

      <h3 className="mem-rules-heading">{t('memory:filterRules.userPreferenceTitle')}</h3>
      <p className="mem-rules-hint">{t('memory:filterRules.preferenceHint')}</p>
      {editing ? (
        <>
          <textarea
            className="mem-core-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={10}
            maxLength={4096}
          />
        </>
      ) : (
        <MemoryMarkdown markdown={draft || t('memory:filterRules.emptyPreference')} className="mem-core-markdown" />
      )}

      <h3 className="mem-rules-heading">{t('memory:filterRules.systemInsightTitle')}</h3>
      <p className="mem-rules-hint">{t('memory:filterRules.insightHint')}</p>
      {data?.insight ? (
        <MemoryMarkdown markdown={data.insight} className="mem-core-markdown" />
      ) : (
        <p className="mem-loading">{t('memory:filterRules.insightPending')}</p>
      )}
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {busy ? <p className="mem-loading"><RefreshCw aria-hidden="true" strokeWidth={1.8} className="mem-spin" />{t('memory:filterRules.saving')}</p> : null}
    </div>
  )
}
