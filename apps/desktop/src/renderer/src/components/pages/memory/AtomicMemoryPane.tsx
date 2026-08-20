import { ChevronLeft, ChevronRight, Link2, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useLocale } from '@/i18n/LocaleContext'

import type { MemoryAtomicItemDto, MemoryAtomicProvenanceDto, MemoryAtomicType } from '../../../../../shared/memory'
import { MemoryEmptyView } from './MemoryStatusViews'
import { formatDate, memoryFailureText, useAsyncData } from './useMemoryData'

const PAGE_SIZE = 50

const TYPE_FILTERS: Array<{ value: MemoryAtomicType | 'all'; label: string }> = [
  { value: 'all', label: 'memory:atomicMemory.all' },
  { value: 'episodic', label: 'memory:atomicMemory.episodic' },
  { value: 'persona', label: 'memory:atomicMemory.persona' },
  { value: 'instruction', label: 'memory:atomicMemory.instruction' },
]

const TYPE_LABELS: Record<string, string> = {
  episodic: 'memory:atomicMemory.episodic',
  persona: 'memory:atomicMemory.persona',
  instruction: 'memory:atomicMemory.instruction',
}

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type
}

/** 溯源区：kind=conversation → 会话原话；document → 文档名 + 标题路径 + 行区间。 */
function ProvenanceSection({ memoryId, onOpenDocument, onOpenConversation }: {
  memoryId: string
  onOpenDocument?: (documentId: string) => void
  onOpenConversation?: (sessionId: string) => void
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const [provenance, setProvenance] = useState<MemoryAtomicProvenanceDto | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setProvenance(await window.nxcore!.memory.atomicProvenance(memoryId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.unableToLoadProvenance'))
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="mem-provenance-toggle" onClick={() => { setOpen(true); void load() }}>
        <Link2 aria-hidden="true" strokeWidth={1.7} />{t('memory:atomicMemory.provenance')}
      </button>
    )
  }

  const isDocument = provenance?.kind === 'document'
  return (
    <div className="mem-provenance" data-open={open}>
      <header>
        <span className="mem-source-badge" data-kind={provenance?.kind ?? ''}>
          {t(isDocument ? 'memory:atomicMemory.documentSource' : 'memory:atomicMemory.sessionSource')}
        </span>
        <button type="button" className="mem-provenance-close" onClick={() => setOpen(false)}>
          <X aria-hidden="true" strokeWidth={1.7} size={14} />
        </button>
      </header>
      {loading ? <p className="mem-loading">{t('memory:atomicMemory.loadingProvenance')}</p> : null}
      {error ? <p className="mem-inline-error">{error}</p> : null}
      {provenance ? (
        <>
          {isDocument && provenance.document ? (
            <p className="mem-provenance-source">
              {t('memory:atomicMemory.documentTitleVVersion', { title: provenance.document.title, version: provenance.document.version ?? '—' })}
              {onOpenDocument ? (
                <button type="button" onClick={() => onOpenDocument(provenance.document!.documentId)}>{t('memory:atomicMemory.viewDocument')}</button>
              ) : null}
            </p>
          ) : null}
          {!isDocument && provenance.session?.sessionId ? (
            <p className="mem-provenance-source">
              {t('memory:atomicMemory.sessionId', { id: provenance.session.sessionId })}
              {onOpenConversation ? (
                <button
                  type="button"
                  onClick={() => onOpenConversation(provenance.anchors[0]?.sessionId ?? provenance.session!.sessionId!)}
                >
                  {t('memory:atomicMemory.viewSession')}
                </button>
              ) : null}
            </p>
          ) : null}
          <ul className="mem-provenance-anchors">
            {provenance.anchors.map((anchor) => (
              <li key={anchor.messageId}>
                <header>
                  <span data-role={anchor.role}>{anchor.role === 'assistant' ? 'AI' : anchor.role === 'user' ? t('memory:atomicMemory.user') : anchor.role}</span>
                  {anchor.headingPath ? <em>{t('memory:atomicMemory.pathLinesStartEnd', { path: anchor.headingPath, start: anchor.lineStart ?? '—', end: anchor.lineEnd ?? '—' })}</em> : null}
                </header>
                <p>{anchor.content}</p>
              </li>
            ))}
            {provenance.anchors.length === 0 ? (
              <li className="mem-doc-hint">{t('memory:atomicMemory.anchorMessagesWereRemovedTheMemoryRemainsBut')}</li>
            ) : null}
          </ul>
        </>
      ) : null}
    </div>
  )
}

function AtomicDetail({ item, onSaved, onDeleted, onOpenDocument, onOpenConversation }: {
  item: MemoryAtomicItemDto
  onSaved: () => void
  onDeleted: () => void
  onOpenDocument?: (documentId: string) => void
  onOpenConversation?: (sessionId: string) => void
}) {
  const { locale, t } = useLocale()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(item.content)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.updateAtomic(item.id, content, item.background ?? undefined)
      setEditing(false)
      onSaved()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.nxcore!.memory.deleteAtomic([item.id])
      onDeleted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('memory:atomicMemory.deleteFailed'))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mem-atomic-detail">
      <div className="mem-atomic-detail-meta">
        <span className="mem-type-badge" data-type={item.type}>{t(typeLabel(item.type))}</span>
        {item.background ? <span className="mem-source">{t('memory:atomicMemory.sourceScenarioScene', { scene: item.background })}</span> : null}
        <span className="mem-time">{t('memory:atomicMemory.createdCreatedUpdatedUpdated', { created: formatDate(item.createdAt, locale), updated: formatDate(item.updatedAt, locale) })}</span>
        <span className="mem-atomic-detail-actions">
          {editing ? null : (
            <button type="button" onClick={() => { setDraft(item.content); setEditing(true) }}>
              <Pencil aria-hidden="true" strokeWidth={1.7} />{t('memory:atomicMemory.edit')}
            </button>
          )}
          {confirming ? (
            <>
              <button type="button" className="mem-danger" disabled={busy} onClick={remove}>{t('memory:atomicMemory.confirmDelete')}</button>
              <button type="button" onClick={() => setConfirming(false)}>{t('memory:atomicMemory.cancel')}</button>
            </>
          ) : (
            <button type="button" onClick={() => setConfirming(true)} disabled={editing}>
              <Trash2 aria-hidden="true" strokeWidth={1.7} />{t('memory:atomicMemory.delete')}
            </button>
          )}
        </span>
      </div>
      {editing ? (
        <div className="mem-atomic-editor">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} maxLength={8192} />
          <div className="mem-atomic-editor-actions">
            <button type="button" className="mem-primary" disabled={busy || !draft.trim()} onClick={save}>{t('memory:atomicMemory.save')}</button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy}>{t('memory:atomicMemory.cancel')}</button>
          </div>
        </div>
      ) : (
        <p className="mem-atomic-content">{item.content}</p>
      )}
      <ProvenanceSection
        memoryId={item.id}
        onOpenDocument={onOpenDocument}
        onOpenConversation={onOpenConversation}
      />
      {error ? <p className="mem-inline-error">{error}</p> : null}
    </div>
  )
}

export function AtomicMemoryPane({ onOpenDocument, onOpenConversation }: {
  onOpenDocument?: (documentId: string) => void
  onOpenConversation?: (sessionId: string) => void
} = {}) {
  const { locale, t } = useLocale()
  const [type, setType] = useState<MemoryAtomicType | 'all'>('all')
  const [offset, setOffset] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  const listOptions = {
    ...(type === 'all' ? {} : { type }),
    limit: PAGE_SIZE,
    offset,
  }
  const { data, failure, loading } = useAsyncData(
    () => window.nxcore!.memory.listAtomic(listOptions),
    [type, offset, reloadTick],
  )

  const items = data?.items ?? []
  const total = data?.total ?? 0
  const pageStart = offset + 1
  const pageEnd = offset + items.length

  if (failure && !data) {
    return <div className="mem-pane-error">{memoryFailureText(failure, t)}</div>
  }

  return (
    <div className="mem-atomic">
      <div className="mem-toolbar">
        <div className="mem-type-filters" role="tablist" aria-label={t('memory:atomicMemory.memoryType')}>
          {TYPE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              data-active={type === filter.value}
              onClick={() => { setType(filter.value); setOffset(0); setExpandedId(null) }}
            >
              {t(filter.label)}
            </button>
          ))}
        </div>
        <span className="mem-count">{t('memory:atomicMemory.countItems', { count: total })}</span>
        <div className="mem-pager">
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            <ChevronLeft aria-hidden="true" strokeWidth={1.8} />
          </button>
          <span>{loading ? '…' : total === 0 ? '0' : `${pageStart}–${pageEnd} / ${total}`}</span>
          <button type="button" disabled={pageEnd >= total || loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        </div>
      </div>
      {!loading && items.length === 0 ? (
        <MemoryEmptyView
          title={t('memory:atomicMemory.noAtomicMemoriesYet')}
          hint={t(type === 'all' ? 'memory:atomicMemory.afterSeveralConversationsWithTheAiAssistantMemorycore' : 'memory:atomicMemory.noMemoriesOfThisType')}
        />
      ) : (
        <ul className="mem-atomic-list">
          {items.map((item) => (
            <li key={item.id} className="mem-atomic-item">
              <button
                type="button"
                className="mem-atomic-summary"
                data-expanded={expandedId === item.id}
                onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
              >
                <span className="mem-type-badge" data-type={item.type}>{t(typeLabel(item.type))}</span>
                <span className="mem-atomic-text">{item.content}</span>
                <span className="mem-time">{formatDate(item.updatedAt, locale)}</span>
              </button>
              {expandedId === item.id ? (
                <AtomicDetail
                  item={item}
                  onSaved={() => setReloadTick((tick) => tick + 1)}
                  onDeleted={() => { setExpandedId(null); setReloadTick((tick) => tick + 1) }}
                  onOpenDocument={onOpenDocument}
                  onOpenConversation={onOpenConversation}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
