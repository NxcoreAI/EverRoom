import { Check, Cloud, HardDrive, LoaderCircle, LogIn, Mic, MonitorSpeaker, Settings2, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { PRODUCT_NAME } from '@/components/ui/brand'
import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings, onRealitySettingsChanged } from '@/state/realitySettings'
import { showToast } from '@/state/toast'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import i18n from '@/i18n/i18next'

import type { AsrJob, AsrResult, AsrSegment, NxcoreDesktopApi, RealityEvent } from '../../../../shared/sources'
import { SpeakerLabel } from './SpeakerLabel'
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

function errorMessage(error: unknown, t: Translate): string {
  const message = error instanceof Error ? error.message : t('diaryReality:recording.transcriptionFailedTryAgain')
  if (message === 'SERVER_ERROR') {
    return t('diaryReality:recording.alibabaCloudCouldNotReadOrProcessThe')
  }
  if (message.includes('own OSS is required')) {
    return t('diaryReality:recording.alibabaCloudOssIsNotConfiguredConfigureThe')
  }
  return message
}

function isDesktopRequestError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Error invoking remote method')
}

function isMicAccessError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'NotFoundError')
}

function reportRecordingError(error: unknown, audioSource: AudioSource, t: Translate, stage: 'start' | 'finish'): void {
  if (isDesktopRequestError(error)) return
  if (stage === 'finish') {
    window.nxcore?.errors.report({
      channel: 'media:recording',
      title: t('diaryReality:recording.transcriptionFailed'),
      message: errorMessage(error, t),
    })
    return
  }
  const message = errorMessage(error, t)
  window.nxcore?.errors.report(audioSource === 'system'
    ? {
        channel: 'media:system-audio',
        title: t('diaryReality:recording.systemAudioPermissionRequired'),
        message: t('diaryReality:recording.allowEverroomToUseScreenSystemAudioRecording'),
        action: 'open-system-audio-settings',
        actionLabel: t('diaryReality:recording.openSystemSettings'),
      }
    : isMicAccessError(error)
      ? {
          channel: 'media:microphone',
          title: t('diaryReality:recording.recordingDidNotStart'),
          message,
          action: 'open-microphone-settings',
          actionLabel: t('diaryReality:recording.openMicrophoneSettings'),
        }
      : {
          channel: 'media:microphone',
          title: t('diaryReality:recording.recordingDidNotStart'),
          message,
        })
}

function desktopApi(t: Translate): NxcoreDesktopApi {
  if (!window.nxcore) throw new Error(t('diaryReality:recording.recordingTranscriptionIsOnlyAvailableInTheProduct', { product: PRODUCT_NAME }))
  return window.nxcore
}

async function waitForStop(recorder: MediaRecorder, t: Translate): Promise<void> {
  if (recorder.state === 'inactive') return
  await new Promise<void>((resolve, reject) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
    recorder.addEventListener('error', () => reject(new Error(t('diaryReality:recording.theRecordingDeviceEncounteredAnError'))), { once: true })
    recorder.stop()
  })
}

export function RecordingPage({
  onOpenSettings,
  onEventChanged,
  onEventRemoved,
  embedded = false,
  controlOnly = false,
}: {
  onOpenSettings: () => void
  onEventChanged?: (event: RealityEvent) => void
  onEventRemoved?: (eventId: string) => void
  embedded?: boolean
  controlOnly?: boolean
}) {
  const { locale, t } = useLocale()
  const initialSettings = loadRealitySettings()
  const [state, setState] = useState<RecordingState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [languages, setLanguages] = useState<string[]>(initialSettings.languages)
  const [result, setResult] = useState<AsrResult | null>(null)
  // 边录边转的实时预览：分段任务转完由主进程推送，段内时间已偏移到整段时间轴。
  const [previewSegments, setPreviewSegments] = useState<AsrSegment[]>([])
  const previewRecordingIdRef = useRef<string | null>(null)
  const [completed, setCompleted] = useState<{ jobId: string; eventId: string } | null>(null)
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
  // 分段级上传（仅 cloud 模式）：与主录音器共用同一路音频流，每 15 秒切一段独立文件直传 SaaS。
  const segmentActiveRef = useRef(false)
  const segmentStreamRef = useRef<MediaStream | null>(null)
  const segmentRecorderRef = useRef<MediaRecorder | null>(null)
  const segmentIndexRef = useRef(0)
  const segmentTimerRef = useRef<number | null>(null)
  const segmentChainRef = useRef<Promise<void>>(Promise.resolve())
  const segmentMetaRef = useRef<{ mimeType: string; languageHints: string[] } | null>(null)
  const isMacDesktop = window.nxcore?.platform === 'darwin'

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') recorder.stop()
      segmentActiveRef.current = false
      if (segmentRecorderRef.current?.state === 'recording') segmentRecorderRef.current.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      recordingStartedAtRef.current = null
      const id = recordingIdRef.current
      if (id) {
        void window.nxcore?.asr.cancelRecording(id)
        if (realityEventIdRef.current) {
          void window.nxcore?.reality.fail(realityEventIdRef.current, i18n.t('diaryReality:recording.captureCancelled'))
        }
      }
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.nxcore?.asr?.onSegmentTranscription?.((event) => {
      if (event.recordingId !== previewRecordingIdRef.current) return
      setPreviewSegments((current) => [...current, ...event.result.segments])
    })
    return () => unsubscribe?.()
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
      if (Date.now() >= deadline) throw new Error(t('diaryReality:recording.transcriptionHasBeenPendingForOver30Minutes'))
      await new Promise((resolve) => window.setTimeout(resolve, TRANSCRIPTION_POLL_INTERVAL_MS))
      if (!mountedRef.current) return
      job = await desktopApi(t).asr.getJob(job.id)
    }
    if (job.status !== 'completed' || !job.result) {
      throw new Error(job.error ?? t('diaryReality:recording.theTranscriptionJobCouldNotBeCompleted'))
    }
    setResult(job.result)
    setState('completed')
    setCompleted({ jobId: job.id, eventId })
    const event = await desktopApi(t).reality.getEvent(eventId)
    onEventChanged?.(event)
    realityEventIdRef.current = null
  }

  const renameSpeaker = async (speakerId: string, name: string | null): Promise<boolean> => {
    if (!completed) return false
    try {
      const job = await desktopApi(t).asr.renameSpeaker(completed.jobId, speakerId, name)
      if (job.result) setResult(job.result)
      const event = await desktopApi(t).reality.getEvent(completed.eventId).catch(() => null)
      if (event) onEventChanged?.(event)
      return true
    } catch (caught) {
      showToast({ title: t('diaryReality:recording.renameSpeaker'), message: caught instanceof Error ? caught.message : undefined, variant: 'error' })
      return false
    }
  }

  const startSegmentRecorder = () => {
    const stream = segmentStreamRef.current
    const meta = segmentMetaRef.current
    const id = recordingIdRef.current
    if (!stream || !meta || !id || !segmentActiveRef.current) return
    const index = segmentIndexRef.current
    segmentIndexRef.current += 1
    const mimeType = meta.mimeType
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
    const chunks: Blob[] = []
    const startedAt = Date.now()
    segmentRecorderRef.current = recorder
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size) chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      if (segmentRecorderRef.current === recorder) segmentRecorderRef.current = null
      // 先启下一段（仍在录时）把切换间隙压到最小，再异步把本段发主进程。
      if (segmentActiveRef.current) startSegmentRecorder()
      const durationMs = Date.now() - startedAt
      if (durationMs < 1000 || !chunks.length) return
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' })
      const languageHints = meta.languageHints.length ? meta.languageHints : undefined
      // 每段追加后立刻接 catch：单段 IPC 失败不能炸链，否则后续段全部丢失。
      segmentChainRef.current = segmentChainRef.current
        .then(async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          await desktopApi(t).asr.uploadRecordingSegment(id, index, bytes, durationMs, { mimeType: mimeType || 'audio/webm', languageHints })
        })
        .catch(() => undefined)
    })
    recorder.start()
    segmentTimerRef.current = window.setTimeout(() => {
      void stopSegmentRecorder()
    }, 15_000)
  }

  const stopSegmentRecorder = async (): Promise<void> => {
    const recorder = segmentRecorderRef.current
    if (!recorder) return
    segmentRecorderRef.current = null
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current)
      segmentTimerRef.current = null
    }
    await waitForStop(recorder, t).catch(() => undefined)
  }

  const startRecording = async () => {
    if (!window.nxcore?.asr) {
      window.nxcore?.errors.report({
        channel: 'media:recording',
        title: t('diaryReality:recording.recordingUnavailable'),
        message: t('diaryReality:recording.recordingTranscriptionIsOnlyAvailableInTheProduct', { product: PRODUCT_NAME }),
      })
      setState('error')
      return
    }
    setState('requesting')
    setResult(null)
    setCompleted(null)
    setElapsed(0)
    try {
      if (audioSource === 'microphone') {
        const microphoneAllowed = await desktopApi(t).asr.requestMicrophoneAccess()
        if (!microphoneAllowed) {
          throw new DOMException('Microphone access was denied.', 'NotAllowedError')
        }
      }
      const stream = audioSource === 'system'
        ? await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
        : await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error(audioSource === 'system'
          ? t('diaryReality:recording.couldNotCaptureComputerAudioAllowEverroomTo')
          : t('diaryReality:recording.couldNotAccessMicrophoneAudio'))
      }
      const mimeType = supportedMimeType()
      const { id } = await desktopApi(t).asr.beginRecording(mimeType || 'audio/webm')
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
          await desktopApi(t).asr.appendRecording(id, chunk)
        })
      })
      recorder.start(1000)
      recordingStartedAtRef.current = Date.now()
      if (mode === 'cloud') {
        segmentActiveRef.current = true
        segmentIndexRef.current = 0
        segmentChainRef.current = Promise.resolve()
        segmentStreamRef.current = audioStream
        segmentMetaRef.current = { mimeType: mimeType || '', languageHints: languages }
        previewRecordingIdRef.current = id
        setPreviewSegments([])
        startSegmentRecorder()
      }
      const capturedEvent = await desktopApi(t).reality.createEvent({
        id,
        title: t('diaryReality:recording.desktopPerceptionTitle', {
          time: new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
        }),
        captureDevice: {
          id: 'desktop-local',
          name: t(desktopApi(t).platform === 'darwin' ? 'diaryReality:recording.thisMac' : 'diaryReality:recording.thisComputer'),
          kind: 'desktop',
        },
        audioSource,
        audioMimeType: recorder.mimeType || 'audio/webm',
      })
      realityEventIdRef.current = id
      onEventChanged?.(capturedEvent)
      setState('recording')
    } catch (caught) {
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') await waitForStop(recorder, t).catch(() => undefined)
      segmentActiveRef.current = false
      previewRecordingIdRef.current = null
      await stopSegmentRecorder()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      recordingStartedAtRef.current = null
      const id = recordingIdRef.current
      recordingIdRef.current = null
      if (id) await desktopApi(t).asr.cancelRecording(id).catch(() => undefined)
      const eventId = realityEventIdRef.current
      realityEventIdRef.current = null
      if (eventId) {
        const failed = await desktopApi(t).reality.fail(eventId, errorMessage(caught, t)).catch(() => null)
        if (failed) onEventChanged?.(failed)
      }
      reportRecordingError(caught, audioSource, t, 'start')
      setState('error')
    }
  }

  const stopRecording = async () => {
    const recorder = recorderRef.current
    const id = recordingIdRef.current
    if (!recorder || !id) return
    setState('saving')
    try {
      await waitForStop(recorder, t)
      segmentActiveRef.current = false
      await stopSegmentRecorder()
      await segmentChainRef.current.catch(() => undefined)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      await writeQueueRef.current
      const durationMs = Math.max(0, Date.now() - (recordingStartedAtRef.current ?? Date.now()))
      recordingStartedAtRef.current = null
      if (durationMs < MIN_TRANSCRIPTION_DURATION_MS) {
        recordingIdRef.current = null
        previewRecordingIdRef.current = null
        await desktopApi(t).asr.cancelRecording(id)
        realityEventIdRef.current = null
        await desktopApi(t).reality.discard(id).catch(() => undefined)
        onEventRemoved?.(id)
        setElapsed(0)
        setState('idle')
        showToast({
          title: t('diaryReality:recording.recordingTooShort'),
          message: t('diaryReality:recording.recordingsShorterThan10SecondsAreNotTranscribed'),
        })
        return
      }
      const { filePath } = await desktopApi(t).asr.finishRecording(id)
      recordingIdRef.current = null
      const finishedEvent = await desktopApi(t).reality.finishCapture(id, {
        durationMs,
        audioFileName: filePath,
      })
      onEventChanged?.(finishedEvent)
      setState('transcribing')
      const job = await desktopApi(t).asr.createJob({
        filePath,
        mode,
        recordingId:id,
        durationMs,
        languageHints: languages,
        diarizationEnabled: true,
      })
      await pollJob(job, id)
      previewRecordingIdRef.current = null
    } catch (caught) {
      segmentActiveRef.current = false
      previewRecordingIdRef.current = null
      await stopSegmentRecorder()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      recordingStartedAtRef.current = null
      if (recordingIdRef.current) {
        await desktopApi(t).asr.cancelRecording(recordingIdRef.current).catch(() => undefined)
        recordingIdRef.current = null
      }
      const eventId = realityEventIdRef.current
      realityEventIdRef.current = null
      if (eventId) {
        const failed = await desktopApi(t).reality.fail(eventId, errorMessage(caught, t)).catch(() => null)
        if (failed) onEventChanged?.(failed)
      }
      reportRecordingError(caught, audioSource, t, 'finish')
      setState('error')
    }
  }

  const busy = state === 'requesting' || state === 'saving' || state === 'transcribing'
  const statusLabel = t(state === 'requesting'
    ? audioSource === 'system' ? 'diaryReality:recording.requestingComputerAudioPermission' : 'diaryReality:recording.requestingMicrophonePermission'
    : state === 'saving'
      ? 'diaryReality:recording.savingRecording'
      : state === 'transcribing'
        ? 'diaryReality:recording.uploadingAndTranscribing'
        : state === 'completed'
          ? 'diaryReality:recording.transcriptionComplete'
          : state === 'error'
            ? 'diaryReality:recording.transcriptionFailed'
          : state === 'recording'
            ? 'diaryReality:recording.recording'
            : 'diaryReality:recording.readyToRecord')

  const previewSegmentsSorted = [...previewSegments].sort((a, b) => a.beginTime - b.beginTime)
  const displayResult = result ?? (previewSegmentsSorted.length
    ? { transcript: previewSegmentsSorted.map((segment) => segment.text).join('\n'), segments: previewSegmentsSorted }
    : null)

  if (controlOnly) {
    const listening = state === 'recording'
    const SourceIcon = audioSource === 'system' ? MonitorSpeaker : Mic
    return (
      <div className="capture-console" data-state={state}>
        <div className="capture-console-copy" aria-live="polite">
          <span>{t('diaryReality:recording.listeningControl')}</span>
          <strong>{statusLabel}</strong>
          <small><SourceIcon aria-hidden="true" />{t(audioSource === 'system' ? 'diaryReality:recording.computerAudio' : 'diaryReality:recording.microphone')} · {t(mode === 'cloud' ? 'diaryReality:recording.cloudHosted' : 'diaryReality:recording.localProcessing')}</small>
        </div>
        <div className="capture-console-actions">
          <button
            type="button"
            className="capture-primary-button"
            data-recording={String(listening)}
            disabled={busy}
            onClick={listening ? stopRecording : startRecording}
          >
            {listening ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
            {t(listening ? 'diaryReality:recording.stopListening' : busy ? 'diaryReality:recording.processing' : 'diaryReality:recording.startListening')}
            {listening ? <time>{formatDuration(elapsed)}</time> : null}
          </button>
          <button type="button" className="capture-settings-button" title={t('diaryReality:recording.captureSettings')} aria-label={t('diaryReality:recording.captureSettings')} onClick={onOpenSettings}>
            <Settings2 aria-hidden="true" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`recording-page${embedded ? ' recording-page-embedded' : ' page'}`}>
      <header className="recording-header">
        <div>
          {embedded ? <h2>{t('diaryReality:recording.localCapture')}</h2> : <h1>{t('diaryReality:recording.recordingTranscription')}</h1>}
          <p>{t(mode === 'cloud' ? 'diaryReality:recording.everroomSaasSubscriptionQuota' : 'diaryReality:recording.localGatewayYourAlibabaCloudConfiguration')}</p>
        </div>
        <span className="recording-status" data-state={state} aria-live="polite">
          {busy ? <LoaderCircle aria-hidden="true" /> : state === 'completed' ? <Check aria-hidden="true" /> : null}
          {statusLabel}
        </span>
      </header>

      <section className="asr-mode-bar" aria-label={t('diaryReality:recording.transcriptionService')}>
        <div className="segmented-control"><button type="button" data-active={String(mode==='cloud')} disabled={!account?.authenticated||busy||state==='recording'} onClick={()=>setMode('cloud')}><Cloud aria-hidden="true"/>{t('diaryReality:recording.cloudHosted')}</button><button type="button" data-active={String(mode==='local')} disabled={busy||state==='recording'} onClick={()=>setMode('local')}><HardDrive aria-hidden="true"/>{t('diaryReality:recording.localConfiguration')}</button></div>
        {!account?.authenticated?<div className="asr-login-hint"><span>{t('diaryReality:recording.youAreSignedOutConfigureAlibabaCloudLocally')}</span><button type="button" className="secondary-button" onClick={onOpenSettings}><LogIn aria-hidden="true"/>{t('diaryReality:recording.signIn')}</button></div>:<span className="asr-account-name">{account.user?.name||account.user?.email||t('diaryReality:recording.signedIn')}</span>}
      </section>

      <section className="recording-controls" aria-label={t('diaryReality:recording.recordingControls')}>
        <button
          type="button"
          className="record-button"
          data-recording={String(state === 'recording')}
          disabled={busy}
          onClick={state === 'recording' ? stopRecording : startRecording}
          aria-label={t(state === 'recording' ? 'diaryReality:recording.stopRecording' : 'diaryReality:recording.startRecording')}
          title={t(state === 'recording' ? 'diaryReality:recording.stopRecording' : 'diaryReality:recording.startRecording')}
        >
          {state === 'recording' ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
        </button>
        <strong className="recording-timer">{formatDuration(elapsed)}</strong>
        <span>{t(state === 'recording' ? 'diaryReality:recording.selectToStop' : 'diaryReality:recording.selectToStart')}</span>
      </section>

      <section className="recording-options">
        <div className="recording-option-row">
          <span className="option-label">{t('diaryReality:recording.recordingSource')}</span>
          <div className="segmented-control recording-source-control" aria-label={t('diaryReality:recording.recordingSource')}>
            <button
              type="button"
              data-active={String(audioSource === 'microphone')}
              disabled={busy || state === 'recording'}
              onClick={() => setAudioSource('microphone')}
            >
              <Mic aria-hidden="true" />{t('diaryReality:recording.microphone')}
            </button>
            <button
              type="button"
              data-active={String(audioSource === 'system')}
              disabled={!isMacDesktop || busy || state === 'recording'}
              title={t(isMacDesktop ? 'diaryReality:recording.recordAudioPlayingOnThisMac' : 'diaryReality:recording.computerAudioRecordingIsCurrentlySupportedOnlyOn')}
              onClick={() => setAudioSource('system')}
            >
              <MonitorSpeaker aria-hidden="true" />{t('diaryReality:recording.computerAudio')}
            </button>
          </div>
        </div>
        <div className="recording-option-row">
          <span className="option-label">{t('diaryReality:recording.language')}</span>
          <div className="segmented-control" aria-label={t('diaryReality:recording.transcriptionLanguages')}>
            <button type="button" data-active={String(languages.includes('zh'))} onClick={() => toggleLanguage('zh')}>{t('diaryReality:recording.chinese')}</button>
            <button type="button" data-active={String(languages.includes('en'))} onClick={() => toggleLanguage('en')}>{t('diaryReality:recording.english')}</button>
          </div>
        </div>
      </section>

      {displayResult ? (
        <section className="transcript-output" aria-label={t('diaryReality:recording.transcript')}>
          <header><h2>{t('diaryReality:recording.transcript')}</h2><span>{t('diaryReality:recording.countBlocks', { count: displayResult.segments.length })}</span></header>
          <div className="transcript-full">{displayResult.transcript}</div>
          {displayResult.segments.length > 0 ? (
            <div className="transcript-segments">
              {displayResult.segments.map((segment, index) => (
                <div className="transcript-segment" key={`${segment.beginTime}-${index}`}>
                  <time>{formatTimestamp(segment.beginTime)}</time>
                  <SpeakerLabel segment={segment} page="recording" onRename={mode === 'cloud' && completed ? renameSpeaker : undefined} />
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
