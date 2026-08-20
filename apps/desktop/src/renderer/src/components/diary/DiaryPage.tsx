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

const diaryDays: Record<string, DiaryDay> = {}

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

function eventPresentation(sourceRef: string | undefined, t: Translate): Pick<DiaryEvent, 'kind' | 'label'> {
  const kind = sourceRef?.split(':', 1)[0]
  if (kind === 'visual_node') return { kind: 'image', label: t('视觉感知') }
  if (kind === 'recording') return { kind: 'audio', label: t('录音感知') }
  if (kind === 'connector_calendar') return { kind: 'schedule', label: t('日程') }
  if (kind === 'connector_email') return { kind: 'meeting', label: t('邮件') }
  if (kind === 'file' || kind === 'document_version' || kind === 'connector_document') {
    return { kind: 'note', label: t('文档记录') }
  }
  return { kind: 'focus', label: t('记忆') }
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
      ? t('第 {version} 版 · 有新记录待更新', { version: version.version })
      : t('第 {version} 版 · {time}', { version: version.version, time: formatClock(version.createdAt, locale) }),
    range: `${formatClock(content.range.start, locale)} - ${formatClock(content.range.end, locale)}`,
    events: content.events.map((event) => {
      const mediaSources = representativeMediaSources(event.sourceRefs, details.sources)
      const images = toImageSet(mediaSources.flatMap((source, index) => {
        const src = source.assetFileId ? mediaByFileId.get(source.assetFileId) : undefined
        return src ? [{ src, alt: t('{title} · 图片 {index}', { title: event.title, index: index + 1 }) }] : []
      }))
      const presentation = images
        ? {
            kind: 'image' as const,
            label: t('{kind} · {count} 张', {
              kind: t(mediaSources.every((source) => source.assetKind === 'screenshot') ? '截图' : '照片'),
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
        meta: t('{date} · Agent 整理完成', {
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
  if (sameDay(date, REFERENCE_TODAY)) return t('今天 · {weekday}', { weekday })
  const formattedDate = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
  return t('{date} · {weekday}', { date: formattedDate, weekday })
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
            <span>{t('日期回顾')}</span>
            <h2 id="diary-calendar-title">{formatMonth(viewDate, locale)}</h2>
          </div>
          <button type="button" className="diary-icon-button" title={t('关闭')} aria-label={t('关闭日历')} onClick={closeDialog}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="diary-calendar-controls">
          <span>
            <button type="button" title={t('上一年')} aria-label={t('上一年')} onClick={() => moveYear(-1)}><ChevronsLeft aria-hidden="true" /></button>
            <button type="button" title={t('上个月')} aria-label={t('上个月')} onClick={() => moveMonth(-1)}><ChevronLeft aria-hidden="true" /></button>
          </span>
          <span>
            <label>
              <span className="sr-only">{t('年份')}</span>
              <select
                value={viewDate.getFullYear()}
                onChange={(event) => setViewDate(new Date(Number(event.target.value), viewDate.getMonth(), 1))}
              >
                {[REFERENCE_TODAY.getFullYear() - 1, REFERENCE_TODAY.getFullYear(), REFERENCE_TODAY.getFullYear() + 1]
                  .map((year) => <option key={year} value={year}>{new Intl.DateTimeFormat(locale, { year: 'numeric' }).format(new Date(year, 0, 1))}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">{t('月份')}</span>
              <select
                value={viewDate.getMonth()}
                onChange={(event) => setViewDate(new Date(viewDate.getFullYear(), Number(event.target.value), 1))}
              >
                {Array.from({ length: 12 }, (_, month) => <option key={month} value={month}>{new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2020, month, 1))}</option>)}
              </select>
            </label>
          </span>
          <span>
            <button type="button" title={t('下个月')} aria-label={t('下个月')} onClick={() => moveMonth(1)}><ChevronRight aria-hidden="true" /></button>
            <button type="button" title={t('下一年')} aria-label={t('下一年')} onClick={() => moveYear(1)}><ChevronsRight aria-hidden="true" /></button>
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
          <span>{t('记录较少')}</span>
          <span className="diary-calendar-legend" aria-hidden="true">
            {[1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}
          </span>
          <span>{t('记录丰富')}</span>
          <button type="button" onClick={() => {
            onSelect(REFERENCE_TODAY)
            closeDialog()
          }}>{t('回到今天')}</button>
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
        aria-label={t(playing ? '暂停语音' : '播放语音')}
        title={t(playing ? '暂停' : '播放')}
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
            aria-label={t('语音播放进度')}
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
      aria-label={t('图片预览')}
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeLightbox()
      }}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="diary-image-lightbox-close"
        aria-label={t('关闭图片预览')}
        title={t('关闭')}
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
            aria-label={t('查看上一张图片')}
            title={t('上一张')}
            onClick={() => navigate(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="diary-image-lightbox-arrow diary-image-lightbox-arrow-next"
            aria-label={t('查看下一张图片')}
            title={t('下一张')}
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
        <strong>{t('这一天还没有留下日记')}</strong>
        <span>{t('日期仍然保留在时间轴中。')}</span>
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
            <time>{event.time}{event.endTime ? <small>{t('至 {time}', { time: event.endTime })}</small> : null}</time>
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
                      aria-label={t('放大查看第 {index} 张图片：{alt}', { index: index + 1, alt: image.alt })}
                      title={t('点击放大')}
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
      <div className="diary-closing-brand">{t('NexOS · 个人信息仅用于你的日记回顾')}</div>
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
  const [loadingDate, setLoadingDate] = useState<string | null>(null)
  const [runElapsedSeconds, setRunElapsedSeconds] = useState(0)
  const stripDays = useMemo(() => buildDateRange(STRIP_START, STRIP_DAY_COUNT), [])
  const selectedKey = toDateKey(selectedDate)
  const diary = generatedDays[selectedKey] ?? diaryDays[selectedKey]
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
    if (!window.nxcore) return
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
      if (!cancelled) setLoadingDate((current) => current === selectedKey ? null : current)
    })
    return () => { cancelled = true }
  }, [locale, selectedKey, t])

  const generateDiary = useCallback(async () => {
    if (!window.nxcore || activeRun) return
    try {
      const { runId } = await window.nxcore.diary.generate(selectedKey)
      setActiveRun({ id: runId, date: selectedKey, startedAt: new Date().toISOString(), attempt: 0 })
      showToast({
        title: t('日记生成已开始'),
        message: t('{date} 正在后台整理。', { date: formatDayHeading(selectedDate, locale, t) }),
      })
    } catch {
      setActiveRun(null)
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
          const generated = details ? toDiaryDay(details, locale, t) : null
          if (generated) setGeneratedDays((current) => ({ ...current, [activeRun.date]: generated }))
          if (details) {
            void loadDiaryMedia(details, locale, t).then((withMedia) => {
              if (!cancelled && withMedia) {
                setGeneratedDays((current) => ({ ...current, [activeRun.date]: withMedia }))
              }
            })
          }
          setActiveRun(null)
          showToast({
            title: t('日记生成完成'),
            message: t('{date} 已生成新的日记版本。', {
              date: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' })
                .format(new Date(`${activeRun.date}T00:00:00`)),
            }),
          })
          return
        }
        if (run.status === 'failed') {
          setActiveRun(null)
          showToast({ title: t('日记生成失败'), message: run.error ?? t('后台任务未能完成。') })
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

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || !contentRef.current) {
      setSelectedDate(nextDate)
      return
    }

    gsap.killTweensOf(contentRef.current)
    gsap.to(contentRef.current, {
      opacity: 0,
      x: direction * -10,
      duration: 0.15,
      ease: 'power2.in',
      onComplete: () => setSelectedDate(nextDate),
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

  return (
    <div ref={pageRef} className="page diary-page">
      <header className="diary-date-strip">
        <div className="diary-date-strip-inner">
          <div className="diary-date-meta">
            <strong>{formatMonth(selectedDate, locale)}</strong>
            <span>{t('滑动查看前后日期')}</span>
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
                <RotateCcw aria-hidden="true" />{t('回到今天')}
              </button>
            ) : null}
            <button
              type="button"
              className="diary-generate-button"
              title={t('手动生成选中日期的日记')}
              disabled={activeRun !== null}
              aria-busy={activeRun !== null}
              onClick={() => void generateDiary()}
            >
              {activeRun ? <LoaderCircle aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              {activeRun ? `${t('生成中')} · ${formatElapsed(runElapsedSeconds)}` : t(diary ? '重新生成' : '生成日记')}
            </button>
            <button
              type="button"
              className="diary-icon-button"
              title={t('打开日历')}
              aria-label={t('打开完整日历')}
              aria-expanded={calendarOpen}
              onClick={() => setCalendarOpen(true)}
            >
              <CalendarDays aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="diary-strip-selection">
          {sameDay(selectedDate, REFERENCE_TODAY) ? t('今天') : new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(selectedDate)}
          <strong>{new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(selectedDate)}</strong>
        </div>
      </header>

      <main ref={contentRef} className="diary-content" aria-busy={diaryLoading}>
        <button
          type="button"
          className="diary-day-arrow diary-day-arrow-previous"
          title={t('前一天')}
          aria-label={t('查看前一天')}
          onClick={() => selectDate(shiftDate(selectedDate, -1))}
        ><ChevronLeft aria-hidden="true" /></button>
        <button
          type="button"
          className="diary-day-arrow diary-day-arrow-next"
          title={t('后一天')}
          aria-label={t('查看后一天')}
          disabled={selectedDate >= REFERENCE_TODAY}
          onClick={() => selectDate(shiftDate(selectedDate, 1))}
        ><ChevronRight aria-hidden="true" /></button>

        <section className="diary-day-intro">
          <span>{formatDayHeading(selectedDate, locale, t)}</span>
          <h1>{diary?.headline ?? t(diaryLoading ? '正在读取这一天的日记' : '这一天还没有留下日记')}</h1>
          <p>{diary?.summary ?? t(diaryLoading ? '正在载入已经整理好的时间轴。' : '没有可供整理的记录，但这一天仍然在你的时间线上。')}</p>
          {diary ? <small><Sparkles aria-hidden="true" />{t('内容已整理')} <i /> {diary.processingNote}</small> : null}
        </section>

        {diary ? (
          <aside className="diary-reflection">
            <strong><Sparkles aria-hidden="true" />{t('今天的状态观察')}</strong>
            <p>{diary.reflection}</p>
          </aside>
        ) : null}

        <section className="diary-trace">
          <header>
            <div><span>DAY TRACE</span><h2>{t('这一天值得记住的 {count} 个时刻', { count: diary?.events.length ?? 0 })}</h2></div>
            <time>{diary?.range ?? t('暂无记录')}</time>
          </header>
          <DiaryTimeline events={diary?.events ?? []} />
          {diary?.closing ? <DiaryClosing thought={diary.closing.thought} meta={diary.closing.meta} /> : null}
        </section>
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
