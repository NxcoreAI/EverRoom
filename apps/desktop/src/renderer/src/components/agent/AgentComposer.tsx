import { ArrowLeft, ArrowUp, FileText, History, LoaderCircle, Plus, Quote, Search, Square, X } from 'lucide-react'
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
  type ReactNode,
} from 'react'
import type { ExternalConversationSummary, LocalAgentInstallation } from '@nxcore/agent-contract'

import { showToast } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon } from '@/components/pages/sources/SourceIcon'
import {
  findMentionRanges,
  matchMentionTrigger,
  resolveMentions,
  slugifyAgentToken,
  type MentionedAgent,
} from './agentMentions'

const ACCEPTED_ATTACHMENTS = '.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx'
const ATTACHMENT_PATTERN = /\.(txt|md|csv|json|pdf|docx|xlsx|pptx)$/i
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
const TEXTAREA_MIN_HEIGHT = 42
const TEXTAREA_MAX_HEIGHT = 180

type ExternalPickerStatus = 'idle' | 'loading' | 'ready' | 'loading-more' | 'error'

interface LocalAttachment {
  id: string
  file: File
  name: string
  size: number
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
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
  contextItems: Array<{ id: string; label: string; detail: string }>
  hasSelectedText: boolean
  /** 有可提交的上下文（引用/选区）时空输入也允许发送；缺省视为无。 */
  hasSubmittableContext?: boolean
  resetKey: number
  value: string
  active: boolean
  available: boolean
  loading: boolean
  selectedExternalConversation: ExternalConversationSummary | null
  /** 本机已发现的 CLI Agent 候选（@ 点名弹层数据源）。 */
  localAgents: LocalAgentInstallation[]
  /** 视口在 Context Room 内时展示「聚焦当前房间」开关。 */
  roomFocusVisible?: boolean
  roomFocusEnabled?: boolean
  roomFocusRoomTitle?: string
  onToggleRoomFocus?: (next: boolean) => void
  onChange: (value: string) => void
  onSelectExternalConversation: (conversation: ExternalConversationSummary | null) => void
  onClearContext: () => void
  onRemoveContext: (id: string) => void
  onStop: () => void
  onSubmit: (files: File[], mentionedAgents: MentionedAgent[]) => void
}>(function AgentComposer({
  active,
  available,
  contextSummary,
  contextItems,
  hasSelectedText,
  hasSubmittableContext = false,
  loading,
  resetKey,
  selectedExternalConversation,
  localAgents,
  roomFocusVisible = false,
  roomFocusEnabled = false,
  roomFocusRoomTitle,
  onToggleRoomFocus,
  value,
  onChange,
  onClearContext,
  onRemoveContext,
  onStop,
  onSubmit,
  onSelectExternalConversation,
}, ref) {
  const { t, formatDate } = useLocale()
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const shellRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const externalResultsRef = useRef<HTMLDivElement>(null)
  const agentResultsRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef(true)
  const composingRef = useRef(false)
  const externalRequestRef = useRef(0)
  const [slashPickerDismissed, setSlashPickerDismissed] = useState(false)
  const [externalPickerOpen, setExternalPickerOpen] = useState(false)
  const [externalQuery, setExternalQuery] = useState('')
  const [externalItems, setExternalItems] = useState<ExternalConversationSummary[]>([])
  const [externalCursor, setExternalCursor] = useState<string | null>(null)
  const [externalIndex, setExternalIndex] = useState(0)
  const [externalStatus, setExternalStatus] = useState<ExternalPickerStatus>('idle')
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [agentIndex, setAgentIndex] = useState(0)
  const [caret, setCaret] = useState(0)
  const overlayRef = useRef<HTMLDivElement>(null)
  const mentionHints = useRef(new Map<string, string>())

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
    if (overlayRef.current) overlayRef.current.scrollTop = textarea.scrollTop
  }

  useLayoutEffect(() => {
    resizeTextarea()
  }, [attachments.length, contextItems.length, value])

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

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    setAttachments([])
    setSlashPickerDismissed(false)
    setExternalPickerOpen(false)
    externalRequestRef.current += 1
    setAgentPickerOpen(false)
    mentionHints.current.clear()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetKey])

  useEffect(() => {
    if (!externalPickerOpen && !agentPickerOpen) return undefined
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (shellRef.current?.contains(event.target as Node)) return
      externalRequestRef.current += 1
      setExternalPickerOpen(false)
      setAgentPickerOpen(false)
    }
    document.addEventListener?.('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener?.('pointerdown', closeOnOutsidePress)
  }, [externalPickerOpen, agentPickerOpen])

  const submitMentions = () => resolveMentions(value, mentionHints.current, localAgents)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (available) onSubmit(attachments.map(({ file }) => file), submitMentions())
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (agentPickerOpen) {
      if (event.key === 'ArrowDown' && filteredAgentItems.length) {
        event.preventDefault()
        setAgentIndex((current) => Math.min(filteredAgentItems.length - 1, current + 1))
        return
      }
      if (event.key === 'ArrowUp' && filteredAgentItems.length) {
        event.preventDefault()
        setAgentIndex((current) => Math.max(0, current - 1))
        return
      }
      if (event.key === 'Enter' && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        const item = filteredAgentItems[Math.min(agentIndex, filteredAgentItems.length - 1)]
        if (item) {
          event.preventDefault()
          chooseAgent(item)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setAgentPickerOpen(false)
        return
      }
      return
    }
    if (externalPickerOpen) return
    if (event.key === 'Enter' && (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) return
    if (slashPickerOpen && ['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); return }
    if (slashPickerOpen && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault(); openExternalPicker(); return
    }
    if (event.key === 'Escape' && slashPickerOpen) { event.preventDefault(); setSlashPickerDismissed(true); return }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (available) onSubmit(attachments.map(({ file }) => file), submitMentions())
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

  const mentionTrigger = matchMentionTrigger(value, caret)
  const mentionQuery = mentionTrigger?.query.toLocaleLowerCase() ?? ''
  const firstLineEnd = value.indexOf('\n') < 0 ? value.length : value.indexOf('\n')
  const slashMatch = /^\/([^\s\n]*)/u.exec(value)
  const slashQuery = slashMatch?.[1]?.toLocaleLowerCase() ?? ''
  const commandMatches = !slashQuery || 'continue'.startsWith(slashQuery)
  const slashPickerOpen = Boolean(slashMatch && commandMatches && caret <= firstLineEnd && !slashPickerDismissed && !externalPickerOpen && !mentionTrigger)
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
  const chooseAgent = (item: LocalAgentInstallation) => {
    const token = slugifyAgentToken(item.displayName)
    const replaceStart = mentionTrigger?.replaceStart ?? caret
    const nextValue = `${value.slice(0, replaceStart)}@${token} ${value.slice(caret)}`
    mentionHints.current.set(token.toLocaleLowerCase(), item.id)
    const nextCaret = replaceStart + token.length + 2
    onChange(nextValue)
    setCaret(nextCaret)
    setAgentPickerOpen(false)
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextCaret, nextCaret)
    })
  }
  const callableLocalAgents = localAgents.filter((agent) => agent.invocationSupported && agent.callable)
  const agentQueryNormalized = mentionQuery.trim().toLocaleLowerCase()
  const filteredAgentItems = agentQueryNormalized
    ? callableLocalAgents.filter((item) => item.displayName.toLocaleLowerCase().includes(agentQueryNormalized)
      || item.id.toLocaleLowerCase().includes(agentQueryNormalized)
      || item.provider.toLocaleLowerCase().includes(agentQueryNormalized))
    : callableLocalAgents
  useEffect(() => {
    if (!mentionTrigger || agentPickerOpen) return
    setAgentPickerOpen(true)
    setSlashPickerDismissed(true)
  }, [mentionTrigger?.replaceStart, mentionTrigger?.query, agentPickerOpen])

  useEffect(() => {
    if (agentPickerOpen && !mentionTrigger) setAgentPickerOpen(false)
  }, [agentPickerOpen, mentionTrigger])

  useEffect(() => {
    if (agentPickerOpen) setAgentIndex(0)
  }, [agentPickerOpen, mentionQuery])

  useEffect(() => {
    if (!agentPickerOpen) return
    agentResultsRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${agentIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [agentIndex, filteredAgentItems[agentIndex]?.id, agentPickerOpen])

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

  const mentionRanges = findMentionRanges(value, mentionHints.current, localAgents)
  const renderOverlaySegments = (): ReactNode[] => {
    const nodes: ReactNode[] = []
    let cursor = 0
    mentionRanges.forEach((range, index) => {
      if (range.start > cursor) nodes.push(value.slice(cursor, range.start))
      nodes.push(<span key={`agent-mention-${index}`} className="agent-mention-token">@{range.token}</span>)
      cursor = range.end
    })
    if (cursor < value.length) nodes.push(value.slice(cursor))
    return nodes
  }

  const menuOpen = slashPickerOpen || externalPickerOpen || agentPickerOpen
  // 会话快照加载时保留本地附件。
  const controlsDisabled = active || !available

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
          <button type="button" role="option" aria-selected="true" onMouseDown={(event) => event.preventDefault()} onClick={() => openExternalPicker()}>
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
                    <span className="agent-external-result-icon"><SourceIcon kind={item.provider === 'claude' || item.provider === 'codex' || item.provider === 'openclaw' ? item.provider : 'openclaw'} /></span>
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
      {agentPickerOpen ? (
        <div ref={agentResultsRef} className="agent-composer-popover agent-mention-list" id="agent-composer-menu" role="listbox" aria-label={t('surface:agentComposer.mentionAgent')}>
          {filteredAgentItems.length === 0 ? (
            <div className="agent-mention-empty">{t(callableLocalAgents.length === 0 ? 'surface:agentComposer.noAgents' : 'surface:agentComposer.noAgentMatches')}</div>
          ) : (
            filteredAgentItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="agent-mention-option"
                role="option"
                aria-selected={index === agentIndex}
                data-active={String(index === agentIndex)}
                data-result-index={index}
                onMouseEnter={() => setAgentIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseAgent(item)}
              >
                <strong>{item.displayName}</strong>
              </button>
            ))
          )}
        </div>
      ) : null}
      <div className="agent-prompt" data-has-attachments={String(attachments.length > 0)}>
        {selectedExternalConversation ? <div className="agent-external-selection"><span><History />{t('surface:agentComposer.referencedConversation')} · {selectedExternalConversation.title}</span><button type="button" title={t('surface:agentComposer.removeExternalConversation')} aria-label={t('surface:agentComposer.removeExternalConversation')} onClick={() => onSelectExternalConversation(null)}><X /></button></div> : null}
        {contextItems.length > 0 ? (
          <div className="agent-context-citations" aria-label={t('surface:agentComposer.referencedRoomContent')}>
            {contextItems.map((item) => (
              <span key={item.id} className="agent-context-citation" title={item.detail}>
                <Quote aria-hidden="true" />
                <span>{item.label}</span>
                <button
                  type="button"
                  aria-label={t('surface:agentComposer.removeReference')}
                  title={t('surface:agentComposer.removeReference')}
                  onClick={() => onRemoveContext(item.id)}
                >
                  <X aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="agent-composer-input">
          <div ref={overlayRef} className="agent-composer-overlay" aria-hidden="true">
            {renderOverlaySegments()}
          </div>
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
            disabled={!available || active}
            onChange={(event) => {
              setSlashPickerDismissed(false)
              setCaret(event.target.selectionStart)
              onChange(event.target.value)
            }}
            onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
            onScroll={(event) => {
              if (overlayRef.current) overlayRef.current.scrollTop = event.currentTarget.scrollTop
            }}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={handleKeyDown}
          />
        </div>
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
            disabled={controlsDisabled}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus aria-hidden="true" />
          </button>
          {roomFocusVisible && onToggleRoomFocus ? (
            <button
              type="button"
              className="agent-room-focus-toggle"
              data-active={String(roomFocusEnabled)}
              aria-pressed={roomFocusEnabled}
              title={t('surface:agentComposer.roomFocusTitle')}
              disabled={controlsDisabled}
              onClick={() => onToggleRoomFocus(!roomFocusEnabled)}
            >
              {roomFocusRoomTitle ? <span className="agent-room-focus-name">{roomFocusRoomTitle}</span> : null}
              <span>{roomFocusEnabled ? t('surface:agentComposer.roomFocusOn') : t('surface:agentComposer.roomFocusOff')}</span>
            </button>
          ) : null}
          <span className="agent-composer-context" title={contextSummary}>
            <span>{contextSummary}</span>
            {hasSelectedText ? (
              <button type="button" aria-label={t('surface:agentComposer.clearAllReferences')} title={t('surface:agentComposer.clearAllReferences')} onClick={onClearContext}>
                <X aria-hidden="true" />
              </button>
            ) : null}
          </span>
          {active ? (
            <button type="button" className="agent-prompt-submit is-stop" title={t('surface:agentComposer.stop')} aria-label={t('surface:agentComposer.stop')} onClick={onStop}>
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button type="submit" className="agent-prompt-submit" title={t('surface:agentComposer.send')} aria-label={t('surface:agentComposer.send')} disabled={!available || (!value.trim() && attachments.length === 0 && !hasSubmittableContext) || loading}>
              <ArrowUp aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </form>
  )
})
