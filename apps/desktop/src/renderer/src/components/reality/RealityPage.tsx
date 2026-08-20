import {
  AlertCircle,
  Bookmark,
  CalendarDays,
  ChevronDown,
  CircleDot,
  Download,
  FileText,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Tag,
  Trash2,
  X,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings } from '@/state/realitySettings'
import { showToast } from '@/state/toast'
import type { RealityEvent, RealityEventStatus, RealityEventType, RealityTag } from '../../../../shared/sources'
import { RecordingPage } from '../recording/RecordingPage'
import { mergeRealityEvent, mergeRealitySnapshot } from './reality-event-state'
import './RealityPage.css'

type DetailTab = 'insights' | 'transcript'
type StatusFilter = 'all' | RealityEventStatus
type ActivityRange = '1w' | '1m' | '3m' | '6m' | '1y'

const STATUS_LABELS: Record<RealityEventStatus, string> = {
  ongoing: '进行中',
  pending_confirmation: '已完成',
  completed: '已完成',
  failed: '失败',
  pending_sync: '待同步',
}

const PROCESSING_LABELS: Record<RealityEvent['processingState'], string> = {
  capturing: '正在采集',
  saving: '正在保存',
  transcribing: 'SaaS 正在转写',
  understanding: '正在整理',
  ready: '处理完成',
  failed: '处理失败',
}

const PROCESSING_HINTS: Record<RealityEvent['processingState'], string> = {
  capturing: '正在录制现场音频,结束后会自动进入转写。',
  saving: '正在保存录音文件,马上开始转写。',
  transcribing: '转写进行中,逐字稿和智能总结完成后会自动出现。',
  understanding: 'AI 正在从转写中提炼总结、标签和关键内容。',
  ready: '',
  failed: '处理失败,可尝试重新处理。',
}

const EVENT_TYPE_LABELS: Record<RealityEventType, string> = {
  MEETING: 'MEETING',
  MEAL: 'MEAL',
  WORK: 'WORK',
  SOCIAL: 'SOCIAL',
  LEARNING: 'LEARNING',
  CHITCHAT: 'CHITCHAT',
  REST: 'REST',
  EXERCISE: 'EXERCISE',
  OTHER: 'OTHER',
}

const RANGE_WEEKS: Record<ActivityRange, number> = { '1w': 1, '1m': 5, '3m': 13, '6m': 26, '1y': 53 }
const ACTIVITY_RANGES: readonly [ActivityRange, string][] = [
  ['1w', '1 周'], ['1m', '1 月'], ['3m', '3 月'], ['6m', '半年'], ['1y', '1 年'],
]

/** 自动选择能覆盖全部使用历史的最大时间范围:尽可能把所有活跃都展示出来。 */
function preferredActivityRange(events: RealityEvent[]): ActivityRange {
  if (events.length === 0) return '1m'
  const now = Date.now()
  const earliest = Math.min(...events.map((event) => Date.parse(event.startedAt)))
  const weeks = Math.max(1, Math.ceil((now - earliest) / (7 * 24 * 60 * 60 * 1000)))
  if (weeks <= RANGE_WEEKS['1w']) return '1w'
  if (weeks <= RANGE_WEEKS['1m']) return '1m'
  if (weeks <= RANGE_WEEKS['3m']) return '3m'
  if (weeks <= RANGE_WEEKS['6m']) return '6m'
  return '1y'
}
const REPROCESS_POLL_INTERVAL_MS = 6_000
const REPROCESS_TIMEOUT_MS = 30 * 60 * 1000

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function dateGroup(value: string): string {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return '今天'
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(date)
}

function dayKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayChipLabel(key: string): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(year!, month! - 1, day!))
}

function eventType(event: RealityEvent): RealityEventType {
  return event.insights.eventType ?? 'OTHER'
}

function buildActivity(events: RealityEvent[], range: ActivityRange) {
  const weekCount = RANGE_WEEKS[range]
  const counts = new Map<string, number>()
  for (const event of events) counts.set(dayKey(event.startedAt), (counts.get(dayKey(event.startedAt)) ?? 0) + 1)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(today.getDate() - today.getDay() - (weekCount - 1) * 7)
  const weeks = Array.from({ length: weekCount }, (_, weekIndex) => {
    const weekStart = new Date(start)
    weekStart.setDate(start.getDate() + weekIndex * 7)
    return Array.from({ length: 7 }, (_, dayIndex) => {
      const date = new Date(weekStart)
      date.setDate(weekStart.getDate() + dayIndex)
      return { date, count: date <= today ? counts.get(dayKey(date)) ?? 0 : -1 }
    })
  })
  const max = Math.max(1, ...weeks.flat().map((cell) => cell.count))
  const monthLabels = weeks.map((week, index) => {
    const date = week[0]!.date
    const previous = index > 0 ? weeks[index - 1]![0]!.date : null
    return !previous || previous.getMonth() !== date.getMonth()
      ? { column: index + 1, label: new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(date) }
      : null
  }).filter(Boolean) as { column: number; label: string }[]
  const past = weeks.flat().filter((cell) => cell.date <= today)
  const total = past.reduce((sum, cell) => sum + Math.max(0, cell.count), 0)
  let streak = 0
  let cursor = past.length - 1
  if (past[cursor]?.count === 0) cursor -= 1
  while (cursor >= 0 && past[cursor]!.count > 0) { streak += 1; cursor -= 1 }
  return { weeks, max, monthLabels, total, streak }
}

export function RealityPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { account } = useAccount()
  const [events, setEvents] = useState<RealityEvent[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [activityRange, setActivityRange] = useState<ActivityRange>('3m')
  const [rangeTouched, setRangeTouched] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('insights')
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [cloudAudioAssetIds, setCloudAudioAssetIds] = useState<string[]>([])
  const [cloudAudioIndex, setCloudAudioIndex] = useState(0)
  const [playbackPositionMs, setPlaybackPositionMs] = useState(0)
  const [playbackDurationMs, setPlaybackDurationMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [reprocessingId, setReprocessingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [savingTags, setSavingTags] = useState(false)
  const [exportingTranscript, setExportingTranscript] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const activeSegmentRef = useRef<HTMLButtonElement | null>(null)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)

  const loadEvents = useCallback(async () => {
    if (!window.nxcore) {
      setLoading(false)
      return
    }
    try {
      const next = await window.nxcore.reality.listEvents()
      setEvents((current) => mergeRealitySnapshot(current, next))
      setExpandedId((current) => current && next.some((event) => event.id === current)
        ? current
        : next.find((event) => event.status === 'ongoing')?.id ?? null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '现实感知事件加载失败。')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadEvents()
    if (!window.nxcore) return
    const removeListener = window.nxcore.reality.onEvent((frame) => {
      if (frame.type !== 'event.updated') return
      const incoming = frame.change.event
      setEvents((current) => mergeRealityEvent(current, incoming))
      if (incoming.status === 'ongoing') setExpandedId((current) => current ?? incoming.id)
    })
    void window.nxcore.reality.subscribe()
    return () => {
      removeListener()
      void window.nxcore?.reality.unsubscribe()
    }
  }, [loadEvents])

  useEffect(() => {
    if (!account?.authenticated || !window.nxcore) return
    const sync = async () => {
      await window.nxcore!.transcriptions.syncPrivate({ quiet: true })
      await loadEvents()
    }
    void sync().catch(() => undefined)
    const timer = window.setInterval(() => void sync().catch(() => undefined), 15_000)
    return () => window.clearInterval(timer)
  }, [account?.authenticated, loadEvents])

  const selected = events.find((event) => event.id === expandedId) ?? null
  const visibleEvents = useMemo(() => events.filter((event) => {
    if (filter !== 'all' && event.status !== filter) return false
    if (selectedDay && dayKey(event.startedAt) !== selectedDay) return false
    const query = search.trim().toLocaleLowerCase()
    return !query || [event.title, event.transcript, event.currentTopic ?? '', event.insights.summary ?? '', ...(event.insights.representativeTags ?? []).map((tag) => tag.label)]
      .some((value) => value.toLocaleLowerCase().includes(query))
  }), [events, filter, search, selectedDay])
  const grouped = useMemo(() => {
    const groups = new Map<string, RealityEvent[]>()
    for (const event of visibleEvents) {
      const key = dateGroup(event.startedAt)
      groups.set(key, [...(groups.get(key) ?? []), event])
    }
    return [...groups.entries()]
  }, [visibleEvents])
  const activity = useMemo(() => buildActivity(events, activityRange), [events, activityRange])

  // 首次加载后按活跃量自动选择范围;用户手动切换后不再覆盖。
  useEffect(() => {
    if (rangeTouched || loading) return
    setActivityRange(preferredActivityRange(events))
    setRangeTouched(true)
  }, [loading, events, rangeTouched])

  useEffect(() => {
    setDetailTab('insights')
    setDeleteConfirmId(null)
  }, [selected?.id])

  const removeTag = async (event: RealityEvent, tag: RealityTag) => {
    const summaryRecordId = event.insights.summaryRecordId
    if (!window.nxcore || !summaryRecordId) return
    setSavingTags(true)
    try {
      await window.nxcore.transcriptions.replaceSummaryTags(summaryRecordId, (event.insights.representativeTags ?? []).filter((item) => item.id ? item.id !== tag.id : item.label !== tag.label))
      await loadEvents()
    } catch (caught) {
      showToast({ title: '标签移除失败', message: caught instanceof Error ? caught.message : undefined })
    } finally {
      setSavingTags(false)
    }
  }

  useEffect(() => {
    let objectUrl: string | null = null
    setAudioUrl(null)
    setPlaybackPositionMs(0)
    setPlaybackDurationMs(selected?.durationMs ?? 0)
    setIsPlaying(false)
    setCloudAudioAssetIds([])
    setCloudAudioIndex(0)
    if (!selected || !window.nxcore) return
    let cancelled = false
    const load = async () => {
      if (selected.audioFileName) {
        const bytes = await window.nxcore!.reality.readAudio(selected.id)
        return { bytes, mimeType: selected.audioMimeType ?? 'audio/webm' }
      }
      const page = await window.nxcore!.privateAudio.list(0)
      const segmentIds = new Set(selected.transcriptSegments.map((segment) => segment.id.split(':')[0]))
      const assets = page.assets.filter((asset) => asset.status === 'uploaded' && (asset.eventId === selected.id || asset.recordingId === selected.id || segmentIds.has(asset.recordingId))).sort((a,b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      setCloudAudioAssetIds(assets.map((asset) => asset.id))
      if (!assets[0]) return null
      return window.nxcore!.privateAudio.read(assets[0].id)
    }
    void load().then((payload) => {
      if (!payload) return
      const { bytes, mimeType } = payload
      if (cancelled) return
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: mimeType }))
      setAudioUrl(objectUrl)
    }).catch((caught) => {
      if (!cancelled) showToast({ title: '录音读取失败', message: caught instanceof Error ? caught.message : undefined })
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [selected?.id, selected?.audioFileName, selected?.audioMimeType, selected?.durationMs])

  const playNextCloudSegment = async () => {
    if (!window.nxcore || cloudAudioIndex + 1 >= cloudAudioAssetIds.length) { setIsPlaying(false); return }
    const nextIndex = cloudAudioIndex + 1
    const payload = await window.nxcore.privateAudio.read(cloudAudioAssetIds[nextIndex])
    const copy = new Uint8Array(payload.bytes.byteLength); copy.set(payload.bytes)
    setCloudAudioIndex(nextIndex)
    setAudioUrl(URL.createObjectURL(new Blob([copy.buffer], { type: payload.mimeType })))
    window.setTimeout(() => void audioRef.current?.play(), 0)
  }

  const activeSegmentId = useMemo(() => {
    if (!selected || (!isPlaying && playbackPositionMs <= 0)) return null
    const segments = selected.transcriptSegments
    return segments.find((segment, index) => {
      const nextBegin = segments[index + 1]?.beginTime ?? Number.POSITIVE_INFINITY
      const end = Math.max(segment.endTime, nextBegin)
      return playbackPositionMs >= segment.beginTime && playbackPositionMs < end
    })?.id ?? null
  }, [isPlaying, playbackPositionMs, selected])

  useEffect(() => {
    const container = transcriptScrollRef.current
    const active = activeSegmentRef.current
    if (!container || !active) return
    const containerRect = container.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    if (activeRect.top >= containerRect.top && activeRect.bottom <= containerRect.bottom) return
    container.scrollTo({
      top: container.scrollTop + activeRect.top - containerRect.top - (container.clientHeight - active.clientHeight) / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [activeSegmentId])

  const replaceEvent = (updated: RealityEvent) => {
    setEvents((current) => mergeRealityEvent(current, updated))
  }

  const toggleImportant = async (event: RealityEvent) => {
    if (!window.nxcore) return
    if (event.important) {
      replaceEvent(await window.nxcore.reality.setImportant(event.id, false))
      return
    }
    const atMs = event.status === 'ongoing' ? Math.max(0, Date.now() - Date.parse(event.startedAt)) : event.durationMs
    replaceEvent(await window.nxcore.reality.addMarker(event.id, { atMs }))
  }

  const discardEvent = async (event: RealityEvent) => {
    if (!window.nxcore) return
    if (deleteConfirmId !== event.id) {
      setDeleteConfirmId(event.id)
      return
    }
    if (typeof window.nxcore.reality.discard !== 'function') {
      setDeleteConfirmId(null)
      showToast({ title: '需要重启 EverRoom', message: '重启后即可删除已有事件。' })
      return
    }
    try {
      await window.nxcore.reality.discard(event.id)
      setEvents((current) => current.filter((item) => item.id !== event.id))
      setExpandedId((current) => current === event.id ? null : current)
      setDeleteConfirmId(null)
      showToast({ title: '事件已删除' })
    } catch (caught) {
      showToast({ title: '事件删除失败', message: caught instanceof Error ? caught.message : undefined })
    }
  }

  const reprocessEvent = async (event: RealityEvent) => {
    if (!window.nxcore || !event.audioFileName || reprocessingId) return
    const settings = loadRealitySettings()
    const mode = settings.mode === 'cloud' || (settings.mode === 'auto' && account?.authenticated)
      ? 'cloud'
      : 'local'
    setReprocessingId(event.id)
    try {
      let job = await window.nxcore.asr.createJob({
        filePath: event.audioFileName,
        mode,
        recordingId: event.id,
        durationMs: event.durationMs,
        retryToken: crypto.randomUUID(),
        languageHints: settings.languages,
        diarizationEnabled: true,
      })
      const deadline = Date.now() + REPROCESS_TIMEOUT_MS
      while (job.status === 'pending' || job.status === 'running') {
        if (Date.now() >= deadline) throw new Error('重新处理超过 30 分钟，请稍后再试。')
        await new Promise((resolve) => window.setTimeout(resolve, REPROCESS_POLL_INTERVAL_MS))
        job = await window.nxcore.asr.getJob(job.id)
      }
      if (job.status !== 'completed') throw new Error(job.error ?? '重新处理失败。')
      replaceEvent(await window.nxcore.reality.getEvent(event.id))
      showToast({ title: '重新处理完成' })
    } catch (caught) {
      showToast({ title: '重新处理失败', message: caught instanceof Error ? caught.message : undefined })
    } finally {
      setReprocessingId(null)
    }
  }

  const exportTranscript = async (event: RealityEvent) => {
    if (!window.nxcore || exportingTranscript) return
    setExportingTranscript(true)
    try {
      const lines = [
        event.title,
        `${new Date(event.startedAt).toLocaleString('zh-CN')} · ${formatDuration(event.durationMs)} · ${event.captureDevice.name}`,
        '',
        ...(event.transcriptSegments.length > 0
          ? event.transcriptSegments.map((segment) => `[${formatDuration(segment.beginTime)}] ${segment.speakerId === null ? '说话人' : `说话人 ${segment.speakerId + 1}`}: ${segment.text}`)
          : [event.transcript]),
      ]
      const result = await window.nxcore.reality.exportTranscript({
        fileName: `${event.title}.txt`,
        content: `${lines.join('\n')}\n`,
      })
      if (!result.canceled) showToast({ title: '逐字稿已导出', message: result.filePath })
    } catch (caught) {
      showToast({ title: '导出失败', message: caught instanceof Error ? caught.message : undefined })
    } finally {
      setExportingTranscript(false)
    }
  }

  const seekTo = (milliseconds: number, playAfterSeek = true) => {
    if (!audioRef.current) return
    audioRef.current.currentTime = milliseconds / 1000
    setPlaybackPositionMs(milliseconds)
    if (playAfterSeek) void audioRef.current.play()
  }

  const togglePlayback = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  }

  const updatePlaybackDuration = () => {
    const audioDurationMs = (audioRef.current?.duration ?? 0) * 1000
    setPlaybackDurationMs(Number.isFinite(audioDurationMs) && audioDurationMs > 0
      ? audioDurationMs
      : selected?.durationMs ?? 0)
  }

  return (
    <div className="reality-page">
      <header className="reality-header">
        <div>
          <h1>现实感知</h1>
        </div>
        <RecordingPage
          embedded
          controlOnly
          onOpenSettings={onOpenSettings}
          onEventChanged={(event) => {
            setEvents((current) => mergeRealityEvent(current, event))
            setExpandedId(event.id)
          }}
        />
      </header>

      <section className="reality-activity" aria-labelledby="activity-title">
        <header>
          <div>
            <h2 id="activity-title">感知活跃度</h2>
            <span>{activity.total} 个事件 · 连续 {activity.streak} 天</span>
          </div>
          <div className="reality-range" aria-label="活跃度时间范围">
            {ACTIVITY_RANGES.map(([value, label]) => (
              <button type="button" key={value} aria-pressed={activityRange === value} onClick={() => { setRangeTouched(true); setActivityRange(value) }}>{label}</button>
            ))}
          </div>
        </header>
        <div className="activity-chart" style={{ '--activity-weeks': activity.weeks.length } as CSSProperties}>
          <div className="activity-months">{activity.monthLabels.map((item) => (
            <span key={item.column} style={{ gridColumn: item.column }}>{item.label}</span>
          ))}</div>
          <div className="activity-weekdays"><span>一</span><span>三</span><span>五</span></div>
          <div className="activity-cells">
            {activity.weeks.flatMap((week, weekIndex) => week.map((cell, dayIndex) => {
              const key = dayKey(cell.date)
              const isFuture = cell.count < 0
              const level = isFuture ? -1 : cell.count === 0 ? 0 : Math.max(1, Math.ceil(cell.count / activity.max * 4))
              const isToday = key === dayKey(new Date())
              return (
                <button
                  type="button"
                  key={`${weekIndex}-${dayIndex}`}
                  className="activity-cell"
                  data-level={level}
                  data-today={String(isToday)}
                  data-selected={String(selectedDay === key)}
                  disabled={isFuture}
                  aria-pressed={selectedDay === key}
                  aria-label={isFuture ? undefined : `${key} · ${cell.count} 个事件`}
                  title={isFuture ? undefined : `${key} · ${cell.count} 个事件`}
                  style={{ animationDelay: `${Math.min((weekIndex * 7 + dayIndex) * 2, 600)}ms` }}
                  onClick={() => setSelectedDay(selectedDay === key ? null : key)}
                />
              )
            }))}
          </div>
        </div>
        <div className="activity-footer">
          <div className="activity-legend" aria-hidden="true">
            <span>少</span>
            {[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}
            <span>多</span>
          </div>
        </div>
      </section>

      <div className="reality-toolbar">
        <div>
          <CalendarDays aria-hidden="true" />
          <strong>时间线</strong>
          {selectedDay ? (
            <button type="button" className="reality-day-chip" onClick={() => setSelectedDay(null)}>
              {dayChipLabel(selectedDay)}
              <X aria-hidden="true" />
            </button>
          ) : (
            <span>{visibleEvents.length} / {events.length} 个事件</span>
          )}
        </div>
        <label className="reality-search"><Search aria-hidden="true" /><input value={search} placeholder="搜索主题或逐字稿" onChange={(event) => setSearch(event.target.value)} /></label>
        <select value={filter} aria-label="事件状态筛选" onChange={(event) => setFilter(event.target.value as StatusFilter)}>
          <option value="all">全部状态</option>
          <option value="ongoing">进行中</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="pending_sync">待同步</option>
        </select>
      </div>

      {error ? (
        <div className="reality-error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="icon-button" title="关闭" aria-label="关闭错误提示" onClick={() => setError(null)}><X aria-hidden="true" /></button>
        </div>
      ) : null}

      <main className="reality-timeline">
        {loading ? <div className="reality-empty"><LoaderCircle className="spin" />正在读取时间线</div> : null}
        {!loading && grouped.length === 0 ? (
          <div className="reality-empty"><div className="empty-signal"><i /><i /><i /><i /><i /></div><strong>今天还很安静</strong><span>打开右上角的聆听开关，第一段感知会出现在这里。</span></div>
        ) : null}
        {grouped.map(([label, items]) => (
          <section className="reality-day" key={label}>
            <header><h2>{label}</h2><span>{items.length} 段</span></header>
            <div className="reality-schedule">
              {items.map((event) => {
                const expanded = event.id === expandedId
                const type = eventType(event)
                return (
                  <article className="schedule-event" key={event.id} data-expanded={String(expanded)} data-type={type.toLowerCase()}>
                    <div className="schedule-time"><time>{timeLabel(event.startedAt)}</time><span /><small>{event.endedAt ? timeLabel(event.endedAt) : 'NOW'}</small></div>
                    <div className="schedule-block">
                      <button type="button" className="schedule-trigger" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : event.id)}>
                        <span className="event-type">{EVENT_TYPE_LABELS[type]}</span>
                        <span className="event-status" data-status={event.status}>{STATUS_LABELS[event.status]}</span>
                        <strong>{event.currentTopic || event.insights.currentTopic || event.title}</strong>
                        <p>{event.insights.summary || (event.transcript ? event.transcript.slice(0, 120) : PROCESSING_LABELS[event.processingState])}</p>
                        {(event.insights.representativeTags?.length ?? 0) > 0 ? <span className="schedule-tags">{event.insights.representativeTags!.slice(0, 5).map((tag) => <span key={tag.id ?? `${tag.kind}:${tag.label}`} data-kind={tag.kind}>{tag.label}{(tag.occurrenceCount ?? 0) > 1 ? <small>{tag.occurrenceCount}</small> : null}</span>)}</span> : null}
                        <small>{event.captureDevice.name} · <LiveDuration durationMs={event.durationMs} startedAt={event.startedAt} ongoing={event.status === 'ongoing'} /> · {PROCESSING_LABELS[event.processingState]}</small>
                        <span className="trigger-actions" onClick={(click) => click.stopPropagation()}>
                          <button type="button" className="icon-button" title={event.important ? '取消重要' : '标记重要'} aria-label={event.important ? '取消重要标记' : '标记重要'} aria-pressed={event.important} onClick={() => void toggleImportant(event)}><Bookmark fill={event.important ? 'currentColor' : 'none'} /></button>
                          <button type="button" className={deleteConfirmId === event.id ? 'danger-button' : 'icon-button'} title={deleteConfirmId === event.id ? '再次点击确认删除' : '删除事件'} aria-label={deleteConfirmId === event.id ? '确认删除事件' : '删除事件'} onClick={() => void discardEvent(event)}><Trash2 />{deleteConfirmId === event.id ? '确认删除' : null}</button>
                        </span>
                        <ChevronDown aria-hidden="true" />
                      </button>

                      {expanded ? (
                        <div className="schedule-detail">
                          <div className="schedule-detail-bar">
                            <div className="reality-detail-tabs" role="tablist">
                              <button type="button" role="tab" aria-selected={detailTab === 'insights'} onClick={() => setDetailTab('insights')}><Sparkles aria-hidden="true" />智能总结</button>
                              <button type="button" role="tab" aria-selected={detailTab === 'transcript'} onClick={() => setDetailTab('transcript')}><FileText aria-hidden="true" />逐字稿</button>
                            </div>
                            <div className="detail-actions">
                              {event.insights.source === 'mock' ? <span className="mock-badge">MOCK</span> : null}
                              {event.status === 'failed' && event.audioFileName ? <button type="button" className="secondary-button" disabled={reprocessingId !== null} onClick={() => void reprocessEvent(event)}>{reprocessingId === event.id ? <LoaderCircle className="spin" /> : <RefreshCw />}重新处理</button> : null}
                              <button type="button" className="secondary-button" disabled={!event.transcript || exportingTranscript} onClick={() => void exportTranscript(event)}>{exportingTranscript ? <LoaderCircle className="spin" /> : <Download />}导出逐字稿</button>
                            </div>
                          </div>

                          {detailTab === 'insights' ? (
                            <div className="reality-insights">
                              {event.processingState !== 'ready' && !event.insights.summary ? (
                                <>
                                  <ProcessingStatus event={event} />
                                  <DetailSkeleton lines={5} />
                                </>
                              ) : (
                                <>
                                  <section className="reality-topic"><span>主题</span><strong>{event.insights.currentTopic || event.currentTopic || '等待转写结果'}</strong><p>{event.insights.summary || '转写完成后将自动生成总结。'}</p></section>
                                  <section className="reality-tags-section">
                                    <div className="reality-tags-heading"><h3><Tag aria-hidden="true" />代表标签</h3></div>
                                    {(event.insights.representativeTags?.length ?? 0) > 0 ? <div className="reality-tag-list">{event.insights.representativeTags!.map((tag) => <div className="reality-tag" key={tag.id ?? `${tag.kind}:${tag.label}`} data-kind={tag.kind} title={tag.evidence || undefined}><span>{tag.kind === 'entity' ? '实体' : '事实'}</span><strong>{tag.label}</strong>{(tag.occurrenceCount ?? 0) > 1 ? <small>出现 {tag.occurrenceCount} 次</small> : null}{tag.id && event.insights.summaryRecordId ? <div><button type="button" title="从本条总结移除" aria-label={`移除 ${tag.label}`} disabled={savingTags} onClick={() => void removeTag(event, tag)}><X /></button></div> : null}</div>)}</div> : <p className="reality-tags-empty">暂无代表标签</p>}
                                  </section>
                                  <InsightList title="关键内容" items={event.insights.keyPoints} empty="暂无关键内容" />
                                  <div className="reality-insight-columns">
                                    <InsightList title="决策" items={event.insights.decisions} empty="暂无决策" />
                                    <InsightList title="行动项" items={event.insights.actionItems} empty="暂无行动项" />
                                  </div>
                                  <div className="reality-insight-columns">
                                    <InsightList title="人物与项目" icon={<UserRound aria-hidden="true" />} items={[...event.insights.people, ...event.insights.projects]} empty="暂无关联" />
                                    <InsightList title="未解决问题" icon={<CircleDot aria-hidden="true" />} items={event.insights.unresolvedQuestions} empty="暂无未解决问题" />
                                  </div>
                                </>
                              )}
                            </div>
                          ) : (
                            <div className="reality-transcript-editor">
                              {event.audioFileName || cloudAudioAssetIds.length ? (
                                <div className="reality-player" data-ready={String(Boolean(audioUrl))}>
                                  <audio
                                    ref={audioRef}
                                    src={audioUrl ?? undefined}
                                    preload="metadata"
                                    onLoadedMetadata={updatePlaybackDuration}
                                    onDurationChange={updatePlaybackDuration}
                                    onTimeUpdate={(audioEvent) => setPlaybackPositionMs(audioEvent.currentTarget.currentTime * 1000)}
                                    onPlay={() => setIsPlaying(true)}
                                    onPause={() => setIsPlaying(false)}
                                    onEnded={() => void playNextCloudSegment()}
                                    onError={() => showToast({ title: '录音无法播放', message: '请确认音频文件仍然存在。' })}
                                  />
                                  <button type="button" className="player-toggle" disabled={!audioUrl} onClick={togglePlayback} aria-label={isPlaying ? '暂停录音' : '播放录音'}>
                                    {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                                  </button>
                                  <time>{formatDuration(playbackPositionMs)}</time>
                                  <input
                                    type="range"
                                    min={0}
                                    max={Math.max(playbackDurationMs, 1)}
                                    step={100}
                                    value={Math.min(playbackPositionMs, Math.max(playbackDurationMs, 1))}
                                    aria-label="录音播放进度"
                                    disabled={!audioUrl || playbackDurationMs <= 0}
                                    style={{ '--player-progress': `${playbackDurationMs > 0 ? playbackPositionMs / playbackDurationMs * 100 : 0}%` } as CSSProperties}
                                    onChange={(change) => seekTo(Number(change.target.value), false)}
                                  />
                                  <time>{formatDuration(playbackDurationMs)}</time>
                                </div>
                              ) : null}
                              {event.transcriptSegments.length === 0 && event.processingState !== 'ready' ? (
                                <>
                                  <ProcessingStatus event={event} />
                                  <DetailSkeleton lines={6} />
                                </>
                              ) : event.transcriptSegments.length === 0 ? (
                                <p className="reality-tags-empty" style={{ padding: '14px 0' }}>{event.transcript ? event.transcript : '暂无逐字稿'}</p>
                              ) : (
                                <>
                                  <div className="reality-editor-heading">
                                    <h3>逐字稿</h3>
                                    <span className="reality-editor-meta">{event.transcriptSegments.length} 个句段</span>
                                  </div>
                                  <div ref={transcriptScrollRef} className="reality-segments" aria-label="逐字稿句段">{event.transcriptSegments.map((segment) => {
                                    const active = segment.id === activeSegmentId
                                    return <button ref={active ? activeSegmentRef : undefined} type="button" key={segment.id} data-active={String(active)} aria-current={active ? 'true' : undefined} onClick={() => seekTo(segment.beginTime)}><time>{formatDuration(segment.beginTime)}</time><strong>{segment.speakerId === null ? '说话人' : `说话人 ${segment.speakerId + 1}`}</strong><span>{segment.text}</span></button>
                                  })}</div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}
      </main>
    </div>
  )
}

function InsightList({ title, items, empty, icon }: { title: string; items: string[]; empty: string; icon?: ReactNode }) {
  return <section className="reality-insight-list"><h3>{icon}{title}</h3>{items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{empty}</p>}</section>
}

/** 处理中/失败的状态条:给用户明确的当前阶段与预期。 */
function ProcessingStatus({ event }: { event: RealityEvent }) {
  const failed = event.processingState === 'failed'
  return (
    <div className="reality-processing" data-state={event.processingState} role="status">
      {failed ? <AlertCircle aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
      <div>
        <strong>{PROCESSING_LABELS[event.processingState]}</strong>
        {PROCESSING_HINTS[event.processingState] ? <span>{PROCESSING_HINTS[event.processingState]}</span> : null}
        {failed && event.error ? <p>{event.error}</p> : null}
      </div>
    </div>
  )
}

/** 总结/逐字稿生成前的占位骨架。 */
function DetailSkeleton({ lines = 5 }: { lines?: number }) {
  return (
    <div className="reality-skeleton" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <i key={index} style={{ width: `${90 - index * 12}%`, animationDelay: `${index * 130}ms` }} />
      ))}
    </div>
  )
}

/** 进行中事件的时长需要每秒走秒;隔离在小组件里避免整页跟着重渲染。 */
function LiveDuration({ durationMs, startedAt, ongoing }: { durationMs: number; startedAt: string; ongoing: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!ongoing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [ongoing])
  const milliseconds = durationMs || (ongoing ? Math.max(0, now - Date.parse(startedAt)) : 0)
  return <>{formatDuration(milliseconds)}</>
}
