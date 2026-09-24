import { ArrowLeft, ArrowUp, Bot, Brain, Check, Feather, FileText, FolderOpen, History, LoaderCircle, Plus, Quote, Search, Square, X, Zap } from 'lucide-react'
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
import type { AgentModelPreference, AgentRoomReference, ExternalConversationSummary, LocalAgentInstallation } from '@nxcore/agent-contract'
import type { FileCatalogDto } from '../../../../shared/ingest'

import { showToast } from '@/state/toast'
import { useLocale } from '@/i18n/LocaleContext'
import { SourceIcon } from '@/components/pages/sources/SourceIcon'
import {
  allocateMentionToken,
  findMentionRanges,
  matchMentionTrigger,
  resolveMentions,
  slugifyAgentToken,
  type MentionedItem,
} from './agentMentions'

const ACCEPTED_ATTACHMENTS = '.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.pptx'
const ATTACHMENT_PATTERN = /\.(txt|md|csv|json|pdf|docx|xlsx|pptx)$/i
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
const TEXTAREA_MIN_HEIGHT = 42
const TEXTAREA_MAX_HEIGHT = 180

const MODEL_TIER_META: Record<AgentModelPreference, { icon: typeof Zap; labelKey: string; hintKey: string }> = {
  smart: { icon: Zap, labelKey: 'surface:agentComposer.modelTierSmart', hintKey: 'surface:agentComposer.modelTierSmartHint' },
  primary: { icon: Brain, labelKey: 'surface:agentComposer.modelTierPrimary', hintKey: 'surface:agentComposer.modelTierPrimaryHint' },
  lite: { icon: Feather, labelKey: 'surface:agentComposer.modelTierLite', hintKey: 'surface:agentComposer.modelTierLiteHint' },
}
const MODEL_TIER_ORDER: AgentModelPreference[] = ['smart', 'primary', 'lite']

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
  /** Room 引用候选（@ 弹层「房间」组；AgentPanel 已持有完整列表）。 */
  rooms?: AgentRoomReference[]
  /** 视口在 Context Room 内时展示「聚焦当前房间」开关。 */
  roomFocusVisible?: boolean
  roomFocusEnabled?: boolean
  roomFocusRoomTitle?: string
  onToggleRoomFocus?: (next: boolean) => void
  /** 当前生效档位：会话已存在＝会话锁定档，否则＝全局默认档。 */
  modelPreference: AgentModelPreference
  /** 会话已创建 → 档位锁定在会话上，切换只影响下一个新会话。 */
  modelPreferenceLocked?: boolean
  /** 打开选择器时拉取最新 lite 可用性（设置页保存后无需重启）。 */
  loadModelAvailability: () => Promise<boolean>
  onSelectModelPreference: (tier: AgentModelPreference) => void
  onChange: (value: string) => void
  onSelectExternalConversation: (conversation: ExternalConversationSummary | null) => void
  onClearContext: () => void
  onRemoveContext: (id: string) => void
  onStop: () => void
  onSubmit: (files: File[], mentioned: MentionedItem[]) => void
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
  rooms = [],
  roomFocusVisible = false,
  roomFocusEnabled = false,
  roomFocusRoomTitle,
  onToggleRoomFocus,
  modelPreference,
  modelPreferenceLocked = false,
  loadModelAvailability,
  onSelectModelPreference,
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
  const [mentionFiles, setMentionFiles] = useState<Array<{ id: string; title: string; detail: string }>>([])
  const [mentionConversations, setMentionConversations] = useState<ExternalConversationSummary[]>([])
  const [mentionSourcesLoading, setMentionSourcesLoading] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [liteAvailable, setLiteAvailable] = useState(false)
  const [caret, setCaret] = useState(0)
  const overlayRef = useRef<HTMLDivElement>(null)
  const mentionHints = useRef(new Map<string, MentionedItem>())

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
    setModelPickerOpen(false)
    mentionHints.current.clear()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetKey])

  useEffect(() => {
    if (!externalPickerOpen && !agentPickerOpen && !modelPickerOpen) return undefined
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (shellRef.current?.contains(event.target as Node)) return
      externalRequestRef.current += 1
      setExternalPickerOpen(false)
      setAgentPickerOpen(false)
      setModelPickerOpen(false)
    }
    document.addEventListener?.('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener?.('pointerdown', closeOnOutsidePress)
  }, [externalPickerOpen, agentPickerOpen, modelPickerOpen])

  const submitMentions = () => resolveMentions(value, mentionHints.current, localAgents)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (available) onSubmit(attachments.map(({ file }) => file), submitMentions())
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (modelPickerOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setModelPickerOpen(false)
      }
      return
    }
    if (agentPickerOpen) {
      if (event.key === 'ArrowDown' && mentionOptions.length) {
        event.preventDefault()
        setAgentIndex((current) => Math.min(mentionOptions.length - 1, current + 1))
        return
      }
      if (event.key === 'ArrowUp' && mentionOptions.length) {
        event.preventDefault()
        setAgentIndex((current) => Math.max(0, current - 1))
        return
      }
      if (event.key === 'Enter' && !composingRef.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        const option = mentionOptions[Math.min(agentIndex, mentionOptions.length - 1)]
        if (option) {
          event.preventDefault()
          chooseMentionOption(option)
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
  const chooseAgent = (item: { id: string; displayName: string }) => {
    const token = allocateMentionToken(item.displayName, item.id, mentionHints.current)
    applyMentionToken(token, { kind: 'agent', id: item.id, displayName: item.displayName })
  }
  const applyMentionToken = (token: string, item: MentionedItem) => {
    const replaceStart = mentionTrigger?.replaceStart ?? caret
    const nextValue = `${value.slice(0, replaceStart)}@${token} ${value.slice(caret)}`
    mentionHints.current.set(token.toLocaleLowerCase(), item)
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
  const chooseRoom = (room: AgentRoomReference) => {
    const token = allocateMentionToken(room.title, room.id, mentionHints.current)
    applyMentionToken(token, { kind: 'room', id: room.id, displayName: room.title })
  }
  const chooseFile = (file: { id: string; title: string }) => {
    const token = allocateMentionToken(file.title, file.id, mentionHints.current)
    applyMentionToken(token, { kind: 'file', id: file.id, displayName: file.title })
  }
  const chooseConversation = (conversation: ExternalConversationSummary) => {
    const token = allocateMentionToken(conversation.title, conversation.id, mentionHints.current)
    applyMentionToken(token, { kind: 'conversation', id: conversation.id, displayName: conversation.title })
  }
  const openModelPicker = () => {
    setSlashPickerDismissed(true)
    externalRequestRef.current += 1
    setExternalPickerOpen(false)
    setAgentPickerOpen(false)
    setModelPickerOpen(true)
    // 每次打开时刷新：设置页保存轻量模型后无需重启即可出现 lite 档。
    loadModelAvailability().then(setLiteAvailable, () => setLiteAvailable(false))
  }
  const chooseModelTier = (tier: AgentModelPreference) => {
    onSelectModelPreference(tier)
    setModelPickerOpen(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const callableLocalAgents = localAgents.filter((agent) => agent.invocationSupported && agent.callable)
  const agentQueryNormalized = mentionQuery.trim().toLocaleLowerCase()
  const matchesQuery = (haystack: string) => !agentQueryNormalized || haystack.toLocaleLowerCase().includes(agentQueryNormalized)
  const filteredAgentItems = agentQueryNormalized
    ? callableLocalAgents.filter((item) => item.displayName.toLocaleLowerCase().includes(agentQueryNormalized)
      || item.id.toLocaleLowerCase().includes(agentQueryNormalized)
      || item.provider.toLocaleLowerCase().includes(agentQueryNormalized))
    : callableLocalAgents
  const filteredRoomItems = rooms.filter((room) => matchesQuery(room.title) || matchesQuery(room.id))
  const filteredFileItems = mentionFiles.filter((file) => matchesQuery(file.title) || matchesQuery(file.id) || matchesQuery(file.detail))
  const filteredConversationItems = mentionConversations.filter((conversation) => matchesQuery(conversation.title)
    || matchesQuery(conversation.provider))
  const mentionOptionCount = filteredAgentItems.length + filteredRoomItems.length
    + filteredFileItems.length + filteredConversationItems.length
  type MentionOption =
    | { kind: 'agent'; item: LocalAgentInstallation }
    | { kind: 'room'; item: AgentRoomReference }
    | { kind: 'file'; item: { id: string; title: string; detail: string } }
    | { kind: 'conversation'; item: ExternalConversationSummary }
  const mentionOptions: MentionOption[] = [
    ...filteredAgentItems.map((item) => ({ kind: 'agent' as const, item })),
    ...filteredRoomItems.map((item) => ({ kind: 'room' as const, item })),
    ...filteredFileItems.map((item) => ({ kind: 'file' as const, item })),
    ...filteredConversationItems.map((item) => ({ kind: 'conversation' as const, item })),
  ]
  const chooseMentionOption = (option: MentionOption) => {
    if (option.kind === 'agent') chooseAgent(option.item)
    else if (option.kind === 'room') chooseRoom(option.item)
    else if (option.kind === 'file') chooseFile(option.item)
    else chooseConversation(option.item)
  }
  // 弹层打开时懒加载文件与对话记录（Agent/Room 由 props 同步提供）。
  useEffect(() => {
    if (!agentPickerOpen || mentionSourcesLoading) return
    setMentionSourcesLoading(true)
    const loadMentionSource = <T,>(promise: Promise<T> | undefined, fallback: T): Promise<T> =>
      promise?.catch(() => fallback) ?? Promise.resolve(fallback)
    void Promise.all([
      loadMentionSource(
        window.nxcore?.files?.list(30).then((page) => page?.items ?? []),
        [] as FileCatalogDto[],
      ),
      loadMentionSource(
        window.nxcore?.migrations?.conversations({ limit: 20 }).then((page) => page?.items ?? []),
        [] as ExternalConversationSummary[],
      ),
    ]).then(([fileItems, conversationItems]) => {
      setMentionFiles(fileItems.map((file) => ({
        id: file.id,
        title: file.displayName ?? file.sharedTitle ?? file.originalName,
        detail: file.processingState === 'ready' ? '' : file.processingState,
      })))
      setMentionConversations(conversationItems)
    }).finally(() => setMentionSourcesLoading(false))
  }, [agentPickerOpen])
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
      nodes.push(<span key={`agent-mention-${index}`} className="agent-mention-token" data-kind={range.item.kind}>@{range.token}</span>)
      cursor = range.end
    })
    if (cursor < value.length) nodes.push(value.slice(cursor))
    return nodes
  }

  const menuOpen = slashPickerOpen || externalPickerOpen || agentPickerOpen || modelPickerOpen
  const activeTierMeta = MODEL_TIER_META[modelPreference]
  const ActiveTierIcon = activeTierMeta.icon
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
          {mentionOptionCount === 0 ? (
            <div className="agent-mention-empty">{t('surface:agentComposer.noMentionMatches')}</div>
          ) : (
            <>
              {filteredAgentItems.length ? (
                <div className="agent-mention-group-label"><Bot aria-hidden="true" />{t('surface:agentComposer.mentionGroupAgents')}</div>
              ) : null}
              {filteredAgentItems.map((item, index) => (
                <button
                  key={`agent:${item.id}`}
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
              ))}
              {filteredRoomItems.length ? (
                <div className="agent-mention-group-label"><FolderOpen aria-hidden="true" />{t('surface:agentComposer.mentionGroupRooms')}</div>
              ) : null}
              {filteredRoomItems.map((room) => {
                const index = mentionOptions.findIndex((option) => option.kind === 'room' && option.item.id === room.id)
                return (
                  <button
                    key={`room:${room.id}`}
                    type="button"
                    className="agent-mention-option"
                    role="option"
                    aria-selected={index === agentIndex}
                    data-active={String(index === agentIndex)}
                    data-result-index={index}
                    onMouseEnter={() => setAgentIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseRoom(room)}
                  >
                    <strong>{room.title}</strong>
                    {room.kind ? <small>{room.kind}</small> : null}
                  </button>
                )
              })}
              {filteredFileItems.length ? (
                <div className="agent-mention-group-label"><FileText aria-hidden="true" />{t('surface:agentComposer.mentionGroupFiles')}</div>
              ) : null}
              {filteredFileItems.map((file) => {
                const index = mentionOptions.findIndex((option) => option.kind === 'file' && option.item.id === file.id)
                return (
                  <button
                    key={`file:${file.id}`}
                    type="button"
                    className="agent-mention-option"
                    role="option"
                    aria-selected={index === agentIndex}
                    data-active={String(index === agentIndex)}
                    data-result-index={index}
                    onMouseEnter={() => setAgentIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseFile(file)}
                  >
                    <strong>{file.title}</strong>
                    {file.detail ? <small>{file.detail}</small> : null}
                  </button>
                )
              })}
              {filteredConversationItems.length ? (
                <div className="agent-mention-group-label"><History aria-hidden="true" />{t('surface:agentComposer.mentionGroupConversations')}</div>
              ) : null}
              {filteredConversationItems.map((conversation) => {
                const index = mentionOptions.findIndex((option) => option.kind === 'conversation' && option.item.id === conversation.id)
                return (
                  <button
                    key={`conversation:${conversation.id}`}
                    type="button"
                    className="agent-mention-option"
                    role="option"
                    aria-selected={index === agentIndex}
                    data-active={String(index === agentIndex)}
                    data-result-index={index}
                    onMouseEnter={() => setAgentIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseConversation(conversation)}
                  >
                    <strong>{displayText(conversation.title, t('surface:agentComposer.untitledConversation'))}</strong>
                    <small>{conversation.provider} · {t('surface:agentComposer.messageCount', { count: Number.isFinite(conversation.messageCount) ? conversation.messageCount : 0 })}</small>
                  </button>
                )
              })}
            </>
          )}
        </div>
      ) : null}
      {modelPickerOpen ? (
        <section className="agent-composer-popover agent-model-picker" id="agent-composer-menu" role="listbox" aria-label={t('surface:agentComposer.modelPickerTitle')}>
          {MODEL_TIER_ORDER
            .filter((tier) => tier !== 'lite' || liteAvailable)
            .map((tier) => {
              const meta = MODEL_TIER_META[tier]
              const TierIcon = meta.icon
              return (
                <button
                  key={tier}
                  type="button"
                  className="agent-model-option"
                  role="option"
                  aria-selected={modelPreference === tier}
                  data-active={String(modelPreference === tier)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseModelTier(tier)}
                >
                  <span className="agent-picker-header-icon"><TierIcon aria-hidden="true" /></span>
                  <span><strong>{t(meta.labelKey)}</strong><small>{t(meta.hintKey)}</small></span>
                  {modelPreference === tier ? <Check aria-hidden="true" /> : null}
                </button>
              )
            })}
          {modelPreferenceLocked ? (
            <footer className="agent-model-picker-hint">{t('surface:agentComposer.modelPickerApplyToNext')}</footer>
          ) : null}
        </section>
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
          <button
            type="button"
            className="agent-model-tier-toggle"
            data-tier={modelPreference}
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
            title={t('surface:agentComposer.modelPickerTitle')}
            disabled={controlsDisabled}
            onClick={() => (modelPickerOpen ? setModelPickerOpen(false) : openModelPicker())}
          >
            <ActiveTierIcon aria-hidden="true" />
            <span>{t(activeTierMeta.labelKey)}</span>
          </button>
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
