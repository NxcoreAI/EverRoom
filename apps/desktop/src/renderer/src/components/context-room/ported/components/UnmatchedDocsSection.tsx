import { Link2, LoaderCircle, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { showToast } from '@/state/toast'
import { useLocale } from '../../../../i18n/LocaleContext'
import type {
  KnowledgeAttachInput,
  KnowledgeEntityDto,
  KnowledgeUnmatchedItemDto,
} from '../../../../../../shared/knowledge'
import { localizedUiText } from '../adapters'
import { ReferenceDialog } from './shared'
import { notifyKnowledgeChanged } from './ResourceCorrection'

/**
 * 未识别资料处置面（P0-2）：路由抽取为空/失败的资料停在 awaiting_review，
 * 此前只能看不能处置。这里提供「挂载到实体」出口——选中既有实体或就地新建，
 * 挂载即写入 manual 链接（权重 1.5），实体已建 Room 时立即沉淀。
 */
export function UnmatchedDocsSection() {
  const { t } = useLocale()
  const [items, setItems] = useState<KnowledgeUnmatchedItemDto[]>([])
  const [attaching, setAttaching] = useState<KnowledgeUnmatchedItemDto | null>(null)
  const [entities, setEntities] = useState<KnowledgeEntityDto[] | null>(null)
  const [query, setQuery] = useState('')
  const [selectedEntityId, setSelectedEntityId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const knowledge = window.nxcore?.knowledge
    if (!knowledge) return
    try {
      const { items: unmatched } = await knowledge.listUnmatched()
      setItems(unmatched)
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
      await knowledge.attachDoc(item.sourceKind, item.sourceId, input)
      showToast({
        title: t('contextRoom:knowledgePending.attachedTitle'),
        message: t('contextRoom:knowledgePending.attachedBody', { title: item.title, name: label }),
      })
      notifyKnowledgeChanged()
      setAttaching(null)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('contextRoom:knowledgePending.attachFailed'))
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0) return null

  return (
    <>
      <details className="context-room-knowledge-history context-room-knowledge-unmatched">
        <summary>
          <span>{t('contextRoom:knowledgePending.unmatchedTitle')}</span>
          <small>{items.length}</small>
        </summary>
        <div className="context-room-knowledge-history-content">
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
                onClick={() => void openAttach(item)}
              >
                <Link2 aria-hidden="true" />
                {t('contextRoom:knowledgePending.attachToEntity')}
              </button>
            </div>
          ))}
        </div>
      </details>

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
                        ? t('contextRoom:knowledgePending.entityPromoted')
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
