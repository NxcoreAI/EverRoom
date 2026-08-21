import {
  CalendarCheck2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FilePenLine,
  Image as ImageIcon,
  LoaderCircle,
  Mic2,
  Monitor,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  UsersRound,
  Volume2,
  X,
  type LucideIcon,
} from 'lucide-react'
import gsap from 'gsap'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { showToast } from '@/state/toast'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import type { DiaryDayDetails } from '../../../../shared/sources'
import { DiaryContentSkeleton, DiaryPageSkeleton } from './DiaryPageSkeleton'

import './DiaryPage.css'

type DiaryEventKind = 'note' | 'focus' | 'meeting' | 'image' | 'audio' | 'schedule'

interface DiaryMetric {
  value: string
  label: string
}

interface DiaryImage {
  src: string
  alt: string
}

type DiaryImageSet =
  | readonly [DiaryImage]
  | readonly [DiaryImage, DiaryImage]
  | readonly [DiaryImage, DiaryImage, DiaryImage]
  | readonly [DiaryImage, DiaryImage, DiaryImage, DiaryImage]

interface DiaryEvent {
  time: string
  endTime?: string
  kind: DiaryEventKind
  label: string
  title: string
  description: string
  detail?: string
  metrics?: DiaryMetric[]
  images?: DiaryImageSet
  audio?: {
    duration: number
    transcript: string
  }
}

interface DiaryDay {
  headline: string
  summary: string
  reflection: string
  processingNote: string
  range: string
  events: DiaryEvent[]
  closing?: {
    thought: string
    meta: string
  }
}

interface DiaryImagePreview {
  images: DiaryImageSet
  index: number
}

interface ActiveDiaryRun {
  id: string
  date: string
  startedAt: string
  attempt: number
}

const REFERENCE_TODAY = new Date()
REFERENCE_TODAY.setHours(0, 0, 0, 0)
const STRIP_START = new Date(
  REFERENCE_TODAY.getFullYear(),
  REFERENCE_TODAY.getMonth(),
  REFERENCE_TODAY.getDate() - 28,
)
const STRIP_DAY_COUNT = 29

const EVENT_ICONS: Record<DiaryEventKind, LucideIcon> = {
  note: FilePenLine,
  focus: Monitor,
  meeting: UsersRound,
  image: ImageIcon,
  audio: Mic2,
  schedule: CalendarCheck2,
}

function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function sameDay(left: Date, right: Date): boolean {
  return toDateKey(left) === toDateKey(right)
}

function shiftDate(date: Date, amount: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount)
}

function buildDateRange(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => shiftDate(start, index))
}

function formatClock(value: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(value))
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function formatActivityCount(count: number, t: Translate): string {
  if (count === 0) return t('diaryReality:diary.noActivityRecordedForThisDay')
  if (count === 1) return t('diaryReality:diary.oneActivityInThisDayTimeline')
  return t('diaryReality:diary.countActivitiesInThisDayTimeline', { count })
}

function eventPresentation(sourceRef: string | undefined, t: Translate): Pick<DiaryEvent, 'kind' | 'label'> {
  const kind = sourceRef?.split(':', 1)[0]
  if (kind === 'visual_node') return { kind: 'image', label: t('diaryReality:diary.visualPerception') }
  if (kind === 'recording') return { kind: 'audio', label: t('diaryReality:diary.audioPerception') }
  if (kind === 'connector_calendar') return { kind: 'schedule', label: t('diaryReality:diary.calendar') }
  if (kind === 'connector_email') return { kind: 'meeting', label: t('diaryReality:diary.email') }
  if (kind === 'file' || kind === 'document_version' || kind === 'connector_document') {
    return { kind: 'note', label: t('diaryReality:diary.documentActivity') }
  }
  return { kind: 'focus', label: t('diaryReality:diary.memory') }
}

function representativeMediaSources(
  sourceRefs: string[],
  sources: DiaryDayDetails['sources'],
): DiaryDayDetails['sources'] {
  const referenced = new Set(sourceRefs)
  const unique = new Map<string, DiaryDayDetails['sources'][number]>()
  for (const source of sources) {
    if (!referenced.has(source.sourceId) || !source.assetFileId) continue
    if (source.assetKind !== 'screenshot' && source.assetKind !== 'photo') continue
    if (!unique.has(source.assetFileId)) unique.set(source.assetFileId, source)
  }
  const media = [...unique.values()]
  if (media.length <= 4) return media
  return [0, 1, 2, 3].map((index) => media[Math.round(index * (media.length - 1) / 3)]!)
}

function toImageSet(images: DiaryImage[]): DiaryImageSet | undefined {
  if (images.length === 1) return [images[0]!]
  if (images.length === 2) return [images[0]!, images[1]!]
  if (images.length === 3) return [images[0]!, images[1]!, images[2]!]
  if (images.length >= 4) return [images[0]!, images[1]!, images[2]!, images[3]!]
  return undefined
}

function toDiaryDay(
  details: DiaryDayDetails,
  locale: AppLocale,
  t: Translate,
  mediaByFileId: ReadonlyMap<string, string> = new Map(),
): DiaryDay | null {
  const version = details.currentVersion
  if (!version) return null
  const content = version.content
  return {
    headline: content.headline,
    summary: content.summary,
    reflection: content.reflection,
    processingNote: details.day.status === 'stale'
      ? t('diaryReality:diary.versionVersionNewActivityToInclude', { version: version.version })
      : t('diaryReality:diary.versionVersionTime', { version: version.version, time: formatClock(version.createdAt, locale) }),
    range: `${formatClock(content.range.start, locale)} - ${formatClock(content.range.end, locale)}`,
    events: content.events.map((event) => {
      const mediaSources = representativeMediaSources(event.sourceRefs, details.sources)
      const images = toImageSet(mediaSources.flatMap((source, index) => {
        const src = source.assetFileId ? mediaByFileId.get(source.assetFileId) : undefined
        return src ? [{ src, alt: t('diaryReality:diary.titleImageIndex', { title: event.title, index: index + 1 }) }] : []
      }))
      const presentation = images
        ? {
            kind: 'image' as const,
            label: t('diaryReality:diary.kindCount', {
              kind: t(mediaSources.every((source) => source.assetKind === 'screenshot') ? 'diaryReality:diary.screenshots' : 'diaryReality:diary.photo'),
              count: images.length,
            }),
          }
        : eventPresentation(event.sourceRefs[0], t)
      return {
        time: formatClock(event.time, locale),
        ...(event.endTime && formatClock(event.endTime, locale) !== formatClock(event.time, locale)
          ? { endTime: formatClock(event.endTime, locale) }
          : {}),
        ...presentation,
        title: event.title,
        description: event.summary,
        ...(images ? { images } : {}),
      }
    }),
    ...(content.closing ? {
      closing: {
        thought: content.closing,
        meta: t('diaryReality:diary.dateOrganizedByAgent', {
          date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' })
            .format(new Date(`${version.date}T00:00:00`)),
        }),
      },
    } : {}),
  }
}

async function loadDiaryMedia(details: DiaryDayDetails, locale: AppLocale, t: Translate): Promise<DiaryDay | null> {
  const version = details.currentVersion
  if (!version || !window.nxcore) return toDiaryDay(details, locale, t)
  const selected = new Map<string, DiaryDayDetails['sources'][number]>()
  for (const event of version.content.events) {
    for (const source of representativeMediaSources(event.sourceRefs, details.sources)) {
      if (source.assetFileId) selected.set(source.assetFileId, source)
    }
  }
  const loaded = await Promise.all([...selected.keys()].map(async (fileId) => {
    try {
      const { dataUrl } = await window.nxcore!.files.readDataUrl(fileId)
      return [fileId, dataUrl] as const
    } catch {
      return null
    }
  }))
  return toDiaryDay(details, locale, t, new Map(loaded.filter((entry): entry is readonly [string, string] => entry !== null)))
}

function formatDayHeading(date: Date, locale: AppLocale, t: Translate): string {
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)
  if (sameDay(date, REFERENCE_TODAY)) return t('diaryReality:diary.todayWeekday', { weekday })
  const formattedDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
  return t('diaryReality:diary.dateWeekday', { date: formattedDate, weekday })
}

function formatMonth(date: Date, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
}

function createCalendarDays(year: number, month: number, locale: AppLocale): Date[] {
  const first = new Date(year, month, 1)
  const weekStart = locale === 'en-US' ? 0 : 1
  const offset = (first.getDay() - weekStart + 7) % 7
  const start = shiftDate(first, -offset)
  return buildDateRange(start, 42)
}

function CalendarDialog({
  selectedDate,
  intensityByDate,
  onSelect,
  onClose,
}: {
  selectedDate: Date
  intensityByDate: Record<string, number>
  onSelect: (date: Date) => void
  onClose: () => void
}) {
  const { locale, t } = useLocale()
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const isClosingRef = useRef(false)
  const [viewDate, setViewDate] = useState(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
  )
  const calendarDays = useMemo(
    () => createCalendarDays(viewDate.getFullYear(), viewDate.getMonth(), locale),
    [locale, viewDate],
  )

  const closeDialog = useCallback(() => {
    if (isClosingRef.current) return
    isClosingRef.current = true

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose()
      return
    }

    gsap.timeline({ onComplete: onClose })
      .to(dialogRef.current, { opacity: 0, y: 8, scale: 0.985, duration: 0.16, ease: 'power2.in' })
      .to(backdropRef.current, { opacity: 0, duration: 0.14, ease: 'power1.in' }, '<0.04')
  }, [onClose])

  useLayoutEffect(() => {
    const media = gsap.matchMedia()
    const context = gsap.context(() => {
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.timeline()
          .from(backdropRef.current, { opacity: 0, duration: 0.2, ease: 'power1.out' })
          .from(dialogRef.current, { opacity: 0, y: 14, scale: 0.975, duration: 0.28, ease: 'power3.out' }, 0.03)
      })
    }, backdropRef)

    return () => {
      media.revert()
      context.revert()
    }
  }, [])

  useLayoutEffect(() => {
    const context = gsap.context(() => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      gsap.fromTo(
        '.diary-calendar-day',
        { opacity: 0, y: 4 },
        { opacity: 1, y: 0, duration: 0.18, stagger: 0.006, ease: 'power2.out', clearProps: 'opacity,transform' },
      )
    }, gridRef)

    return () => context.revert()
  }, [viewDate])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDialog()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closeDialog])

  const moveMonth = (amount: number) => {
    setViewDate((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1))
  }

  const moveYear = (amount: number) => {
    setViewDate((current) => new Date(current.getFullYear() + amount, current.getMonth(), 1))
  }

  return (
    <div
      ref={backdropRef}
      className="diary-calendar-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeDialog()
      }}
    >
      <section ref={dialogRef} className="diary-calendar-dialog" role="dialog" aria-modal="true" aria-labelledby="diary-calendar-title">
        <header className="diary-calendar-heading">
          <div>
            <span>{t('diaryReality:diary.dateReview')}</span>
            <h2 id="diary-calendar-title">{formatMonth(viewDate, locale)}</h2>
          </div>
          <button type="button" className="diary-icon-button" title={t('diaryReality:diary.close')} aria-label={t('diaryReality:diary.closeCalendar')} onClick={closeDialog}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="diary-calendar-controls">
          <span>
            <button type="button" title={t('diaryReality:diary.previousYear')} aria-label={t('diaryReality:diary.previousYear')} onClick={() => moveYear(-1)}><ChevronsLeft aria-hidden="true" /></button>
            <button type="button" title={t('diaryReality:diary.previousMonth')} aria-label={t('diaryReality:diary.previousMonth')} onClick={() => moveMonth(-1)}><ChevronLeft aria-hidden="true" /></button>
          </span>
          <span>
            <label>
              <span className="sr-only">{t('diaryReality:diary.year')}</span>
              <select
                value={viewDate.getFullYear()}
                onChange={(event) => setViewDate(new Date(Number(event.target.value), viewDate.getMonth(), 1))}
              >
                {[REFERENCE_TODAY.getFullYear() - 1, REFERENCE_TODAY.getFullYear(), REFERENCE_TODAY.getFullYear() + 1]
                  .map((year) => <option key={year} value={year}>{new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(new Date(year, 0, 1))}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">{t('diaryReality:diary.month')}</span>
              <select
                value={viewDate.getMonth()}
                onChange={(event) => setViewDate(new Date(viewDate.getFullYear(), Number(event.target.value), 1))}
              >
                {Array.from({ length: 12 }, (_, month) => <option key={month} value={month}>{new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2020, month, 1))}</option>)}
              </select>
            </label>
          </span>
          <span>
            <button type="button" title={t('diaryReality:diary.nextMonth')} aria-label={t('diaryReality:diary.nextMonth')} onClick={() => moveMonth(1)}><ChevronRight aria-hidden="true" /></button>
            <button type="button" title={t('diaryReality:diary.nextYear')} aria-label={t('diaryReality:diary.nextYear')} onClick={() => moveYear(1)}><ChevronsRight aria-hidden="true" /></button>
          </span>
        </div>

        <div className="diary-calendar-weekdays" aria-hidden="true">
          {Array.from({ length: 7 }, (_, index) => {
            const date = new Date(2026, 0, (locale === 'en-US' ? 4 : 5) + index)
            return <span key={index}>{new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)}</span>
          })}
        </div>
        <div ref={gridRef} className="diary-calendar-grid">
          {calendarDays.map((date) => {
            const key = toDateKey(date)
            const isOutside = date.getMonth() !== viewDate.getMonth()
            const isFuture = date > REFERENCE_TODAY
            return (
              <button
                key={key}
                type="button"
                className="diary-calendar-day"
                data-level={intensityByDate[key] ?? 0}
                data-outside={String(isOutside)}
                data-selected={String(sameDay(date, selectedDate))}
                data-today={String(sameDay(date, REFERENCE_TODAY))}
                data-today-label={sameDay(date, REFERENCE_TODAY) ? t('diaryReality:diary.todayShort') : undefined}
                disabled={isFuture}
                aria-pressed={sameDay(date, selectedDate)}
                aria-label={new Intl.DateTimeFormat(locale, { dateStyle: 'full' }).format(date)}
                onClick={() => {
                  onSelect(date)
                  closeDialog()
                }}
              >
                <span>{date.getDate()}</span>
                <i aria-hidden="true" />
              </button>
            )
          })}
        </div>

        <footer className="diary-calendar-footer">
          <span>{t('diaryReality:diary.lessActivity')}</span>
          <span className="diary-calendar-legend" aria-hidden="true">
            {[1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}
          </span>
          <span>{t('diaryReality:diary.moreActivity')}</span>
          <button type="button" onClick={() => {
            onSelect(REFERENCE_TODAY)
            closeDialog()
          }}>{t('diaryReality:diary.backToToday')}</button>
        </footer>
      </section>
    </div>
  )
}

function formatAudioTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function DiaryAudioPlayer({ duration, transcript }: { duration: number; transcript: string }) {
  const { t } = useLocale()
  const playButtonRef = useRef<HTMLButtonElement>(null)
  const [playing, setPlaying] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      setElapsed((current) => Math.min(current + 1, duration))
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [duration, playing])

  useEffect(() => {
    if (elapsed >= duration) setPlaying(false)
  }, [duration, elapsed])

  const togglePlayback = () => {
    if (elapsed >= duration) setElapsed(0)
    setPlaying((current) => !current)
  }

  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const tween = gsap.fromTo(
      playButtonRef.current,
      { scale: 0.88 },
      { scale: 1, duration: 0.34, ease: 'back.out(2.4)', clearProps: 'transform' },
    )
    return () => {
      tween.revert()
    }
  }, [playing])

  return (
    <div className="diary-audio-player">
      <button
        ref={playButtonRef}
        type="button"
        className="diary-audio-play"
        aria-label={t(playing ? 'diaryReality:diary.pauseAudio' : 'diaryReality:diary.playAudio')}
        title={t(playing ? 'diaryReality:diary.pause' : 'diaryReality:diary.play')}
        onClick={togglePlayback}
      >
        {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
      </button>
      <div className="diary-audio-body">
        <div className="diary-audio-progress">
          <input
            type="range"
            min={0}
            max={duration}
            value={elapsed}
            aria-label={t('diaryReality:diary.audioPlaybackProgress')}
            onChange={(event) => setElapsed(Number(event.target.value))}
            style={{ '--diary-audio-progress': `${(elapsed / duration) * 100}%` } as CSSProperties}
          />
          <time>{formatAudioTime(elapsed)} / {formatAudioTime(duration)}</time>
          <Volume2 aria-hidden="true" />
        </div>
        <p>{transcript}</p>
      </div>
    </div>
  )
}

function DiaryImageLightbox({
  preview,
  onClose,
  onNavigate,
}: {
  preview: DiaryImagePreview
  onClose: () => void
  onNavigate: (index: number) => void
}) {
  const { t } = useLocale()
  const lightboxRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const isClosingRef = useRef(false)
  const image = preview.images[preview.index] ?? preview.images[0]
  const hasMultipleImages = preview.images.length > 1

  const navigate = useCallback((direction: -1 | 1) => {
    const nextIndex = (preview.index + direction + preview.images.length) % preview.images.length
    onNavigate(nextIndex)
  }, [onNavigate, preview.images.length, preview.index])

  const closeLightbox = useCallback(() => {
    if (isClosingRef.current) return
    isClosingRef.current = true

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose()
      return
    }

    gsap.timeline({ onComplete: onClose })
      .to([imageRef.current, closeButtonRef.current], { opacity: 0, scale: 0.975, duration: 0.16, ease: 'power2.in' })
      .to(lightboxRef.current, { opacity: 0, duration: 0.18, ease: 'power1.in' }, '<0.02')
  }, [onClose])

  useLayoutEffect(() => {
    const media = gsap.matchMedia()
    const context = gsap.context(() => {
      media.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.timeline()
          .from(lightboxRef.current, { opacity: 0, duration: 0.22, ease: 'power1.out' })
          .from(imageRef.current, { opacity: 0, scale: 0.94, y: 10, duration: 0.38, ease: 'power3.out' }, 0.03)
          .from(closeButtonRef.current, { opacity: 0, scale: 0.8, duration: 0.22, ease: 'back.out(2)' }, 0.13)
      })
    }, lightboxRef)

    return () => {
      media.revert()
      context.revert()
    }
  }, [])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeLightbox()
      if (event.key === 'ArrowLeft' && hasMultipleImages) navigate(-1)
      if (event.key === 'ArrowRight' && hasMultipleImages) navigate(1)
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', closeOnEscape)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [closeLightbox, hasMultipleImages, navigate])

  return (
    <div
      ref={lightboxRef}
      className="diary-image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t('diaryReality:diary.imagePreview')}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeLightbox()
      }}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="diary-image-lightbox-close"
        aria-label={t('diaryReality:diary.closeImagePreview')}
        title={t('diaryReality:diary.close')}
        autoFocus
        onClick={closeLightbox}
      >
        <X aria-hidden="true" />
      </button>
      {hasMultipleImages ? (
        <>
          <button
            type="button"
            className="diary-image-lightbox-arrow diary-image-lightbox-arrow-previous"
            aria-label={t('diaryReality:diary.viewPreviousImage')}
            title={t('diaryReality:diary.previousImage')}
            onClick={() => navigate(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="diary-image-lightbox-arrow diary-image-lightbox-arrow-next"
            aria-label={t('diaryReality:diary.viewNextImage')}
            title={t('diaryReality:diary.nextImage')}
            onClick={() => navigate(1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <span className="diary-image-lightbox-count" aria-live="polite">
            {preview.index + 1} / {preview.images.length}
          </span>
        </>
      ) : null}
      <img ref={imageRef} src={image.src} alt={image.alt} />
    </div>
  )
}

function DiaryTimeline({ events }: { events: DiaryEvent[] }) {
  const { t } = useLocale()
  const [previewImage, setPreviewImage] = useState<DiaryImagePreview | null>(null)

  if (events.length === 0) {
    return (
      <div className="diary-empty-state">
        <CalendarDays aria-hidden="true" />
        <strong>{t('diaryReality:diary.noDiaryEntryForThisDayYet')}</strong>
        <span>{t('diaryReality:diary.thisDateIsStillKeptOnYourTimeline')}</span>
      </div>
    )
  }

  return (
    <div className="diary-timeline-list">
      {events.map((event) => {
        const EventIcon = EVENT_ICONS[event.kind]
        const images = event.images
        return (
          <article key={`${event.time}-${event.endTime ?? ''}-${event.title}`} className="diary-timeline-event" data-kind={event.kind}>
            <time>{event.time}{event.endTime ? <small>{t('diaryReality:diary.toTime', { time: event.endTime })}</small> : null}</time>
            <div className="diary-event-content">
              <span className="diary-event-icon"><EventIcon aria-hidden="true" /></span>
              <div className="diary-event-label"><EventIcon aria-hidden="true" />{event.label}</div>
              <h3>{event.title}</h3>
              <p>{event.description}</p>
              {event.detail ? <div className="diary-event-detail">{event.detail}</div> : null}
              {event.metrics ? (
                <div className="diary-event-metrics">
                  {event.metrics.map((metric) => (
                    <span key={metric.label}><strong>{metric.value}</strong><small>{metric.label}</small></span>
                  ))}
                </div>
              ) : null}
              {images ? (
                <div className="diary-event-image-grid" data-count={images.length}>
                  {images.map((image, index) => (
                    <button
                      key={`${image.src}-${index}`}
                      type="button"
                      className="diary-event-image-button"
                      aria-label={t('diaryReality:diary.enlargeImageIndexAlt', { index: index + 1, alt: image.alt })}
                      title={t('diaryReality:diary.clickToEnlarge')}
                      onClick={() => setPreviewImage({ images, index })}
                    >
                      <img className="diary-event-image" src={image.src} alt={image.alt} />
                    </button>
                  ))}
                </div>
              ) : null}
              {event.audio ? <DiaryAudioPlayer duration={event.audio.duration} transcript={event.audio.transcript} /> : null}
            </div>
          </article>
        )
      })}
      {previewImage ? (
        <DiaryImageLightbox
          preview={previewImage}
          onClose={() => setPreviewImage(null)}
          onNavigate={(index) => setPreviewImage((current) => current ? { ...current, index } : null)}
        />
      ) : null}
    </div>
  )
}

function DiaryClosing({ thought, meta }: { thought: string; meta: string }) {
  const { t } = useLocale()
  return (
    <footer className="diary-closing">
      <div className="diary-closing-divider" aria-hidden="true"><span><Sparkles /></span></div>
      <blockquote>{thought}</blockquote>
      <small>{meta}</small>
      <div className="diary-closing-brand">{t('diaryReality:diary.nexosYourPersonalInformationIsUsedOnlyFor')}</div>
    </footer>
  )
}

export function DiaryPage() {
  const { locale, t } = useLocale()
  const pageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const transitionDirectionRef = useRef(1)
  const isFirstRenderRef = useRef(true)
  const [selectedDate, setSelectedDate] = useState(REFERENCE_TODAY)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [activeRun, setActiveRun] = useState<ActiveDiaryRun | null>(null)
  const [generatedDays, setGeneratedDays] = useState<Record<string, DiaryDay>>({})
  const [intensityByDate, setIntensityByDate] = useState<Record<string, number>>({})
  const [loadingDate, setLoadingDate] = useState<string | null>(() => toDateKey(REFERENCE_TODAY))
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(false)
  const [runElapsedSeconds, setRunElapsedSeconds] = useState(0)
  const stripDays = useMemo(() => buildDateRange(STRIP_START, STRIP_DAY_COUNT), [])
  const selectedKey = toDateKey(selectedDate)
  const diary = generatedDays[selectedKey]
  const diaryLoading = loadingDate === selectedKey

  useEffect(() => {
    if (!window.nxcore) return
    let cancelled = false
    void window.nxcore.diary.activeRun().then((run) => {
      if (cancelled || !run) return
      setActiveRun({
        id: run.id,
        date: run.date,
        startedAt: run.startedAt ?? run.createdAt,
        attempt: run.attempt,
      })
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!window.nxcore) return
    let cancelled = false
    void window.nxcore.diary.days(toDateKey(STRIP_START), toDateKey(REFERENCE_TODAY)).then((days) => {
      if (cancelled) return
      setIntensityByDate(Object.fromEntries(days.map((day) => [
        day.date,
        Math.min(4, Math.max(1, Math.ceil(day.eventCount / 2))),
      ])))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!window.nxcore) {
      setLoadingDate(null)
      setHasCompletedInitialLoad(true)
      return
    }
    let cancelled = false
    setLoadingDate(selectedKey)
    void window.nxcore.diary.day(selectedKey).then((details) => {
      if (cancelled) return
      const loaded = details ? toDiaryDay(details, locale, t) : null
      setGeneratedDays((current) => {
        if (loaded) return { ...current, [selectedKey]: loaded }
        const next = { ...current }
        delete next[selectedKey]
        return next
      })
      if (details) {
        setIntensityByDate((current) => ({
          ...current,
          [selectedKey]: Math.min(4, Math.max(1, Math.ceil(details.day.eventCount / 2))),
        }))
        void loadDiaryMedia(details, locale, t).then((withMedia) => {
          if (!cancelled && withMedia) {
            setGeneratedDays((current) => ({ ...current, [selectedKey]: withMedia }))
          }
        })
      }
    }).catch(() => undefined).finally(() => {
      if (!cancelled) {
        setLoadingDate((current) => current === selectedKey ? null : current)
        setHasCompletedInitialLoad(true)
      }
    })
    return () => { cancelled = true }
  }, [locale, selectedKey, t])

  const generateDiary = useCallback(async () => {
    if (!window.nxcore || activeRun) return
    try {
      const { runId } = await window.nxcore.diary.generate(selectedKey)
      setActiveRun({ id: runId, date: selectedKey, startedAt: new Date().toISOString(), attempt: 0 })
      showToast({
        title: t('diaryReality:diary.diaryGenerationStarted'),
        message: t('diaryReality:diary.dateIsBeingOrganizedInTheBackground', { date: formatDayHeading(selectedDate, locale, t) }),
      })
    } catch (error) {
      setActiveRun(null)
      showToast({
        title: t('diaryReality:diary.diaryGenerationFailed'),
        message: error instanceof Error ? error.message : t('diaryReality:diary.theBackgroundTaskCouldNotBeCompleted'),
      })
    }
  }, [activeRun, locale, selectedDate, selectedKey, t])

  useEffect(() => {
    if (!activeRun || !window.nxcore) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const run = await window.nxcore!.diary.run(activeRun.id)
        if (cancelled) return
        setActiveRun((current) => {
          if (!current || current.id !== run.id) return current
          const startedAt = run.startedAt ?? current.startedAt
          return current.startedAt === startedAt && current.attempt === run.attempt
            ? current
            : { ...current, startedAt, attempt: run.attempt }
        })
        if (run.status === 'completed') {
          const details = await window.nxcore!.diary.day(activeRun.date)
          if (cancelled) return
          // Keep this effect alive until screenshot data is loaded. Clearing the
          // active run first would clean up the effect and cancel the media
          // update, leaving the freshly generated diary without its image grid.
          const generated = details ? await loadDiaryMedia(details, locale, t) : null
          if (cancelled) return
          if (generated) setGeneratedDays((current) => ({ ...current, [activeRun.date]: generated }))
          setActiveRun(null)
          showToast({
            title: t('diaryReality:diary.diaryGenerationComplete'),
            message: t('diaryReality:diary.aNewDiaryVersionWasGeneratedForDate', {
              date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' })
                .format(new Date(`${activeRun.date}T00:00:00`)),
            }),
          })
          return
        }
        if (run.status === 'failed') {
          setActiveRun(null)
          showToast({ title: t('diaryReality:diary.diaryGenerationFailed'), message: run.error ?? t('diaryReality:diary.theBackgroundTaskCouldNotBeCompleted') })
          return
        }
        timer = setTimeout(() => void poll(), 1_000)
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), 2_000)
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeRun?.date, activeRun?.id, locale, t])

  useEffect(() => {
    if (!activeRun) {
      setRunElapsedSeconds(0)
      return
    }
    const update = () => setRunElapsedSeconds(Math.max(
      0,
      Math.floor((Date.now() - new Date(activeRun.startedAt).getTime()) / 1_000),
    ))
    update()
    const timer = setInterval(update, 1_000)
    return () => clearInterval(timer)
  }, [activeRun?.id, activeRun?.startedAt])

  const selectDate = useCallback((nextDate: Date) => {
    if (sameDay(nextDate, selectedDate)) return
    const direction = nextDate > selectedDate ? 1 : -1
    transitionDirectionRef.current = direction

    const commitSelection = () => {
      setLoadingDate(toDateKey(nextDate))
      setSelectedDate(nextDate)
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !contentRef.current) {
      commitSelection()
      return
    }

    gsap.killTweensOf(contentRef.current)
    gsap.to(contentRef.current, {
      opacity: 0,
      x: direction * -10,
      duration: 0.15,
      ease: 'power2.in',
      onComplete: commitSelection,
    })
  }, [selectedDate])

  useLayoutEffect(() => {
    const media = gsap.matchMedia()
    const context = gsap.context(() => {
      media.add('(prefers-reduced-motion: no-preference)', () => {
        const direction = transitionDirectionRef.current
        const timeline = gsap.timeline()
        const stagedTargets = pageRef.current?.querySelectorAll([
          '.diary-day-intro > span',
          '.diary-day-intro h1',
          '.diary-day-intro p',
          '.diary-day-intro small',
          '.diary-reflection',
          '.diary-trace > header',
        ].join(','))
        const timelineTargets = pageRef.current?.querySelectorAll(
          '.diary-timeline-event, .diary-empty-state',
        )
        const closing = pageRef.current?.querySelector('.diary-closing')

        if (isFirstRenderRef.current) {
          timeline.from('.diary-date-strip-inner, .diary-strip-selection', {
            opacity: 0,
            y: -7,
            duration: 0.34,
            stagger: 0.05,
            ease: 'power2.out',
          })
        }

        timeline
          .fromTo(contentRef.current, { opacity: 0, x: direction * 12 }, {
            opacity: 1,
            x: 0,
            duration: 0.3,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          }, isFirstRenderRef.current ? 0.08 : 0)
          .from(stagedTargets ?? [], {
            opacity: 0,
            y: 8,
            duration: 0.34,
            stagger: 0.045,
            ease: 'power2.out',
            clearProps: 'opacity,transform',
          }, '<0.02')
          .from(timelineTargets ?? [], {
            opacity: 0,
            y: 12,
            duration: 0.38,
            stagger: 0.055,
            ease: 'power3.out',
            clearProps: 'opacity,transform',
          }, '<0.08')
        if (closing) {
          timeline.from(closing, {
              opacity: 0,
              y: 10,
              duration: 0.36,
              ease: 'power2.out',
              clearProps: 'opacity,transform',
            }, '<0.04')
        }
      })
    }, pageRef)

    isFirstRenderRef.current = false
    return () => {
      media.revert()
      context.revert()
    }
  }, [selectedKey])

  if (!hasCompletedInitialLoad && diaryLoading) {
    return <DiaryPageSkeleton />
  }

  return (
    <div ref={pageRef} className="page diary-page">
      <header className="diary-date-strip">
        <div className="diary-date-strip-inner">
          <div className="diary-date-meta">
            <strong>{formatMonth(selectedDate, locale)}</strong>
            <span>{t('diaryReality:diary.scrollToBrowseNearbyDates')}</span>
          </div>
          <div className="diary-strip-days">
            {stripDays.map((date) => {
              const key = toDateKey(date)
              const isFuture = date > REFERENCE_TODAY
              return (
                <button
                  key={key}
                  type="button"
                  data-level={intensityByDate[key] ?? 0}
                  data-selected={String(sameDay(date, selectedDate))}
                  disabled={isFuture}
                  aria-label={new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(date)}
                  aria-pressed={sameDay(date, selectedDate)}
                  onClick={() => selectDate(date)}
                >
                  <small>{new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(date)}</small>
                  <i aria-hidden="true" />
                  <span>{date.getDate()}</span>
                </button>
              )
            })}
          </div>
          <span className="diary-strip-actions">
            {!sameDay(selectedDate, REFERENCE_TODAY) ? (
              <button type="button" className="diary-today-button" onClick={() => selectDate(REFERENCE_TODAY)}>
                <RotateCcw aria-hidden="true" />{t('diaryReality:diary.backToToday')}
              </button>
            ) : null}
            <button
              type="button"
              className="diary-generate-button"
              title={t('diaryReality:diary.generateADiaryForTheSelectedDate')}
              disabled={activeRun !== null}
              aria-busy={activeRun !== null}
              onClick={() => void generateDiary()}
            >
              {activeRun ? <LoaderCircle aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              {activeRun ? `${t('diaryReality:diary.generating')} · ${formatElapsed(runElapsedSeconds)}` : t(diary ? 'diaryReality:diary.regenerate' : 'diaryReality:diary.generateDiary')}
            </button>
            <button
              type="button"
              className="diary-icon-button"
              title={t('diaryReality:diary.openCalendar')}
              aria-label={t('diaryReality:diary.openFullCalendar')}
              aria-expanded={calendarOpen}
              onClick={() => setCalendarOpen(true)}
            >
              <CalendarDays aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="diary-strip-selection">
          {sameDay(selectedDate, REFERENCE_TODAY) ? t('diaryReality:diary.today') : new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(selectedDate)}
          <strong>{new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(selectedDate)}</strong>
        </div>
      </header>

      <main
        ref={contentRef}
        className={`diary-content${diaryLoading ? ' diary-skeleton-content diary-skeleton-content-only' : ''}`}
        aria-busy={diaryLoading}
        aria-label={diaryLoading ? t('diaryReality:diaryPageSkeleton.loadingDiary') : undefined}
      >
        {diaryLoading ? (
          <>
            <span className="diary-skeleton-status" role="status">{t('diaryReality:diaryPageSkeleton.loadingDiary')}</span>
            <div aria-hidden="true"><DiaryContentSkeleton /></div>
          </>
        ) : (
          <>
            <button
              type="button"
              className="diary-day-arrow diary-day-arrow-previous"
              title={t('diaryReality:diary.previousDay')}
              aria-label={t('diaryReality:diary.viewPreviousDay')}
              onClick={() => selectDate(shiftDate(selectedDate, -1))}
            ><ChevronLeft aria-hidden="true" /></button>
            <button
              type="button"
              className="diary-day-arrow diary-day-arrow-next"
              title={t('diaryReality:diary.nextDay')}
              aria-label={t('diaryReality:diary.viewNextDay')}
              disabled={selectedDate >= REFERENCE_TODAY}
              onClick={() => selectDate(shiftDate(selectedDate, 1))}
            ><ChevronRight aria-hidden="true" /></button>

            <section className="diary-day-intro">
              <span>{formatDayHeading(selectedDate, locale, t)}</span>
              <h1>{diary?.headline ?? t('diaryReality:diary.noDiaryEntryForThisDayYet')}</h1>
              <p>{diary?.summary ?? t('diaryReality:diary.thereAreNoRecordsToOrganizeButThis')}</p>
              {diary ? <small><Sparkles aria-hidden="true" />{t('diaryReality:diary.contentOrganized')} <i /> {diary.processingNote}</small> : null}
            </section>

            {diary ? (
              <aside className="diary-reflection">
                <strong><Sparkles aria-hidden="true" />{t('diaryReality:diary.todaySReflection')}</strong>
                <p>{diary.reflection}</p>
              </aside>
            ) : null}

            <section className="diary-trace">
              <header>
                <div><span>{t('diaryReality:diary.dayTrace')}</span><h2>{formatActivityCount(diary?.events.length ?? 0, t)}</h2></div>
                <time>{diary?.range ?? t('diaryReality:diary.noActivity')}</time>
              </header>
              <DiaryTimeline events={diary?.events ?? []} />
              {diary?.closing ? <DiaryClosing thought={diary.closing.thought} meta={diary.closing.meta} /> : null}
            </section>
          </>
        )}
      </main>

      {calendarOpen ? (
        <CalendarDialog
          selectedDate={selectedDate}
          intensityByDate={intensityByDate}
          onSelect={selectDate}
          onClose={() => setCalendarOpen(false)}
        />
      ) : null}
    </div>
  )
}
