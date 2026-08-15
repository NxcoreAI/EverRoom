import {
  AlertCircle,
  Bookmark,
  CalendarDays,
  Check,
  ChevronDown,
  CircleDot,
  FilePenLine,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings } from '@/state/realitySettings'
import { showToast } from '@/state/toast'
import type { RealityEvent, RealityEventStatus, RealityEventType } from '../../../../shared/sources'
import { RecordingPage } from '../recording/RecordingPage'
import './RealityPage.css'

type DetailTab = 'insights' | 'transcript'
type StatusFilter = 'all' | RealityEventStatus
type ActivityRange = '1m' | '3m' | '6m' | '1y'

const STATUS_LABELS: Record<RealityEventStatus, string> = {
  ongoing: '进行中',
  pending_confirmation: '待确认',
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

const EVENT_TYPE_LABELS: Record<RealityEventType, string> = {
  MEETING: 'MEETING',
  MEAL: 'MEAL',
  WORK: 'WORK',
  REST: 'REST',
  EXERCISE: 'EXERCISE',
  OTHER: 'OTHER',
}

const RANGE_WEEKS: Record<ActivityRange, number> = { '1m': 5, '3m': 13, '6m': 26, '1y': 53 }
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
      ? new Intl.DateTimeFormat('zh-CN', { month: 'short' }).format(date)
      : ''
  })
  return { weeks, max, monthLabels }
}

export function RealityPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { account } = useAccount()
  const [events, setEvents] = useState<RealityEvent[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [search, setSearch] = useState('')
  const [activityRange, setActivityRange] = useState<ActivityRange>('3m')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('insights')
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const [savingTranscript, setSavingTranscript] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [playbackPositionMs, setPlaybackPositionMs] = useState(0)
  const [playbackDurationMs, setPlaybackDurationMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [reprocessingId, setReprocessingId] = useState<string | null>(null)
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
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
      setEvents(next)
      setExpandedId((current) => current && next.some((event) => event.id === current)
        ? current
        : next.find((event) => event.status === 'ongoing')?.id ?? null)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '智能感知事件加载失败。')
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
      setEvents((current) => {
        const existing = current.find((event) => event.id === incoming.id)
        if (existing && existing.version >= incoming.version) return current
        return [incoming, ...current.filter((event) => event.id !== incoming.id)]
          .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      })
      if (incoming.status === 'ongoing') setExpandedId((current) => current ?? incoming.id)
    })
    void window.nxcore.reality.subscribe()
    return () => {
      removeListener()
      void window.nxcore?.reality.unsubscribe()
    }
  }, [loadEvents])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  const selected = events.find((event) => event.id === expandedId) ?? null
  const visibleEvents = useMemo(() => events.filter((event) => {
    if (filter !== 'all' && event.status !== filter) return false
    const query = search.trim().toLocaleLowerCase()
    return !query || [event.title, event.transcript, event.currentTopic ?? '', event.insights.summary ?? '']
      .some((value) => value.toLocaleLowerCase().includes(query))
  }), [events, filter, search])
  const grouped = useMemo(() => {
    const groups = new Map<string, RealityEvent[]>()
    for (const event of visibleEvents) {
      const key = dateGroup(event.startedAt)
      groups.set(key, [...(groups.get(key) ?? []), event])
    }
    return [...groups.entries()]
  }, [visibleEvents])
  const activity = useMemo(() => buildActivity(events, activityRange), [events, activityRange])

  useEffect(() => {
    setTranscriptDraft(selected?.transcript ?? '')
    setDetailTab('insights')
    setDeleteConfirmId(null)
  }, [selected?.id, selected?.transcript])

  useEffect(() => {
    let objectUrl: string | null = null
    setAudioUrl(null)
    setPlaybackPositionMs(0)
    setPlaybackDurationMs(selected?.durationMs ?? 0)
    setIsPlaying(false)
    if (!selected?.audioFileName || !window.nxcore) return
    let cancelled = false
    void window.nxcore.reality.readAudio(selected.id).then((bytes) => {
      if (cancelled) return
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: selected.audioMimeType ?? 'audio/webm' }))
      setAudioUrl(objectUrl)
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : '本地录音读取失败。')
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [selected?.id, selected?.audioFileName, selected?.audioMimeType, selected?.durationMs])

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
    setEvents((current) => current.map((event) => event.id === updated.id ? updated : event))
  }

  const markImportant = async (event: RealityEvent) => {
    if (!window.nxcore) return
    const atMs = event.status === 'ongoing' ? Math.max(0, now - Date.parse(event.startedAt)) : event.durationMs
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
      setError(caught instanceof Error ? caught.message : '事件删除失败。')
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
      setError(caught instanceof Error ? caught.message : '重新处理失败。')
    } finally {
      setReprocessingId(null)
    }
  }

  const saveTranscript = async () => {
    if (!selected || !window.nxcore) return
    setSavingTranscript(true)
    try {
      replaceEvent(await window.nxcore.reality.updateTranscript(selected.id, {
        transcript: transcriptDraft,
        expectedVersion: selected.version,
      }))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '转写保存失败。')
      await loadEvents()
    } finally {
      setSavingTranscript(false)
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
          <span className="reality-eyebrow">REALITY STREAM</span>
          <h1>智能感知</h1>
          <p>每段声音都会在转写后归入今天的时间线。</p>
        </div>
        <RecordingPage
          embedded
          controlOnly
          onOpenSettings={onOpenSettings}
          onEventChanged={(event) => {
            setEvents((current) => [event, ...current.filter((item) => item.id !== event.id)])
            setExpandedId(event.id)
          }}
        />
      </header>

      <section className="reality-activity" aria-labelledby="activity-title">
        <header>
          <div><h2 id="activity-title">感知活跃度</h2><span>{events.length} 个事件</span></div>
          <div className="reality-range" aria-label="活跃度时间范围">
            {([['1m', '1 月'], ['3m', '3 月'], ['6m', '半年'], ['1y', '1 年']] as const).map(([value, label]) => (
              <button type="button" key={value} aria-pressed={activityRange === value} onClick={() => setActivityRange(value)}>{label}</button>
            ))}
          </div>
        </header>
        <div className="activity-chart" style={{ '--activity-weeks': activity.weeks.length } as CSSProperties}>
          <div className="activity-months">{activity.monthLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}</div>
          <div className="activity-weekdays"><span>一</span><span>三</span><span>五</span></div>
          <div className="activity-cells">
            {activity.weeks.flatMap((week, weekIndex) => week.map((cell, dayIndex) => {
              const level = cell.count < 0 ? -1 : cell.count === 0 ? 0 : Math.max(1, Math.ceil(cell.count / activity.max * 4))
              return <span key={`${weekIndex}-${dayIndex}`} data-level={level} title={cell.count < 0 ? '' : `${dayKey(cell.date)} · ${cell.count} 个事件`} />
            }))}
          </div>
        </div>
      </section>

      <div className="reality-toolbar">
        <div><CalendarDays aria-hidden="true" /><strong>时间线</strong><span>{visibleEvents.length} 个事件</span></div>
        <label className="reality-search"><Search aria-hidden="true" /><input value={search} placeholder="搜索主题或逐字稿" onChange={(event) => setSearch(event.target.value)} /></label>
        <select value={filter} aria-label="事件状态筛选" onChange={(event) => setFilter(event.target.value as StatusFilter)}>
          <option value="all">全部状态</option>
          <option value="ongoing">进行中</option>
          <option value="pending_confirmation">待确认</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="pending_sync">待同步</option>
        </select>
      </div>

      {error ? <div className="reality-error" role="alert"><AlertCircle aria-hidden="true" />{error}</div> : null}

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
                const duration = event.durationMs || (event.status === 'ongoing' ? now - Date.parse(event.startedAt) : 0)
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
                        <small>{event.captureDevice.name} · {formatDuration(duration)} · {PROCESSING_LABELS[event.processingState]}</small>
                        <ChevronDown aria-hidden="true" />
                      </button>

                      {expanded ? (
                        <div className="schedule-detail">
                          <div className="schedule-detail-bar">
                            <div className="reality-detail-tabs" role="tablist">
                              <button type="button" role="tab" aria-selected={detailTab === 'insights'} onClick={() => setDetailTab('insights')}><Sparkles aria-hidden="true" />关键总结</button>
                              <button type="button" role="tab" aria-selected={detailTab === 'transcript'} onClick={() => setDetailTab('transcript')}><FilePenLine aria-hidden="true" />逐字稿</button>
                            </div>
                            <div className="detail-actions">
                              {event.insights.source === 'mock' ? <span className="mock-badge">MOCK</span> : null}
                              {event.status === 'failed' && event.audioFileName ? <button type="button" className="secondary-button" disabled={reprocessingId !== null} onClick={() => void reprocessEvent(event)}>{reprocessingId === event.id ? <LoaderCircle className="spin" /> : <RefreshCw />}重新处理</button> : null}
                              <button type="button" className="icon-button" title="标记重要" aria-label="标记重要" onClick={() => markImportant(event)}><Bookmark fill={event.important ? 'currentColor' : 'none'} /></button>
                              <button type="button" className={deleteConfirmId === event.id ? 'danger-button' : 'icon-button'} title={deleteConfirmId === event.id ? '再次点击确认删除' : '删除事件'} aria-label={deleteConfirmId === event.id ? '确认删除事件' : '删除事件'} onClick={() => void discardEvent(event)}><Trash2 />{deleteConfirmId === event.id ? '确认删除' : null}</button>
                              {event.status === 'pending_confirmation' ? <button type="button" className="primary-button" onClick={async () => window.nxcore && replaceEvent(await window.nxcore.reality.confirm(event.id))}><Check />确认归档</button> : null}
                            </div>
                          </div>

                          {detailTab === 'insights' ? (
                            <div className="reality-insights">
                              <section className="reality-topic"><span>主题</span><strong>{event.insights.currentTopic || event.currentTopic || '等待转写结果'}</strong><p>{event.insights.summary || 'SaaS 完成转写后会返回一份模拟总结。'}</p></section>
                              <InsightList title="关键内容" items={event.insights.keyPoints} empty="暂无关键内容" />
                              <div className="reality-insight-columns">
                                <InsightList title="决策" items={event.insights.decisions} empty="暂无决策" />
                                <InsightList title="行动项" items={event.insights.actionItems} empty="暂无行动项" />
                              </div>
                              <div className="reality-insight-columns">
                                <InsightList title="人物与项目" icon={<UserRound aria-hidden="true" />} items={[...event.insights.people, ...event.insights.projects]} empty="暂无关联" />
                                <InsightList title="未解决问题" icon={<CircleDot aria-hidden="true" />} items={event.insights.unresolvedQuestions} empty="暂无未解决问题" />
                              </div>
                            </div>
                          ) : (
                            <div className="reality-transcript-editor">
                              {event.audioFileName ? (
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
                                    onEnded={() => setIsPlaying(false)}
                                    onError={() => setError('本地录音无法播放，请确认音频文件仍然存在。')}
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
                              <div className="reality-editor-heading"><div><h3>完整逐字稿</h3><span>{event.transcriptEditedAt ? '人工修改已锁定' : '来自 SaaS 转写结果'}</span></div><button type="button" className="secondary-button" disabled={savingTranscript || transcriptDraft === event.transcript} onClick={saveTranscript}>{savingTranscript ? <LoaderCircle className="spin" /> : <Check />}保存修改</button></div>
                              <textarea value={transcriptDraft} onChange={(change) => setTranscriptDraft(change.target.value)} placeholder="等待 SaaS 返回转写结果" />
                              <div ref={transcriptScrollRef} className="reality-segments" aria-label="逐字稿句段">{event.transcriptSegments.map((segment) => {
                                const active = segment.id === activeSegmentId
                                return <button ref={active ? activeSegmentRef : undefined} type="button" key={segment.id} data-active={String(active)} aria-current={active ? 'true' : undefined} onClick={() => seekTo(segment.beginTime)}><time>{formatDuration(segment.beginTime)}</time><strong>{segment.speakerId === null ? '说话人' : `说话人 ${segment.speakerId + 1}`}</strong><span>{segment.text}</span></button>
                              })}</div>
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
