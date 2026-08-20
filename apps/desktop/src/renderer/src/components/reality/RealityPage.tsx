import {
  AlertCircle,
  Bookmark,
  CalendarDays,
  Camera,
  ChevronDown,
  CircleDot,
  Download,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  Search,
  Smartphone,
  Sparkles,
  Tag,
  Trash2,
  Watch,
  X,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings } from '@/state/realitySettings'
import { showToast } from '@/state/toast'
import { useLocale, type AppLocale, type Translate } from '@/i18n/LocaleContext'
import type {
  PerceptionNode,
  PerceptionNodeDetail,
  RealityEvent,
  RealityEventStatus,
  RealityEventType,
  RealityTag,
} from '../../../../shared/sources'
import { RecordingPage } from '../recording/RecordingPage'
import { mergeRealityEvent, mergeRealitySnapshot } from './reality-event-state'
import { perceptionDisplayText, VisualDetail } from './VisualPerceptionPanel'
import './RealityPage.css'

type DetailTab = 'insights' | 'transcript'
type StatusFilter = 'all' | RealityEventStatus
type ActivityRange = '1w' | '1m' | '3m' | '6m' | '1y'
type TimelineItem =
  | { kind: 'audio'; id: string; startedAt: string; event: RealityEvent }
  | { kind: 'visual'; id: string; startedAt: string; node: PerceptionNode }

const STATUS_LABELS: Record<RealityEventStatus, string> = {
  ongoing: 'diaryReality:reality.inProgress',
  completed: 'diaryReality:reality.completed',
  failed: 'diaryReality:reality.failed',
  pending_sync: 'diaryReality:reality.pendingSync',
}

/** 转录来源图标：PC / 手机 / 手表。 */
const DEVICE_ICONS = {
  desktop: Monitor,
  iphone: Smartphone,
  apple_watch: Watch,
} as const

function DeviceIcon({ event }: { event: RealityEvent }) {
  const Icon = DEVICE_ICONS[event.captureDevice.kind] ?? Monitor
  return (
    <span className="event-device" title={event.captureDevice.name} aria-label={event.captureDevice.name}>
      <Icon aria-hidden="true" />
    </span>
  )
}

const PROCESSING_LABELS: Record<RealityEvent['processingState'], string> = {
  capturing: 'diaryReality:reality.processingCapturing',
  saving: 'diaryReality:reality.processingSaving',
  transcribing: 'diaryReality:reality.processingTranscribing',
  understanding: 'diaryReality:reality.processingUnderstanding',
  ready: 'diaryReality:reality.processingReady',
  failed: 'diaryReality:reality.processingFailed',
}

const VISUAL_STATUS_LABELS: Record<string, string> = {
  disabled: 'diaryReality:reality.visualDisabled',
  pending: 'diaryReality:reality.visualPending',
  processing: 'diaryReality:reality.visualProcessing',
  ready: 'diaryReality:reality.visualReady',
  failed: 'diaryReality:reality.processingFailed',
}

const PROCESSING_HINTS: Record<RealityEvent['processingState'], string> = {
  capturing: 'diaryReality:reality.processingCapturingHint',
  saving: 'diaryReality:reality.processingSavingHint',
  transcribing: 'diaryReality:reality.processingTranscribingHint',
  understanding: 'diaryReality:reality.processingUnderstandingHint',
  ready: '',
  failed: 'diaryReality:reality.processingFailedHint',
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
  ['1w', 'diaryReality:reality.rangeOneWeek'], ['1m', 'diaryReality:reality.rangeOneMonth'], ['3m', 'diaryReality:reality.rangeThreeMonths'], ['6m', 'diaryReality:reality.rangeHalfYear'], ['1y', 'diaryReality:reality.rangeOneYear'],
]

/** 自动选择能覆盖全部使用历史的最大时间范围:尽可能把所有活跃都展示出来。 */
function preferredActivityRange(events: Array<{ startedAt: string }>): ActivityRange {
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

function timeLabel(value: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
}

function dateGroup(value: string, locale: AppLocale, t: Translate): string {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return t('diaryReality:reality.today')
  if (date.toDateString() === yesterday.toDateString()) return t('diaryReality:reality.yesterday')
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(date)
}

function dayKey(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayChipLabel(key: string, locale: AppLocale): string {
  const [year, month, day] = key.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(year!, month! - 1, day!))
}

function eventType(event: RealityEvent): RealityEventType {
  return event.insights.eventType ?? 'OTHER'
}

function buildActivity(events: Array<{ startedAt: string }>, range: ActivityRange, locale: AppLocale) {
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
      ? { column: index + 1, label: new Intl.DateTimeFormat(locale, { month: 'short' }).format(date) }
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
  const { locale, t } = useLocale()
  const { t: perceptionT } = useTranslation('diaryReality')
  const { account } = useAccount()
  const [events, setEvents] = useState<RealityEvent[]>([])
  const [visualNodes, setVisualNodes] = useState<PerceptionNode[]>([])
  const [visualDetail, setVisualDetail] = useState<PerceptionNodeDetail | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [activityRange, setActivityRange] = useState<ActivityRange>('3m')
  const [rangeTouched, setRangeTouched] = useState(false)
  const [loading, setLoading] = useState(true)
  const [visualLoading, setVisualLoading] = useState(true)
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
  const [retryingVisualId, setRetryingVisualId] = useState<string | null>(null)
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
      setError(caught instanceof Error ? caught.message : t('diaryReality:reality.unableToLoadRealityPerceptionEvents'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const loadVisualNodes = useCallback(async (quiet = false) => {
    if (!window.nxcore) {
      setVisualLoading(false)
      return
    }
    try {
      const result = await window.nxcore.screenCapture.listPerceptionNodes()
      setVisualNodes(result.items.filter((node) => node.kind === 'screenshot' || node.kind === 'photo'))
      if (!quiet) setError(null)
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : t('diaryReality:reality.unableToLoadVisualPerception'))
    } finally {
      setVisualLoading(false)
    }
  }, [t])

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
    void loadVisualNodes()
    const timer = window.setInterval(() => void loadVisualNodes(true), 5_000)
    return () => window.clearInterval(timer)
  }, [loadVisualNodes])

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
  const timelineItems = useMemo<TimelineItem[]>(() => [
    ...events.map((event): TimelineItem => ({ kind: 'audio', id: event.id, startedAt: event.startedAt, event })),
    ...visualNodes.map((node): TimelineItem => ({ kind: 'visual', id: node.id, startedAt: node.startAt, node })),
  ].sort((left, right) => right.startedAt.localeCompare(left.startedAt)), [events, visualNodes])
  const visibleEvents = useMemo(() => timelineItems.filter((item) => {
    if (filter !== 'all') {
      const matches = item.kind === 'audio'
        ? filter === 'completed'
          ? item.event.status === 'completed'
          : item.event.status === filter
        : filter === 'ongoing'
          ? item.node.status === 'pending' || item.node.status === 'processing'
          : filter === 'completed'
            ? item.node.status === 'ready'
            : filter === 'failed' && item.node.status === 'failed'
      if (!matches) return false
    }
    if (selectedDay && dayKey(item.startedAt) !== selectedDay) return false
    const query = search.trim().toLocaleLowerCase()
    if (!query) return true
    const values = item.kind === 'audio'
      ? [item.event.title, item.event.transcript, item.event.currentTopic ?? '', item.event.insights.summary ?? '', ...(item.event.insights.representativeTags ?? []).map((tag) => tag.label)]
      : [
          item.node.title,
          perceptionDisplayText(item.node.title, perceptionT),
          item.node.summary,
          perceptionDisplayText(item.node.summary, perceptionT),
          item.node.eventType ?? '',
          ...item.node.tags,
        ]
    return values.some((value) => value.toLocaleLowerCase().includes(query))
  }), [filter, perceptionT, search, selectedDay, t, timelineItems])
  const grouped = useMemo(() => {
    const groups = new Map<string, TimelineItem[]>()
    for (const item of visibleEvents) {
      const key = dateGroup(item.startedAt, locale, t)
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
    return [...groups.entries()]
  }, [locale, t, visibleEvents])
  const activity = useMemo(() => buildActivity(timelineItems, activityRange, locale), [activityRange, locale, timelineItems])

  const expandedVisualNode = visualNodes.find((node) => node.id === expandedId) ?? null

  useEffect(() => {
    if (!expandedVisualNode || !window.nxcore) {
      setVisualDetail(null)
      return
    }
    let cancelled = false
    void window.nxcore.screenCapture.getPerceptionNode(expandedVisualNode.id)
      .then((detail) => { if (!cancelled) setVisualDetail(detail) })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : t('diaryReality:reality.unableToLoadPerceptionDetails'))
      })
    return () => { cancelled = true }
  }, [expandedVisualNode?.id, expandedVisualNode?.status, t])

  // 首次加载后按活跃量自动选择范围;用户手动切换后不再覆盖。
  useEffect(() => {
    if (rangeTouched || loading || visualLoading) return
    setActivityRange(preferredActivityRange(timelineItems))
    setRangeTouched(true)
  }, [loading, rangeTouched, timelineItems, visualLoading])

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
      showToast({ title: t('diaryReality:reality.failedToRemoveTheTag'), message: caught instanceof Error ? caught.message : undefined })
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
      if (!cancelled) showToast({ title: t('diaryReality:reality.failedToLoadTheRecording'), message: caught instanceof Error ? caught.message : undefined })
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [selected?.id, selected?.audioFileName, selected?.audioMimeType, selected?.durationMs, t])

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
      showToast({ title: t('diaryReality:reality.everroomRestartRequired'), message: t('diaryReality:reality.restartEverroomToDeleteExistingEvents') })
      return
    }
    try {
      await window.nxcore.reality.discard(event.id)
      setEvents((current) => current.filter((item) => item.id !== event.id))
      setExpandedId((current) => current === event.id ? null : current)
      setDeleteConfirmId(null)
      showToast({ title: t('diaryReality:reality.eventDeleted') })
    } catch (caught) {
      showToast({ title: t('diaryReality:reality.failedToDeleteTheEvent'), message: caught instanceof Error ? caught.message : undefined })
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
        if (Date.now() >= deadline) throw new Error(t('diaryReality:reality.reprocessingExceeded30MinutesPleaseTryAgainLater'))
        await new Promise((resolve) => window.setTimeout(resolve, REPROCESS_POLL_INTERVAL_MS))
        job = await window.nxcore.asr.getJob(job.id)
      }
      if (job.status !== 'completed') throw new Error(job.error ?? t('diaryReality:reality.reprocessingFailed'))
      replaceEvent(await window.nxcore.reality.getEvent(event.id))
      showToast({ title: t('diaryReality:reality.reprocessingComplete') })
    } catch (caught) {
      showToast({ title: t('diaryReality:reality.reprocessingFailedTitle'), message: caught instanceof Error ? caught.message : undefined })
    } finally {
      setReprocessingId(null)
    }
  }

  const retryVisualNode = async (node: PerceptionNode) => {
    if (!window.nxcore || retryingVisualId) return
    setRetryingVisualId(node.id)
    try {
      await window.nxcore.screenCapture.retryPerceptionNode(node.id)
      await loadVisualNodes(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('diaryReality:reality.unableToRetryVisualUnderstanding'))
    } finally {
      setRetryingVisualId(null)
    }
  }

  const exportTranscript = async (event: RealityEvent) => {
    if (!window.nxcore || exportingTranscript) return
    setExportingTranscript(true)
    try {
      const lines = [
        event.title,
        `${new Date(event.startedAt).toLocaleString(locale)} · ${formatDuration(event.durationMs)} · ${event.captureDevice.name}`,
        '',
        ...(event.transcriptSegments.length > 0
          ? event.transcriptSegments.map((segment) => `[${formatDuration(segment.beginTime)}] ${segment.speakerId === null ? t('diaryReality:reality.speaker') : t('diaryReality:reality.speakerNumber', { number: segment.speakerId + 1 })}: ${segment.text}`)
          : [event.transcript]),
      ]
      const result = await window.nxcore.reality.exportTranscript({
        fileName: `${event.title}.txt`,
        content: `${lines.join('\n')}\n`,
      })
      if (!result.canceled) showToast({ title: t('diaryReality:reality.transcriptExported'), message: result.filePath })
    } catch (caught) {
      showToast({ title: t('diaryReality:reality.exportFailed'), message: caught instanceof Error ? caught.message : undefined })
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
          <h1>{t('diaryReality:reality.realityPerception')}</h1>
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
            <h2 id="activity-title">{t('diaryReality:reality.perceptionActivity')}</h2>
            <span>{t('diaryReality:reality.countEventsDaysDayStreak', { count: activity.total, days: activity.streak })}</span>
          </div>
          <div className="reality-range" aria-label={t('diaryReality:reality.activityTimeRange')}>
            {ACTIVITY_RANGES.map(([value, label]) => (
              <button type="button" key={value} aria-pressed={activityRange === value} onClick={() => { setRangeTouched(true); setActivityRange(value) }}>{t(label)}</button>
            ))}
          </div>
        </header>
        <div className="activity-chart" style={{ '--activity-weeks': activity.weeks.length } as CSSProperties}>
          <div className="activity-months">{activity.monthLabels.map((item) => (
            <span key={item.column} style={{ gridColumn: item.column }}>{item.label}</span>
          ))}</div>
          <div className="activity-weekdays"><span>{t('diaryReality:reality.mon')}</span><span>{t('diaryReality:reality.wed')}</span><span>{t('diaryReality:reality.fri')}</span></div>
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
                  aria-label={isFuture ? undefined : t('diaryReality:reality.dateCountEvents', { date: key, count: cell.count })}
                  title={isFuture ? undefined : t('diaryReality:reality.dateCountEvents', { date: key, count: cell.count })}
                  style={{ animationDelay: `${Math.min((weekIndex * 7 + dayIndex) * 2, 600)}ms` }}
                  onClick={() => setSelectedDay(selectedDay === key ? null : key)}
                />
              )
            }))}
          </div>
        </div>
        <div className="activity-footer">
          <div className="activity-legend" aria-hidden="true">
            <span>{t('diaryReality:reality.less')}</span>
            {[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}
            <span>{t('diaryReality:reality.more')}</span>
          </div>
        </div>
      </section>

      <div className="reality-toolbar">
        <div>
          <CalendarDays aria-hidden="true" />
          <strong>{t('diaryReality:reality.timeline')}</strong>
          {selectedDay ? (
            <button type="button" className="reality-day-chip" onClick={() => setSelectedDay(null)}>
              {dayChipLabel(selectedDay, locale)}
              <X aria-hidden="true" />
            </button>
          ) : (
            <span>{t('diaryReality:reality.visibleTotalEvents', { visible: visibleEvents.length, total: timelineItems.length })}</span>
          )}
        </div>
        <label className="reality-search"><Search aria-hidden="true" /><input value={search} placeholder={t('diaryReality:reality.searchTopicsTranscriptsOrVisualSummaries')} onChange={(event) => setSearch(event.target.value)} /></label>
        <select value={filter} aria-label={t('diaryReality:reality.filterByEventStatus')} onChange={(event) => setFilter(event.target.value as StatusFilter)}>
          <option value="all">{t('diaryReality:reality.allStatuses')}</option>
          <option value="ongoing">{t('diaryReality:reality.inProgress')}</option>
          <option value="completed">{t('diaryReality:reality.completed')}</option>
          <option value="failed">{t('diaryReality:reality.failed')}</option>
          <option value="pending_sync">{t('diaryReality:reality.pendingSync')}</option>
        </select>
      </div>

      {error ? (
        <div className="reality-error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error}</span>
          <button type="button" className="icon-button" title={t('diaryReality:reality.close')} aria-label={t('diaryReality:reality.dismissError')} onClick={() => setError(null)}><X aria-hidden="true" /></button>
        </div>
      ) : null}

      <main className="reality-timeline">
        {loading || visualLoading ? <div className="reality-empty"><LoaderCircle className="spin" />{t('diaryReality:reality.loadingTimeline')}</div> : null}
        {!loading && !visualLoading && grouped.length === 0 ? (
          <div className="reality-empty"><div className="empty-signal"><i /><i /><i /><i /><i /></div><strong>{t('diaryReality:reality.nothingCapturedYetToday')}</strong><span>{t('diaryReality:reality.enableListeningOrAutomaticScreenshotsToAddPerception')}</span></div>
        ) : null}
        {grouped.map(([label, items]) => (
          <section className="reality-day" key={label}>
            <header><h2>{label}</h2><span>{t('diaryReality:reality.countBlocks', { count: items.length })}</span></header>
            <div className="reality-schedule">
              {items.map((item) => {
                if (item.kind === 'visual') {
                  const node = item.node
                  const expanded = node.id === expandedId
                  const KindIcon = node.kind === 'photo' ? ImageIcon : Camera
                  const statusLabel = VISUAL_STATUS_LABELS[node.status] ?? node.status
                  return (
                    <article className="schedule-event visual-schedule-event" key={node.id} data-expanded={String(expanded)} data-type={node.kind} data-status={node.status}>
                      <div className="schedule-time">
                        <time>{timeLabel(node.startAt, locale)}</time>
                        <span />
                        <small>{node.endAt !== node.startAt ? timeLabel(node.endAt, locale) : t('diaryReality:reality.countFrames', { count: node.sampleCount })}</small>
                      </div>
                      <div className="schedule-block">
                        <button type="button" className="schedule-trigger" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : node.id)}>
                          <span className="event-type"><KindIcon aria-hidden="true" />{t(node.kind === 'photo' ? 'diaryReality:reality.photo' : 'diaryReality:reality.screen')}</span>
                          <span className="event-status" data-status={node.status}>{t(statusLabel)}</span>
                          <strong>{perceptionDisplayText(node.title, perceptionT)}</strong>
                          <p>{perceptionDisplayText(node.summary, perceptionT)}</p>
                          {node.tags.length > 0 ? <span className="schedule-tags">{node.tags.slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}</span> : null}
                          <small>{t(node.kind === 'photo' ? 'diaryReality:reality.localPhoto' : 'diaryReality:reality.everroomWindow')}{node.sampleCount > 1 ? ` · ${t('diaryReality:reality.countFrames', { count: node.sampleCount })}` : ''}{node.confidence === null ? '' : t('diaryReality:reality.confidenceConfidence', { confidence: Math.round(node.confidence * 100) })}</small>
                          <ChevronDown aria-hidden="true" />
                        </button>
                        {expanded ? (
                          <div className="schedule-detail">
                            <div className="schedule-detail-bar">
                              <div className="visual-perception-detail-label"><Sparkles aria-hidden="true" />{t('diaryReality:reality.visualUnderstanding')}</div>
                              <div className="detail-actions">
                                {node.status === 'failed' || node.status === 'disabled' ? (
                                  <button type="button" className="secondary-button" disabled={retryingVisualId !== null} onClick={() => void retryVisualNode(node)}>
                                    {retryingVisualId === node.id ? <LoaderCircle className="spin" /> : <RefreshCw />}{t('diaryReality:reality.understandAgain')}
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            {visualDetail?.id === node.id
                              ? <VisualDetail node={visualDetail} />
                              : <div className="visual-perception-detail-loading"><LoaderCircle className="spin" />{t('diaryReality:reality.loadingDetails')}</div>}
                          </div>
                        ) : null}
                      </div>
                    </article>
                  )
                }
                const event = item.event
                const expanded = event.id === expandedId
                const type = eventType(event)
                return (
                  <article className="schedule-event" key={event.id} data-expanded={String(expanded)} data-type={type.toLowerCase()}>
                    <div className="schedule-time"><time>{timeLabel(event.startedAt, locale)}</time><span /><small>{event.endedAt ? timeLabel(event.endedAt, locale) : t('diaryReality:reality.now')}</small></div>
                    <div className="schedule-block">
                      <button type="button" className="schedule-trigger" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : event.id)}>
                        <span className="event-type">{EVENT_TYPE_LABELS[type]}</span>
                        <span className="event-status" data-status={event.status}>{t(STATUS_LABELS[event.status])}</span>
                        <DeviceIcon event={event} />
                        <strong>{event.currentTopic || event.insights.currentTopic || event.title}</strong>
                        <p>{event.insights.summary || (event.transcript ? event.transcript.slice(0, 120) : t(PROCESSING_LABELS[event.processingState]))}</p>
                        {(event.insights.representativeTags?.length ?? 0) > 0 ? <span className="schedule-tags">{event.insights.representativeTags!.slice(0, 5).map((tag) => <span key={tag.id ?? `${tag.kind}:${tag.label}`} data-kind={tag.kind}>{tag.label}{(tag.occurrenceCount ?? 0) > 1 ? <small>{tag.occurrenceCount}</small> : null}</span>)}</span> : null}
                        <small>{event.captureDevice.name} · <LiveDuration durationMs={event.durationMs} startedAt={event.startedAt} ongoing={event.status === 'ongoing'} /> · {t(PROCESSING_LABELS[event.processingState])}</small>
                        <span className="trigger-actions" onClick={(click) => click.stopPropagation()}>
                          <button type="button" className="icon-button" title={t(event.important ? 'diaryReality:reality.unmarkImportant' : 'diaryReality:reality.markImportant')} aria-label={t(event.important ? 'diaryReality:reality.unmarkImportantLabel' : 'diaryReality:reality.markImportant')} aria-pressed={event.important} onClick={() => void toggleImportant(event)}><Bookmark fill={event.important ? 'currentColor' : 'none'} /></button>
                          <button type="button" className={deleteConfirmId === event.id ? 'danger-button' : 'icon-button'} title={t(deleteConfirmId === event.id ? 'diaryReality:reality.selectAgainToConfirmDeletion' : 'diaryReality:reality.deleteEvent')} aria-label={t(deleteConfirmId === event.id ? 'diaryReality:reality.confirmEventDeletion' : 'diaryReality:reality.deleteEvent')} onClick={() => void discardEvent(event)}><Trash2 />{deleteConfirmId === event.id ? t('diaryReality:reality.confirmDelete') : null}</button>
                        </span>
                        <ChevronDown aria-hidden="true" />
                      </button>

                      {expanded ? (
                        <div className="schedule-detail">
                          <div className="schedule-detail-bar">
                            <div className="reality-detail-tabs" role="tablist">
                              <button type="button" role="tab" aria-selected={detailTab === 'insights'} onClick={() => setDetailTab('insights')}><Sparkles aria-hidden="true" />{t('diaryReality:reality.aiSummary')}</button>
                              <button type="button" role="tab" aria-selected={detailTab === 'transcript'} onClick={() => setDetailTab('transcript')}><FileText aria-hidden="true" />{t('diaryReality:reality.transcript')}</button>
                            </div>
                            <div className="detail-actions">
                              {event.insights.source === 'mock' ? <span className="mock-badge">MOCK</span> : null}
                              {event.status === 'failed' && event.audioFileName ? <button type="button" className="secondary-button" disabled={reprocessingId !== null} onClick={() => void reprocessEvent(event)}>{reprocessingId === event.id ? <LoaderCircle className="spin" /> : <RefreshCw />}{t('diaryReality:reality.processAgain')}</button> : null}
                              <button type="button" className="secondary-button" disabled={!event.transcript || exportingTranscript} onClick={() => void exportTranscript(event)}>{exportingTranscript ? <LoaderCircle className="spin" /> : <Download />}{t('diaryReality:reality.exportTranscript')}</button>
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
                                  <section className="reality-topic"><span>{t('diaryReality:reality.topic')}</span><strong>{event.insights.currentTopic || event.currentTopic || t('diaryReality:reality.waitingForTranscript')}</strong><p>{event.insights.summary || t('diaryReality:reality.aSummaryWillBeGeneratedAfterTranscription')}</p></section>
                                  <section className="reality-tags-section">
                                    <div className="reality-tags-heading"><h3><Tag aria-hidden="true" />{t('diaryReality:reality.representativeTags')}</h3></div>
                                    {(event.insights.representativeTags?.length ?? 0) > 0 ? <div className="reality-tag-list">{event.insights.representativeTags!.map((tag) => <div className="reality-tag" key={tag.id ?? `${tag.kind}:${tag.label}`} data-kind={tag.kind} title={tag.evidence || undefined}><span>{t(tag.kind === 'entity' ? 'diaryReality:reality.entity' : 'diaryReality:reality.fact')}</span><strong>{tag.label}</strong>{(tag.occurrenceCount ?? 0) > 1 ? <small>{t('diaryReality:reality.appearsCountTimes', { count: tag.occurrenceCount ?? 0 })}</small> : null}{tag.id && event.insights.summaryRecordId ? <div><button type="button" title={t('diaryReality:reality.removeFromThisSummary')} aria-label={t('diaryReality:reality.removeLabel', { label: tag.label })} disabled={savingTags} onClick={() => void removeTag(event, tag)}><X /></button></div> : null}</div>)}</div> : <p className="reality-tags-empty">{t('diaryReality:reality.noRepresentativeTags')}</p>}
                                  </section>
                                  <InsightList title="diaryReality:reality.keyContent" items={event.insights.keyPoints} empty="diaryReality:reality.noKeyContent" />
                                  <div className="reality-insight-columns">
                                    <InsightList title="diaryReality:reality.decisions" items={event.insights.decisions} empty="diaryReality:reality.noDecisions" />
                                    <InsightList title="diaryReality:reality.actionItems" items={event.insights.actionItems} empty="diaryReality:reality.noActionItems" />
                                  </div>
                                  <div className="reality-insight-columns">
                                    <InsightList title="diaryReality:reality.peopleAndProjects" icon={<UserRound aria-hidden="true" />} items={[...event.insights.people, ...event.insights.projects]} empty="diaryReality:reality.noRelations" />
                                    <InsightList title="diaryReality:reality.unresolvedQuestions" icon={<CircleDot aria-hidden="true" />} items={event.insights.unresolvedQuestions} empty="diaryReality:reality.noUnresolvedQuestions" />
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
                                    onError={() => showToast({ title: t('diaryReality:reality.unableToPlayRecording'), message: t('diaryReality:reality.checkThatTheAudioFileStillExists') })}
                                  />
                                  <button type="button" className="player-toggle" disabled={!audioUrl} onClick={togglePlayback} aria-label={t(isPlaying ? 'diaryReality:reality.pauseRecording' : 'diaryReality:reality.playRecording')}>
                                    {isPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                                  </button>
                                  <time>{formatDuration(playbackPositionMs)}</time>
                                  <input
                                    type="range"
                                    min={0}
                                    max={Math.max(playbackDurationMs, 1)}
                                    step={100}
                                    value={Math.min(playbackPositionMs, Math.max(playbackDurationMs, 1))}
                                    aria-label={t('diaryReality:reality.recordingPlaybackProgress')}
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
                                <p className="reality-tags-empty" style={{ padding: '14px 0' }}>{event.transcript ? event.transcript : t('diaryReality:reality.noTranscriptYet')}</p>
                              ) : (
                                <>
                                  <div className="reality-editor-heading">
                                    <h3>{t('diaryReality:reality.transcript')}</h3>
                                    <span className="reality-editor-meta">{t('diaryReality:reality.countSegments', { count: event.transcriptSegments.length })}</span>
                                  </div>
                                  <div ref={transcriptScrollRef} className="reality-segments" aria-label={t('diaryReality:reality.transcriptSegments')}>{event.transcriptSegments.map((segment) => {
                                    const active = segment.id === activeSegmentId
                                    return <button ref={active ? activeSegmentRef : undefined} type="button" key={segment.id} data-active={String(active)} aria-current={active ? 'true' : undefined} onClick={() => seekTo(segment.beginTime)}><time>{formatDuration(segment.beginTime)}</time><strong>{segment.speakerId === null ? t('diaryReality:reality.speaker') : t('diaryReality:reality.speakerNumber', { number: segment.speakerId + 1 })}</strong><span>{segment.text}</span></button>
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
  const { t } = useLocale()
  return <section className="reality-insight-list"><h3>{icon}{t(title)}</h3>{items.length > 0 ? <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul> : <p>{t(empty)}</p>}</section>
}

/** 处理中/失败的状态条:给用户明确的当前阶段与预期。 */
function ProcessingStatus({ event }: { event: RealityEvent }) {
  const { t } = useLocale()
  const failed = event.processingState === 'failed'
  return (
    <div className="reality-processing" data-state={event.processingState} role="status">
      {failed ? <AlertCircle aria-hidden="true" /> : <LoaderCircle className="spin" aria-hidden="true" />}
      <div>
        <strong>{t(PROCESSING_LABELS[event.processingState])}</strong>
        {PROCESSING_HINTS[event.processingState] ? <span>{t(PROCESSING_HINTS[event.processingState])}</span> : null}
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

/** Keep the live timer isolated so ongoing captures do not rerender the whole page. */
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
