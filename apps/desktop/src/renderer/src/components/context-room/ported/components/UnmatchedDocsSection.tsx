import { Link2, LoaderCircle, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '../../../../i18n/LocaleContext'
import type {
  KnowledgeAttachInput,
  KnowledgeEntityDto,
  KnowledgeRuleDto,
  KnowledgeUnmatchedItemDto,
} from '../../../../../../shared/knowledge'
import { localizedUiText } from '../adapters'
import { ReferenceDialog } from './shared'
import { notifyKnowledgeChanged } from './ResourceCorrection'

/**
 * 未识别资料处置面（P0-2）：路由抽取为空/失败的资料停在 awaiting_review，
 * 此前只能看不能处置。这里提供「挂载到实体」出口——选中既有实体或就地新建，
 * 挂载即写入 manual 链接（权重 1.5），实体已建 Room 时立即沉淀。
 * 治理三件套：单条/全部重路由（重走完整瀑布）、单条/全部忽略（显式移出）、
 * 挂载即学习规则的清单与撤销。
 */
export function UnmatchedDocsSection() {
  const { t } = useLocale()
  const [items, setItems] = useState<KnowledgeUnmatchedItemDto[]>([])
  const [rules, setRules] = useState<KnowledgeRuleDto[]>([])
  const [attaching, setAttaching] = useState<KnowledgeUnmatchedItemDto | null>(null)
  const [entities, setEntities] = useState<KnowledgeEntityDto[] | null>(null)
  const [query, setQuery] = useState('')
  const [selectedEntityId, setSelectedEntityId] = useState('')
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    try {
      const [{ items: unmatched }, { items: ruleItems }] = await Promise.all([
        knowledge.listUnmatched(),
        knowledge.listRules(),
      ])
      setItems(unmatched)
      setRules(ruleItems)
    } catch {
      // 拉取失败保留上一批清单；主面板的错误态（loadFailed*）已覆盖服务不可见性
    }
  }, [])

  useEffect(() => {
    void refresh()
    const onChanged = () => void refresh()
    window.addEventListener('everroom:knowledge-changed', onChanged)
    return () => window.removeEventListener('everroom:knowledge-changed', onChanged)
  }, [refresh])

  const describeMatcher = useCallback((matcher: Record<string, unknown>): string => {
    const value = (key: string) => (typeof matcher[key] === 'string' ? String(matcher[key]) : '')
    const clip = (text: string) => (text.length > 48 ? `${text.slice(0, 48)}…` : text)
    if (value('creatorId')) return t('contextRoom:knowledgePending.ruleMatcherCreator', { value: clip(value('creatorId')) })
    if (value('listId')) return t('contextRoom:knowledgePending.ruleMatcherList', { value: clip(value('listId')) })
    if (value('calendarId')) return t('contextRoom:knowledgePending.ruleMatcherCalendar', { value: clip(value('calendarId')) })
    if (value('filenamePrefix')) return t('contextRoom:knowledgePending.ruleMatcherFilename', { value: clip(value('filenamePrefix')) })
    if (value('threadId')) return t('contextRoom:knowledgePending.ruleMatcherThread', { value: clip(value('threadId')) })
    if (value('sourceTag')) return t('contextRoom:knowledgePending.ruleMatcherSourceTag', { value: clip(value('sourceTag')) })
    if (value('titleKeyword')) return t('contextRoom:knowledgePending.ruleMatcherTitle', { value: clip(value('titleKeyword')) })
    return Object.entries(matcher).map(([key, val]) => `${key}=${String(val)}`).join(' · ')
  }, [t])

  const retry = async (decisionIds?: string[]) => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    setActing(decisionIds ? `retry:${decisionIds[0]}` : 'retry:all')
    try {
      const { requeued } = await knowledge.retryUnmatched(decisionIds)
      showToast({ title: t('contextRoom:knowledgePending.retryQueued', { count: requeued }) })
      notifyKnowledgeChanged()
      await refresh()
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgePending.retryFailed'),
        message: cause instanceof Error ? cause.message : undefined,
        variant: 'error',
      })
    } finally {
      setActing(null)
    }
  }

  const ignore = async (decisionIds: string[]) => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    setActing(decisionIds.length === 1 ? `ignore:${decisionIds[0]}` : 'ignore:all')
    try {
      const { ignored } = await knowledge.ignoreUnmatched(decisionIds)
      showToast({ title: t('contextRoom:knowledgePending.ignoredCount', { count: ignored }) })
      notifyKnowledgeChanged()
      await refresh()
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgePending.ignoreFailed'),
        message: cause instanceof Error ? cause.message : undefined,
        variant: 'error',
      })
    } finally {
      setActing(null)
    }
  }

  const removeRule = async (ruleId: string) => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    setActing(`rule:${ruleId}`)
    try {
      await knowledge.deleteRule(ruleId)
      showToast({ title: t('contextRoom:knowledgePending.ruleDeleted') })
      await refresh()
    } catch (cause) {
      showToast({
        title: t('contextRoom:knowledgePending.ruleDeleteFailed'),
        message: cause instanceof Error ? cause.message : undefined,
        variant: 'error',
      })
    } finally {
      setActing(null)
    }
  }

  const openAttach = async (item: KnowledgeUnmatchedItemDto) => {
    setAttaching(item)
    setQuery('')
    setSelectedEntityId('')
    setError(null)
    setEntities(null)
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    try {
      // 候选池：孵化中（weak）+ 待确认（ready）+ 已建 Room（room，挂载即沉淀）
      const [weak, ready, rooms] = await Promise.all([
        knowledge.listEntities('weak'),
        knowledge.listEntities('ready'),
        knowledge.listEntities('room'),
      ])
      setEntities([...rooms.items, ...ready.items, ...weak.items])
    } catch {
      setEntities([])
    }
  }

  const keyword = query.trim().toLowerCase()
  const matches = useMemo(() => (entities ?? []).filter((entity) =>
    !keyword || entity.name.toLowerCase().includes(keyword)), [entities, keyword])
  const exactName = (entities ?? []).some((entity) => entity.name.toLowerCase() === keyword)

  const attach = async (input: KnowledgeAttachInput, label: string) => {
    const knowledge = window.nxcore?.knowledge
    const item = attaching
    if (!knowledge || !item) return
    setBusy(true)
    setError(null)
    try {
      const result = await knowledge.attachDoc(item.sourceKind, item.sourceId, input)
      showToast({
        title: t('contextRoom:knowledgePending.attachedTitle'),
        message: t('contextRoom:knowledgePending.attachedBody', { title: item.title, name: label }),
      })
      // 挂载即学习：派生了规则时提示并允许撤销（删规则不影响本次挂载）。
      if (result.learnedRule) {
        const ruleId = result.learnedRule.id
        showToast({
          title: t('contextRoom:knowledgePending.ruleLearnedTitle'),
          message: `${describeMatcher(result.learnedRule.matcher)}${t('contextRoom:knowledgePending.ruleReplayed', { count: result.learnedRule.replayed })}`,
          actionLabel: t('contextRoom:knowledgePending.undo'),
          onAction: () => {
            void (async () => {
              try {
                await window.nxcore?.knowledge?.deleteRule(ruleId)
                showToast({ title: t('contextRoom:knowledgePending.ruleDeleted') })
                notifyKnowledgeChanged()
              } catch {
                showToast({ title: t('contextRoom:knowledgePending.ruleUndoFailed'), variant: 'error' })
              }
            })()
          },
        })
      }
      notifyKnowledgeChanged()
      setAttaching(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:knowledgePending.attachFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0 && rules.length === 0) return null

  return (
    <>
      {items.length > 0 ? (
        <details className="context-room-knowledge-history context-room-knowledge-unmatched">
          <summary>
            <span>{t('contextRoom:knowledgePending.unmatchedTitle')}</span>
            <small>{items.length}</small>
          </summary>
          <div className="context-room-knowledge-history-content">
            <div className="context-room-knowledge-unmatched-actions">
              <button
                type="button"
                className="context-room-knowledge-defer"
                disabled={acting !== null}
                onClick={() => void retry()}
              >
                {acting === 'retry:all' ? <LoaderCircle aria-hidden="true" className="context-room-spin" /> : <RotateCcw aria-hidden="true" />}
                {t('contextRoom:knowledgePending.retryAll')}
              </button>
              <button
                type="button"
                className="context-room-knowledge-defer"
                disabled={acting !== null}
                onClick={() => void ignore(items.map((item) => item.decisionId))}
              >
                {acting === 'ignore:all' ? <LoaderCircle aria-hidden="true" className="context-room-spin" /> : <X aria-hidden="true" />}
                {t('contextRoom:knowledgePending.ignoreAll')}
              </button>
            </div>
            {items.slice(0, 20).map((item) => (
              <div key={item.decisionId} className="context-room-knowledge-recent-row">
                <span
                  className="context-room-knowledge-recent-title"
                  title={item.reason ?? undefined}
                >
                  {item.title}
                </span>
                <button
                  type="button"
                  className="context-room-knowledge-defer"
                  disabled={acting !== null}
                  title={t('contextRoom:knowledgePending.retryHint')}
                  onClick={() => void retry([item.decisionId])}
                >
                  {acting === `retry:${item.decisionId}` ? <LoaderCircle aria-hidden="true" className="context-room-spin" /> : <RotateCcw aria-hidden="true" />}
                  {t('contextRoom:knowledgePending.retry')}
                </button>
                <button
                  type="button"
                  className="context-room-knowledge-defer"
                  disabled={acting !== null}
                  title={t('contextRoom:knowledgePending.ignoreHint')}
                  onClick={() => void ignore([item.decisionId])}
                >
                  {acting === `ignore:${item.decisionId}` ? <LoaderCircle aria-hidden="true" className="context-room-spin" /> : <X aria-hidden="true" />}
                  {t('contextRoom:knowledgePending.ignore')}
                </button>
                <button
                  type="button"
                  className="context-room-knowledge-defer"
                  onClick={() => void openAttach(item)}
                >
                  <Link2 aria-hidden="true" />
                  {t('contextRoom:knowledgePending.attachToEntity')}
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {rules.length > 0 ? (
        <details className="context-room-knowledge-history context-room-knowledge-rules">
          <summary>
            <span>{t('contextRoom:knowledgePending.rulesTitle')}</span>
            <small>{rules.length}</small>
          </summary>
          <div className="context-room-knowledge-history-content">
            {rules.map((rule) => (
              <div key={rule.id} className="context-room-knowledge-recent-row">
                <span className="context-room-knowledge-recent-title" title={JSON.stringify(rule.matcher)}>
                  {describeMatcher(rule.matcher)}
                  <small className="context-room-knowledge-rule-meta">
                    → {rule.roomTitle ?? rule.targetRoomId.slice(0, 8)}
                    {' · '}
                    {rule.origin === 'learned'
                      ? t('contextRoom:knowledgePending.ruleOriginLearned')
                      : t('contextRoom:knowledgePending.ruleOriginManual')}
                    {rule.hitCount > 0 ? ` · ${t('contextRoom:knowledgePending.ruleHits', { count: rule.hitCount })}` : ''}
                  </small>
                </span>
                <button
                  type="button"
                  className="context-room-knowledge-defer"
                  disabled={acting !== null}
                  onClick={() => void removeRule(rule.id)}
                >
                  {acting === `rule:${rule.id}` ? <LoaderCircle aria-hidden="true" className="context-room-spin" /> : <Trash2 aria-hidden="true" />}
                  {t('contextRoom:knowledgePending.ruleDelete')}
                </button>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <ReferenceDialog
        open={Boolean(attaching)}
        onOpenChange={(open) => { if (!open && !busy) setAttaching(null) }}
        title={t('contextRoom:knowledgePending.attachDialogTitle')}
      >
        <div className="context-room-manual-merge">
          <header>
            <div>
              <span>{t('contextRoom:knowledgePending.attachEyebrow')}</span>
              <h2>{t('contextRoom:knowledgePending.attachDialogTitle')}</h2>
            </div>
          </header>
          <p>{t('contextRoom:knowledgePending.attachDialogHint', { title: attaching?.title ?? '' })}</p>
          <div className="context-room-merge-picker">
            <label>
              <span>{t('contextRoom:knowledgePending.attachTarget')}</span>
              <div className="context-room-merge-picker-search">
                <Search aria-hidden="true" />
                <input
                  type="text"
                  value={query}
                  placeholder={t('contextRoom:knowledgePending.attachSearchPlaceholder')}
                  onChange={(event) => { setQuery(event.target.value); setSelectedEntityId('') }}
                />
              </div>
            </label>
            <div className="context-room-merge-picker-list" role="listbox">
              {entities === null ? (
                <p className="context-room-merge-picker-empty">
                  <LoaderCircle aria-hidden="true" /> {t('contextRoom:knowledgePending.attachLoadingEntities')}
                </p>
              ) : matches.length === 0 && (!keyword || exactName) ? (
                <p className="context-room-merge-picker-empty">{t('contextRoom:knowledgePending.attachNoMatch')}</p>
              ) : (
                <>
                  {matches.slice(0, 30).map((entity) => (
                    <button
                      key={entity.id}
                      type="button"
                      role="option"
                      aria-selected={selectedEntityId === entity.id}
                      data-selected={selectedEntityId === entity.id}
                      onClick={() => setSelectedEntityId(entity.id)}
                    >
                      <b>{entity.name}</b>
                      <small>{entity.roomId
                        ? entity.roomTitle
                          ? t('contextRoom:knowledgePending.entityPromotedIn', { title: entity.roomTitle })
                          : t('contextRoom:knowledgePending.entityPromoted')
                        : localizedUiText(entity.kind, t)}</small>
                    </button>
                  ))}
                  {keyword && !exactName ? (
                    <button
                      type="button"
                      className="context-room-merge-picker-create"
                      onClick={() => void attach(
                        { createEntity: { name: query.trim().slice(0, 120), kind: '主题' } },
                        query.trim(),
                      )}
                      disabled={busy}
                    >
                      <b>{t('contextRoom:knowledgePending.createNewEntity', { name: query.trim() })}</b>
                    </button>
                  ) : null}
                </>
              )}
            </div>
          </div>
          {error ? <p className="context-room-form-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" onClick={() => setAttaching(null)} disabled={busy}>
              {t('contextRoom:duplicateCenter.cancel')}
            </button>
            <button
              type="button"
              className="context-room-primary-button"
              disabled={!selectedEntityId || busy}
              onClick={() => {
                const entity = (entities ?? []).find((item) => item.id === selectedEntityId)
                if (entity) void attach({ entityId: entity.id }, entity.name)
              }}
            >
              {t('contextRoom:knowledgePending.attachConfirm')}
            </button>
          </footer>
        </div>
      </ReferenceDialog>
    </>
  )
}
