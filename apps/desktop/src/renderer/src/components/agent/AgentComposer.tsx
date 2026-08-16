import { ArrowUp, FileText, LoaderCircle, Mic, Plus, Square, X } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'

import { loadRealitySettings } from '@/state/realitySettings'
import { showToast } from '@/state/toast'

const ACCEPTED_ATTACHMENTS = '.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx'
const ATTACHMENT_PATTERN = /\.(txt|md|csv|json|pdf|docx|xlsx|pptx)$/i
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
const MIN_RECORDING_MS = 10_000
const ASR_POLL_MS = 2_000
const ASR_TIMEOUT_MS = 30 * 60 * 1000
const AUDIO_MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
const TEXTAREA_MIN_HEIGHT = 42
const TEXTAREA_MAX_HEIGHT = 180

type VoiceState = 'idle' | 'requesting' | 'recording' | 'saving' | 'transcribing'

interface LocalAttachment {
  id: string
  name: string
  size: number
}

function supportedAudioMimeType(): string {
  return AUDIO_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '录音转写失败，请重试。'
}

export const AgentComposer = forwardRef<HTMLTextAreaElement, {
  contextSummary: string
  hasSelectedText: boolean
  resetKey: number
  value: string
  active: boolean
  loading: boolean
  onChange: (value: string) => void
  onClearContext: () => void
  onStop: () => void
  onSubmit: () => void
}>(function AgentComposer({
  active,
  contextSummary,
  hasSelectedText,
  loading,
  resetKey,
  value,
  onChange,
  onClearContext,
  onStop,
  onSubmit,
}, ref) {
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const shellRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const recordingStartedAtRef = useRef<number | null>(null)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const voiceOperationRef = useRef(0)
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)
  const valueRef = useRef(value)
  const insertionPointRef = useRef(0)

  valueRef.current = value
  useImperativeHandle(ref, () => textareaRef.current as HTMLTextAreaElement)

  const resizeTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    const stickToBottom = document.activeElement === textarea
      && textarea.selectionEnd === textarea.value.length
    const previousScrollTop = textarea.scrollTop
    textarea.style.height = '0px'
    const contentHeight = textarea.scrollHeight
    const nextHeight = Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, contentHeight))
    textarea.style.height = `${nextHeight}px`
    textarea.dataset.scrollable = String(contentHeight > TEXTAREA_MAX_HEIGHT)
    textarea.scrollTop = stickToBottom ? textarea.scrollHeight : previousScrollTop
  }

  useLayoutEffect(() => {
    resizeTextarea()
  }, [attachments.length, value])

  useEffect(() => {
    const shell = shellRef.current
    const prompt = shell?.querySelector<HTMLElement>('.agent-prompt')
    const frame = shell?.parentElement
    if (!shell || !prompt || !frame) return undefined

    const syncHeight = () => {
      frame.style.setProperty('--agent-composer-height', `${shell.getBoundingClientRect().height}px`)
    }
    let promptWidth = prompt.getBoundingClientRect().width
    const promptObserver = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - promptWidth) < 0.5) return
      promptWidth = entry.contentRect.width
      resizeTextarea()
    })
    const shellObserver = new ResizeObserver(syncHeight)
    promptObserver.observe(prompt)
    shellObserver.observe(shell)
    syncHeight()

    return () => {
      promptObserver.disconnect()
      shellObserver.disconnect()
      frame.style.removeProperty('--agent-composer-height')
    }
  }, [])

  const releaseMedia = () => {
    voiceOperationRef.current += 1
    const recorder = recorderRef.current
    cancelledRef.current = true
    if (recorder?.state === 'recording') recorder.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    recorderRef.current = null
    streamRef.current = null
    recordingStartedAtRef.current = null
  }

  const cancelRecording = () => {
    const id = recordingIdRef.current
    releaseMedia()
    recordingIdRef.current = null
    if (id) void window.nxcore?.asr.cancelRecording(id).catch(() => undefined)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelRecording()
    }
  }, [])

  useEffect(() => {
    cancelRecording()
    setAttachments([])
    setElapsed(0)
    setVoiceState('idle')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetKey])

  useEffect(() => {
    if (voiceState !== 'recording') return undefined
    const timer = window.setInterval(() => setElapsed((current) => current + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [voiceState])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (voiceState === 'idle') onSubmit()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (voiceState === 'idle') onSubmit()
    }
  }

  const selectAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    const known = new Set(attachments.map((file) => file.id))
    const candidates = files
      .filter((file) => ATTACHMENT_PATTERN.test(file.name) && file.size <= MAX_ATTACHMENT_SIZE)
      .map((file) => ({ id: `${file.name}:${file.size}:${file.lastModified}`, name: file.name, size: file.size }))
      .filter((file) => !known.has(file.id))
    const accepted = candidates.slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length))
    const rejected = files.length - accepted.length
    setAttachments((current) => [...current, ...accepted])
    showToast({
      title: rejected ? '部分附件未添加' : '附件已添加到输入区',
      message: rejected
        ? '仅支持指定文档格式且单个文件不超过 10 MB。当前 Agent 链路不会上传附件。'
        : '当前 Agent 链路不会上传附件，文件仅保留在本次输入区。',
    })
    event.target.value = ''
  }

  const insertTranscript = (transcript: string) => {
    const text = transcript.trim()
    if (!text) return
    const current = valueRef.current
    const point = Math.min(insertionPointRef.current, current.length)
    const prefix = current.slice(0, point)
    const suffix = current.slice(point)
    const separatorBefore = prefix && !/\s$/.test(prefix) ? ' ' : ''
    const separatorAfter = suffix && !/^\s/.test(suffix) ? ' ' : ''
    const next = `${prefix}${separatorBefore}${text}${separatorAfter}${suffix}`
    const caret = prefix.length + separatorBefore.length + text.length
    onChange(next)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }

  const startRecording = async () => {
    if (!window.nxcore?.asr) {
      showToast({ title: '录音不可用', message: '录音转写仅在 EverRoom 桌面版中可用。' })
      return
    }
    setVoiceState('requesting')
    setElapsed(0)
    cancelledRef.current = false
    const operation = ++voiceOperationRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (voiceOperationRef.current !== operation || !mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const mimeType = supportedAudioMimeType()
      const { id } = await window.nxcore.asr.beginRecording(mimeType || 'audio/webm')
      if (voiceOperationRef.current !== operation || !mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        await window.nxcore.asr.cancelRecording(id).catch(() => undefined)
        return
      }
      recordingIdRef.current = id
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      recorderRef.current = recorder
      recordingStartedAtRef.current = Date.now()
      writeQueueRef.current = Promise.resolve()
      recorder.addEventListener('dataavailable', (audioEvent) => {
        if (!audioEvent.data.size || cancelledRef.current) return
        writeQueueRef.current = writeQueueRef.current.then(async () => {
          const chunk = new Uint8Array(await audioEvent.data.arrayBuffer())
          await window.nxcore?.asr.appendRecording(id, chunk)
        })
      })
      recorder.start(1_000)
      setVoiceState('recording')
    } catch (error) {
      if (voiceOperationRef.current !== operation || !mountedRef.current) return
      cancelRecording()
      setVoiceState('idle')
      showToast({ title: '无法开始录音', message: errorMessage(error) })
    }
  }

  const stopRecording = async () => {
    const recorder = recorderRef.current
    const id = recordingIdRef.current
    if (!recorder || !id || !window.nxcore?.asr) return
    const operation = voiceOperationRef.current
    insertionPointRef.current = textareaRef.current?.selectionStart ?? valueRef.current.length
    setVoiceState('saving')
    try {
      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve, reject) => {
          recorder.addEventListener('stop', () => resolve(), { once: true })
          recorder.addEventListener('error', () => reject(new Error('录音设备发生错误。')), { once: true })
          recorder.stop()
        })
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      recorderRef.current = null
      await writeQueueRef.current
      if (voiceOperationRef.current !== operation || !mountedRef.current) return
      const durationMs = Math.max(0, Date.now() - (recordingStartedAtRef.current ?? Date.now()))
      recordingStartedAtRef.current = null
      if (durationMs < MIN_RECORDING_MS) {
        recordingIdRef.current = null
        await window.nxcore.asr.cancelRecording(id)
        setVoiceState('idle')
        setElapsed(0)
        showToast({ title: '录音时间太短', message: '录音至少需要 10 秒才能转写。' })
        return
      }

      const { filePath } = await window.nxcore.asr.finishRecording(id)
      recordingIdRef.current = null
      setVoiceState('transcribing')
      const settings = loadRealitySettings()
      let job = await window.nxcore.asr.createJob({
        filePath,
        mode: settings.mode === 'cloud' ? 'cloud' : 'local',
        recordingId: id,
        durationMs,
        languageHints: settings.languages,
        diarizationEnabled: false,
      })
      const deadline = Date.now() + ASR_TIMEOUT_MS
      while (job.status === 'pending' || job.status === 'running') {
        if (Date.now() >= deadline) throw new Error('转写等待超时，请稍后重试。')
        await new Promise((resolve) => window.setTimeout(resolve, ASR_POLL_MS))
        if (voiceOperationRef.current !== operation || !mountedRef.current) return
        job = await window.nxcore.asr.getJob(job.id)
      }
      if (voiceOperationRef.current !== operation || !mountedRef.current) return
      if (job.status !== 'completed' || !job.result) throw new Error(job.error ?? '转写任务未完成。')
      insertTranscript(job.result.transcript)
      setElapsed(0)
      setVoiceState('idle')
    } catch (error) {
      if (voiceOperationRef.current !== operation || !mountedRef.current) return
      cancelRecording()
      setVoiceState('idle')
      showToast({ title: '录音转写失败', message: errorMessage(error) })
    }
  }

  const voiceBusy = voiceState !== 'idle'
  const controlsDisabled = active || loading
  const voiceLabel = voiceState === 'recording'
    ? `录音 ${formatDuration(elapsed)}`
    : voiceState === 'requesting'
      ? '请求麦克风'
      : voiceState === 'saving'
        ? '保存录音'
        : voiceState === 'transcribing'
          ? '正在转写'
          : ''

  return (
    <form ref={shellRef} className="agent-composer-shell" onSubmit={submit}>
      <div className="agent-prompt" data-has-attachments={String(attachments.length > 0)}>
        <textarea
          ref={textareaRef}
          aria-label="桌面 AI 工作台输入框"
          placeholder={active ? 'Agent 正在处理...' : '基于当前页面提问，或描述需要执行的操作'}
          rows={2}
          value={value}
          disabled={active || voiceState === 'saving' || voiceState === 'transcribing'}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {attachments.length > 0 ? (
          <div className="agent-attachments" aria-label="本地附件">
            {attachments.map((file) => (
              <span key={file.id} className="agent-attachment">
                <FileText aria-hidden="true" />
                <span title={file.name}>{file.name}</span>
                <small>{formatFileSize(file.size)}</small>
                <button
                  type="button"
                  aria-label={`移除 ${file.name}`}
                  title="移除附件"
                  onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="agent-prompt-actions">
          <input
            ref={fileInputRef}
            className="agent-file-input"
            type="file"
            accept={ACCEPTED_ATTACHMENTS}
            multiple
            tabIndex={-1}
            onChange={selectAttachments}
          />
          <button
            type="button"
            className="agent-prompt-tool"
            title="添加附件"
            aria-label="添加附件"
            disabled={controlsDisabled || voiceBusy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="agent-prompt-tool agent-prompt-voice"
            data-recording={String(voiceState === 'recording')}
            title={voiceState === 'recording' ? '停止录音' : '语音输入'}
            aria-label={voiceState === 'recording' ? '停止录音' : '语音输入'}
            disabled={controlsDisabled || (voiceBusy && voiceState !== 'recording')}
            onClick={voiceState === 'recording' ? stopRecording : startRecording}
          >
            {voiceState === 'recording'
              ? <Square aria-hidden="true" />
              : voiceBusy
                ? <LoaderCircle className="spin" aria-hidden="true" />
                : <Mic aria-hidden="true" />}
          </button>
          {voiceLabel ? <span className="agent-voice-status" role="status">{voiceLabel}</span> : null}
          <span className="agent-composer-context" title={contextSummary}>
            <span>{contextSummary}</span>
            {hasSelectedText ? (
              <button type="button" aria-label="移除选中文字" title="移除选中文字" onClick={onClearContext}>
                <X aria-hidden="true" />
              </button>
            ) : null}
          </span>
          {active ? (
            <button type="button" className="agent-prompt-submit is-stop" title="停止" aria-label="停止" onClick={onStop}>
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-prompt-submit" title="发送" aria-label="发送" disabled={!value.trim() || loading || voiceBusy}>
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
})
