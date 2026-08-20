import {
  BookOpenText,
  ChevronRight,
  Clock3,
  FileText,
  FolderKanban,
  Mic2,
  NotebookPen,
  Sparkles,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { PageId } from '@/data/navigation'
import { useContextRoomState } from '@/components/context-room/ContextRoomStateProvider'
import { useRoomDocumentsState } from '@/components/context-room/RoomDocumentsProvider'
import { useLocale, type AppLocale } from '@/i18n/LocaleContext'
import type { DiaryDayDetails } from '../../../../shared/sources'

import './HomePage.css'

interface HomeDiaryEvent {
  time: string
  title: string
  summary: string
}

interface HomeDiarySnapshot {
  date: string
  headline: string
  summary: string
  events: HomeDiaryEvent[]
}

function dateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatClock(value: string, locale: AppLocale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
}

function formatDiaryDate(value: string, locale: AppLocale): string {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date)
}

function toHomeDiary(details: DiaryDayDetails, locale: AppLocale): HomeDiarySnapshot | null {
  const version = details.currentVersion
  if (!version) return null
  return {
    date: details.day.date,
    headline: version.content.headline,
    summary: version.content.summary,
    events: version.content.events.slice(0, 6).map((event) => ({
      time: formatClock(event.time, locale),
      title: event.title,
      summary: event.summary,
    })),
  }
}

export function HomePage({
  onNavigate,
  onFocusAgent,
  onOpenDocument,
}: {
  onNavigate: (page: PageId) => void
  onFocusAgent: () => void
  onOpenDocument?: (target: { roomId: string; documentId: string }) => void
}) {
  const { locale, t } = useLocale()
  const { state: roomState } = useContextRoomState()
  const { documentsByRoom, documentsLoading } = useRoomDocumentsState()
  const [diary, setDiary] = useState<HomeDiarySnapshot | null>(null)
  const [diaryLoading, setDiaryLoading] = useState(true)

  const recentRooms = useMemo(() => (
    [...roomState.rooms]
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
      .slice(0, 5)
  ), [roomState.rooms])

  const recentDocuments = useMemo(() => {
    const roomTitleById = new Map(roomState.rooms.map((room) => [room.id, room.title]))
    return Object.entries(documentsByRoom)
      .flatMap(([roomId, documents]) => documents.map((document) => ({
        id: document.id,
        roomId,
        roomTitle: roomTitleById.get(roomId) ?? t('surface:docs.unknownRoom'),
        title: document.title || t('surface:docs.untitledDocument'),
        updatedAt: document.updatedAt,
      })))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 5)
  }, [documentsByRoom, roomState.rooms, t])

  useEffect(() => {
    if (!window.nxcore) {
      setDiaryLoading(false)
      return
    }
    let cancelled = false
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - 6)

    setDiaryLoading(true)
    void window.nxcore.diary.days(dateKey(start), dateKey(today))
      .then(async (days) => {
        const candidates = [...days]
          .sort((left, right) => right.date.localeCompare(left.date))
          .filter((day) => day.eventCount > 0)
        for (const candidate of candidates) {
          const details = await window.nxcore!.diary.day(candidate.date)
          if (details?.currentVersion) return details
        }
        return null
      })
      .then((details) => {
        if (!cancelled) setDiary(details ? toHomeDiary(details, locale) : null)
      })
      .catch(() => {
        if (!cancelled) setDiary(null)
      })
      .finally(() => {
        if (!cancelled) setDiaryLoading(false)
      })

    return () => { cancelled = true }
  }, [locale])

  return (
    <section className="workspace-home-surface" data-testid="workspace-home-surface">
      <div className="workspace-home-inner">
        <header className="workspace-home-heading">
          <div>
            <h1>{t('surface:home.goodEvening')}</h1>
            <p>{t('surface:home.continueWhereYouLeftOffOrStartSomething')}</p>
          </div>
        </header>

        <div className="workspace-home-grid">
          <section className="workspace-home-quick-start">
            <div className="workspace-home-section-heading">
              <div>
                <h2>{t('surface:home.startFromHere')}</h2>
              </div>
            </div>
            <div className="workspace-quick-grid">
              <button type="button" className="workspace-quick-action" onClick={onFocusAgent}>
                <Sparkles aria-hidden="true" strokeWidth={1.8} data-tone="blue" />
                <span>{t('surface:home.askAi')}</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('recording')}>
                <Mic2 aria-hidden="true" strokeWidth={1.8} data-tone="violet" />
                <span>{t('surface:home.aiNotes')}</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
              <button type="button" className="workspace-quick-action" onClick={() => onNavigate('rooms')}>
                <BookOpenText aria-hidden="true" strokeWidth={1.8} data-tone="emerald" />
                <span>Context Room</span>
                <ChevronRight aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
          </section>

          <section className="workspace-home-recent">
            <header className="workspace-home-section-heading">
              <div>
                <span className="workspace-home-eyebrow">{t('surface:home.recent')}</span>
                <h2>{t('surface:home.recentlyOpened')}</h2>
              </div>
              <button type="button" className="workspace-home-link" onClick={() => onNavigate('rooms')}>
                {t('surface:home.openWorkspace')}<ChevronRight aria-hidden="true" />
              </button>
            </header>
            <div className="workspace-home-recent-grid">
              <div className="workspace-home-list-column">
                <div className="workspace-home-list-heading">
                  <FolderKanban aria-hidden="true" strokeWidth={1.8} />
                  <strong>{t('surface:home.contextRooms')}</strong>
                  <span>{roomState.rooms.length}</span>
                </div>
                {recentRooms.length > 0 ? recentRooms.map((room) => (
                  <button key={room.id} type="button" className="workspace-home-list-item" onClick={() => onNavigate('rooms')}>
                    <span className="workspace-home-item-mark" data-tone={room.tone} aria-hidden="true" />
                    <span>
                      <strong>{room.title}</strong>
                      <small>{room.kind} · {room.stats.docs} {t('surface:home.documents')}</small>
                    </span>
                    <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                  </button>
                )) : (
                  <button type="button" className="workspace-home-empty-row" onClick={() => onNavigate('rooms')}>
                    <BookOpenText aria-hidden="true" />
                    <span>{t('surface:home.noContextRooms')}</span>
                  </button>
                )}
              </div>

              <div className="workspace-home-list-column">
                <div className="workspace-home-list-heading">
                  <FileText aria-hidden="true" strokeWidth={1.8} />
                  <strong>{t('surface:home.documents')}</strong>
                  <span>{recentDocuments.length}</span>
                </div>
                {documentsLoading && recentDocuments.length === 0 ? (
                  <div className="workspace-home-loading-list" aria-busy="true">
                    <i /><i /><i />
                  </div>
                ) : recentDocuments.length > 0 ? recentDocuments.map((document) => (
                  <button
                    key={document.id}
                    type="button"
                    className="workspace-home-list-item"
                    onClick={() => onOpenDocument
                      ? onOpenDocument({ roomId: document.roomId, documentId: document.id })
                      : onNavigate('docs')}
                  >
                    <FileText aria-hidden="true" strokeWidth={1.8} />
                    <span>
                      <strong>{document.title}</strong>
                      <small>{document.roomTitle}</small>
                    </span>
                    <ChevronRight aria-hidden="true" strokeWidth={1.8} />
                  </button>
                )) : (
                  <button type="button" className="workspace-home-empty-row" onClick={() => onNavigate('docs')}>
                    <FileText aria-hidden="true" />
                    <span>{t('surface:home.noDocuments')}</span>
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="workspace-home-diary">
            <header className="workspace-home-section-heading">
              <div>
                <span className="workspace-home-eyebrow">{t('surface:home.dailyTrace')}</span>
                <h2>{t('surface:home.recentDiary')}</h2>
              </div>
              <button type="button" className="workspace-home-link" onClick={() => onNavigate('diary')}>
                {t('surface:home.openDiary')}<ChevronRight aria-hidden="true" />
              </button>
            </header>
            {diaryLoading ? (
              <div className="workspace-home-diary-loading" aria-busy="true">
                <i /><i /><i />
              </div>
            ) : diary ? (
              <div className="workspace-home-diary-content">
                <div className="workspace-home-diary-intro">
                  <div className="workspace-home-diary-date"><Clock3 aria-hidden="true" />{formatDiaryDate(diary.date, locale)}</div>
                  <strong>{diary.headline}</strong>
                  <p>{diary.summary}</p>
                </div>
                <div className="workspace-home-timeline">
                  {diary.events.map((event, index) => (
                    <button key={`${event.time}-${event.title}-${index}`} type="button" className="workspace-home-timeline-item" onClick={() => onNavigate('diary')}>
                      <time>{event.time}</time>
                      <span className="workspace-home-timeline-dot" aria-hidden="true" />
                      <span className="workspace-home-timeline-copy">
                        <strong>{event.title}</strong>
                        <small>{event.summary}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <button type="button" className="workspace-home-diary-empty" onClick={() => onNavigate('diary')}>
                <NotebookPen aria-hidden="true" />
                <span>{t('surface:home.noDiaryYet')}</span>
                <ChevronRight aria-hidden="true" />
              </button>
            )}
          </section>
        </div>
      </div>
    </section>
  )
}
