import { Check, MessageSquarePlus, Quote, X } from 'lucide-react'
import { type FormEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { useLocale } from '@/i18n/LocaleContext'

import {
  addRoomOverviewCitation,
  isRoomOverviewCitationSection,
  ROOM_OVERVIEW_CITATION_CLEAR_EVENT,
  type RoomOverviewCitation,
  type RoomOverviewCitationSection,
} from './roomOverviewCitation'

const CITATION_HIGHLIGHT_NAME = 'room-overview-citation'
const PENDING_HIGHLIGHT_NAME = 'room-overview-citation-pending'
const MAX_CITATION_LENGTH = 8_000
const MAX_COMMENT_LENGTH = 500
const ACTION_WIDTH = 160
const COMMENT_EDITOR_WIDTH = 320

type ViewportPoint = { top: number; left: number }

export type RoomOverviewTextSelection = ViewportPoint & {
  range: Range
  section: RoomOverviewCitationSection
  text: string
  claimRefs: Array<{ claimId: string; text: string }>
}

type PendingCitation = RoomOverviewTextSelection & {
  comment: string
  editorPoint: ViewportPoint
}

type CitationBadge = {
  citation: RoomOverviewCitation
  point: ViewportPoint
}

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null
}

function horizontalPoint(rect: Pick<DOMRect, 'left' | 'width'>, width: number): number {
  return Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))
}

function actionPoint(rect: DOMRect | Pick<DOMRect, 'top' | 'left' | 'width'>): ViewportPoint {
  return {
    top: Math.max(8, rect.top - 38),
    left: horizontalPoint(rect, ACTION_WIDTH),
  }
}

function commentEditorPoint(
  rect: DOMRect | Pick<DOMRect, 'bottom' | 'left' | 'width'>,
): ViewportPoint {
  return {
    top: Math.max(8, Math.min(window.innerHeight - 104, rect.bottom + 8)),
    left: horizontalPoint(rect, COMMENT_EDITOR_WIDTH),
  }
}

export function roomOverviewCitationBadgePoint(
  rect: DOMRect | Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom'>,
): ViewportPoint | null {
  if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) return null
  return {
    top: Math.max(4, rect.bottom - 7),
    left: Math.max(4, Math.min(window.innerWidth - 22, rect.right - 5)),
  }
}

export function readRoomOverviewTextSelection(
  root: HTMLElement,
  selection: Selection | null,
): RoomOverviewTextSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const anchor = elementOf(selection.anchorNode)?.closest<HTMLElement>('[data-room-citation-section]')
  const focus = elementOf(selection.focusNode)?.closest<HTMLElement>('[data-room-citation-section]')
  const section = anchor?.dataset.roomCitationSection
  if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)
    || section !== focus.dataset.roomCitationSection || !isRoomOverviewCitationSection(section)) {
    return null
  }

  const text = selection.toString().replace(/\s+/g, ' ').trim().slice(0, MAX_CITATION_LENGTH)
  const range = selection.getRangeAt(0).cloneRange()
  const rect = range.getBoundingClientRect()
  if (!text || rect.width === 0 || rect.height === 0) return null

  const selectionNodes = new Set([elementOf(selection.anchorNode), elementOf(selection.focusNode)])
  const claimRefs = [...anchor.querySelectorAll<HTMLElement>('[data-room-citation-claim-id]')]
    .filter((element) => {
      if (typeof range.intersectsNode === 'function') return range.intersectsNode(element)
      return [...selectionNodes].some((node) => node && (element === node || element.contains(node)))
    })
    .map((element) => ({
      claimId: element.dataset.roomCitationClaimId?.trim() ?? '',
      text: (element.dataset.roomCitationClaimText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((claim) => claim.claimId && claim.text)

  return { range, section, text, claimRefs, ...actionPoint(rect) }
}

function highlightRegistry(): { delete: (name: string) => void; set: (name: string, value: unknown) => void } | undefined {
  return (globalThis.CSS as unknown as {
    highlights?: { delete: (name: string) => void; set: (name: string, value: unknown) => void }
  } | undefined)?.highlights
}

function createHighlight(ranges: Range[]): unknown {
  const HighlightConstructor = (window as unknown as { Highlight?: new (...values: Range[]) => unknown }).Highlight
  return HighlightConstructor ? new HighlightConstructor(...ranges) : null
}

export function RoomOverviewCitationControls({
  rootRef,
  roomId,
  roomTitle,
}: {
  rootRef: RefObject<HTMLElement>
  roomId: string
  roomTitle: string
}) {
  const { t } = useLocale()
  const citedRangesRef = useRef(new Map<string, Range>())
  const previousRoomIdRef = useRef(roomId)
  const commentInputRef = useRef<HTMLInputElement>(null)
  const [selectionOverlay, setSelectionOverlay] = useState<RoomOverviewTextSelection | null>(null)
  const [pendingCitation, setPendingCitation] = useState<PendingCitation | null>(null)
  const [citations, setCitations] = useState<RoomOverviewCitation[]>([])
  const [citationBadges, setCitationBadges] = useState<CitationBadge[]>([])

  const syncCommittedHighlight = useCallback(() => {
    const registry = highlightRegistry()
    const ranges = [...citedRangesRef.current.values()]
    const highlight = createHighlight(ranges)
    if (highlight && ranges.length) registry?.set(CITATION_HIGHLIGHT_NAME, highlight)
    else registry?.delete(CITATION_HIGHLIGHT_NAME)
  }, [])

  const syncPositions = useCallback(() => {
    setCitationBadges(citations.flatMap((citation) => {
      const rect = citedRangesRef.current.get(citation.id)?.getBoundingClientRect()
      const point = rect ? roomOverviewCitationBadgePoint(rect) : null
      return point ? [{ citation, point }] : []
    }))
    setPendingCitation((current) => {
      if (!current) return null
      const rect = current.range.getBoundingClientRect()
      return { ...current, editorPoint: commentEditorPoint(rect) }
    })
  }, [citations])

  const cancelPendingCitation = useCallback(() => {
    highlightRegistry()?.delete(PENDING_HIGHLIGHT_NAME)
    setPendingCitation(null)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return undefined
    const readSelection = () => setSelectionOverlay(readRoomOverviewTextSelection(root, document.getSelection()))
    const handleViewportChange = () => {
      setSelectionOverlay(null)
      syncPositions()
    }
    root.addEventListener('mouseup', readSelection)
    root.addEventListener('keyup', readSelection)
    root.addEventListener('scroll', handleViewportChange, { passive: true })
    window.addEventListener('resize', handleViewportChange)
    return () => {
      root.removeEventListener('mouseup', readSelection)
      root.removeEventListener('keyup', readSelection)
      root.removeEventListener('scroll', handleViewportChange)
      window.removeEventListener('resize', handleViewportChange)
    }
  }, [rootRef, syncPositions])

  useEffect(() => {
    const clear = (event: Event) => {
      const citationId = (event as CustomEvent<string>).detail
      if (!citedRangesRef.current.delete(citationId)) return
      setCitations((current) => current.filter((citation) => citation.id !== citationId))
      setCitationBadges((current) => current.filter(({ citation }) => citation.id !== citationId))
    }
    window.addEventListener(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, clear as EventListener)
    return () => window.removeEventListener(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, clear as EventListener)
  }, [])

  useEffect(() => {
    syncCommittedHighlight()
    syncPositions()
  }, [citations, syncCommittedHighlight, syncPositions])

  useEffect(() => {
    if (pendingCitation) commentInputRef.current?.focus()
  }, [pendingCitation])

  useEffect(() => {
    if (previousRoomIdRef.current === roomId) return
    previousRoomIdRef.current = roomId
    citedRangesRef.current.clear()
    setCitations([])
    setCitationBadges([])
    setSelectionOverlay(null)
    cancelPendingCitation()
    highlightRegistry()?.delete(CITATION_HIGHLIGHT_NAME)
  }, [cancelPendingCitation, roomId])

  useEffect(() => () => {
    highlightRegistry()?.delete(CITATION_HIGHLIGHT_NAME)
    highlightRegistry()?.delete(PENDING_HIGHLIGHT_NAME)
  }, [])

  const openCommentEditor = useCallback(() => {
    if (!selectionOverlay) return
    cancelPendingCitation()
    const rect = selectionOverlay.range.getBoundingClientRect()
    const highlight = createHighlight([selectionOverlay.range])
    if (highlight) highlightRegistry()?.set(PENDING_HIGHLIGHT_NAME, highlight)
    setPendingCitation({
      ...selectionOverlay,
      comment: '',
      editorPoint: commentEditorPoint(rect),
    })
    setSelectionOverlay(null)
    document.getSelection()?.removeAllRanges()
  }, [cancelPendingCitation, selectionOverlay])

  const addPendingCitation = useCallback((event?: FormEvent) => {
    event?.preventDefault()
    if (!pendingCitation) return
    const id = crypto.randomUUID()
    const comment = pendingCitation.comment.trim().slice(0, MAX_COMMENT_LENGTH)
    const citation: RoomOverviewCitation = {
      id,
      roomId,
      roomTitle,
      section: pendingCitation.section,
      text: pendingCitation.text,
      ...(pendingCitation.claimRefs.length ? { claimRefs: pendingCitation.claimRefs } : {}),
      ...(comment ? { comment } : {}),
    }
    citedRangesRef.current.set(id, pendingCitation.range)
    highlightRegistry()?.delete(PENDING_HIGHLIGHT_NAME)
    setPendingCitation(null)
    setCitations((current) => [...current, citation])
    addRoomOverviewCitation(citation)
  }, [pendingCitation, roomId, roomTitle])

  return (
    <>
      {selectionOverlay ? (
        <button
          type="button"
          className="context-room-selection-to-agent"
          style={{ top: selectionOverlay.top, left: selectionOverlay.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openCommentEditor}
        >
          <MessageSquarePlus aria-hidden="true" />
          {t('contextRoom:overviewDashboard.addToAgent')}
        </button>
      ) : null}
      {pendingCitation ? (
        <form
          className="context-room-citation-comment"
          style={{ top: pendingCitation.editorPoint.top, left: pendingCitation.editorPoint.left }}
          onSubmit={addPendingCitation}
        >
          <span title={pendingCitation.text}><Quote aria-hidden="true" />{pendingCitation.text}</span>
          <input
            ref={commentInputRef}
            value={pendingCitation.comment}
            maxLength={MAX_COMMENT_LENGTH}
            aria-label={t('contextRoom:overviewDashboard.optionalCitationComment')}
            placeholder={t('contextRoom:overviewDashboard.optionalCitationComment')}
            onChange={(event) => setPendingCitation((current) => current ? { ...current, comment: event.target.value } : null)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancelPendingCitation()
            }}
          />
          <button
            type="button"
            className="context-room-citation-comment-cancel"
            aria-label={t('contextRoom:overviewDashboard.cancelCitation')}
            title={t('contextRoom:overviewDashboard.cancelCitation')}
            onClick={cancelPendingCitation}
          ><X aria-hidden="true" /></button>
          <button type="submit" className="context-room-citation-comment-add">
            <Check aria-hidden="true" />
            {t('contextRoom:overviewDashboard.addCitation')}
          </button>
        </form>
      ) : null}
      {citationBadges.map(({ citation, point }) => (
        <span
          key={citation.id}
          className="context-room-citation-badge"
          title={citation.comment || t('contextRoom:overviewDashboard.referencedByAgent')}
          style={point}
        ><Quote aria-hidden="true" /></span>
      ))}
    </>
  )
}
