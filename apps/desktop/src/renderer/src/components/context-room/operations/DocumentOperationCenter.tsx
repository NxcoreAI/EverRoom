import { AlertCircle, ChevronRight, FileClock, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocale } from '../../../i18n/LocaleContext'

import { requestDocumentOperationNavigation } from './documentOperationNavigation'
import { useDocumentOperations } from './DocumentOperationProvider'
import './DocumentOperationCenter.css'

const visibleStatuses = new Set(['awaiting_review', 'conflicted', 'failed'])
const statusCopy: Record<string, string> = {
  awaiting_review: 'contextRoom:documentOperationCenter.awaitingReview',
  conflicted: 'contextRoom:documentOperationCenter.conflicted',
  failed: 'contextRoom:documentOperationCenter.executionFailed',
}

export function DocumentOperationCenter({ activeRoomId }: { activeRoomId: string | null }) {
  const { t } = useLocale()
  const { operations, refresh } = useDocumentOperations()
  const [open, setOpen] = useState(false)
  const [roomFilter, setRoomFilter] = useState(activeRoomId ?? '')
  const [documentFilter, setDocumentFilter] = useState('')
  const [sessionFilter, setSessionFilter] = useState('')
  const [capabilityFilter, setCapabilityFilter] = useState('')
  useEffect(() => {
    setRoomFilter(activeRoomId ?? '')
    setDocumentFilter('')
    setSessionFilter('')
  }, [activeRoomId])
  const active = useMemo(
    () => operations.filter((entry) => visibleStatuses.has(entry.summary.status)),
    [operations],
  )
  const rooms = useMemo(
    () => [...new Set(active.map((entry) => entry.summary.roomId))],
    [active],
  )
  const documents = useMemo(
    () => active.filter((entry) => !roomFilter || entry.summary.roomId === roomFilter),
    [active, roomFilter],
  )
  const capabilities = useMemo(
    () => [...new Set(active.map((entry) => entry.summary.capabilityId))],
    [active],
  )
  const sessions = useMemo(
    () => [...new Set(active.map((entry) => entry.summary.sessionId))],
    [active],
  )
  const filtered = active
    .filter((entry) => !roomFilter || entry.summary.roomId === roomFilter)
    .filter((entry) => !documentFilter || entry.summary.documentId === documentFilter)
    .filter((entry) => !sessionFilter || entry.summary.sessionId === sessionFilter)
    .filter((entry) => !capabilityFilter || entry.summary.capabilityId === capabilityFilter)

  const navigate = async (operationId: string) => {
    const entry = operations.find((candidate) => candidate.id === operationId)
    if (!entry?.summary.documentId) return
    requestDocumentOperationNavigation({
      roomId: entry.summary.roomId,
      documentId: entry.summary.documentId,
      operationId: entry.id,
    })
    setOpen(false)
  }

  return (
    <div className="document-operation-center" data-open={String(open)}>
      <button
        type="button"
        className="document-operation-center-trigger"
        aria-label={t('contextRoom:documentOperationCenter.agentDocumentOperations')}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FileClock aria-hidden="true" />
        {active.length ? <span>{active.length}</span> : null}
      </button>
      {open ? (
        <aside className="document-operation-center-panel" aria-label={t('contextRoom:documentOperationCenter.agentDocumentOperationsCenter')}>
          <header>
            <div><strong>{t('contextRoom:documentOperationCenter.documentOperations')}</strong><span>{t('contextRoom:documentOperationCenter.countPending', { count: filtered.length })}</span></div>
            <button type="button" aria-label={t('contextRoom:documentOperationCenter.closeOperationsCenter')} onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
          </header>
          <div className="document-operation-center-filters">
            <select aria-label={t('contextRoom:documentOperationCenter.filterByRoom')} value={roomFilter} onChange={(event) => { setRoomFilter(event.target.value); setDocumentFilter('') }}>
              <option value="">{t('contextRoom:documentOperationCenter.allRooms')}</option>
              {rooms.map((roomId) => <option key={roomId} value={roomId}>{roomId}</option>)}
            </select>
            <select aria-label={t('contextRoom:documentOperationCenter.filterByDocument')} value={documentFilter} onChange={(event) => setDocumentFilter(event.target.value)}>
              <option value="">{t('contextRoom:documentOperationCenter.allDocuments')}</option>
              {documents.map((entry) => <option key={entry.id} value={entry.summary.documentId ?? ''}>{entry.summary.documentTitle}</option>)}
            </select>
            <select aria-label={t('contextRoom:documentOperationCenter.filterByCapability')} value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)}>
              <option value="">{t('contextRoom:documentOperationCenter.allCapabilities')}</option>
              {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}
            </select>
            <select aria-label={t('contextRoom:documentOperationCenter.filterBySession')} value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)}>
              <option value="">{t('contextRoom:documentOperationCenter.allSessions')}</option>
              {sessions.map((sessionId) => <option key={sessionId} value={sessionId}>{sessionId}</option>)}
            </select>
            <button type="button" aria-label={t('contextRoom:documentOperationCenter.refreshOperations')} onClick={() => void refresh()}><RefreshCw aria-hidden="true" /></button>
          </div>
          <div className="document-operation-center-list">
            {filtered.length ? filtered.map((entry) => (
              <button type="button" className="document-operation-row" key={entry.id} onClick={() => void navigate(entry.id)}>
                <span className="document-operation-row-state" data-status={entry.summary.status}>
                  <AlertCircle aria-hidden="true" />
                </span>
                <span className="document-operation-row-copy">
                  <strong>{entry.summary.documentTitle || t('contextRoom:documentOperationCenter.untitledDocument')}</strong>
                  <span>{entry.summary.summary || entry.summary.capabilityId}</span>
                  <small>{t(statusCopy[entry.summary.status] ?? entry.summary.status)} · r{entry.revision}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            )) : <p className="document-operation-center-empty">{t('contextRoom:documentOperationCenter.noPendingDocumentOperations')}</p>}
          </div>
        </aside>
      ) : null}
    </div>
  )
}
