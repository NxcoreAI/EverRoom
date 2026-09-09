import type {
  DocumentDiffResult,
  DocumentVersionSnapshot,
  DocumentVersionSummary,
  ImportCandidateDiffView,
  RoomDocument,
} from '@nxcore/agent-contract'
import { Check, ChevronDown, Clock3, CloudDownload, History, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { showToast } from '../../../../../state/toast'
import { useLocale } from '../../../../../i18n/LocaleContext'
import { SourceIcon } from '../../../../pages/sources/SourceIcon'

/** 时间轴上的"导入版本"卡片数据（未应用候选）。 */
interface PendingImportVersion {
  roomImportId: string
  provider: 'feishu' | 'notion'
  title: string
  capturedAt: string
}

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
  onShowDiff: (
    snapshot: DocumentVersionSnapshot,
    diff: DocumentDiffResult,
    importCandidate?: ImportCandidateDiffView['candidate'],
  ) => void
  onClearDiff: () => void
  onCloseDiff: () => void
  closeSignal: number
  refreshSignal: number
}) {
  const { locale, t } = useLocale()
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<DocumentVersionSummary[]>([])
  const [pendingImports, setPendingImports] = useState<PendingImportVersion[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null)
  const [collapsedDates, setCollapsedDates] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [summaries, setSummaries] = useState<Record<number, string>>({})
  const summaryRequestedRef = useRef<Set<number>>(new Set())
  const [hasMore, setHasMore] = useState(false)
  const historyRequestGenerationRef = useRef(0)
  // 统一时间轴：本地版本与导入候选按时间混排（导入按捕获时间插入对应
  // 日期分组），UI 上共用同一条版本时间轴。
  const timelineGroups = useMemo(() => {
    const items: Array<{ kind: 'version'; version: DocumentVersionSummary; at: number }
      | { kind: 'import'; candidate: PendingImportVersion; at: number }> = [
      ...versions.map((version) => ({ kind: 'version' as const, version, at: Date.parse(version.createdAt) || 0 })),
      ...pendingImports.map((candidate) => ({ kind: 'import' as const, candidate, at: Date.parse(candidate.capturedAt) || 0 })),
    ]
    items.sort((left, right) => right.at - left.at)
    const groups = new Map<string, typeof items>()
    for (const item of items) {
      const date = new Date(item.at || Date.now())
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const group = groups.get(key)
      if (group) group.push(item)
      else groups.set(key, [item])
    }
    return [...groups.entries()]
  }, [pendingImports, versions])

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
        // 保存时已落库的概览立即显示（重要变更为 AI 概览，不重要变更为本地
        // 规则摘要占位）；非 AI 的稍后由懒加载升级。服务端值比会话内缓存新。
        const prefilled: Record<number, string> = {}
        for (const version of result) {
          if (version.changeSummary) prefilled[version.version] = version.changeSummary
          summaryRequestedRef.current.delete(version.version)
        }
        setSummaries((current) => ({ ...current, ...prefilled }))
        setHasMore(result.length === HISTORY_PAGE_SIZE)
        setSelected(null)
        setSelectedImportId(null)
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

  // 外部导入：候选混排进时间轴；"检查外部更新"按钮（仅导入过的文档显示）
  // 也在本面板内。顺带做陈旧检测——服务端版本比当前高（外部应用过候选）
  // 时触发文档数据刷新，让编辑器同步新内容。
  const [hasImportSource, setHasImportSource] = useState(false)
  const [importRefreshTick, setImportRefreshTick] = useState(0)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  useEffect(() => {
    if (!open || !currentDocument) return
    let cancelled = false
    void window.nxcore?.externalDocuments?.importHistory(currentDocument.roomId, currentDocument.id)
      .then((result) => {
        if (cancelled) return
        setPendingImports(result.entries
          .filter((entry) => entry.relation === 'candidate' && entry.importedVersion === null)
          .map((entry) => ({
            roomImportId: entry.roomImportId,
            provider: entry.provider,
            title: entry.displayTitle,
            capturedAt: entry.capturedAt,
          })))
        setHasImportSource(result.entries.length > 0)
      })
      .catch(() => {
        if (!cancelled) {
          setPendingImports([])
          setHasImportSource(false)
        }
      })
    const documents = window.nxcore?.documents
    if (documents) {
      void documents.get(currentDocument.id)
        .then((latest) => {
          if (cancelled || latest.version <= currentDocument.version) return
          window.dispatchEvent(new CustomEvent('everroom:documents-refresh', {
            detail: { roomId: currentDocument.roomId, documentId: currentDocument.id },
          }))
        })
        .catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [currentDocument, open, refreshSignal, importRefreshTick])

  const checkExternalUpdate = () => {
    const external = window.nxcore?.externalDocuments
    if (!external || !currentDocument || checkingUpdate) return
    setCheckingUpdate(true)
    void external.checkExternalUpdate(currentDocument.roomId, currentDocument.id)
      .then((result) => {
        showToast({
          title: result.noChange
            ? t('contextRoom:importHistory.noRemoteUpdate')
            : t('contextRoom:importHistory.candidateCreated'),
          message: result.noChange ? undefined : t('contextRoom:importHistory.compareThenApply'),
        })
        setImportRefreshTick((value) => value + 1)
      })
      .catch((error: unknown) => {
        showToast({ title: t('contextRoom:importHistory.checkFailed'), message: error instanceof Error ? error.message : undefined })
      })
      .finally(() => setCheckingUpdate(false))
  }

  const openImportDiff = (roomImportId: string) => {
    const external = window.nxcore?.externalDocuments
    if (!external) return
    setSelected(null)
    setSelectedImportId(roomImportId)
    void external.importStructuredDiff(roomImportId)
      .then((result) => {
        onShowDiff(result.snapshot, result.diff, result.candidate)
      })
      .catch((error: unknown) => {
        setSelectedImportId(null)
        showToast({ title: t('contextRoom:importHistory.checkFailed'), message: error instanceof Error ? error.message : undefined })
      })
  }

  // AI 概览标题：面板打开后按批懒加载（每批 4 个，每版本一次，缓存）。
  // 没有摘要的版本生成概览；只有本地占位摘要（不重要变更保存时落库）的
  // 版本升级为 AI 概览。summaries 变化会带动下一批继续，避免首批之后停摆。
  useEffect(() => {
    if (!open) return
    const documents = window.nxcore?.documents
    if (!documents) return
    const pending = versions
      .filter((version) => version.changeSummarySource !== 'ai' && !summaryRequestedRef.current.has(version.version))
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
  }, [open, versions, documentId, summaries])

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
                  <small>{t('contextRoom:documentHistory.versionCount', { count: versions.length + pendingImports.length })}</small>
                  {hasImportSource ? (
                    <button
                      type="button"
                      className="context-room-history-import-check"
                      disabled={checkingUpdate}
                      onClick={checkExternalUpdate}
                      title={t('contextRoom:importHistory.checkExternalUpdate')}
                    >
                      {checkingUpdate ? <span className="context-room-history-import-check-spin" aria-hidden="true" /> : <CloudDownload aria-hidden="true" />}
                      {t('contextRoom:importHistory.checkExternalUpdate')}
                    </button>
                  ) : null}
                </div>
                {loading ? <div className="context-room-history-loading" role="status"><span /><span /><span /></div> : null}
                {!loading && !versions.length && !pendingImports.length ? <p className="context-room-history-empty">{t('contextRoom:documentHistory.empty')}</p> : null}
                {!loading && timelineGroups.map(([key, group]) => {
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
                      {!collapsed ? group.map((item) => item.kind === 'import' ? (
                        <button
                          type="button"
                          key={`import-${item.candidate.roomImportId}`}
                          className={`context-room-history-version context-room-history-import-version${selectedImportId === item.candidate.roomImportId ? ' is-selected' : ''}`}
                          onClick={() => openImportDiff(item.candidate.roomImportId)}
                        >
                          <span className="context-room-history-version-rail is-import" aria-hidden="true"><CloudDownload aria-hidden="true" /></span>
                          <span className="context-room-history-version-copy">
                            <span className="context-room-history-import-title-row">
                              <span className="context-room-history-version-title">{item.candidate.title}</span>
                              <em className="context-room-history-import-badge">
                                <SourceIcon kind={item.candidate.provider} className="glyph" aria-hidden="true" />
                                {t('contextRoom:importHistory.pendingImportVersion')}
                              </em>
                            </span>
                            <span className="context-room-history-version-summary" data-loaded="true">
                              {t('contextRoom:importHistory.importCandidateSummary')}
                            </span>
                            <span className="context-room-history-version-meta"><Clock3 aria-hidden="true" />{new Date(item.candidate.capturedAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                          </span>
                        </button>
                      ) : (() => {
                        const version = item.version
                        return (
                        <button
                          type="button"
                          key={version.version}
                          className={`context-room-history-version${selected === version.version ? ' is-selected' : ''}`}
                          data-current={String(version.version === currentDocument?.version)}
                          onClick={() => {
                            setSelected(version.version)
                            setSelectedImportId(null)
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
                              {summaries[version.version] ?? <i className="context-room-history-summary-skeleton" aria-hidden="true" />}
                            </span>
                            <span className="context-room-history-version-meta"><Clock3 aria-hidden="true" />{versionDate(version, locale)}</span>
                          </span>
                        </button>
                        )
                      })()) : null}
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
</aside>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
