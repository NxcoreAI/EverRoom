import { ArrowLeft, ArrowUp, Bot, FileText, History, LoaderCircle, Mic, Plus, Search, Square, X } from 'lucide-react'
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
import type { ExternalConversationSummary } from '@nxcore/agent-contract'

import { loadRealitySettings } from '@/state/realitySettings'
import { showToast } from '@/state/toast'
import { useLocale, type Translate } from '@/i18n/LocaleContext'
import type { LocalAgentInstallation } from '../../../../shared/local-agents'

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
type ExternalPickerStatus = 'idle' | 'loading' | 'ready' | 'loading-more' | 'error'

interface LocalAttachment {
  id: string
  file: File
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

function errorMessage(error: unknown, t: Translate): string {
  return error instanceof Error ? error.message : t('surface:agentComposer.transcriptionFailedTryAgain')
}

function displayText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function displayDate(
  value: unknown,
  formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => string,
  fallback: string,
): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fallback
  try {
    return formatDate(value, { dateStyle: 'medium' })
  } catch {
    return fallback
  }
}

export const AgentComposer = forwardRef<HTMLTextAreaElement, {
  contextSummary: string
  hasSelectedText: boolean
  resetKey: number
  value: string
  active: boolean
  available: boolean
  loading: boolean
  localAgents: LocalAgentInstallation[]
  selectedAgent: LocalAgentInstallation | null
  selectedExternalConversation: ExternalConversationSummary | null
  onChange: (value: string) => void
  onSelectAgent: (agent: LocalAgentInstallation | null) => void
  onSelectExternalConversation: (conversation: ExternalConversationSummary | null) => void
  onClearContext: () => void
  onStop: () => void
  onSubmit: (files: File[]) => void
}>(function AgentComposer({
  active,
  available,
  contextSummary,
  hasSelectedText,
  loading,
  localAgents,
  resetKey,
  selectedAgent,
  selectedExternalConversation,
  value,
  onChange,
  onClearContext,
  onStop,
  onSubmit,
  onSelectAgent,
  onSelectExternalConversation,
}, ref) {
  const { t, formatDate } = useLocale()
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const shellRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const externalResultsRef = useRef<HTMLDivElement>(null)
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
  const composingRef = useRef(false)
  const externalRequestRef = useRef(0)
  const [agentPickerDismissed, setAgentPickerDismissed] = useState(false)
  const [slashPickerDismissed, setSlashPickerDismissed] = useState(false)
  const [externalPickerOpen, setExternalPickerOpen] = useState(false)
  const [externalQuery, setExternalQuery] = useState('')
  const [externalItems, setExternalItems] = useState<ExternalConversationSummary[]>([])
  const [externalCursor, setExternalCursor] = useState<string | null>(null)
  const [externalIndex, setExternalIndex] = useState(0)
  const [externalStatus, setExternalStatus] = useState<ExternalPickerStatus>('idle')
  const [caret, setCaret] = useState(0)

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
    setAgentPickerDismissed(false)
    setSlashPickerDismissed(false)
    setExternalPickerOpen(false)
    externalRequestRef.current += 1
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetKey])

  useEffect(() => {
    if (!externalPickerOpen) return undefined
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (shellRef.current?.contains(event.target as Node)) return
      externalRequestRef.current += 1
      setExternalPickerOpen(false)
    }
    document.addEventListener?.('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener?.('pointerdown', closeOnOutsidePress)
  }, [externalPickerOpen])

  useEffect(() => {
    if (voiceState !== 'recording') return undefined
    const timer = window.setInterval(() => setElapsed((current) => current + 1), 1_000)
    return () => window.clearInterval(timer)
  }, [voiceState])

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (available && voiceState === 'idle') onSubmit(attachments.map(({ file }) => file))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (externalPickerOpen) return
    if (event.key === 'Enter' && (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) return
    if (slashPickerOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); return }
    if (slashPickerOpen && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); openExternalPicker(); return
    }
    if (event.key === 'Escape' && slashPickerOpen) { event.preventDefault(); setSlashPickerDismissed(true); return }
    if (event.key === 'Escape' && pickerOpen) {
      event.preventDefault()
      setAgentPickerDismissed(true)
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && pickerOpen && matchingAgents[0]) {
      event.preventDefault()
      selectAgent(matchingAgents[0])
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (available && voiceState === 'idle') onSubmit(attachments.map(({ file }) => file))
    }
  }

  const selectAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    const known = new Set(attachments.map((file) => file.id))
    const candidates = files
      .filter((file) => ATTACHMENT_PATTERN.test(file.name) && file.size <= MAX_ATTACHMENT_SIZE)
      .map((file) => ({ id: `${file.name}:${file.size}:${file.lastModified}`, file, name: file.name, size: file.size }))
      .filter((file) => !known.has(file.id))
    const accepted = candidates.slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length))
    const rejected = files.length - accepted.length
    setAttachments((current) => [...current, ...accepted])
    showToast({
      title: t(rejected ? 'surface:agentComposer.someAttachmentsWereNotAdded' : 'surface:agentComposer.attachmentsAddedToTheComposer'),
      message: rejected
        ? t('surface:agentComposer.onlySupportedDocumentFormatsUpTo10Mb')
        : t('surface:agentComposer.attachmentsAddedToTheComposer'),
    })
    event.target.value = ''
  }

  const addDroppedAttachments = (files: File[]) => {
    const known = new Set(attachments.map((file) => file.id))
    const candidates = files
      .filter((file) => ATTACHMENT_PATTERN.test(file.name) && file.size <= MAX_ATTACHMENT_SIZE)
      .map((file) => ({ id: `${file.name}:${file.size}:${file.lastModified}`, file, name: file.name, size: file.size }))
      .filter((file) => !known.has(file.id))
    const accepted = candidates.slice(0, Math.max(0, MAX_ATTACHMENTS - attachments.length))
    if (accepted.length === 0) return
    setAttachments((current) => [...current, ...accepted])
    showToast({
      title: t('surface:agentComposer.attachmentsAddedToTheComposer'),
      message: t('surface:agentComposer.attachmentsAddedToTheComposer'),
    })
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
      showToast({ title: t('surface:agentComposer.recordingUnavailable'), message: t('surface:agentComposer.voiceTranscriptionIsAvailableOnlyInTheEverroom') })
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
      showToast({ title: t('surface:agentComposer.couldNotStartRecording'), message: errorMessage(error, t) })
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
          recorder.addEventListener('error', () => reject(new Error(t('surface:agentComposer.recordingDeviceError'))), { once: true })
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
        showToast({ title: t('surface:agentComposer.recordingTooShort'), message: t('surface:agentComposer.aRecordingMustBeAtLeast10Seconds') })
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
        if (Date.now() >= deadline) throw new Error(t('surface:agentComposer.transcriptionTimedOut'))
        await new Promise((resolve) => window.setTimeout(resolve, ASR_POLL_MS))
        if (voiceOperationRef.current !== operation || !mountedRef.current) return
        job = await window.nxcore.asr.getJob(job.id)
      }
      if (voiceOperationRef.current !== operation || !mountedRef.current) return
      if (job.status !== 'completed' || !job.result) throw new Error(job.error ?? t('surface:agentComposer.transcriptionIncomplete'))
      insertTranscript(job.result.transcript)
      setElapsed(0)
      setVoiceState('idle')
    } catch (error) {
      if (voiceOperationRef.current !== operation || !mountedRef.current) return
      cancelRecording()
      setVoiceState('idle')
      showToast({ title: t('surface:agentComposer.voiceTranscriptionFailed'), message: errorMessage(error, t) })
    }
  }

  const voiceBusy = voiceState !== 'idle'
  const mentionMatch = /^@([^\s]*)$/u.exec(value.trim())
  const mentionQuery = mentionMatch?.[1]?.toLocaleLowerCase() ?? ''
  const matchingAgents = mentionMatch
    ? localAgents.filter((agent) => (
        agent.callable
        && agent.invocationSupported
        && (`${agent.displayName} ${agent.provider}`).toLocaleLowerCase().includes(mentionQuery)
      ))
    : []
  const pickerOpen = Boolean(mentionMatch && !agentPickerDismissed && matchingAgents.length > 0)
  const firstLineEnd = value.indexOf('\n') < 0 ? value.length : value.indexOf('\n')
  const slashMatch = /^\/([^\s\n]*)/u.exec(value)
  const slashQuery = slashMatch?.[1]?.toLocaleLowerCase() ?? ''
  const commandMatches = !slashQuery || 'continue'.startsWith(slashQuery)
  const slashPickerOpen = Boolean(slashMatch && commandMatches && caret <= firstLineEnd && !slashPickerDismissed && !externalPickerOpen && !mentionMatch)
  const loadExternal = async (query: string, cursor?: string, append = false) => {
    const request = ++externalRequestRef.current
    setExternalStatus(append ? 'loading-more' : 'loading')
    try {
      const page = await window.nxcore?.migrations?.conversations({ query, cursor, limit: 20 })
      if (request !== externalRequestRef.current || !mountedRef.current) return
      if (!page) throw new Error('external_conversations_unavailable')
      setExternalItems((current) => append ? [...current, ...page.items] : page.items)
      setExternalCursor(page.nextCursor)
      setExternalIndex((current) => append ? current : Math.min(current, Math.max(0, page.items.length - 1)))
      setExternalStatus('ready')
    } catch {
      if (request !== externalRequestRef.current || !mountedRef.current) return
      if (!append) {
        setExternalItems([])
        setExternalCursor(null)
        setExternalIndex(0)
      }
      setExternalStatus('error')
    }
  }
  const openExternalPicker = () => {
    setExternalPickerOpen(true)
    setSlashPickerDismissed(true)
    setExternalQuery('')
    setExternalItems([])
    setExternalCursor(null)
    setExternalIndex(0)
  }
  const closeExternalPicker = () => {
    externalRequestRef.current += 1
    setExternalPickerOpen(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const backToCommands = () => {
    externalRequestRef.current += 1
    setExternalPickerOpen(false)
    setSlashPickerDismissed(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const chooseExternal = (item: ExternalConversationSummary) => {
    const remaining = value.slice(firstLineEnd + (value[firstLineEnd] === '\n' ? 1 : 0))
    externalRequestRef.current += 1
    onChange(remaining)
    onSelectExternalConversation(item)
    setExternalPickerOpen(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const selectAgent = (agent: LocalAgentInstallation) => {
    onSelectAgent(agent)
    onChange('')
    setAgentPickerDismissed(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  useEffect(() => {
    if (!externalPickerOpen) return undefined
    const timer = window.setTimeout(() => {
      void loadExternal(externalQuery.trim(), undefined, false)
    }, externalQuery ? 180 : 0)
    return () => window.clearTimeout(timer)
  }, [externalPickerOpen, externalQuery])

  useEffect(() => {
    if (!externalPickerOpen) return
    externalResultsRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${externalIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [externalIndex, externalItems[externalIndex]?.id, externalPickerOpen])

  const menuOpen = slashPickerOpen || externalPickerOpen || pickerOpen
  // 会话快照加载时保留本地附件和录音状态。
  const controlsDisabled = active || !available
  const voiceLabel = voiceState === 'recording'
    ? t('surface:agentComposer.recordingDuration', { duration: formatDuration(elapsed) })
    : voiceState === 'requesting'
      ? t('surface:agentComposer.requestingMicrophone')
      : voiceState === 'saving'
        ? t('surface:agentComposer.savingRecording')
        : voiceState === 'transcribing'
          ? t('surface:agentComposer.transcribing')
          : ''

  return (
    <form
      ref={shellRef}
      className="agent-composer-shell"
      data-menu-open={String(menuOpen)}
      onSubmit={submit}
      onDragOver={(event) => {
        if (!controlsDisabled && event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDrop={(event) => {
        if (controlsDisabled) return
        event.preventDefault()
        addDroppedAttachments([...event.dataTransfer.files])
      }}
    >
      {slashPickerOpen ? (
        <div className="agent-composer-popover agent-command-picker" id="agent-composer-menu" role="listbox" aria-label={t('surface:agentComposer.commands')}>
          <button type="button" role="option" aria-selected="true" onMouseDown={(event) => event.preventDefault()} onClick={openExternalPicker}>
            <span className="agent-mention-icon"><History aria-hidden="true" /></span>
            <span><strong>{t('surface:agentComposer.continueExternalConversation')}</strong><small>{t('surface:agentComposer.externalConversationHint')}</small></span>
            <kbd>/continue</kbd>
          </button>
        </div>
      ) : null}
      {externalPickerOpen ? (
        <section className="agent-composer-popover agent-external-picker" id="agent-composer-menu" role="dialog" aria-modal="false" aria-label={t('surface:agentComposer.continueExternalConversation')}>
          <header className="agent-external-header">
            <button type="button" className="agent-picker-icon-button" title={t('surface:agentComposer.backToCommands')} aria-label={t('surface:agentComposer.backToCommands')} onClick={backToCommands}>
              <ArrowLeft aria-hidden="true" />
            </button>
            <div><strong>{t('surface:agentComposer.continueExternalConversation')}</strong><small>{t('surface:agentComposer.chooseConversation')}</small></div>
            <button type="button" className="agent-picker-icon-button" title={t('surface:agentComposer.close')} aria-label={t('surface:agentComposer.close')} onClick={closeExternalPicker}>
              <X aria-hidden="true" />
            </button>
          </header>
          <label className="agent-external-search">
            <Search aria-hidden="true" />
            <input
              autoFocus
              value={externalQuery}
              placeholder={t('surface:agentComposer.searchExternalConversations')}
              onChange={(event) => setExternalQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  closeExternalPicker()
                } else if (event.key === 'ArrowDown' && externalItems.length) {
                  event.preventDefault()
                  setExternalIndex((current) => Math.min(externalItems.length - 1, current + 1))
                } else if (event.key === 'ArrowUp' && externalItems.length) {
                  event.preventDefault()
                  setExternalIndex((current) => Math.max(0, current - 1))
                } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && externalItems[externalIndex]) {
                  event.preventDefault()
                  chooseExternal(externalItems[externalIndex]!)
                }
              }}
            />
            {externalStatus === 'loading' ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
          </label>
          <div ref={externalResultsRef} className="agent-external-results" role="listbox" aria-label={t('surface:agentComposer.externalConversations')} aria-busy={externalStatus === 'loading'}>
            {externalStatus === 'loading' && externalItems.length === 0 ? (
              <div className="agent-external-state" role="status"><LoaderCircle className="spin" aria-hidden="true" /><span>{t('surface:agentComposer.loadingExternalConversations')}</span></div>
            ) : externalStatus === 'error' && externalItems.length === 0 ? (
              <div className="agent-external-state is-error" role="alert"><span>{t('surface:agentComposer.externalConversationsUnavailable')}</span><button type="button" onClick={() => void loadExternal(externalQuery.trim())}>{t('surface:agentComposer.retry')}</button></div>
            ) : externalItems.length === 0 ? (
              <div className="agent-external-state"><History aria-hidden="true" /><span>{t('surface:agentComposer.noExternalConversations')}</span></div>
            ) : (
              <>
                {externalItems.map((item, index) => (
                  <button
                    key={`${item.id}:${index}`}
                    type="button"
                    className="agent-external-result"
                    role="option"
                    aria-selected={index === externalIndex}
                    data-active={String(index === externalIndex)}
                    data-result-index={index}
                    onMouseEnter={() => setExternalIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseExternal(item)}
                  >
                    <span className="agent-external-result-icon"><Bot aria-hidden="true" /></span>
                    <span className="agent-external-result-copy">
                      <strong>{displayText(item.title, t('surface:agentComposer.untitledConversation'))}</strong>
                      <small>{displayText(item.agentId, displayText(item.provider, t('surface:agentComposer.unknownAgent')))} · {displayDate(item.lastMessageAt, formatDate, t('surface:agentComposer.dateUnavailable'))} · {t('surface:agentComposer.messageCount', { count: Number.isFinite(item.messageCount) ? item.messageCount : 0 })}</small>
                      <span>{displayText(item.lastMessageExcerpt, t('surface:agentComposer.noMessagePreview'))}</span>
                    </span>
                  </button>
                ))}
                {externalCursor ? (
                  <button type="button" className="agent-external-load-more" disabled={externalStatus === 'loading-more'} onClick={() => void loadExternal(externalQuery.trim(), externalCursor, true)}>
                    {externalStatus === 'loading-more' ? <LoaderCircle className="spin" aria-hidden="true" /> : null}
                    {t(externalStatus === 'loading-more' ? 'surface:agentComposer.loadingMore' : 'surface:agentComposer.loadMore')}
                  </button>
                ) : null}
                {externalStatus === 'error' ? <div className="agent-external-inline-error" role="alert">{t('surface:agentComposer.couldNotLoadMore')}</div> : null}
              </>
            )}
          </div>
        </section>
      ) : null}
      {pickerOpen ? (
        <div className="agent-composer-popover agent-mention-picker" id="agent-composer-menu" role="listbox" aria-label={t('surface:agentComposer.chooseLocalAgent')}>
          {matchingAgents.map((agent) => (
            <button key={agent.id} type="button" role="option" aria-selected="false" onMouseDown={(event) => event.preventDefault()} onClick={() => selectAgent(agent)}>
              <span className="agent-mention-icon"><Bot aria-hidden="true" /></span>
              <span><strong>{agent.displayName}</strong><small>{agent.version ?? agent.provider}</small></span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="agent-prompt" data-has-attachments={String(attachments.length > 0)}>
        {selectedAgent ? (
          <div className="agent-mention-selection">
            <span><Bot aria-hidden="true" />@{selectedAgent.displayName}</span>
            {selectedAgent.id !== 'main' ? (
              <button type="button" aria-label={t('surface:agentComposer.removeLocalAgent')} title={t('surface:agentComposer.removeLocalAgent')} onClick={() => onSelectAgent(null)}>
                <X aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}
        {selectedExternalConversation ? <div className="agent-external-selection"><span><History />{selectedExternalConversation.provider} · {selectedExternalConversation.title}</span><button type="button" title={t('surface:agentComposer.removeExternalConversation')} aria-label={t('surface:agentComposer.removeExternalConversation')} onClick={() => onSelectExternalConversation(null)}><X /></button></div> : null}
        <textarea
          ref={textareaRef}
          aria-label={t('surface:agentComposer.desktopAiWorkspaceInput')}
          placeholder={active
            ? t('surface:agentComposer.agentIsWorking')
            : available
              ? t('surface:agentComposer.askAboutThisPageOrDescribeAnAction')
              : t('surface:agentComposer.syncingRoomData')}
          rows={2}
          value={value}
          aria-controls={menuOpen ? 'agent-composer-menu' : undefined}
          aria-expanded={menuOpen}
          disabled={!available || active || voiceState === 'saving' || voiceState === 'transcribing'}
          onChange={(event) => {
            setAgentPickerDismissed(false)
            setSlashPickerDismissed(false)
            setCaret(event.target.selectionStart)
            onChange(event.target.value)
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={handleKeyDown}
        />
        {attachments.length > 0 ? (
          <div className="agent-attachments" aria-label={t('surface:agentComposer.localAttachments')}>
            {attachments.map((file) => (
              <span key={file.id} className="agent-attachment">
                <FileText aria-hidden="true" />
                <span title={file.name}>{file.name}</span>
                <small>{formatFileSize(file.size)}</small>
                <button
                  type="button"
                  aria-label={t('surface:agentComposer.removeName', { name: file.name })}
                  title={t('surface:agentComposer.removeAttachment')}
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
            title={t('surface:agentComposer.addAttachment')}
            aria-label={t('surface:agentComposer.addAttachment')}
            disabled={controlsDisabled || voiceBusy}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="agent-prompt-tool agent-prompt-voice"
            data-recording={String(voiceState === 'recording')}
            title={t(voiceState === 'recording' ? 'surface:agentComposer.stopRecording' : 'surface:agentComposer.voiceInput')}
            aria-label={t(voiceState === 'recording' ? 'surface:agentComposer.stopRecording' : 'surface:agentComposer.voiceInput')}
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
              <button type="button" aria-label={t('surface:agentComposer.removeSelectedText')} title={t('surface:agentComposer.removeSelectedText')} onClick={onClearContext}>
                <X aria-hidden="true" />
              </button>
            ) : null}
          </span>
          {active ? (
            <button type="button" className="agent-prompt-submit is-stop" title={t('surface:agentComposer.stop')} aria-label={t('surface:agentComposer.stop')} onClick={onStop}>
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-prompt-submit" title={t('surface:agentComposer.send')} aria-label={t('surface:agentComposer.send')} disabled={!available || (!value.trim() && attachments.length === 0) || loading || voiceBusy}>
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
})
