import { Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import { MemoryEmptyView } from './MemoryStatusViews'
import { MemoryMarkdown } from './MemoryMarkdown'
import { formatDate, memoryFailureText, useAsyncData } from './useMemoryData'

export function CoreProfilePane() {
  const { locale, t } = useLocale()
  const { data, failure, loading, refresh } = useAsyncData(() => window.nxcore!.memory.readCore())
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (data && !editing) setDraft(data.content ?? '')
  }, [data, editing])

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.writeCore(content)
      setEditing(false)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:coreProfile.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (failure) return <div className="mem-pane-error">{memoryFailureText(failure, t)}</div>
  if (loading) return <p className="mem-loading">{t('memory:coreProfile.loading')}</p>

  return (
    <div className="mem-core">
      <div className="mem-toolbar">
        <span className="mem-count">
          {t('memory:coreProfile.profileVersionVVersion', { version: data?.version ?? 0 })}{data?.updatedAt ? ` · ${t('memory:coreProfile.updatedTime', { time: formatDate(data.updatedAt, locale) })}` : ''}
        </span>
        {editing ? (
          <span className="mem-toolbar-actions">
            <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={save}>{t('memory:coreProfile.save')}</button>
            <button type="button" disabled={busy} onClick={() => setEditing(false)}>{t('memory:coreProfile.cancel')}</button>
          </span>
        ) : data?.content ? (
          <span className="mem-toolbar-actions">
            <button type="button" onClick={() => setEditing(true)}><Pencil aria-hidden="true" strokeWidth={1.7} />{t('memory:coreProfile.edit')}</button>
          </span>
        ) : null}
      </div>
      {editing ? (
        <>
          <textarea
            className="mem-core-editor"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={18}
            maxLength={65536}
          />
          <p className="mem-core-hint">{t('memory:coreProfile.savingReplacesTheFullProfileEditTheCurrent')}</p>
        </>
      ) : data?.content ? (
        <MemoryMarkdown markdown={data.content} className="mem-core-markdown" />
      ) : (
        <MemoryEmptyView
          title={t('memory:coreProfile.profileNotGeneratedYet')}
          hint={t('memory:coreProfile.theL3ProfileIsALongTermUser')}
        />
      )}
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {busy ? <p className="mem-loading"><RefreshCw aria-hidden="true" strokeWidth={1.8} className="mem-spin" />{t('memory:coreProfile.saving')}</p> : null}
    </div>
  )
}
