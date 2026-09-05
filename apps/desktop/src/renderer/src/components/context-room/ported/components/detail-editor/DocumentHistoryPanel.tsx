import type {
  DocumentDiffResult,
  DocumentVersionSnapshot,
  DocumentVersionSummary,
  RoomDocument,
} from '@nxcore/agent-contract'
import { Check, ChevronDown, Clock3, History, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { showToast } from '../../../../../state/toast'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { DocumentImportHistorySection } from './DocumentImportHistorySection'

const HISTORY_PAGE_SIZE = 100

function versionDate(version: DocumentVersionSummary, locale: string): string {
  return new Date(version.createdAt).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function dateKey(version: DocumentVersionSummary): string {
  const date = new Date(version.createdAt)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dateLabel(key: string, locale: string, t: (message: string) => string): string {
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  const today = new Date()
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const distance = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000)
  if (distance === 0) return t('contextRoom:documentHistory.today')
  if (distance === 1) return t('contextRoom:documentHistory.yesterday')
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' })
}

export function DocumentHistoryPanel({
  documentId,
  currentDocument,
  onShowDiff,
  onClearDiff,
  onCloseDiff,
  closeSignal,
  refreshSignal,
}: {
  documentId: string
  currentDocument: RoomDocument | null
  onShowDiff: (snapshot: DocumentVersionSnapshot, diff: DocumentDiffResult) => void
  onClearDiff: () => void
  onCloseDiff: () => void
  closeSignal: number
  refreshSignal: number
}) {
  const { locale, t } = useLocale()
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<DocumentVersionSummary[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [collapsedDates, setCollapsedDates] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [summaries, setSummaries] = useState<Record<number, string>>({})
  const summaryRequestedRef = useRef<Set<number>>(new Set())
  const [hasMore, setHasMore] = useState(false)
  const historyRequestGenerationRef = useRef(0)
  const versionGroups = useMemo(() => {
    const groups = new Map<string, DocumentVersionSummary[]>()
    for (const version of versions) {
      const key = dateKey(version)
      const group = groups.get(key)
      if (group) group.push(version)
      else groups.set(key, [version])
    }
    return [...groups.entries()]
  }, [versions])

  useEffect(() => {
    const requestGeneration = historyRequestGenerationRef.current + 1
    historyRequestGenerationRef.current = requestGeneration
    if (!open) return
    let cancelled = false
    setLoading(true)
    setLoadingMore(false)
    setVersions([])
    setHasMore(false)
    const documents = window.nxcore?.documents
    if (!documents) return () => { cancelled = true }
    void documents.listVersions(documentId, { limit: HISTORY_PAGE_SIZE })
      .then((result) => {
        if (cancelled || historyRequestGenerationRef.current !== requestGeneration) return
        setVersions(result)
        // 保存时已自动生成的重要变更概览立即显示；其余保持空待懒加载。
        const prefilled: Record<number, string> = {}
        for (const version of result) {
          if (version.changeSummary) prefilled[version.version] = version.changeSummary
          summaryRequestedRef.current.delete(version.version)
        }
        setSummaries((current) => ({ ...prefilled, ...current }))
        setHasMore(result.length === HISTORY_PAGE_SIZE)
        setSelected(null)
        setCollapsedDates(new Set())
      })
      .catch((error: unknown) => {
        if (!cancelled && historyRequestGenerationRef.current === requestGeneration) showToast({ title: t('contextRoom:documentHistory.loadingFailed'), message: error instanceof Error ? error.message : t('contextRoom:documentHistory.tryAgain') })
      })
      .finally(() => {
        if (!cancelled && historyRequestGenerationRef.current === requestGeneration) setLoading(false)
      })
    return () => { cancelled = true }
  }, [currentDocument?.version, documentId, open, refreshSignal, t])

  const loadMore = () => {
    if (!open || loading || loadingMore || !hasMore) return
    const beforeVersion = versions.at(-1)?.version
    const documents = window.nxcore?.documents
    if (!documents || beforeVersion === undefined) return
    const requestGeneration = historyRequestGenerationRef.current
    setLoadingMore(true)
    void documents.listVersions(documentId, {
      limit: HISTORY_PAGE_SIZE,
      beforeVersion,
    }).then((result) => {
      if (historyRequestGenerationRef.current !== requestGeneration) return
      setVersions((current) => {
        const seen = new Set(current.map((version) => version.version))
        return [...current, ...result.filter((version) => !seen.has(version.version))]
      })
      setHasMore(result.length === HISTORY_PAGE_SIZE)
    }).catch((error: unknown) => {
      if (historyRequestGenerationRef.current !== requestGeneration) return
      showToast({ title: t('contextRoom:documentHistory.earlierLoadingFailed'), message: error instanceof Error ? error.message : t('contextRoom:documentHistory.tryAgain') })
    }).finally(() => {
      if (historyRequestGenerationRef.current === requestGeneration) setLoadingMore(false)
    })
  }

  useEffect(() => {
    if (!open || selected === null) return
    let cancelled = false
    void Promise.all([
      window.nxcore?.documents.getVersionSnapshot(documentId, selected),
      currentDocument && selected !== currentDocument.version
        ? window.nxcore?.documents.getDiff(documentId, selected, currentDocument.version)
        : Promise.resolve(null),
    ]).then(([nextSnapshot, nextDiff]) => {
      if (cancelled) return
      if (nextSnapshot && nextDiff) {
        onShowDiff(nextSnapshot, nextDiff)
      }
    }).catch((error: unknown) => {
      if (!cancelled) showToast({ title: t('contextRoom:documentHistory.readFailed'), message: error instanceof Error ? error.message : t('contextRoom:documentHistory.tryAgain') })
    })
    return () => { cancelled = true }
  }, [currentDocument, documentId, onShowDiff, onClearDiff, open, selected, t])

  useEffect(() => {
    if (closeSignal > 0) {
      historyRequestGenerationRef.current += 1
      setOpen(false)
    }
  }, [closeSignal])

  // AI 概览标题：按需加载（每版本一次，缓存；AI 不可用时网关回本地规则摘要）。
  useEffect(() => {
    if (!open) return
    const documents = window.nxcore?.documents
    if (!documents) return
    const pending = versions
      .filter((version) => !version.changeSummary && !summaryRequestedRef.current.has(version.version))
      .slice(0, 4)
    if (pending.length === 0) return
    for (const version of pending) summaryRequestedRef.current.add(version.version)
    for (const version of pending) {
      void documents.versionChangeSummary(documentId, version.version)
        .then((result) => {
          setSummaries((current) => ({ ...current, [version.version]: result.summary }))
        })
        .catch(() => undefined)
    }
  }, [open, versions, documentId])

  const closePanel = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    // The navigator and editor Diff are one browsing mode: closing either
    // surface exits both together.
    historyRequestGenerationRef.current += 1
    setOpen(false)
    onCloseDiff()
  }

  return (
    <>
      <button type="button" aria-label={t('contextRoom:documentHistory.open')} title={t('contextRoom:documentHistory.open')} onClick={() => setOpen(true)}>
        <History aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="context-room-history-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={t('contextRoom:documentHistory.title')}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="context-room-history-panel">
            <header>
              <div className="context-room-history-heading">
                <span className="context-room-history-heading-icon"><History aria-hidden="true" /></span>
                <div>
                  <strong>{t('contextRoom:documentHistory.title')}</strong>
                  <small>{currentDocument ? t('contextRoom:documentHistory.currentVersion', { version: currentDocument.version }) : t('contextRoom:documentHistory.snapshot')}</small>
                </div>
              </div>
              <button type="button" aria-label={t('contextRoom:documentHistory.close')} title={t('contextRoom:documentHistory.close')} onClick={closePanel}><X aria-hidden="true" /></button>
            </header>
            <div className="context-room-history-body">
              <aside>
                <div className="context-room-history-list-heading">
                  <span>{t('contextRoom:documentHistory.versionList')}</span>
                  <small>{t('contextRoom:documentHistory.versionCount', { count: versions.length })}</small>
                </div>
                {loading ? <div className="context-room-history-loading" role="status"><span /><span /><span /></div> : null}
                {!loading && !versions.length ? <p className="context-room-history-empty">{t('contextRoom:documentHistory.empty')}</p> : null}
                {!loading && versionGroups.map(([key, group]) => {
                  const collapsed = collapsedDates.has(key)
                  return (
                    <section
                      className="context-room-history-date-group"
                      data-collapsed={String(collapsed)}
                      key={key}
                    >
                      <button
                        type="button"
                        className="context-room-history-date-toggle"
                        aria-expanded={!collapsed}
                        onClick={() => setCollapsedDates((current) => {
                          const next = new Set(current)
                          if (next.has(key)) next.delete(key)
                          else next.add(key)
                          return next
                        })}
                      >
                        <ChevronDown aria-hidden="true" />
                        <span>{dateLabel(key, locale, t)}</span>
                        <small>{group.length}</small>
                      </button>
                      {!collapsed ? group.map((version) => (
                        <button
                          type="button"
                          key={version.version}
                          className={`context-room-history-version${selected === version.version ? ' is-selected' : ''}`}
                          data-current={String(version.version === currentDocument?.version)}
                          onClick={() => {
                            setSelected(version.version)
                            if (version.version === currentDocument?.version) onClearDiff()
                          }}
                        >
                          <span className="context-room-history-version-rail" aria-hidden="true"><i /></span>
                          <span className="context-room-history-version-copy">
                            <span className="context-room-history-version-topline">
                              {version.version === currentDocument?.version ? <em><Check aria-hidden="true" />{t('contextRoom:documentHistory.current')}</em> : null}
                            </span>
                            <span className="context-room-history-version-title">{version.title || t('contextRoom:documentHistory.untitled')}</span>
                            <span
                              className="context-room-history-version-summary"
                              data-loaded={String(Boolean(summaries[version.version]))}
                              title={version.version === 1 ? undefined : t('contextRoom:documentHistory.summaryTitle')}
                            >
                              {summaries[version.version] ?? ''}
                            </span>
                            <span className="context-room-history-version-meta"><Clock3 aria-hidden="true" />{versionDate(version, locale)}</span>
                          </span>
                        </button>
                      )) : null}
                    </section>
                  )
                  })}
                {!loading && hasMore ? (
                  <button
                    type="button"
                    className="context-room-history-load-more"
                    disabled={loadingMore}
                    onClick={loadMore}
                  >
                    {loadingMore ? t('contextRoom:documentHistory.loading') : t('contextRoom:documentHistory.loadEarlier')}
                  </button>
                ) : null}
                {currentDocument && (
                  <DocumentImportHistorySection
                    roomId={currentDocument.roomId}
                    currentDocument={currentDocument}
                    refreshSignal={refreshSignal}
                    onApplied={onClearDiff}
                  />
                )}
              </aside>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
