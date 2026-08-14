import { AlertCircle, Check, LoaderCircle, Mic, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { PRODUCT_NAME } from '@/components/ui/brand'

import type { AsrJob, AsrResult, NxcoreDesktopApi } from '../../../../shared/sources'
import './RecordingPage.css'

type RecordingState = 'idle' | 'requesting' | 'recording' | 'saving' | 'transcribing' | 'completed' | 'error'

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '录音转写失败，请重试。'
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

export function RecordingPage() {
  const [state, setState] = useState<RecordingState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [languages, setLanguages] = useState<string[]>(['zh', 'en'])
  const [diarizationEnabled, setDiarizationEnabled] = useState(true)
  const [contextPrompt, setContextPrompt] = useState('')
  const [result, setResult] = useState<AsrResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') recorder.stop()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      const id = recordingIdRef.current
      if (id) void window.nxcore?.asr.cancelRecording(id)
    }
  }, [])

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

  const pollJob = async (initialJob: AsrJob): Promise<void> => {
    let job = initialJob
    while (job.status === 'pending' || job.status === 'running') {
      await new Promise((resolve) => window.setTimeout(resolve, 1800))
      if (!mountedRef.current) return
      job = await desktopApi().asr.getJob(job.id)
    }
    if (job.status !== 'completed' || !job.result) {
      throw new Error(job.error ?? '转写任务未能完成。')
    }
    setResult(job.result)
    setState('completed')
  }

  const startRecording = async () => {
    if (!window.nxcore?.asr) {
      setError(`录音转写仅在 ${PRODUCT_NAME} 桌面版中可用。`)
      setState('error')
      return
    }
    setState('requesting')
    setError(null)
    setResult(null)
    setElapsed(0)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = supportedMimeType()
      const { id } = await desktopApi().asr.beginRecording(mimeType || 'audio/webm')
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
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
      setState('recording')
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      const id = recordingIdRef.current
      recordingIdRef.current = null
      if (id) await desktopApi().asr.cancelRecording(id).catch(() => undefined)
      setError(errorMessage(caught))
      setState('error')
    }
  }

  const stopRecording = async () => {
    const recorder = recorderRef.current
    const id = recordingIdRef.current
    if (!recorder || !id) return
    setState('saving')
    setError(null)
    try {
      await waitForStop(recorder)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      await writeQueueRef.current
      const { filePath } = await desktopApi().asr.finishRecording(id)
      recordingIdRef.current = null
      setState('transcribing')
      const job = await desktopApi().asr.createJob({
        filePath,
        languageHints: languages,
        diarizationEnabled,
        ...(contextPrompt.trim() ? { contextPrompt: contextPrompt.trim() } : {}),
      })
      await pollJob(job)
    } catch (caught) {
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      if (recordingIdRef.current) {
        await desktopApi().asr.cancelRecording(recordingIdRef.current).catch(() => undefined)
        recordingIdRef.current = null
      }
      setError(errorMessage(caught))
      setState('error')
    }
  }

  const busy = state === 'requesting' || state === 'saving' || state === 'transcribing'
  const statusLabel = state === 'requesting'
    ? '正在请求麦克风权限'
    : state === 'saving'
      ? '正在保存录音'
      : state === 'transcribing'
        ? '正在上传并转写'
        : state === 'completed'
          ? '转写完成'
          : state === 'recording'
            ? '正在录音'
            : '准备录音'

  return (
    <div className="page recording-page">
      <header className="recording-header">
        <div>
          <h1>录音转写</h1>
          <p>阿里云百炼 · 文件转写</p>
        </div>
        <span className="recording-status" data-state={state} aria-live="polite">
          {busy ? <LoaderCircle aria-hidden="true" /> : state === 'completed' ? <Check aria-hidden="true" /> : null}
          {statusLabel}
        </span>
      </header>

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
          <span className="option-label">语言</span>
          <div className="segmented-control" aria-label="转写语言">
            <button type="button" data-active={String(languages.includes('zh'))} onClick={() => toggleLanguage('zh')}>中文</button>
            <button type="button" data-active={String(languages.includes('en'))} onClick={() => toggleLanguage('en')}>English</button>
          </div>
        </div>
        <label className="recording-option-row toggle-row">
          <span><strong>区分说话人</strong><small>在逐段结果中标记不同说话人</small></span>
          <input type="checkbox" checked={diarizationEnabled} onChange={(event) => setDiarizationEnabled(event.target.checked)} />
        </label>
        <label className="context-field">
          <span>转写上下文 <small>{contextPrompt.length}/400</small></span>
          <textarea
            value={contextPrompt}
            maxLength={400}
            rows={3}
            placeholder="人名、产品名、专业术语"
            onChange={(event) => setContextPrompt(event.target.value)}
          />
        </label>
      </section>

      {error ? (
        <div className="recording-error" role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span></div>
      ) : null}

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
