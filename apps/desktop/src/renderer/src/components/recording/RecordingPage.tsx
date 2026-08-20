import { Check, Cloud, HardDrive, LoaderCircle, LogIn, Mic, MonitorSpeaker, Square } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'

import { PRODUCT_NAME } from '@/components/ui/brand'
import { useAccount } from '@/state/AccountContext'
import { loadRealitySettings, onRealitySettingsChanged } from '@/state/realitySettings'
import { showToast } from '@/state/toast'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import i18n from '@/i18n/i18next'

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

function reportRecordingError(error: unknown, audioSource: AudioSource, t: Translate): void {
  if (isDesktopRequestError(error)) return
  const message = errorMessage(error, t)
  window.nxcore?.errors.report(audioSource === 'system'
    ? {
        channel: 'media:system-audio',
        title: t('diaryReality:recording.systemAudioPermissionRequired'),
        message: t('diaryReality:recording.allowEverroomToUseScreenSystemAudioRecording'),
        action: 'open-system-audio-settings',
        actionLabel: t('diaryReality:recording.openSystemSettings'),
      }
    : {
        channel: 'media:microphone',
        title: t('diaryReality:recording.recordingDidNotStart'),
        message,
        action: 'open-microphone-settings',
        actionLabel: t('diaryReality:recording.openMicrophoneSettings'),
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

const CassetteListeningControl = memo(function CassetteListeningControl({
  listening,
  busy,
  elapsed,
  onToggle,
}: {
  listening: boolean
  busy: boolean
  elapsed: number
  onToggle: () => void
}) {
  const { t } = useLocale()
  return (
    <button
      type="button"
      className="cassette-switch"
      role="switch"
      aria-checked={listening}
      aria-label={t(listening ? 'diaryReality:recording.stopListening' : busy ? 'diaryReality:recording.processingRecording' : 'diaryReality:recording.startListening')}
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
  const { locale, t } = useLocale()
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
          void window.nxcore?.reality.fail(realityEventIdRef.current, i18n.t('diaryReality:recording.captureCancelled'))
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
    const event = await desktopApi(t).reality.getEvent(eventId)
    onEventChanged?.(event)
    realityEventIdRef.current = null
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
      setState('recording')
    } catch (caught) {
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') await waitForStop(recorder, t).catch(() => undefined)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      recordingStartedAtRef.current = null
      const id = recordingIdRef.current
      recordingIdRef.current = null
      if (id) await desktopApi(t).asr.cancelRecording(id).catch(() => undefined)
      const eventId = realityEventIdRef.current
      realityEventIdRef.current = null
      if (eventId) await desktopApi(t).reality.fail(eventId, errorMessage(caught, t)).catch(() => undefined)
      reportRecordingError(caught, audioSource, t)
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
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      await writeQueueRef.current
      const durationMs = Math.max(0, Date.now() - (recordingStartedAtRef.current ?? Date.now()))
      recordingStartedAtRef.current = null
      if (durationMs < MIN_TRANSCRIPTION_DURATION_MS) {
        recordingIdRef.current = null
        await desktopApi(t).asr.cancelRecording(id)
        setElapsed(0)
        setState('idle')
        showToast({
          title: t('diaryReality:recording.recordingTooShort'),
          message: t('diaryReality:recording.recordingsShorterThan10SecondsAreNotTranscribed'),
        })
        return
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
    } catch (caught) {
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
      reportRecordingError(caught, audioSource, t)
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

  if (controlOnly) {
    const listening = state === 'recording'
    return (
      <div className="cassette-control-column">
        <CassetteListeningControl
          listening={listening}
          busy={busy}
          elapsed={listening ? elapsed : 0}
          onToggle={listening ? stopRecording : startRecording}
        />
        {listening || busy ? (
          <span className="cassette-recording-timer" data-recording={String(listening)} role="timer">
            <i aria-hidden="true" />
            {listening ? formatDuration(elapsed) : t('diaryReality:recording.processing')}
          </span>
        ) : null}
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

      {result ? (
        <section className="transcript-output" aria-label={t('diaryReality:recording.transcript')}>
          <header><h2>{t('diaryReality:recording.transcript')}</h2><span>{t('diaryReality:recording.countBlocks', { count: result.segments.length })}</span></header>
          <div className="transcript-full">{result.transcript}</div>
          {result.segments.length > 0 ? (
            <div className="transcript-segments">
              {result.segments.map((segment, index) => (
                <div className="transcript-segment" key={`${segment.beginTime}-${index}`}>
                  <time>{formatTimestamp(segment.beginTime)}</time>
                  <strong>{segment.speakerId === null ? t('diaryReality:recording.speaker') : t('diaryReality:recording.speakerNumber', { number: segment.speakerId + 1 })}</strong>
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
