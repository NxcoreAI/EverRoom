import {
  CalendarCheck2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FilePenLine,
  Image as ImageIcon,
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

import diaryOfficeHallway from '@/assets/diary-office-hallway.png'
import diaryOfficeMeeting from '@/assets/diary-office-meeting.png'
import diaryOfficeWindow from '@/assets/diary-office-window.png'
import diarySunset from '@/assets/diary-sunset.png'

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

const officeHallwayImage: DiaryImage = { src: diaryOfficeHallway, alt: '安静的办公室走廊' }
const officeMeetingImage: DiaryImage = { src: diaryOfficeMeeting, alt: '围桌讨论中的团队' }
const officeWindowImage: DiaryImage = { src: diaryOfficeWindow, alt: '窗边明亮的工作空间' }
const sunsetImage: DiaryImage = { src: diarySunset, alt: '傍晚阳光照亮山野' }

const REFERENCE_TODAY = new Date(2026, 7, 13)
const STRIP_START = new Date(2026, 6, 30)
const STRIP_DAY_COUNT = 29

const EVENT_ICONS: Record<DiaryEventKind, LucideIcon> = {
  note: FilePenLine,
  focus: Monitor,
  meeting: UsersRound,
  image: ImageIcon,
  audio: Mic2,
  schedule: CalendarCheck2,
}

const diaryDays: Record<string, DiaryDay> = {
  '2026-08-13': {
    headline: '把复杂的想法，整理成了可以被看见的样子',
    summary: '今天的重心很清楚：你沿着 AI 日记的体验一路收束，从信息很多的工作台，慢慢确认它更应该是一页轻松读完的个人回顾。下午的讨论和几次修改，让这个方向变得具体了。',
    reflection: '从今天的记录看，你似乎在主动减少不必要的复杂度。几次停下来重新确认目标，没有拖慢进度，反而让后面的决定更连贯。',
    processingNote: '已在 01:07 完成',
    range: '09:18 - 20:24',
    events: [
      {
        time: '09:18',
        kind: 'note',
        label: '文字记录',
        title: '先把体验目标写成一句话',
        description: 'AI 日记首先是信息反馈和情绪回应，不应该要求用户在这里完成复杂操作。你把“30-60 秒读完”写在了草稿最上方。',
        detail: '让用户看见自己的一天，然后自然离开。',
      },
      {
        time: '10:42',
        kind: 'focus',
        label: '设备活动',
        title: '连续专注 1 小时 26 分钟',
        description: '主要停留在需求文档、原型画布和浏览器；窗口切换比昨天少，上午的工作节奏较集中。',
        metrics: [
          { value: '1h 26m', label: '连续专注' },
          { value: '3', label: '主要应用' },
          { value: '11:08', label: '结束时间' },
        ],
      },
      {
        time: '13:35',
        kind: 'meeting',
        label: '会议',
        title: '产品体验快速评审',
        description: '讨论从“如何让用户修改 AI”转向“如何让用户快速感受到一天被理解”。最终保留日期回看、图片查看和语音播放三个必要动作。',
        detail: '42 分钟，4 人参与',
      },
      {
        time: '14:48',
        kind: 'image',
        label: '图片 · 单图',
        title: '一张图，保留完整画面',
        description: '单张图片沿用舒展的横向比例，让一个瞬间成为这段记录的视觉重点。',
        images: [sunsetImage],
      },
      {
        time: '15:06',
        kind: 'image',
        label: '图片 · 两张',
        title: '两张图，平行记录同一段经历',
        description: '两张图片左右等分，适合同一时刻的两个视角。',
        images: [officeHallwayImage, officeMeetingImage],
      },
      {
        time: '15:28',
        kind: 'image',
        label: '图片 · 三张',
        title: '三张图，用主次关系讲清现场',
        description: '左侧主图承担叙事，右侧两张补充人物和空间细节。',
        images: [officeHallwayImage, officeMeetingImage, officeWindowImage],
      },
      {
        time: '15:52',
        kind: 'image',
        label: '图片 · 四张',
        title: '四张图，收进一组完整回顾',
        description: '四宫格保持每张图片同等权重，适合连续发生的片段。',
        images: [officeHallwayImage, officeMeetingImage, officeWindowImage, sunsetImage],
      },
      {
        time: '18:06',
        kind: 'audio',
        label: '语音片段',
        title: '回家路上记下的一个判断',
        description: '一段 38 秒的随手记录，后来成为今天方案的收尾。',
        audio: {
          duration: 38,
          transcript: '我觉得日记不是另一个需要维护的系统。它应该像有人替我把散落的一天轻轻收好，我看一眼，就知道今天大概是怎么走过来的。',
        },
      },
      {
        time: '20:24',
        kind: 'schedule',
        label: '日程',
        title: '给明天留出一段安静的时间',
        description: '明早 09:30-10:30 已预留，用来单独检查日期导航与多媒体内容的阅读节奏。',
        detail: '明天 09:30 · 个人日程',
      },
    ],
    closing: {
      thought: '今天留下的不只是一个页面，而是一个更清楚的判断：有些好的体验，来自少做一点。',
      meta: '2026 年 8 月 13 日 · 这一天已经轻轻收好',
    },
  },
  '2026-08-05': {
    headline: '在工作之外，也留住了一点具体的生活',
    summary: '今天完成了计划中的两项工作，也在午后和傍晚留下了几段轻松的片刻。',
    reflection: '从当天记录看，节奏似乎比前几天舒展一些。这里不对没有记录的时段作推断。',
    processingNote: '当天记录已整理完成',
    range: '09:24 - 19:40',
    events: [
      {
        time: '09:24',
        kind: 'focus',
        label: '设备活动',
        title: '上午完成一段连续专注',
        description: '主要在文档和浏览器之间工作，连续停留约 54 分钟。',
      },
      {
        time: '11:16',
        kind: 'meeting',
        label: '会议',
        title: '一次简短而有效的同步',
        description: '对齐了当前重点，也明确了下一步需要独立完成的部分。',
        detail: '26 分钟，3 人参与',
      },
      {
        time: '15:32',
        kind: 'image',
        label: '图片',
        title: '下午留下的一张照片',
        description: '光线落在桌面上，成为这一天里一个安静的停顿。',
        images: [sunsetImage],
      },
      {
        time: '19:40',
        kind: 'note',
        label: '文字记录',
        title: '下班后的慢节奏',
        description: '没有继续处理新的任务，只简单整理了明天需要开始的事情。',
      },
    ],
  },
}

const intensityByDate: Record<string, number> = {
  '2026-07-22': 1,
  '2026-07-23': 2,
  '2026-07-24': 2,
  '2026-07-25': 3,
  '2026-07-26': 4,
  '2026-07-27': 2,
  '2026-07-28': 2,
  '2026-07-29': 3,
  '2026-07-30': 1,
  '2026-07-31': 2,
  '2026-08-01': 3,
  '2026-08-02': 2,
  '2026-08-03': 4,
  '2026-08-04': 2,
  '2026-08-05': 3,
  '2026-08-06': 3,
  '2026-08-07': 1,
  '2026-08-08': 2,
  '2026-08-09': 1,
  '2026-08-10': 2,
  '2026-08-11': 4,
  '2026-08-12': 2,
  '2026-08-13': 4,
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

function formatDayHeading(date: Date): string {
  if (sameDay(date, REFERENCE_TODAY)) return '今天 · 星期四'
  const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date)
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekday}`
}

function formatMonth(date: Date): string {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`
}

function createCalendarDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1)
  const mondayOffset = (first.getDay() + 6) % 7
  const start = shiftDate(first, -mondayOffset)
  return buildDateRange(start, 42)
}

function CalendarDialog({
  selectedDate,
  onSelect,
  onClose,
}: {
  selectedDate: Date
  onSelect: (date: Date) => void
  onClose: () => void
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const isClosingRef = useRef(false)
  const [viewDate, setViewDate] = useState(
    () => new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1),
  )
  const calendarDays = useMemo(
    () => createCalendarDays(viewDate.getFullYear(), viewDate.getMonth()),
    [viewDate],
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
            <span>日期回顾</span>
            <h2 id="diary-calendar-title">{formatMonth(viewDate)}</h2>
          </div>
          <button type="button" className="diary-icon-button" title="关闭" aria-label="关闭日历" onClick={closeDialog}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="diary-calendar-controls">
          <span>
            <button type="button" title="上一年" aria-label="上一年" onClick={() => moveYear(-1)}><ChevronsLeft aria-hidden="true" /></button>
            <button type="button" title="上个月" aria-label="上个月" onClick={() => moveMonth(-1)}><ChevronLeft aria-hidden="true" /></button>
          </span>
          <span>
            <label>
              <span className="sr-only">年份</span>
              <select
                value={viewDate.getFullYear()}
                onChange={(event) => setViewDate(new Date(Number(event.target.value), viewDate.getMonth(), 1))}
              >
                {[2025, 2026, 2027].map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">月份</span>
              <select
                value={viewDate.getMonth()}
                onChange={(event) => setViewDate(new Date(viewDate.getFullYear(), Number(event.target.value), 1))}
              >
                {Array.from({ length: 12 }, (_, month) => <option key={month} value={month}>{month + 1} 月</option>)}
              </select>
            </label>
          </span>
          <span>
            <button type="button" title="下个月" aria-label="下个月" onClick={() => moveMonth(1)}><ChevronRight aria-hidden="true" /></button>
            <button type="button" title="下一年" aria-label="下一年" onClick={() => moveYear(1)}><ChevronsRight aria-hidden="true" /></button>
          </span>
        </div>

        <div className="diary-calendar-weekdays" aria-hidden="true">
          {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day) => <span key={day}>{day}</span>)}
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
          <span>记录较少</span>
          <span className="diary-calendar-legend" aria-hidden="true">
            {[1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}
          </span>
          <span>记录丰富</span>
          <button type="button" onClick={() => {
            onSelect(REFERENCE_TODAY)
            closeDialog()
          }}>回到今天</button>
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
        aria-label={playing ? '暂停语音' : '播放语音'}
        title={playing ? '暂停' : '播放'}
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
            aria-label="语音播放进度"
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
      aria-label="图片预览"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) closeLightbox()
      }}
    >
      <button
        ref={closeButtonRef}
        type="button"
        className="diary-image-lightbox-close"
        aria-label="关闭图片预览"
        title="关闭"
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
            aria-label="查看上一张图片"
            title="上一张"
            onClick={() => navigate(-1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="diary-image-lightbox-arrow diary-image-lightbox-arrow-next"
            aria-label="查看下一张图片"
            title="下一张"
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
  const [previewImage, setPreviewImage] = useState<DiaryImagePreview | null>(null)

  if (events.length === 0) {
    return (
      <div className="diary-empty-state">
        <CalendarDays aria-hidden="true" />
        <strong>这一天还没有留下日记</strong>
        <span>日期仍然保留在时间轴中。</span>
      </div>
    )
  }

  return (
    <div className="diary-timeline-list">
      {events.map((event) => {
        const EventIcon = EVENT_ICONS[event.kind]
        const images = event.images
        return (
          <article key={`${event.time}-${event.title}`} className="diary-timeline-event" data-kind={event.kind}>
            <time>{event.time}</time>
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
                      aria-label={`放大查看第 ${index + 1} 张图片：${image.alt}`}
                      title="点击放大"
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
  return (
    <footer className="diary-closing">
      <div className="diary-closing-divider" aria-hidden="true"><span><Sparkles /></span></div>
      <blockquote>{thought}</blockquote>
      <small>{meta}</small>
      <div className="diary-closing-brand">NexOS · 个人信息仅用于你的日记回顾</div>
    </footer>
  )
}

export function DiaryPage() {
  const pageRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLElement>(null)
  const transitionDirectionRef = useRef(1)
  const isFirstRenderRef = useRef(true)
  const [selectedDate, setSelectedDate] = useState(REFERENCE_TODAY)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const stripDays = useMemo(() => buildDateRange(STRIP_START, STRIP_DAY_COUNT), [])
  const selectedKey = toDateKey(selectedDate)
  const diary = diaryDays[selectedKey]

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
            <strong>{formatMonth(selectedDate)}</strong>
            <span>滑动查看前后日期</span>
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
                  aria-label={`${date.getMonth() + 1} 月 ${date.getDate()} 日`}
                  aria-pressed={sameDay(date, selectedDate)}
                  onClick={() => selectDate(date)}
                >
                  <small>{['日', '一', '二', '三', '四', '五', '六'][date.getDay()]}</small>
                  <i aria-hidden="true" />
                  <span>{date.getDate()}</span>
                </button>
              )
            })}
          </div>
          <span className="diary-strip-actions">
            {!sameDay(selectedDate, REFERENCE_TODAY) ? (
              <button type="button" className="diary-today-button" onClick={() => selectDate(REFERENCE_TODAY)}>
                <RotateCcw aria-hidden="true" />回到今天
              </button>
            ) : null}
            <button
              type="button"
              className="diary-icon-button"
              title="打开日历"
              aria-label="打开完整日历"
              aria-expanded={calendarOpen}
              onClick={() => setCalendarOpen(true)}
            >
              <CalendarDays aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="diary-strip-selection">
          {sameDay(selectedDate, REFERENCE_TODAY) ? '今天' : new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(selectedDate)}
          <strong>{selectedDate.getMonth() + 1} 月 {selectedDate.getDate()} 日</strong>
        </div>
      </header>

      <main ref={contentRef} className="diary-content">
        <button
          type="button"
          className="diary-day-arrow diary-day-arrow-previous"
          title="前一天"
          aria-label="查看前一天"
          onClick={() => selectDate(shiftDate(selectedDate, -1))}
        ><ChevronLeft aria-hidden="true" /></button>
        <button
          type="button"
          className="diary-day-arrow diary-day-arrow-next"
          title="后一天"
          aria-label="查看后一天"
          disabled={selectedDate >= REFERENCE_TODAY}
          onClick={() => selectDate(shiftDate(selectedDate, 1))}
        ><ChevronRight aria-hidden="true" /></button>

        <section className="diary-day-intro">
          <span>{formatDayHeading(selectedDate)}</span>
          <h1>{diary?.headline ?? '这一天还没有留下日记'}</h1>
          <p>{diary?.summary ?? '没有可供整理的记录，但这一天仍然在你的时间线上。'}</p>
          <small><Sparkles aria-hidden="true" />内容已整理 <i /> {diary?.processingNote ?? '暂无内容'}</small>
        </section>

        {diary ? (
          <aside className="diary-reflection">
            <strong><Sparkles aria-hidden="true" />今天的状态观察</strong>
            <p>{diary.reflection}</p>
          </aside>
        ) : null}

        <section className="diary-trace">
          <header>
            <div><span>DAY TRACE</span><h2>今天值得记住的 {diary?.events.length ?? 0} 个时刻</h2></div>
            <time>{diary?.range ?? '暂无记录'}</time>
          </header>
          <DiaryTimeline events={diary?.events ?? []} />
          {diary?.closing ? <DiaryClosing thought={diary.closing.thought} meta={diary.closing.meta} /> : null}
        </section>
      </main>

      {calendarOpen ? (
        <CalendarDialog selectedDate={selectedDate} onSelect={selectDate} onClose={() => setCalendarOpen(false)} />
      ) : null}
    </div>
  )
}
