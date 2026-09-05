import type {
  DocumentBlockResolution,
  ResolveDocumentBlockReferencesInput,
  ResolveDocumentBlockReferencesResult,
} from '@nxcore/agent-contract'
import { formatBlockIndexMarkMarkdown, parseBlockIndexMarkMarkdown } from '@nxcore/document-model'
import {
  Node,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  mergeAttributes,
  type Editor,
  type MarkdownToken,
  type NodeViewProps,
} from '@tiptap/react'
import { Brain, FileText, FileWarning, LocateFixed, Trash2 } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { Plugin } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'
import i18n from '@/i18n/i18next'
import { showToast } from '@/state/toast'

import type { ContextRoomMemoryItem } from '../../types'
import { resolveDocumentBlockReference } from './documentBlockReferenceResolver'
import {
  DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT,
  documentBlockReferenceInvalidationMatches,
} from './documentBlockReferenceInvalidation'
import { documentBlockResolutionLabel } from './documentBlockReferenceLink'
import {
  BLOCK_INDEX_MARK_NODE,
  blockIndexTargetFromClipboardText,
  fromBlockIndexMarkNodeAttrs,
  toBlockIndexMarkNodeAttrs,
  type BlockIndexMarkNodeAttrs,
  type BlockIndexTarget,
} from './blockIndexLink'
import './BlockIndexMark.css'

/** Chips beyond this many on one block collapse into a `+N` overflow badge. */
const MAX_STACKED_CHIPS = 3

/** IPC 兜底超时：网关无响应时预览不许永远停在"正在加载"。 */
const RESOLVE_TIMEOUT_MS = 6_000

function withResolveTimeout(promise: Promise<DocumentBlockResolution | null>): Promise<DocumentBlockResolution | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS)
    void promise.then(
      (value) => { window.clearTimeout(timer); resolve(value) },
      () => { window.clearTimeout(timer); resolve(null) },
    )
  })
}

/** 诊断日志走 app:diagnostic-log → desktop-*.log,用于真机排查预览加载问题。 */
function logMarkDiagnostic(event: Record<string, unknown>): void {
  try {
    window.nxcore?.diagnostics?.log({ module: 'block-index-mark', level: 'info', event })
  } catch {
    // 诊断失败不影响交互。
  }
}

export interface BlockIndexMarkOptions {
  sourceRoomId: string
  resolveReferences?: (
    input: ResolveDocumentBlockReferencesInput,
  ) => Promise<ResolveDocumentBlockReferencesResult>
  onNavigateDocument?: (
    target: Extract<BlockIndexTarget, { kind: 'document' }>,
    resolution: DocumentBlockResolution | null,
  ) => void
  getMemoryItems?: () => ContextRoomMemoryItem[]
  onNavigateMemory?: (target: Extract<BlockIndexTarget, { kind: 'memory' }>) => void
}

function attrsFromNodeView(node: NodeViewProps['node']): BlockIndexMarkNodeAttrs {
  return {
    kind: node.attrs.kind === 'memory' ? 'memory' : 'document',
    targetRoomId: String(node.attrs.targetRoomId || ''),
    targetDocumentId: String(node.attrs.targetDocumentId || ''),
    targetBlockId: String(node.attrs.targetBlockId || ''),
    targetMemoryId: String(node.attrs.targetMemoryId || ''),
    fallbackTitle: typeof node.attrs.fallbackTitle === 'string' ? node.attrs.fallbackTitle : null,
    fallbackPreview: typeof node.attrs.fallbackPreview === 'string' ? node.attrs.fallbackPreview : null,
  }
}

function sameIndexTarget(a: BlockIndexTarget, b: BlockIndexTarget): boolean {
  if (a.kind !== b.kind || a.roomId !== b.roomId) return false
  if (a.kind === 'document' && b.kind === 'document') {
    return a.documentId === b.documentId && a.blockId === b.blockId
  }
  if (a.kind === 'memory' && b.kind === 'memory') return a.memoryId === b.memoryId
  return false
}

interface ClipboardLikeEvent {
  clipboardData?: { getData: (type: string) => string } | null
}

/**
 * 把粘贴的块链接(复制块引用产出的 everroom:// URL,或其 markdown 形式)
 * 挂载为当前文本块的索引标记,而不是落下一段死链接文本。
 * 返回 true 表示已消费本次粘贴。
 */
export function handleBlockIndexPaste(
  view: EditorView,
  event: ClipboardLikeEvent,
  options: BlockIndexMarkOptions,
): boolean {
  const text = event.clipboardData?.getData('text/plain') ?? ''
  const target = blockIndexTargetFromClipboardText(text)
  if (!target) return false
  const translate = (key: string) => i18n.t(key) as string
  if (options.sourceRoomId !== target.roomId) {
    showToast({
      title: translate('contextRoom:blockIndexMark.crossRoomPasteBlocked'),
      message: translate('contextRoom:blockIndexMark.crossRoomPasteBlockedDetail'),
    })
    return true
  }
  const { state, dispatch } = view
  const parent = state.selection.$from.parent
  if (!parent.isTextblock || parent.type.name === 'codeBlock') {
    showToast({ title: translate('contextRoom:blockIndexMark.pasteNoHost') })
    return true
  }
  let duplicate = false
  parent.forEach((child) => {
    if (child.type.name !== BLOCK_INDEX_MARK_NODE) return
    const existing = fromBlockIndexMarkNodeAttrs(child.attrs as Partial<BlockIndexMarkNodeAttrs>)
    if (existing && sameIndexTarget(existing, target)) duplicate = true
  })
  if (duplicate) {
    showToast({ title: translate('contextRoom:blockIndexMark.duplicateIndex') })
    return true
  }
  const markType = state.schema.nodes[BLOCK_INDEX_MARK_NODE]
  if (!markType) return false
  const insertPos = state.selection.$from.start() + parent.content.size
  dispatch(state.tr
    .insert(insertPos, markType.create(toBlockIndexMarkNodeAttrs(target)))
    .scrollIntoView())
  showToast({
    title: translate('contextRoom:blockIndexMark.pastedAsIndex'),
    message: target.fallbackTitle || translate('contextRoom:blockIndexMark.pastedAsIndexDetail'),
  })
  return true
}

function hostMarkLayout(editor: Editor, pos: number): { ordinal: number; total: number } {
  const doc = editor.state.doc
  const node = doc.nodeAt(pos)
  if (!node) return { ordinal: 0, total: 1 }
  const $pos = doc.resolve(pos)
  const host = $pos.parent
  let ordinal = 0
  let total = 0
  host.forEach((child, offset) => {
    if (child.type.name !== BLOCK_INDEX_MARK_NODE) return
    total += 1
    if ($pos.start() + offset < pos) ordinal += 1
  })
  return { ordinal, total }
}

/** 导出仅供测试：正常挂载经 ReactNodeViewRenderer,不需要直接引用。 */
export function BlockIndexMarkView(props: NodeViewProps) {  const { t } = useLocale()
  const editor = props.editor
  const options = props.extension.options as BlockIndexMarkOptions
  const target = fromBlockIndexMarkNodeAttrs(attrsFromNodeView(props.node))
  const [open, setOpen] = useState(false)
  const [resolution, setResolution] = useState<DocumentBlockResolution | null>(null)
  const [loading, setLoading] = useState(false)
  const [memory, setMemory] = useState<ContextRoomMemoryItem | null>(null)
  const [layout, setLayout] = useState<{ ordinal: number; total: number }>({ ordinal: 0, total: 1 })
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const resolveSequence = useRef(0)
  const pendingResolveCount = useRef(0)

  const getPos = props.getPos

  const refreshLayout = useCallback(() => {
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (pos == null) return
    const next = hostMarkLayout(editor, pos)
    setLayout((current) => (current.ordinal === next.ordinal && current.total === next.total
      ? current
      : next))
  }, [editor, getPos])

  useEffect(() => {
    refreshLayout()
    const handleTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (transaction.docChanged) refreshLayout()
    }
    editor.on('transaction', handleTransaction)
    return () => {
      editor.off('transaction', handleTransaction)
    }
  }, [editor, refreshLayout])

  useEffect(() => () => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current)
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
  }, [])

  // 依赖必须是原始值：target 对象每次渲染重建，若作为 useCallback/effect 依赖，
  // 预览打开期间会陷入"渲染→重建 resolve→effect 再解析→setState→再渲染"的循环。
  const kind = target?.kind ?? null
  const targetRoomId = target?.roomId ?? ''
  const targetDocumentId = target?.kind === 'document' ? target.documentId : ''
  const targetBlockId = target?.kind === 'document' ? target.blockId : ''
  const targetMemoryId = target?.kind === 'memory' ? target.memoryId : ''
  const fallbackTitle = target?.fallbackTitle ?? null
  const fallbackPreview = target?.fallbackPreview ?? null

  // tiptap v3 里 props.extension.options 每次渲染都是新引用——直接进 useCallback
  // 依赖会让 resolve 身份每渲染一变,预热 effect 无限重跑(真机 79 秒 4.6 万次
  // IPC,预览永远显示"正在加载引用",2026-09-04 日志实锤)。回调一律经 ref 取
  // 最新值,依赖收敛为原始值。
  const resolveReferencesRef = useRef(options.resolveReferences)
  resolveReferencesRef.current = options.resolveReferences
  const getMemoryItemsRef = useRef(options.getMemoryItems)
  getMemoryItemsRef.current = options.getMemoryItems
  const sourceRoomId = options.sourceRoomId

  const resolve = useCallback(async () => {
    const sequence = ++resolveSequence.current
    const startedAt = performance.now()
    let branch: 'memory' | 'invalid' | 'no-resolver' | 'ipc' = 'ipc'
    if (kind === 'memory') branch = 'memory'
    else if (kind !== 'document' || !targetRoomId || !targetDocumentId || !targetBlockId) branch = 'invalid'
    else if (!resolveReferencesRef.current || sourceRoomId !== targetRoomId) branch = 'no-resolver'
    logMarkDiagnostic({ at: 'resolve', seq: sequence, branch, targetBlockId, targetDocumentId })
    if (kind === 'memory') {
      const item = targetMemoryId
        ? getMemoryItemsRef.current?.().find((memoryItem) => memoryItem.id === targetMemoryId) ?? null
        : null
      if (sequence === resolveSequence.current) setMemory(item)
      return
    }
    if (kind !== 'document' || !targetRoomId || !targetDocumentId || !targetBlockId) {
      if (sequence === resolveSequence.current) setResolution(null)
      return
    }
    const resolveReferences = resolveReferencesRef.current
    if (!resolveReferences || sourceRoomId !== targetRoomId) {
      if (sequence === resolveSequence.current) {
        setResolution({
          roomId: targetRoomId,
          documentId: targetDocumentId,
          blockId: targetBlockId,
          status: 'room_unavailable',
          title: null,
          textPreview: null,
          version: null,
        })
      }
      return
    }
    setLoading(true)
    pendingResolveCount.current += 1
    let outcome: string | null = null
    try {
      const result = await withResolveTimeout(resolveDocumentBlockReference(
        resolveReferences,
        sourceRoomId,
        { roomId: targetRoomId, documentId: targetDocumentId, blockId: targetBlockId },
      ))
      outcome = result?.status ?? 'null'
      if (sequence === resolveSequence.current) setResolution(result)
    } catch {
      outcome = 'error'
      if (sequence === resolveSequence.current) setResolution(null)
    } finally {
      pendingResolveCount.current = Math.max(0, pendingResolveCount.current - 1)
      // 清除 loading 不能带 sequence 守卫：被更新的 resolve 顶掉的旧解析若跳过
      // 清除，loading 永久卡在 true，预览永远停在"正在加载引用"（2026-09-04 真机）。
      // 早退分支只递增 sequence、不碰 loading，同样依赖这里兜底。
      if (pendingResolveCount.current === 0) setLoading(false)
      logMarkDiagnostic({
        at: 'resolve-settled',
        seq: sequence,
        outcome,
        superseded: sequence !== resolveSequence.current,
        pending: pendingResolveCount.current,
        ms: Math.round(performance.now() - startedAt),
      })
    }
  }, [kind, sourceRoomId, targetDocumentId, targetMemoryId, targetBlockId, targetRoomId])

  // 挂载即预热解析(与 documentBlockReference 卡片一致):hover 之前结果已就绪,
  // 预览打开时不再等 IPC。resolve 依赖稳定,本 effect 每次挂载只跑一次。
  useEffect(() => {
    logMarkDiagnostic({
      at: 'mount',
      kind,
      targetBlockId,
      targetDocumentId,
      sourceRoomId: options.sourceRoomId,
      hasResolver: Boolean(options.resolveReferences),
    })
    void resolve()
  }, [resolve])

  useEffect(() => {
    if (!open) return
    // 只要还没有结果就允许（重新）解析，即使上一次仍在途——loading 一旦因
    // 任何路径卡住，这里是唯一自愈入口，预览不许永远停在"正在加载引用"。
    logMarkDiagnostic({ at: 'open', hasResolution: resolution !== null })
    if (resolution !== null) return
    void resolve()
  }, [open, resolve, resolution])

  useEffect(() => {
    const refreshOnFocus = () => {
      if (kind === 'document') void resolve()
    }
    const refreshOnInvalidation = (event: Event) => {
      if (kind !== 'document') return
      const detail = (event as CustomEvent<{ roomId?: string; documentId?: string }>).detail ?? {}
      if (!documentBlockReferenceInvalidationMatches(detail, {
        roomId: targetRoomId,
        documentId: targetDocumentId,
        blockId: targetBlockId,
      })) return
      void resolve()
    }
    window.addEventListener('focus', refreshOnFocus)
    window.addEventListener(DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT, refreshOnInvalidation)
    return () => {
      window.removeEventListener('focus', refreshOnFocus)
      window.removeEventListener(DOCUMENT_BLOCK_REFERENCES_INVALIDATED_EVENT, refreshOnInvalidation)
    }
  }, [kind, resolve, targetBlockId, targetDocumentId, targetRoomId])

  const scheduleOpen = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    if (openTimer.current !== null) return
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null
      setOpen(true)
    }, 180)
  }
  const scheduleClose = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current)
      openTimer.current = null
    }
    if (closeTimer.current !== null) return
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      setOpen(false)
    }, 120)
  }
  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const navigate = () => {
    if (!target) return
    if (target.kind === 'document') {
      options.onNavigateDocument?.(target, resolution)
      return
    }
    const items = options.getMemoryItems?.() ?? []
    if (!items.some((item) => item.id === target.memoryId)) {
      showToast({
        title: t('contextRoom:blockIndexMark.memoryMissing'),
        message: t('contextRoom:blockIndexMark.memoryMissingDetail'),
      })
      return
    }
    options.onNavigateMemory?.(target)
  }

  const removeIndex = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined
    if (pos == null || !editor.isEditable) return
    setOpen(false)
    editor.chain().focus().deleteRange({ from: pos, to: pos + props.node.nodeSize }).run()
  }

  if (!target) return <NodeViewWrapper as="span" className="context-room-block-index-mark" />

  const isMemory = target.kind === 'memory'
  const brokenDocument = !isMemory && resolution !== null
    && resolution.status !== 'available' && resolution.status !== 'block_missing'
  const brokenMemory = isMemory && memory === null && !loading
  const overflow = layout.ordinal >= MAX_STACKED_CHIPS
  const overflowBadge = layout.ordinal === MAX_STACKED_CHIPS

  return (
    <NodeViewWrapper
      as="span"
      className="context-room-block-index-mark"
      contentEditable={false}
      data-preview-open={open ? 'true' : undefined}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          {overflow ? (
            <span
              className="context-room-block-index-overflow"
              style={{ '--block-index-ordinal': String(Math.min(layout.ordinal, MAX_STACKED_CHIPS)) } as React.CSSProperties}
              aria-hidden={!overflowBadge || undefined}
            >
              {overflowBadge ? `+${String(layout.total - MAX_STACKED_CHIPS)}` : null}
            </span>
          ) : (
            <button
              type="button"
              className="context-room-block-index-chip"
              style={{ '--block-index-ordinal': String(layout.ordinal) } as React.CSSProperties}
              data-kind={target.kind}
              data-broken={String(brokenDocument || brokenMemory)}
              aria-label={t(isMemory
                ? 'contextRoom:blockIndexMark.indexedMemory'
                : 'contextRoom:blockIndexMark.indexedDocumentBlock')}
              title={target.fallbackTitle || undefined}
              onMouseEnter={scheduleOpen}
              onMouseLeave={scheduleClose}
              onFocus={scheduleOpen}
              onBlur={scheduleClose}
              onClick={navigate}
            >
              {isMemory ? <Brain aria-hidden="true" /> : brokenDocument ? <FileWarning aria-hidden="true" /> : <FileText aria-hidden="true" />}
            </button>
          )}
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            className="context-room-block-index-popover"
            side="right"
            align="start"
            sideOffset={10}
            collisionPadding={12}
            onMouseEnter={cancelClose}
            onMouseLeave={() => setOpen(false)}
          >
            <header>
              {isMemory ? <Brain aria-hidden="true" /> : <FileText aria-hidden="true" />}
              <strong>{(isMemory
                ? memory?.type || fallbackTitle
                : resolution?.title ?? fallbackTitle)
                || t('contextRoom:blockIndexMark.previewUnavailable')}</strong>
            </header>
            <p>
              {loading
                ? t('contextRoom:blockIndexMark.loadingReference')
                : (isMemory
                  ? memory?.content ?? fallbackPreview ?? t('contextRoom:blockIndexMark.memoryMissing')
                  : resolution?.textPreview ?? fallbackPreview ?? t('contextRoom:blockIndexMark.previewUnavailable'))}
            </p>
            {!isMemory && resolution ? (
              <em>{t(documentBlockResolutionLabel(resolution))}</em>
            ) : null}
            {isMemory && memory ? <em>{memory.type}</em> : null}
            <footer>
              <button type="button" onClick={navigate}>
                <LocateFixed aria-hidden="true" />{t('contextRoom:blockIndexMark.jumpToTarget')}
              </button>
              <button type="button" onClick={removeIndex} disabled={!editor.isEditable}>
                <Trash2 aria-hidden="true" />{t('contextRoom:blockIndexMark.removeIndex')}
              </button>
            </footer>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </NodeViewWrapper>
  )
}

export const BlockIndexMark = Node.create<BlockIndexMarkOptions>({
  name: BLOCK_INDEX_MARK_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addOptions() {
    return { sourceRoomId: '' }
  },

  addAttributes() {
    return {
      kind: { default: 'document' },
      targetRoomId: { default: '' },
      targetDocumentId: { default: '' },
      targetBlockId: { default: '' },
      targetMemoryId: { default: '' },
      fallbackTitle: { default: null },
      fallbackPreview: { default: null },
    }
  },

  parseHTML() {
    return [{
      tag: 'span[data-block-index-mark]',
      getAttrs: (element) => {
        if (!(element instanceof HTMLElement)) return false
        return {
          kind: element.getAttribute('data-kind') === 'memory' ? 'memory' : 'document',
          targetRoomId: element.getAttribute('data-target-room-id') || '',
          targetDocumentId: element.getAttribute('data-target-document-id') || '',
          targetBlockId: element.getAttribute('data-target-block-id') || '',
          targetMemoryId: element.getAttribute('data-target-memory-id') || '',
          fallbackTitle: element.getAttribute('data-fallback-title'),
          fallbackPreview: element.getAttribute('data-fallback-preview'),
        }
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({
      'data-block-index-mark': '',
      'data-kind': HTMLAttributes.kind === 'memory' ? 'memory' : 'document',
      'data-target-room-id': HTMLAttributes.targetRoomId,
      'data-target-document-id': HTMLAttributes.targetDocumentId,
      'data-target-block-id': HTMLAttributes.targetBlockId,
      'data-target-memory-id': HTMLAttributes.targetMemoryId,
      'data-fallback-title': HTMLAttributes.fallbackTitle || undefined,
      'data-fallback-preview': HTMLAttributes.fallbackPreview || undefined,
    })]
  },

  markdownTokenName: BLOCK_INDEX_MARK_NODE,

  markdownTokenizer: {
    name: BLOCK_INDEX_MARK_NODE,
    level: 'inline',
    start: (source: string) => source.search(/\^\[/),
    tokenize: (source: string) => {
      const parsed = parseBlockIndexMarkMarkdown(source)
      if (!parsed) return undefined
      return {
        type: BLOCK_INDEX_MARK_NODE,
        raw: parsed.raw,
        attrs: toBlockIndexMarkNodeAttrs(parsed.target),
      } as MarkdownToken
    },
  },

  parseMarkdown(token, helpers) {
    const attrs = fromBlockIndexMarkNodeAttrs(token.attrs as Partial<BlockIndexMarkNodeAttrs>)
    return helpers.createNode(
      BLOCK_INDEX_MARK_NODE,
      attrs ? toBlockIndexMarkNodeAttrs(attrs) : toBlockIndexMarkNodeAttrs({
        kind: 'document',
        roomId: '',
        documentId: '',
        blockId: '',
      }),
      [],
    )
  },

  renderMarkdown(node) {
    const target = fromBlockIndexMarkNodeAttrs(node.attrs as Partial<BlockIndexMarkNodeAttrs>)
    if (!target) return ''
    return formatBlockIndexMarkMarkdown(target, target.fallbackTitle || '')
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockIndexMarkView)
  },

  addProseMirrorPlugins() {
    const options = this.options
    return [new Plugin({
      props: {
        handlePaste: (view, event) => handleBlockIndexPaste(view, event, options),
      },
    })]
  },
})
