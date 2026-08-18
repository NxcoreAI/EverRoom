import { AlertCircle, ChevronRight, FileClock, RefreshCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { requestDocumentOperationNavigation } from './documentOperationNavigation'
import { useDocumentOperations } from './DocumentOperationProvider'
import './DocumentOperationCenter.css'

const visibleStatuses = new Set(['awaiting_review', 'conflicted', 'failed'])
const statusCopy: Record<string, string> = {
  awaiting_review: '等待审阅',
  conflicted: '存在冲突',
  failed: '执行失败',
}

export function DocumentOperationCenter({ activeRoomId }: { activeRoomId: string | null }) {
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
        aria-label="Agent 文档操作"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <FileClock aria-hidden="true" />
        {active.length ? <span>{active.length}</span> : null}
      </button>
      {open ? (
        <aside className="document-operation-center-panel" aria-label="Agent 文档操作中心">
          <header>
            <div><strong>文档操作</strong><span>{filtered.length} 项待处理</span></div>
            <button type="button" aria-label="关闭操作中心" onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
          </header>
          <div className="document-operation-center-filters">
            <select aria-label="按 Room 筛选" value={roomFilter} onChange={(event) => { setRoomFilter(event.target.value); setDocumentFilter('') }}>
              <option value="">全部 Room</option>
              {rooms.map((roomId) => <option key={roomId} value={roomId}>{roomId}</option>)}
            </select>
            <select aria-label="按文档筛选" value={documentFilter} onChange={(event) => setDocumentFilter(event.target.value)}>
              <option value="">全部文档</option>
              {documents.map((entry) => <option key={entry.id} value={entry.summary.documentId ?? ''}>{entry.summary.documentTitle}</option>)}
            </select>
            <select aria-label="按能力筛选" value={capabilityFilter} onChange={(event) => setCapabilityFilter(event.target.value)}>
              <option value="">全部能力</option>
              {capabilities.map((capability) => <option key={capability} value={capability}>{capability}</option>)}
            </select>
            <select aria-label="按会话筛选" value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)}>
              <option value="">全部会话</option>
              {sessions.map((sessionId) => <option key={sessionId} value={sessionId}>{sessionId}</option>)}
            </select>
            <button type="button" aria-label="刷新操作" onClick={() => void refresh()}><RefreshCw aria-hidden="true" /></button>
          </div>
          <div className="document-operation-center-list">
            {filtered.length ? filtered.map((entry) => (
              <button type="button" className="document-operation-row" key={entry.id} onClick={() => void navigate(entry.id)}>
                <span className="document-operation-row-state" data-status={entry.summary.status}>
                  <AlertCircle aria-hidden="true" />
                </span>
                <span className="document-operation-row-copy">
                  <strong>{entry.summary.documentTitle || '未命名文档'}</strong>
                  <span>{entry.summary.summary || entry.summary.capabilityId}</span>
                  <small>{statusCopy[entry.summary.status] ?? entry.summary.status} · r{entry.revision}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            )) : <p className="document-operation-center-empty">没有待处理的文档操作</p>}
          </div>
        </aside>
      ) : null}
    </div>
  )
}
