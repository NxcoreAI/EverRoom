import { ArrowUp, FileText, LoaderCircle, Plus, Square, X } from 'lucide-react'
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react'

import type { AgentAttachmentReference } from '@nxcore/agent-contract'
import { showToast } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'

const ACCEPTED_ATTACHMENTS = '.txt,.md,.csv,.docx,.xlsx,.pptx,.html,.htm,.gif,.jpeg,.jpg,.png,.webp'
const ACCEPTED_ATTACHMENT_PATTERN = /\.(txt|md|csv|docx|xlsx|pptx|html?|gif|jpe?g|png|webp)$/i
const TEXTAREA_MIN_HEIGHT = 42
const TEXTAREA_MAX_HEIGHT = 180

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export const AgentComposer = forwardRef<HTMLTextAreaElement, {
  contextSummary: string
  hasSelectedText: boolean
  resetKey: number
  value: string
  active: boolean
  available: boolean
  loading: boolean
  onChange: (value: string) => void
  onClearContext: () => void
  onStop: () => void
  onSubmit: (attachments: AgentAttachmentReference[]) => void
}>(function AgentComposer({
  active,
  available,
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
  const { t } = useLocale()
  const [attachments, setAttachments] = useState<AgentAttachmentReference[]>([])
  const [importing, setImporting] = useState(false)
  const [dragging, setDragging] = useState(false)
  const shellRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composingRef = useRef(false)

  useImperativeHandle(ref, () => textareaRef.current as HTMLTextAreaElement)

  const resizeTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    const stickToBottom = document.activeElement === textarea && textarea.selectionEnd === textarea.value.length
    const previousScrollTop = textarea.scrollTop
    textarea.style.height = '0px'
    const contentHeight = textarea.scrollHeight
    const nextHeight = Math.min(TEXTAREA_MAX_HEIGHT, Math.max(TEXTAREA_MIN_HEIGHT, contentHeight))
    textarea.style.height = `${nextHeight}px`
    textarea.dataset.scrollable = String(contentHeight > TEXTAREA_MAX_HEIGHT)
    textarea.scrollTop = stickToBottom ? textarea.scrollHeight : previousScrollTop
  }

  useLayoutEffect(() => resizeTextarea(), [attachments.length, value])

  useEffect(() => {
    const shell = shellRef.current
    const prompt = shell?.querySelector<HTMLElement>('.agent-prompt')
    const frame = shell?.parentElement
    if (!shell || !prompt || !frame) return undefined
    const syncHeight = () => frame.style.setProperty('--agent-composer-height', `${shell.getBoundingClientRect().height}px`)
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

  useEffect(() => {
    setAttachments([])
    setDragging(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetKey])

  const addFiles = async (files: File[]) => {
    const pendingFiles = files
      .filter((file) => ACCEPTED_ATTACHMENT_PATTERN.test(file.name))
      .slice(0, Math.max(0, 5 - attachments.length))
    if (!pendingFiles.length || importing || !window.nxcore?.files) return
    setImporting(true)
    try {
      const imported = await window.nxcore.files.importAgentAttachments(pendingFiles)
      setAttachments((current) => {
        const known = new Set(current.map((item) => item.fileId))
        return [...current, ...imported.filter((item) => !known.has(item.fileId))].slice(0, 5)
      })
      if (imported.length) showToast({
        title: t('surface:agentComposer.attachmentsAddedToTheComposer'),
        message: t('surface:agentComposer.attachmentsReadyForTheAgent'),
      })
    } catch (error) {
      showToast({
        title: t('surface:agentComposer.someAttachmentsWereNotAdded'),
        message: error instanceof Error ? error.message : t('surface:agentComposer.onlySupportedDocumentFormatsUpTo10Mb'),
      })
    } finally {
      setImporting(false)
    }
  }

  const selectAttachments = (event: ChangeEvent<HTMLInputElement>) => {
    void addFiles([...(event.target.files ?? [])])
    event.target.value = ''
  }

  const handleDrop = (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault()
    setDragging(false)
    void addFiles([...event.dataTransfer.files])
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (available && !active && !importing && (value.trim() || attachments.length)) onSubmit(attachments)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    event.preventDefault()
    if (available && !active && !importing && (value.trim() || attachments.length)) onSubmit(attachments)
  }

  const controlsDisabled = active || !available || importing
  const canSubmit = Boolean(value.trim() || attachments.length)

  return (
    <form
      ref={shellRef}
      className="agent-composer-shell"
      data-dragging={String(dragging)}
      onSubmit={submit}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <div className="agent-prompt" data-has-attachments={String(attachments.length > 0)}>
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
          disabled={!available || active || importing}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onKeyDown={handleKeyDown}
        />
        {attachments.length > 0 ? (
          <div className="agent-attachments" aria-label={t('surface:agentComposer.localAttachments')}>
            {attachments.map((file) => (
              <span key={file.fileId} className="agent-attachment">
                <FileText aria-hidden="true" />
                <span title={file.filename}>{file.filename}</span>
                <small>{formatFileSize(file.size)}</small>
                <button
                  type="button"
                  aria-label={t('surface:agentComposer.removeName', { name: file.filename })}
                  title={t('surface:agentComposer.removeAttachment')}
                  onClick={() => setAttachments((current) => current.filter((item) => item.fileId !== file.fileId))}
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
            disabled={controlsDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            {importing ? <LoaderCircle className="spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
          </button>
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
            <button type="submit" className="agent-prompt-submit" title={t('surface:agentComposer.send')} aria-label={t('surface:agentComposer.send')} disabled={!available || !canSubmit || loading || importing}>
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
})
