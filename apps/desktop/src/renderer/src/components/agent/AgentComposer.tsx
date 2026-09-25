import { ArrowLeft, ArrowUp, Bot, Brain, Check, Feather, FileText, FolderOpen, History, LoaderCircle, MessagesSquare, Plus, Quote, Search, Square, Terminal, X, Zap } from 'lucide-react'
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
import type { AgentContextUsage, AgentModelPreference, AgentRoomReference, AgentSession, ExternalConversationSummary, LocalAgentInstallation, MigrationProvider } from '@nxcore/agent-contract'
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
type MentionCategory = 'all' | 'agent' | 'room' | 'file' | 'conversation'

/** @ 弹层「对话记录」条目：导入的外部会话 + 本应用自有会话（provider 'everroom'）。 */
interface MentionConversationItem {
  id: string
  title: string | null
  provider: MigrationProvider | 'everroom'
  messageCount: number | null
  occurredAt: string | null
}

const MENTION_CONVERSATION_LIMIT = 200

const mentionConversationTime = (value: string | null): number => {
  const parsed = Date.parse(value ?? '')
  return Number.isNaN(parsed) ? 0 : parsed
}

function mergeMentionConversations(
  native: MentionConversationItem[],
  imported: MentionConversationItem[],
): MentionConversationItem[] {
  return [...native, ...imported]
    .sort((a, b) => mentionConversationTime(b.occurredAt) - mentionConversationTime(a.occurredAt))
    .slice(0, MENTION_CONVERSATION_LIMIT)
}

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

/** token 数紧凑显示：<1000 原样，否则 K 单位（40960→"41K"，150000→"150K"）。 */
function formatContextTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${Math.round(tokens / 1000)}K`
}

/** 圆环周长（r=5.5）。 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 5.5

/** 占用构成占比：<10% 保留一位小数，否则取整。 */
function formatContextPercent(percent: number): string {
  return percent >= 9.95 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`
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
  /** 实时上下文用量（context.usage 事件快照；缺省=未知，不渲染）。 */
  contextUsage?: AgentContextUsage | null
  /** 上下文压缩进行中（渲染动效提示）。 */
  contextCompacting?: boolean
  /** 会话已创建 → 档位锁定在会话上，切换只影响下一个新会话。 */
  modelPreferenceLocked?: boolean
  /** 打开选择器时拉取最新 lite 可用性（设置页保存后无需重启）。 */
  loadModelAvailability: () => Promise<boolean>
  onSelectModelPreference: (tier: AgentModelPreference) => void
  /** 当前生效渠道：会话已存在＝会话锁定渠道，否则＝全局默认（null=档位模式）。 */
  channelAgentId?: string | null
  /** 选择本机 CLI Agent 渠道（整个新会话由其连续执行）；null=回到档位模式。 */
  onSelectChannelAgent?: (agentId: string | null) => void
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
  contextUsage = null,
  contextCompacting = false,
  loadModelAvailability,
  onSelectModelPreference,
  channelAgentId = null,
  onSelectChannelAgent,
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
  const [mentionConversations, setMentionConversations] = useState<MentionConversationItem[]>([])
  const [conversationServerQuery, setConversationServerQuery] = useState('')
  const [mentionSourcesLoading, setMentionSourcesLoading] = useState(false)
  const [mentionCategory, setMentionCategory] = useState<MentionCategory>('all')
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [contextPanelOpen, setContextPanelOpen] = useState(false)
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
    setContextPanelOpen(false)
    mentionHints.current.clear()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [resetKey])

  useEffect(() => {
    if (!externalPickerOpen && !agentPickerOpen && !modelPickerOpen && !contextPanelOpen) return undefined
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (shellRef.current?.contains(event.target as Node)) return
      externalRequestRef.current += 1
      setExternalPickerOpen(false)
      setAgentPickerOpen(false)
      setModelPickerOpen(false)
      setContextPanelOpen(false)
    }
    document.addEventListener?.('pointerdown', closeOnOutsidePress)
    return () => document.removeEventListener?.('pointerdown', closeOnOutsidePress)
  }, [externalPickerOpen, agentPickerOpen, modelPickerOpen, contextPanelOpen])

  const submitMentions = () => resolveMentions(value, mentionHints.current, localAgents)

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (available) onSubmit(attachments.map(({ file }) => file), submitMentions())
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape' && contextPanelOpen) {
      event.preventDefault()
      setContextPanelOpen(false)
      return
    }
    if (modelPickerOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setModelPickerOpen(false)
      }
      return
    }
    if (agentPickerOpen) {
      if (event.key === 'Tab') {
        // Tab / Shift+Tab 在有内容的分类间循环切换（含「全部」）。
        event.preventDefault()
        cycleMentionCategory(event.shiftKey ? -1 : 1)
        return
      }
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
  const chooseConversation = (conversation: MentionConversationItem) => {
    const displayName = conversation.title ?? t('surface:agentComposer.untitledConversation')
    const token = allocateMentionToken(displayName, conversation.id, mentionHints.current)
    applyMentionToken(token, { kind: 'conversation', id: conversation.id, displayName, provider: conversation.provider })
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
    // 渠道生效时点档位＝退出渠道，回到档位模式。
    if (channelAgentId) onSelectChannelAgent?.(null)
    onSelectModelPreference(tier)
    setModelPickerOpen(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }
  const chooseChannelAgent = (agentId: string) => {
    onSelectChannelAgent?.(agentId)
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
  // 查询词与当前服务端检索一致时，导入条目已按 FTS 命中（含消息正文），
  // 不再做客户端标题过滤以免误杀；应用自有会话仍走客户端过滤。
  const conversationQueryServerFiltered = conversationServerQuery !== '' && conversationServerQuery === mentionQuery.trim()
  const filteredConversationItems = mentionConversations.filter((conversation) => {
    if (conversationQueryServerFiltered && conversation.provider !== 'everroom') return true
    return matchesQuery(conversation.title ?? '')
      || matchesQuery(conversation.provider)
  })
  const mentionCategoryTabs: Array<{ id: MentionCategory; labelKey: string; count: number }> = [
    { id: 'all', labelKey: 'surface:agentComposer.mentionTabAll', count: filteredAgentItems.length + filteredRoomItems.length + filteredFileItems.length + filteredConversationItems.length },
    { id: 'agent', labelKey: 'surface:agentComposer.mentionGroupAgents', count: filteredAgentItems.length },
    { id: 'room', labelKey: 'surface:agentComposer.mentionGroupRooms', count: filteredRoomItems.length },
    { id: 'file', labelKey: 'surface:agentComposer.mentionGroupFiles', count: filteredFileItems.length },
    { id: 'conversation', labelKey: 'surface:agentComposer.mentionGroupConversations', count: filteredConversationItems.length },
  ]
  const showMentionGroup = (kind: Exclude<MentionCategory, 'all'>) => mentionCategory === 'all' || mentionCategory === kind
  const cycleMentionCategory = (step: 1 | -1) => {
    const order = mentionCategoryTabs.filter((tab) => tab.count > 0).map((tab) => tab.id)
    if (order.length < 2) return
    const current = order.includes(mentionCategory) ? order.indexOf(mentionCategory) : 0
    setMentionCategory(order[(current + step + order.length) % order.length]!)
    setAgentIndex(0)
  }
  type MentionOption =
    | { kind: 'agent'; item: LocalAgentInstallation }
    | { kind: 'room'; item: AgentRoomReference }
    | { kind: 'file'; item: { id: string; title: string; detail: string } }
    | { kind: 'conversation'; item: MentionConversationItem }
  const mentionOptions: MentionOption[] = [
    ...(showMentionGroup('agent') ? filteredAgentItems.map((item) => ({ kind: 'agent' as const, item })) : []),
    ...(showMentionGroup('room') ? filteredRoomItems.map((item) => ({ kind: 'room' as const, item })) : []),
    ...(showMentionGroup('file') ? filteredFileItems.map((item) => ({ kind: 'file' as const, item })) : []),
    ...(showMentionGroup('conversation') ? filteredConversationItems.map((item) => ({ kind: 'conversation' as const, item })) : []),
  ]
  const mentionOptionCount = mentionOptions.length
  const chooseMentionOption = (option: MentionOption) => {
    if (option.kind === 'agent') chooseAgent(option.item)
    else if (option.kind === 'room') chooseRoom(option.item)
    else if (option.kind === 'file') chooseFile(option.item)
    else chooseConversation(option.item)
  }
  // 弹层打开时懒加载文件与对话记录（Agent/Room 由 props 同步提供）。
  // 对话记录合并导入的外部会话与本应用自有会话（provider 'everroom'），按最近活跃排序。
  useEffect(() => {
    if (!agentPickerOpen || mentionSourcesLoading) return
    setMentionSourcesLoading(true)
    setConversationServerQuery('')
    const loadMentionSource = <T,>(promise: Promise<T> | undefined, fallback: T): Promise<T> =>
      promise?.catch(() => fallback) ?? Promise.resolve(fallback)
    void Promise.all([
      loadMentionSource(
        window.nxcore?.files?.list(MENTION_CONVERSATION_LIMIT).then((page) => page?.items ?? []),
        [] as FileCatalogDto[],
      ),
      loadMentionSource(
        window.nxcore?.migrations?.conversations({ limit: MENTION_CONVERSATION_LIMIT }).then((page) => page?.items ?? []),
        [] as ExternalConversationSummary[],
      ),
      loadMentionSource(
        window.nxcore?.agent?.listSessions?.().then((sessions) => sessions ?? []),
        [] as AgentSession[],
      ),
    ]).then(([fileItems, conversationItems, nativeSessions]) => {
      setMentionFiles(fileItems.map((file) => ({
        id: file.id,
        title: file.displayName ?? file.sharedTitle ?? file.originalName,
        detail: file.processingState === 'ready' ? '' : file.processingState,
      })))
      const importedItems: MentionConversationItem[] = conversationItems.map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        provider: conversation.provider,
        messageCount: conversation.messageCount,
        occurredAt: conversation.lastMessageAt,
      }))
      const nativeItems: MentionConversationItem[] = nativeSessions
        // 空会话（从未对话、无标题且未更新过）不值得被 @。
        .filter((session) => session.title !== null || session.updatedAt !== session.createdAt)
        .map((session) => ({
          id: session.id,
          title: session.title,
          provider: 'everroom' as const,
          messageCount: null,
          occurredAt: session.updatedAt,
        }))
      setMentionConversations(mergeMentionConversations(nativeItems, importedItems))
    }).finally(() => setMentionSourcesLoading(false))
  }, [agentPickerOpen])
  // 有查询词时导入的对话记录转服务端 FTS 检索（可命中消息正文，突破首屏 200 条），
  // 清空查询词则还原全量；应用自有会话始终保留并走客户端过滤。
  useEffect(() => {
    if (!agentPickerOpen) return undefined
    const query = mentionQuery.trim()
    if (!query && !conversationServerQuery) return undefined
    const timer = window.setTimeout(() => {
      void window.nxcore?.migrations?.conversations(query ? { query, limit: MENTION_CONVERSATION_LIMIT } : { limit: MENTION_CONVERSATION_LIMIT })
        ?.then((page) => page?.items ?? [])
        .then((items) => {
          const importedItems: MentionConversationItem[] = items.map((conversation) => ({
            id: conversation.id,
            title: conversation.title,
            provider: conversation.provider,
            messageCount: conversation.messageCount,
            occurredAt: conversation.lastMessageAt,
          }))
          setMentionConversations((current) => mergeMentionConversations(
            current.filter((conversation) => conversation.provider === 'everroom'),
            importedItems,
          ))
          setConversationServerQuery(query)
        })
        .catch(() => undefined)
    }, 200)
    return () => window.clearTimeout(timer)
  }, [mentionQuery, agentPickerOpen, conversationServerQuery])
  useEffect(() => {
    if (!mentionTrigger || agentPickerOpen) return
    setAgentPickerOpen(true)
    setMentionCategory('all')
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

  // 弹层引用对象为空时弹层不渲染，composer 也不抬升（menuOpen 与可见弹层保持一致）。
  const menuOpen = slashPickerOpen || externalPickerOpen || modelPickerOpen || (agentPickerOpen && mentionOptionCount > 0)
  const channelAgent = channelAgentId ? localAgents.find((agent) => agent.id === channelAgentId) ?? null : null
  const channelActive = Boolean(channelAgentId)
  const activeTierMeta = MODEL_TIER_META[modelPreference]
  const ActiveTierIcon = activeTierMeta.icon
  // 上下文占用构成：按占比降序，tokens 已知时补一段剩余空间。
  const contextBreakdown = contextUsage?.contextWindow
    ? {
        window: contextUsage.contextWindow,
        tokens: contextUsage.tokens,
        percent: contextUsage.percent,
        segments: (contextUsage.segments ?? []).filter((segment) => segment.tokens > 0)
          .sort((left, right) => right.tokens - left.tokens),
        freeTokens: contextUsage.tokens === null ? null : Math.max(0, contextUsage.contextWindow - contextUsage.tokens),
      }
    : null
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
      {agentPickerOpen && mentionOptionCount > 0 ? (
        <div ref={agentResultsRef} className="agent-composer-popover agent-mention-popover" id="agent-composer-menu" role="listbox" aria-label={t('surface:agentComposer.mentionAgent')}>
          <div className="agent-mention-tabs" role="tablist" aria-label={t('surface:agentComposer.mentionCategoryLabel')}>
            {mentionCategoryTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className="agent-mention-tab"
                role="tab"
                aria-selected={mentionCategory === tab.id}
                data-selected={String(mentionCategory === tab.id)}
                disabled={tab.count === 0 && tab.id !== mentionCategory}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setMentionCategory(tab.id)
                  setAgentIndex(0)
                }}
              >
                {t(tab.labelKey)}{tab.count > 0 ? <span>{tab.count}</span> : null}
              </button>
            ))}
          </div>
          <div className="agent-mention-list">
            {mentionCategory === 'all' && filteredAgentItems.length ? (
              <div className="agent-mention-group-label"><Bot aria-hidden="true" />{t('surface:agentComposer.mentionGroupAgents')}</div>
            ) : null}
            {showMentionGroup('agent') ? filteredAgentItems.map((item, index) => (
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
                <span className="agent-mention-option-icon"><SourceIcon kind={item.provider === 'claude' || item.provider === 'openclaw' ? item.provider : 'codex'} /></span>
                <strong>{item.displayName}</strong>
              </button>
            )) : null}
            {mentionCategory === 'all' && filteredRoomItems.length ? (
              <div className="agent-mention-group-label"><FolderOpen aria-hidden="true" />{t('surface:agentComposer.mentionGroupRooms')}</div>
            ) : null}
            {showMentionGroup('room') ? filteredRoomItems.map((room) => {
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
                  <span className="agent-mention-option-icon"><FolderOpen aria-hidden="true" /></span>
                  <strong>{room.title}</strong>
                  {room.kind ? <small>{room.kind}</small> : null}
                </button>
              )
            }) : null}
                          {mentionCategory === 'all' && filteredFileItems.length ? (
              <div className="agent-mention-group-label"><FileText aria-hidden="true" />{t('surface:agentComposer.mentionGroupFiles')}</div>
            ) : null}
            {showMentionGroup('file') ? filteredFileItems.map((file) => {
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
                  <span className="agent-mention-option-icon"><FileText aria-hidden="true" /></span>
                  <strong>{file.title}</strong>
                  {file.detail ? <small>{file.detail}</small> : null}
                </button>
              )
            }) : null}
                          {mentionCategory === 'all' && filteredConversationItems.length ? (
              <div className="agent-mention-group-label"><History aria-hidden="true" />{t('surface:agentComposer.mentionGroupConversations')}</div>
            ) : null}
            {showMentionGroup('conversation') ? filteredConversationItems.map((conversation) => {
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
                  <span className="agent-mention-option-icon">
                    {conversation.provider === 'everroom' ? (
                      <MessagesSquare aria-hidden="true" />
                    ) : (
                      <SourceIcon kind={conversation.provider} />
                    )}
                  </span>
                  <strong>{displayText(conversation.title, t('surface:agentComposer.untitledConversation'))}</strong>
                  <small>
                    {conversation.provider === 'everroom'
                      ? `${t('surface:agentComposer.everroomConversationTag')} · ${displayDate(conversation.occurredAt, formatDate, t('surface:agentComposer.dateUnavailable'))}`
                      : `${conversation.provider} · ${t('surface:agentComposer.messageCount', { count: conversation.messageCount ?? 0 })}`}
                  </small>
                </button>
              )
            }) : null}
          </div>
        </div>
      ) : null}
      {modelPickerOpen ? (
        <section className="agent-composer-popover agent-model-picker" id="agent-composer-menu" role="listbox" aria-label={t('surface:agentComposer.modelPickerTitle')}>
          {MODEL_TIER_ORDER
            .filter((tier) => tier !== 'lite' || liteAvailable)
            .map((tier) => {
              const meta = MODEL_TIER_META[tier]
              const TierIcon = meta.icon
              const tierSelected = !channelActive && modelPreference === tier
              return (
                <button
                  key={tier}
                  type="button"
                  className="agent-model-option"
                  role="option"
                  aria-selected={tierSelected}
                  data-active={String(tierSelected)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseModelTier(tier)}
                >
                  <span className="agent-picker-header-icon"><TierIcon aria-hidden="true" /></span>
                  <span><strong>{t(meta.labelKey)}</strong><small>{t(meta.hintKey)}</small></span>
                  {tierSelected ? <Check aria-hidden="true" /> : null}
                </button>
              )
            })}
          {onSelectChannelAgent && callableLocalAgents.length > 0 ? (
            <div className="agent-model-channel-group" role="group" aria-label={t('surface:agentComposer.channelGroupLabel')}>
              <span className="agent-model-group-label">{t('surface:agentComposer.channelGroupLabel')}</span>
              {callableLocalAgents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  className="agent-model-option"
                  role="option"
                  aria-selected={channelAgentId === agent.id}
                  data-active={String(channelAgentId === agent.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseChannelAgent(agent.id)}
                >
                  <span className="agent-picker-header-icon"><Terminal aria-hidden="true" /></span>
                  <span><strong>{agent.displayName}</strong><small>{t('surface:agentComposer.channelOptionHint')}</small></span>
                  {channelAgentId === agent.id ? <Check aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {modelPreferenceLocked ? (
            <footer className="agent-model-picker-hint">{t('surface:agentComposer.modelPickerApplyToNext')}</footer>
          ) : null}
        </section>
      ) : null}
      {contextPanelOpen && contextBreakdown ? (
        <section className="agent-composer-popover agent-context-breakdown" aria-label={t('surface:agentComposer.contextWindow')}>
          <header className="agent-context-breakdown-head">
            <span>{t('surface:agentComposer.contextWindow')}</span>
            <strong>
              {contextBreakdown.tokens !== null
                ? `${formatContextTokens(contextBreakdown.tokens)} / ${formatContextTokens(contextBreakdown.window)}`
                : formatContextTokens(contextBreakdown.window)}
              {contextBreakdown.percent != null ? `（${formatContextPercent(contextBreakdown.percent)}）` : ''}
            </strong>
          </header>
          {contextBreakdown.segments.length ? (
            <>
              <div className="agent-context-breakdown-bar" aria-hidden="true">
                {contextBreakdown.segments.map((segment) => (
                  <span
                    key={segment.key}
                    data-key={segment.key}
                    style={{ width: `${Math.min(100, (segment.tokens / contextBreakdown.window) * 100)}%` }}
                  />
                ))}
              </div>
              <ul className="agent-context-breakdown-rows">
                {contextBreakdown.segments.map((segment) => (
                  <li key={segment.key}>
                    <span className="agent-context-breakdown-dot" data-key={segment.key} aria-hidden="true" />
                    <span className="agent-context-breakdown-label">{t(`surface:agentComposer.segment.${segment.key}`)}</span>
                    <span className="agent-context-breakdown-tokens">{formatContextTokens(segment.tokens)}</span>
                    <span className="agent-context-breakdown-share">
                      {formatContextPercent((segment.tokens / contextBreakdown.window) * 100)}
                    </span>
                  </li>
                ))}
                {contextBreakdown.freeTokens !== null && contextBreakdown.freeTokens > 0 ? (
                  <li>
                    <span className="agent-context-breakdown-dot" data-key="free" aria-hidden="true" />
                    <span className="agent-context-breakdown-label">{t('surface:agentComposer.segment.free')}</span>
                    <span className="agent-context-breakdown-tokens">{formatContextTokens(contextBreakdown.freeTokens)}</span>
                    <span className="agent-context-breakdown-share">
                      {formatContextPercent((contextBreakdown.freeTokens / contextBreakdown.window) * 100)}
                    </span>
                  </li>
                ) : null}
              </ul>
            </>
          ) : (
            <p className="agent-context-breakdown-empty">{t('surface:agentComposer.contextBreakdownUnknown')}</p>
          )}
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
            data-tier={channelActive ? undefined : modelPreference}
            data-channel={channelAgentId ?? undefined}
            aria-haspopup="listbox"
            aria-expanded={modelPickerOpen}
            title={channelActive ? channelAgent?.displayName ?? channelAgentId ?? undefined : t('surface:agentComposer.modelPickerTitle')}
            disabled={controlsDisabled}
            onClick={() => (modelPickerOpen ? setModelPickerOpen(false) : openModelPicker())}
          >
            {channelActive ? <Terminal aria-hidden="true" /> : <ActiveTierIcon aria-hidden="true" />}
            <span>{channelActive ? channelAgent?.displayName ?? channelAgentId : t(activeTierMeta.labelKey)}</span>
          </button>
          {/* 占位 flex 撑开发送钮；无引用时不渲染文案。 */}
          <span className="agent-composer-context" title={hasSelectedText ? contextSummary : undefined}>
            {hasSelectedText ? <span>{contextSummary}</span> : null}
            {hasSelectedText ? (
              <button type="button" aria-label={t('surface:agentComposer.clearAllReferences')} title={t('surface:agentComposer.clearAllReferences')} onClick={onClearContext}>
                <X aria-hidden="true" />
              </button>
            ) : null}
            {/* 实时上下文用量：默认只有小圆环，悬停看数字，点击展开占用构成；压缩中圆环呼吸。 */}
            {contextUsage?.contextWindow ? (
              <button
                type="button"
                className={`agent-context-ring${contextCompacting ? ' agent-context-ring--compacting' : ''}`}
                data-level={contextUsage.percent !== null && contextUsage.percent >= 85 ? 'high' : undefined}
                aria-expanded={contextPanelOpen}
                title={contextCompacting
                  ? t('surface:agentComposer.contextCompacting')
                  : t('surface:agentComposer.contextUsageTitle', {
                    used: contextUsage.tokens === null ? '—' : contextUsage.tokens.toLocaleString(),
                    total: contextUsage.contextWindow.toLocaleString(),
                    percent: contextUsage.percent === null ? '—' : Math.round(contextUsage.percent),
                  })}
                onClick={() => setContextPanelOpen((open) => !open)}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <circle className="agent-context-ring-track" cx="8" cy="8" r="5.5" fill="none" strokeWidth="2.5" />
                  {contextUsage.percent !== null ? (
                    <circle
                      className="agent-context-ring-arc"
                      cx="8"
                      cy="8"
                      r="5.5"
                      fill="none"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeDasharray={`${(RING_CIRCUMFERENCE * Math.min(100, Math.max(3, contextUsage.percent))) / 100} ${RING_CIRCUMFERENCE}`}
                      transform="rotate(-90 8 8)"
                    />
                  ) : null}
                </svg>
              </button>
            ) : contextCompacting ? (
              <span className="agent-context-usage agent-context-usage--compacting" title={t('surface:agentComposer.contextCompacting')}>
                <span className="agent-context-usage-pulse" aria-hidden="true" />
                {t('surface:agentComposer.contextCompacting')}
              </span>
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
