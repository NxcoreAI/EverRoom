import { Pencil, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type {
  WritingStyleCorpusEntryDto,
  WritingStyleInsightDto,
  WritingStyleProfileDto,
  WritingStyleSettingsDto,
} from '../../../../../shared/writing-style'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, useAsyncData, useSnapshottedAsyncData } from './useMemoryData'
import { invalidateCompletionWritingStyleCache } from '../../context-room/ported/components/detail-editor/writingStyleInjection'

const TIER_LABEL: Record<WritingStyleProfileDto['confidenceTier'], string> = {
  empty: 'memory:writingStyle.tierEmpty',
  sparse: 'memory:writingStyle.tierSparse',
  established: 'memory:writingStyle.tierEstablished',
  mature: 'memory:writingStyle.tierMature',
}

const USER_CONTENT_MAX = 2_000

/**
 * 写作风格画像（writing-style-profile-plan §9）：画像式双段布局——
 * 个人风格正文可自由编辑（保存 = PUT 全量替换，对齐 CoreProfile 体验）；
 * 系统沉淀段只读（统计摘要由增量管线自动刷新，保证可复现）。
 */
export function WritingStylePane() {
  const { locale, t } = useLocale()
  // 离线快照（2026-09-03）：网关断联时回落到本地最后一份好数据，
  // 恢复后自动回到实时（useSnapshottedAsyncData 的 stale 重试）。
  const profile = useSnapshottedAsyncData<WritingStyleProfileDto>(
    'writing-style:profile',
    () => window.nxcore!.writingStyle.profile(),
  )
  const settings = useSnapshottedAsyncData<WritingStyleSettingsDto>(
    'writing-style:settings',
    () => window.nxcore!.writingStyle.settings(),
  )
  const content = useSnapshottedAsyncData(
    'writing-style:user-content',
    () => window.nxcore!.writingStyle.userContent(),
  )
  const insights = useSnapshottedAsyncData<{ insights: WritingStyleInsightDto[] }>(
    'writing-style:insights',
    () => window.nxcore!.writingStyle.insights(),
  )

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmingRecompute, setConfirmingRecompute] = useState(false)
  const [showCorpus, setShowCorpus] = useState(false)
  const corpus = useAsyncData<{ documents: WritingStyleCorpusEntryDto[] }>(
    () => window.nxcore!.writingStyle.corpus(),
    [showCorpus],
  )

  useEffect(() => {
    if (content.data && !editing) setDraft(content.data.content)
  }, [content.data, editing])

  const saveContent = async (): Promise<void> => {
    const trimmed = draft.trim()
    setBusy(true)
    setError(null)
    try {
      // 空文本 = 解除接管回系统版（gateway 语义），非空 = 保存接管版本。
      await window.nxcore!.writingStyle.replaceUserContent(trimmed)
      setEditing(false)
      content.refresh()
      // 注入块随画像文本变化：立即失效补全缓存，不等 TTL 兜底。
      invalidateCompletionWritingStyleCache()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** 清空 = 解除接管，gateway 会立即回填系统版本（有统计时）。 */
  const clearAndRestore = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.writingStyle.replaceUserContent('')
      setEditing(false)
      content.refresh()
      invalidateCompletionWritingStyleCache()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** 从系统沉淀重建画像文本（解除接管，恢复自动维护）。 */
  const regenerate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.writingStyle.regenerateUserContent()
      setDraft('')
      content.refresh()
      invalidateCompletionWritingStyleCache()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.recomputeFailed'))
    } finally {
      setBusy(false)
    }
  }

  const toggleSetting = async (key: 'completionEnabled' | 'generationEnabled'): Promise<void> => {
    const current = settings.data
    if (!current) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.writingStyle.updateSettings({ [key]: !current[key] })
      settings.refresh()
      // 补全注入块带 TTL 缓存：开关切换立即生效，不等 10 分钟兜底。
      invalidateCompletionWritingStyleCache()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const runRecompute = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.writingStyle.recompute()
      setConfirmingRecompute(false)
      profile.refresh()
      corpus.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.recomputeFailed'))
    } finally {
      setBusy(false)
    }
  }

  const toggleExclusion = async (documentId: string, excluded: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.writingStyle.setExclusion(documentId, excluded)
      corpus.refresh()
      profile.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const confirmInsight = async (insightId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.writingStyle.confirmInsight(insightId)
      insights.refresh()
      content.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:writingStyle.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (profile.loading || settings.loading) {
    return <p className="mem-loading">{t('memory:writingStyle.loading')}</p>
  }
  if (profile.failure && !profile.data) {
    return <div className="mem-pane-error">{memoryFailureText(profile.failure, t)}</div>
  }

  const profileData = profile.data
  const sparse = profileData?.confidenceTier === 'sparse' || profileData?.confidenceTier === 'empty'
  const currentContent = content.data?.content ?? ''

  return (
    <div className="mem-core">
      {profile.stale || content.stale || insights.stale ? (
        <div className="mem-offline-snapshot" role="status">
          {t('memory:writingStyle.offlineSnapshot', {
            time: formatDate(
              new Date(
                Math.max(
                  profile.snapshotAt ?? 0,
                  content.snapshotAt ?? 0,
                  insights.snapshotAt ?? 0,
                ),
              ).toISOString(),
              locale,
            ),
          })}
        </div>
      ) : null}
      <div className="mem-toolbar">
        <span className="mem-count">
          {t('memory:writingStyle.sampleCount', { count: profileData?.sampleDocumentCount ?? 0 })}
          {profileData?.lastRefreshedAt ? ` · ${t('memory:writingStyle.updatedTime', { time: formatDate(profileData.lastRefreshedAt, locale) })}` : ''}
          {profileData ? ` · ${t(TIER_LABEL[profileData.confidenceTier])}` : ''}
        </span>
        <span className="mem-toolbar-actions">
          {confirmingRecompute ? (
            <>
              <button type="button" className="mem-primary" disabled={busy} onClick={runRecompute}>{t('memory:writingStyle.confirmRecompute')}</button>
              <button type="button" disabled={busy} onClick={() => setConfirmingRecompute(false)}>{t('memory:writingStyle.cancel')}</button>
            </>
          ) : (
            <button type="button" disabled={busy} onClick={() => setConfirmingRecompute(true)}>
              <RefreshCw aria-hidden="true" strokeWidth={1.7} />{t('memory:writingStyle.recompute')}
            </button>
          )}
        </span>
      </div>

      {sparse ? <p className="mem-writing-style-hint">{t('memory:writingStyle.sparseHint')}</p> : null}

      <h3 className="mem-rules-heading">{t('memory:writingStyle.applyTitle')}</h3>
      <div className="mem-writing-style-toggles">
        <label className="mem-writing-style-toggle">
          <input
            type="checkbox"
            checked={settings.data?.completionEnabled ?? false}
            disabled={busy}
            onChange={() => void toggleSetting('completionEnabled')}
          />
          <span>{t('memory:writingStyle.completionToggle')}</span>
        </label>
        <label className="mem-writing-style-toggle">
          <input
            type="checkbox"
            checked={settings.data?.generationEnabled ?? false}
            disabled={busy}
            onChange={() => void toggleSetting('generationEnabled')}
          />
          <span>{t('memory:writingStyle.generationToggle')}</span>
        </label>
      </div>

      <h3 className="mem-rules-heading">{t('memory:writingStyle.profileTextTitle')}</h3>
      <p className="mem-rules-hint">{t('memory:writingStyle.profileTextHint')}</p>
      <div className="mem-toolbar-actions mem-writing-style-edit-entry">
        {editing ? (
          <>
            <button type="button" className="mem-primary" disabled={busy} onClick={() => void saveContent()}>{t('memory:writingStyle.save')}</button>
            <button type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(currentContent) }}>{t('memory:writingStyle.cancel')}</button>
            {currentContent ? (
              <button type="button" disabled={busy} onClick={() => void clearAndRestore()}>{t('memory:writingStyle.clearContent')}</button>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil aria-hidden="true" strokeWidth={1.7} />{t('memory:writingStyle.editContent')}
            </button>
            {content.data?.userEdited ? (
              <button type="button" disabled={busy} onClick={() => void regenerate()}>{t('memory:writingStyle.regenerate')}</button>
            ) : null}
          </>
        )}
      </div>
      {content.data?.systemUpdateAvailable && !editing ? (
        <p className="mem-writing-style-hint">{t('memory:writingStyle.systemUpdateHint')}</p>
      ) : null}
      {editing ? (
        <textarea
          className="mem-core-editor"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={12}
          maxLength={USER_CONTENT_MAX}
          placeholder={t('memory:writingStyle.contentPlaceholder')}
        />
      ) : currentContent ? (
        <p className="mem-writing-style-content" data-user-edited={content.data?.userEdited ?? false}>
          {currentContent}
          {content.data?.userEdited ? <span className="mem-writing-style-badge">{t('memory:writingStyle.userEditedBadge')}</span> : null}
        </p>
      ) : (
        <p className="mem-rules-hint">{t('memory:writingStyle.emptyContent')}</p>
      )}

      <h3 className="mem-rules-heading">{t('memory:writingStyle.systemSummaryTitle')}</h3>
      <p className="mem-rules-hint">{t('memory:writingStyle.systemSummaryHint')}</p>
      {profileData && (profileData.sampleDocumentCount > 0
        || profileData.behavior.instructionCounts.length > 0
        || profileData.behavior.revisionCount > 0) ? (
        <div className="mem-writing-style-summary">
          {(profileData.behavior.instructionCounts.length > 0 || profileData.behavior.revisionCount > 0) ? (
            <div className="mem-writing-style-section">
              <h4>{t('memory:writingStyle.sectionBehavior')}</h4>
              <ul>
                {profileData.behavior.instructionCounts.slice(0, 4).map((entry) => (
                  <li key={entry.label}>{t('memory:writingStyle.behaviorInstruction', { label: entry.label, count: entry.count })}</li>
                ))}
                {profileData.behavior.revisionCount > 0 && profileData.behavior.averageLenDeltaRatio !== null ? (
                  <li>{t('memory:writingStyle.behaviorRevision', {
                    count: profileData.behavior.revisionCount,
                    percent: Math.round(profileData.behavior.averageLenDeltaRatio * 100),
                  })}</li>
                ) : null}
                {profileData.behavior.reviewRejectedCount >= 2 ? (
                  <li>{t('memory:writingStyle.behaviorReview', {
                    rejected: profileData.behavior.reviewRejectedCount,
                    accepted: profileData.behavior.reviewAcceptedCount,
                  })}</li>
                ) : null}
                {profileData.behavior.recentInstructions.slice(0, 2).map((instruction) => (
                  <li key={instruction}>{t('memory:writingStyle.behaviorSample', { instruction })}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {profileData.sections.qualitative.length > 0 ? (
            <div className="mem-writing-style-section">
              <h4>{t('memory:writingStyle.sectionQualitative')}</h4>
              <ul>
                {profileData.sections.qualitative.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          ) : (
            <p className="mem-rules-hint">{t('memory:writingStyle.qualitativePending')}</p>
          )}
          {(['vocabulary', 'sentence', 'structure'] as const).map((key) => {
            const lines = profileData.sections[key]
            if (!lines || lines.length === 0) return null
            const titles: Record<typeof key, string> = {
              vocabulary: t('memory:writingStyle.sectionVocabulary'),
              sentence: t('memory:writingStyle.sectionSentence'),
              structure: t('memory:writingStyle.sectionStructure'),
            }
            return (
              <div key={key} className="mem-writing-style-section">
                <h4>{titles[key]}</h4>
                <ul>
                  {lines.map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            )
          })}
        </div>
      ) : (
        <MemoryEmptyView
          title={t('memory:writingStyle.emptyProfile')}
          hint={t('memory:writingStyle.emptyProfileHint')}
        />
      )}

      {(insights.data?.insights ?? []).length > 0 ? (
        <>
          <h3 className="mem-rules-heading">{t('memory:writingStyle.insightTitle')}</h3>
          <p className="mem-rules-hint">{t('memory:writingStyle.insightHint')}</p>
          <ul className="mem-writing-style-insights">
            {(insights.data?.insights ?? []).filter((insight) => insight.status !== 'confirmed').map((insight) => (
              <li key={insight.id} data-status={insight.status}>
                <div className="mem-writing-style-insight-body">
                  <ul>
                    {insight.preferences.map((preference) => <li key={preference}>{preference}</li>)}
                  </ul>
                  {insight.status === 'snoozed'
                    ? <span className="mem-writing-style-insight-meta">{t('memory:writingStyle.insightSnoozed')}</span>
                    : null}
                </div>
                <button type="button" disabled={busy} onClick={() => void confirmInsight(insight.id)}>
                  {t('memory:writingStyle.insightConfirm')}
                </button>
              </li>
            ))}
            {(insights.data?.insights ?? []).filter((insight) => insight.status === 'confirmed').slice(0, 5).map((insight) => (
              <li key={insight.id} data-status="confirmed">
                <div className="mem-writing-style-insight-body">
                  <ul>
                    {insight.preferences.map((preference) => <li key={preference}>{preference}</li>)}
                  </ul>
                  <span className="mem-writing-style-insight-meta">{t('memory:writingStyle.insightConfirmed')}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h3 className="mem-rules-heading">{t('memory:writingStyle.corpusTitle')}</h3>
      <div className="mem-toolbar-actions mem-writing-style-edit-entry">
        <button type="button" onClick={() => setShowCorpus((value) => !value)}>
          {showCorpus ? t('memory:writingStyle.hideCorpus') : t('memory:writingStyle.showCorpus')}
        </button>
      </div>
      {showCorpus ? (
        corpus.loading ? (
          <p className="mem-loading">{t('memory:writingStyle.loading')}</p>
        ) : corpus.failure ? (
          <div className="mem-pane-error">{memoryFailureText(corpus.failure, t)}</div>
        ) : (corpus.data?.documents.length ?? 0) === 0 ? (
          <p className="mem-rules-hint">{t('memory:writingStyle.emptyCorpus')}</p>
        ) : (
          <ul className="mem-writing-style-corpus">
            {[...corpus.data!.documents]
              .sort((a, b) => b.charCount - a.charCount)
              .map((entry) => (
                <li key={entry.documentId} data-excluded={entry.excluded}>
                  <label className="mem-writing-style-toggle" title={t('memory:writingStyle.exclusionHint')}>
                    <input
                      type="checkbox"
                      checked={!entry.excluded}
                      disabled={busy || entry.status !== 'extracted'}
                      onChange={(event) => void toggleExclusion(entry.documentId, !event.target.checked)}
                    />
                    <span className="mem-writing-style-corpus-title">{entry.title}</span>
                  </label>
                  <span className="mem-writing-style-corpus-meta">
                    {entry.status === 'extracted'
                      ? t('memory:writingStyle.corpusChars', { count: entry.charCount })
                      : t(`memory:writingStyle.corpusStatus.${entry.status === 'pending' || entry.status === 'failed' || entry.status === 'skipped' ? entry.status : 'skipped'}`)}
                    {entry.origin === 'agent' ? ` · ${t('memory:writingStyle.corpusAgentOrigin')}` : ''}
                  </span>
                </li>
              ))}
          </ul>
        )
      ) : null}

      {error ? <p className="mem-inline-error">{error}</p> : null}
      {busy ? <p className="mem-loading"><RefreshCw aria-hidden="true" strokeWidth={1.8} className="mem-spin" />{t('memory:writingStyle.busy')}</p> : null}
    </div>
  )
}
