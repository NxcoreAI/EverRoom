import { Check, Cloud, HardDrive, LoaderCircle, LogIn, Mic, MonitorSpeaker, Square } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'

import { PRODUCT_NAME } from '@/components/ui/brand'
import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings, onRealitySettingsChanged } from '@/state/realitySettings'
import { showToast } from '@/state/toast'

import type { AsrJob, AsrResult, NxcoreDesktopApi, RealityEvent } from '../../../../shared/sources'
import './RecordingPage.css'

type RecordingState = 'idle' | 'requesting' | 'recording' | 'saving' | 'transcribing' | 'completed' | 'error'
type AudioSource = 'microphone' | 'system'

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
const MAX_TRANSCRIPTION_WAIT_MS = 30 * 60 * 1000
const MIN_TRANSCRIPTION_DURATION_MS = 10_000
const TRANSCRIPTION_POLL_INTERVAL_MS = 6_000

function supportedMimeType(): string {
  return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function formatTimestamp(milliseconds: number): string {
  return formatDuration(Math.max(0, Math.floor(milliseconds / 1000)))
}

function errorMessage(error: unknown, audioSource?: AudioSource): string {
  const message = error instanceof Error ? error.message : '录音转写失败，请重试。'
  const errorName = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name?: unknown }).name ?? '')
    : ''
  if (audioSource === 'microphone' && (errorName === 'NotFoundError' || /Requested device not found/i.test(message))) {
    return '未检测到麦克风输入设备。请连接麦克风或耳机，并在“系统设置 → 隐私与安全性 → 麦克风”中允许 EverRoom 访问。'
  }
  if (audioSource === 'microphone' && errorName === 'NotAllowedError') {
    return '麦克风访问被拒绝。请在“系统设置 → 隐私与安全性 → 麦克风”中允许 EverRoom 访问，然后重新开始录音。'
  }
  if (message === 'SERVER_ERROR') {
    return '阿里云未能读取或处理录音（SERVER_ERROR）。当前百炼临时存储链路不可用，请配置自有 OSS 后重试。'
  }
  if (message.includes('own OSS is required')) {
    return '尚未配置阿里云 OSS。请配置 Bucket、Region 和访问凭证后再转写。'
  }
  return message
}

function isDesktopRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Error invoking remote method')
}

function reportRecordingError(error: unknown, audioSource: AudioSource): void {
  if (isDesktopRequestError(error)) return
  const message = errorMessage(error)
  window.nxcore?.errors.report(audioSource === 'system'
    ? {
        channel: 'media:system-audio',
        title: '需要系统音频权限',
        message: '请在 macOS 系统设置中允许 EverRoom 使用“屏幕与系统音频录制”，然后完全退出并重新打开 EverRoom。',
        action: 'open-system-audio-settings',
        actionLabel: '打开系统设置',
      }
    : { channel: 'media:microphone', title: '录音未开始', message })
}

function desktopApi(): NxcoreDesktopApi {
  if (!window.nxcore) throw new Error(`录音转写仅在 ${PRODUCT_NAME} 桌面版中可用。`)
  return window.nxcore
}

async function waitForStop(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === 'inactive') return
  await new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.addEventListener('error', () => reject(new Error('录音设备发生错误。')), { once: true })
    recorder.stop()
  })
}

const CassetteListeningControl = memo(function CassetteListeningControl({
  listening,
  busy,
  onToggle,
}: {
  listening: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className="cassette-switch"
      role="switch"
      aria-checked={listening}
      aria-label={listening ? '关闭聆听' : busy ? '正在处理录音' : '开启聆听'}
      data-active={String(listening)}
      data-busy={String(busy)}
      disabled={busy}
      onClick={onToggle}
    >
      <span className="cassette-topline" aria-hidden="true">
        <span>ER-01</span>
        <span className="cassette-state"><i />{listening ? 'REC' : busy ? 'WAIT' : 'READY'}</span>
      </span>
      <span className="cassette-window" aria-hidden="true">
        <span className="cassette-reel cassette-reel-left"><i /></span>
        <span className="cassette-tape"><i /></span>
        <span className="cassette-reel cassette-reel-right"><i /></span>
      </span>
      <span className="cassette-footer" aria-hidden="true">
        <span className="cassette-levels"><i /><i /><i /><i /></span>
        <span className="cassette-key"><i /></span>
      </span>
    </button>
  )
})

export function RecordingPage({
  onOpenSettings,
  onEventChanged,
  embedded = false,
  controlOnly = false,
}: {
  onOpenSettings: () => void
  onEventChanged?: (event: RealityEvent) => void
  embedded?: boolean
  controlOnly?: boolean
}) {
  const initialSettings = loadRealitySettings()
  const [state, setState] = useState<RecordingState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [languages, setLanguages] = useState<string[]>(initialSettings.languages)
  const [result, setResult] = useState<AsrResult | null>(null)
  const [audioSource, setAudioSource] = useState<AudioSource>(initialSettings.audioSource)
  const { account } = useAccount()
  const [mode,setMode]=useState<'cloud'|'local'>('local')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const realityEventIdRef = useRef<string | null>(null)
  const recordingStartedAtRef = useRef<number | null>(null)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const mountedRef = useRef(true)
  const isMacDesktop = window.nxcore?.platform === 'darwin'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') recorder.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      recordingStartedAtRef.current = null
      const id = recordingIdRef.current
      if (id) {
        void window.nxcore?.asr.cancelRecording(id)
        if (realityEventIdRef.current) {
          void window.nxcore?.reality.fail(realityEventIdRef.current, '采集已取消')
        }
      }
    }
  }, [])

  useEffect(() => {
    const settings = loadRealitySettings()
    setMode(settings.mode === 'cloud' || (settings.mode === 'auto' && account?.authenticated) ? 'cloud' : 'local')
  }, [account])

  useEffect(() => onRealitySettingsChanged((settings) => {
    if (state !== 'idle' && state !== 'completed' && state !== 'error') return
    setAudioSource(settings.audioSource)
    setLanguages(settings.languages)
    setMode(settings.mode === 'cloud' || (settings.mode === 'auto' && account?.authenticated) ? 'cloud' : 'local')
  }), [account?.authenticated, state])

  useEffect(() => {
    if (state !== 'recording') return
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => window.clearInterval(timer)
  }, [state])

  const toggleLanguage = (language: string) => {
    setLanguages((current) => current.includes(language)
      ? current.filter((item) => item !== language)
      : [...current, language])
  }

  const pollJob = async (initialJob: AsrJob, eventId: string): Promise<void> => {
    let job = initialJob
    const deadline = Date.now() + MAX_TRANSCRIPTION_WAIT_MS
    while (job.status === 'pending' || job.status === 'running') {
      if (Date.now() >= deadline) throw new Error('转写等待超过 30 分钟，请稍后重试。')
      await new Promise((resolve) => window.setTimeout(resolve, TRANSCRIPTION_POLL_INTERVAL_MS))
      if (!mountedRef.current) return
      job = await desktopApi().asr.getJob(job.id)
    }
    if (job.status !== 'completed' || !job.result) {
      throw new Error(job.error ?? '转写任务未能完成。')
    }
    setResult(job.result)
    setState('completed')
    const event = await desktopApi().reality.getEvent(eventId)
    onEventChanged?.(event)
    realityEventIdRef.current = null
  }

  const startRecording = async () => {
    if (!window.nxcore?.asr) {
      window.nxcore?.errors.report({
        channel: 'media:recording',
        title: '录音不可用',
        message: `录音转写仅在 ${PRODUCT_NAME} 桌面版中可用。`,
      })
      setState('error')
      return
    }
    setState('requesting')
    setResult(null)
    setElapsed(0)
    try {
      const stream = audioSource === 'system'
        ? await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        : await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error(audioSource === 'system'
          ? '未能获取电脑音频。请在 macOS 系统设置中允许 EverRoom 录制系统音频。'
          : '未能获取麦克风音频。')
      }
      const mimeType = supportedMimeType()
      const { id } = await desktopApi().asr.beginRecording(mimeType || 'audio/webm')
      const audioStream = new MediaStream(audioTracks)
      const recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream)
      streamRef.current = stream
      recorderRef.current = recorder
      recordingIdRef.current = id
      writeQueueRef.current = Promise.resolve()
      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size) return
        writeQueueRef.current = writeQueueRef.current.then(async () => {
          const chunk = new Uint8Array(await event.data.arrayBuffer())
          await desktopApi().asr.appendRecording(id, chunk)
        })
      })
      recorder.start(1000)
      recordingStartedAtRef.current = Date.now()
      setState('recording')
    } catch (caught) {
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') await waitForStop(recorder).catch(() => undefined)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      recordingStartedAtRef.current = null
      const id = recordingIdRef.current
      recordingIdRef.current = null
      if (id) await desktopApi().asr.cancelRecording(id).catch(() => undefined)
      const eventId = realityEventIdRef.current
      realityEventIdRef.current = null
      if (eventId) await desktopApi().reality.fail(eventId, errorMessage(caught, audioSource)).catch(() => undefined)
      reportRecordingError(caught, audioSource)
      setState('error')
    }
  }

  const stopRecording = async () => {
    const recorder = recorderRef.current
    const id = recordingIdRef.current
    if (!recorder || !id) return
    setState('saving')
    try {
      await waitForStop(recorder)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      await writeQueueRef.current
      const durationMs = Math.max(0, Date.now() - (recordingStartedAtRef.current ?? Date.now()))
      recordingStartedAtRef.current = null
      if (durationMs < MIN_TRANSCRIPTION_DURATION_MS) {
        recordingIdRef.current = null
        await desktopApi().asr.cancelRecording(id)
        setElapsed(0)
        setState('idle')
        showToast({
          title: '录音时间太短',
          message: '少于 10 秒的录音不会转写，本次内容已丢弃。',
        })
        return
      }
      const capturedEvent = await desktopApi().reality.createEvent({
        id,
        title: `桌面感知 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`,
        captureDevice: {
          id: 'desktop-local',
          name: desktopApi().platform === 'darwin' ? '这台 Mac' : '这台电脑',
          kind: 'desktop',
        },
        audioSource,
        audioMimeType: recorder.mimeType || 'audio/webm',
      })
      realityEventIdRef.current = id
      onEventChanged?.(capturedEvent)
      const { filePath } = await desktopApi().asr.finishRecording(id)
      recordingIdRef.current = null
      const finishedEvent = await desktopApi().reality.finishCapture(id, {
        durationMs,
        audioFileName: filePath,
      })
      onEventChanged?.(finishedEvent)
      setState('transcribing')
      const job = await desktopApi().asr.createJob({
        filePath,
        mode,
        recordingId:id,
        durationMs,
        languageHints: languages,
        diarizationEnabled: true,
      })
      await pollJob(job, id)
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      recordingStartedAtRef.current = null
      if (recordingIdRef.current) {
        await desktopApi().asr.cancelRecording(recordingIdRef.current).catch(() => undefined)
        recordingIdRef.current = null
      }
      const eventId = realityEventIdRef.current
      realityEventIdRef.current = null
      if (eventId) {
        const failed = await desktopApi().reality.fail(eventId, errorMessage(caught, audioSource)).catch(() => null)
        if (failed) onEventChanged?.(failed)
      }
      reportRecordingError(caught, audioSource)
      setState('error')
    }
  }

  const busy = state === 'requesting' || state === 'saving' || state === 'transcribing'
  const statusLabel = state === 'requesting'
    ? audioSource === 'system' ? '正在请求电脑音频权限' : '正在请求麦克风权限'
    : state === 'saving'
      ? '正在保存录音'
      : state === 'transcribing'
        ? '正在上传并转写'
        : state === 'completed'
          ? '转写完成'
          : state === 'error'
            ? '转写失败'
          : state === 'recording'
            ? '正在录音'
            : '准备录音'

  if (controlOnly) {
    const listening = state === 'recording'
    return (
      <CassetteListeningControl
        listening={listening}
        busy={busy}
        onToggle={listening ? stopRecording : startRecording}
      />
    )
  }

  return (
    <div className={`recording-page${embedded ? ' recording-page-embedded' : ' page'}`}>
      <header className="recording-header">
        <div>
          {embedded ? <h2>本机采集</h2> : <h1>录音转写</h1>}
          <p>{mode==='cloud'?'EverRoom SaaS · 订阅额度':'本地 Gateway · 自有阿里云配置'}</p>
        </div>
        <span className="recording-status" data-state={state} aria-live="polite">
          {busy ? <LoaderCircle aria-hidden="true" /> : state === 'completed' ? <Check aria-hidden="true" /> : null}
          {statusLabel}
        </span>
      </header>

      <section className="asr-mode-bar" aria-label="转写服务">
        <div className="segmented-control"><button type="button" data-active={String(mode==='cloud')} disabled={!account?.authenticated||busy||state==='recording'} onClick={()=>setMode('cloud')}><Cloud aria-hidden="true"/>云端托管</button><button type="button" data-active={String(mode==='local')} disabled={busy||state==='recording'} onClick={()=>setMode('local')}><HardDrive aria-hidden="true"/>本地配置</button></div>
        {!account?.authenticated?<div className="asr-login-hint"><span>未登录。请自行配置本地阿里云，或登录后使用订阅额度。</span><button type="button" className="secondary-button" onClick={onOpenSettings}><LogIn aria-hidden="true"/>登录</button></div>:<span className="asr-account-name">{account.user?.name||account.user?.email||'已登录'}</span>}
      </section>

      <section className="recording-controls" aria-label="录音控制">
        <button
          type="button"
          className="record-button"
          data-recording={String(state === 'recording')}
          disabled={busy}
          onClick={state === 'recording' ? stopRecording : startRecording}
          aria-label={state === 'recording' ? '停止录音' : '开始录音'}
          title={state === 'recording' ? '停止录音' : '开始录音'}
        >
          {state === 'recording' ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
        </button>
        <strong className="recording-timer">{formatDuration(elapsed)}</strong>
        <span>{state === 'recording' ? '点击停止' : '点击开始'}</span>
      </section>

      <section className="recording-options">
        <div className="recording-option-row">
          <span className="option-label">录制来源</span>
          <div className="segmented-control recording-source-control" aria-label="录制来源">
            <button
              type="button"
              data-active={String(audioSource === 'microphone')}
              disabled={busy || state === 'recording'}
              onClick={() => setAudioSource('microphone')}
            >
              <Mic aria-hidden="true" />麦克风
            </button>
            <button
              type="button"
              data-active={String(audioSource === 'system')}
              disabled={!isMacDesktop || busy || state === 'recording'}
              title={isMacDesktop ? '录制这台 Mac 正在播放的音频' : '电脑音频录制目前仅支持 macOS 桌面版'}
              onClick={() => setAudioSource('system')}
            >
              <MonitorSpeaker aria-hidden="true" />电脑音频
            </button>
          </div>
        </div>
        <div className="recording-option-row">
          <span className="option-label">语言</span>
          <div className="segmented-control" aria-label="转写语言">
            <button type="button" data-active={String(languages.includes('zh'))} onClick={() => toggleLanguage('zh')}>中文</button>
            <button type="button" data-active={String(languages.includes('en'))} onClick={() => toggleLanguage('en')}>English</button>
          </div>
        </div>
      </section>

      {result ? (
        <section className="transcript-output" aria-label="转写结果">
          <header><h2>转写结果</h2><span>{result.segments.length} 段</span></header>
          <div className="transcript-full">{result.transcript}</div>
          {result.segments.length > 0 ? (
            <div className="transcript-segments">
              {result.segments.map((segment, index) => (
                <div className="transcript-segment" key={`${segment.beginTime}-${index}`}>
                  <time>{formatTimestamp(segment.beginTime)}</time>
                  <strong>{segment.speakerId === null ? '说话人' : `说话人 ${segment.speakerId + 1}`}</strong>
                  <p>{segment.text}</p>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
