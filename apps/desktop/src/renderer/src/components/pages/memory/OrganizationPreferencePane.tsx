import { Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type { KnowledgePreferencesDto } from '../../../../../shared/knowledge'
import { MemoryMarkdown } from './MemoryMarkdown'
import { formatDate, useAsyncData } from './useMemoryData'

/**
 * 知识整理偏好（M3 习惯学习，记忆页入口）：三类用户决策信号（路由纠正/
 * 合并判定/晋升意愿）的确定性统计 + LLM 系统洞察（只读，每小时修订式重写）
 * + 用户偏好段（编辑即接管，注入时优先）。学习与注入双开关：关注入 =
 * 抽取与同一性判定回到无偏好行为。
 */
export function OrganizationPreferencePane() {
  const { locale, t } = useLocale()
  const { data, failure, loading, refresh } = useAsyncData<KnowledgePreferencesDto>(
    () => window.nxcore!.knowledge.getPreferences(),
  )
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (data && !editing) setDraft(data.userPreference)
  }, [data, editing])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.knowledge.updatePreferenceContent(draft)
      setEditing(false)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:orgPrefs.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const toggleSetting = async (input: { learningEnabled?: boolean; injectionEnabled?: boolean }) => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.knowledge.updatePreferenceSettings(input)
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:orgPrefs.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    setRefreshing(true)
    setError(null)
    try {
      await window.nxcore!.knowledge.refreshPreferences()
      refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:orgPrefs.refreshFailed'))
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) return <p className="mem-loading">{t('memory:orgPrefs.loading')}</p>
  if (failure) return <div className="mem-pane-error">{t('memory:orgPrefs.unavailable')}</div>

  const stats = data?.stats ?? null

  return (
    <div className="mem-core">
      <div className="mem-toolbar">
        <span className="mem-count">
          {stats ? t('memory:orgPrefs.updatedTime', { time: formatDate(stats.generatedAt, locale) }) : ''}
        </span>
        <span className="mem-toolbar-actions">
          <button type="button" disabled={refreshing} onClick={() => void regenerate()}>
            <RefreshCw aria-hidden="true" strokeWidth={1.7} className={refreshing ? 'mem-spin' : undefined} />
            {t('memory:orgPrefs.refresh')}
          </button>
          {editing ? (
            <>
              <button type="button" className="mem-primary" disabled={busy} onClick={() => void save()}>{t('memory:orgPrefs.save')}</button>
              <button type="button" disabled={busy} onClick={() => setEditing(false)}>{t('memory:orgPrefs.cancel')}</button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" strokeWidth={1.7} />
              {t('memory:orgPrefs.editPreference')}
            </button>
          )}
        </span>
      </div>

      <div className="mem-rules-switches">
        <label>
          <input
            type="checkbox"
            checked={data?.settings.learningEnabled ?? true}
            disabled={busy}
            onChange={(event) => void toggleSetting({ learningEnabled: event.target.checked })}
          />
          <span>{t('memory:orgPrefs.learningSwitch')}</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={data?.settings.injectionEnabled ?? true}
            disabled={busy}
            onChange={(event) => void toggleSetting({ injectionEnabled: event.target.checked })}
          />
          <span>{t('memory:orgPrefs.injectionSwitch')}</span>
        </label>
      </div>
      <p className="mem-rules-hint">{t('memory:orgPrefs.switchesHint')}</p>

      <h3 className="mem-rules-heading">{t('memory:orgPrefs.userPreferenceTitle')}</h3>
      <p className="mem-rules-hint">{t('memory:orgPrefs.preferenceHint')}</p>
      {editing ? (
        <textarea
          className="mem-core-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={6}
          maxLength={2000}
          placeholder={t('memory:orgPrefs.emptyPreference')}
        />
      ) : (
        <MemoryMarkdown markdown={draft || t('memory:orgPrefs.emptyPreference')} className="mem-core-markdown" />
      )}

      <h3 className="mem-rules-heading">{t('memory:orgPrefs.systemInsightTitle')}</h3>
      <p className="mem-rules-hint">{t('memory:orgPrefs.insightHint')}</p>
      {data?.insight ? (
        <MemoryMarkdown markdown={data.insight} className="mem-core-markdown" />
      ) : (
        <p className="mem-loading">{t('memory:orgPrefs.insightPending')}</p>
      )}

      <h3 className="mem-rules-heading">{t('memory:orgPrefs.statsTitle')}</h3>
      {stats ? (
        <ul className="mem-rules-stats">
          <li>{t('memory:orgPrefs.statsVerdicts', {
            distinct: stats.mergeVerdicts.distinct,
            related: stats.mergeVerdicts.related,
          })}</li>
          <li>{t('memory:orgPrefs.statsCorrections', {
            reverts: stats.corrections.reverts,
            manualLinks: stats.corrections.manualLinks,
          })}</li>
          <li>{t('memory:orgPrefs.statsPromotion', {
            suppressed: stats.promotion.suppressed,
            rooms: stats.promotion.promotedRooms,
          })}</li>
          {stats.mergeVerdicts.topDistinctNames.length > 0 ? (
            <li>{t('memory:orgPrefs.statsTopNames', {
              names: stats.mergeVerdicts.topDistinctNames.map((item) => `${item.name}×${item.count}`).join('、'),
            })}</li>
          ) : null}
        </ul>
      ) : (
        <p className="mem-loading">{t('memory:orgPrefs.statsPending')}</p>
      )}
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {busy ? <p className="mem-loading"><RefreshCw aria-hidden="true" strokeWidth={1.8} className="mem-spin" />{t('memory:orgPrefs.saving')}</p> : null}
    </div>
  )
}
