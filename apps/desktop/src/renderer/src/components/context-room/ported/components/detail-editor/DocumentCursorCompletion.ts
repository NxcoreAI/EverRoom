import { Extension, type Editor } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEffect, useRef, useState } from 'react'
import i18n from '@/i18n/i18next'
import { useLocale } from '../../../../../i18n/LocaleContext'

import {
  classifyDocumentCursorCompletionError,
  documentCursorCompletionCircuitBreaker,
  DocumentCursorCompletionSessionChannel,
  streamDocumentCursorCompletion,
  type DocumentCursorCompletionFormatContext,
  type DocumentCursorCompletionListType,
  type DocumentCursorCompletionMode,
  type DocumentCursorCompletionNearbyBlock,
  type DocumentCursorCompletionSuggestion,
  validatedDocumentCursorReplacement,
} from './documentCursorCompletionAgent'
import { loadCompletionWritingStyleBlock } from './writingStyleInjection'
import { recordCompletionAcceptance, recordCompletionRejection } from './completionStyleFeedback'
import {
  documentCursorCompletionSnippet,
  nextDocumentCursorCompletionRequestId,
  recordDocumentCursorCompletionDiagnostic,
  type DocumentCursorCompletionTrigger,
} from './DocumentCursorCompletionDiagnostics'

interface DocumentCursorCompletionState {
  position: number
  text: string
  replaceFrom?: number
  activeMarks?: string[]
  /** 灯泡气泡各选项的文案（hook 按 locale 算好传入，插件层不依赖 i18n）。 */
  retryLabel?: string
  acceptLabel?: string
  dismissLabel?: string
  /** 建议所属档位：重生成请求与诊断的单一事实源。 */
  mode?: DocumentCursorCompletionMode
}

interface DocumentCursorCompletionContext {
  position: number
  contextBefore: string
  contextAfter: string
  blockPrefix: string
  blockSuffix: string
  blockType: string
  formatContext: DocumentCursorCompletionFormatContext
  nearbyBlocks: DocumentCursorCompletionNearbyBlock[]
  requestKey: string
}

interface ActiveCompletionRequest {
  controller: AbortController
  diagnosticEnded: boolean
  diagnosticId: string
  diagnosticStartedAt: number
  diagnosticTrigger: DocumentCursorCompletionTrigger
  lastDiagnosticShown: string | null
  lastDiagnosticSuggestion: string | null
  currentRequestKey: string
  position: number
  typedSinceRequest: string
  visibleText: string | null
  visibleReplacement: boolean
  completionMode: DocumentCursorCompletionMode
}

function abortCompletionRequest(request: ActiveCompletionRequest, reason: string): void {
  if (request.controller.signal.aborted) return
  request.diagnosticEnded = true
  recordDocumentCursorCompletionDiagnostic('request.cancelled', {
    requestId: request.diagnosticId,
    trigger: request.diagnosticTrigger,
    reason,
    durationMs: Date.now() - request.diagnosticStartedAt,
  })
  request.controller.abort()
}

function recordShownCompletion(
  request: ActiveCompletionRequest,
  completion: DocumentCursorCompletionState,
): void {
  const signature = `${completion.replaceFrom ?? completion.position}:${completion.position}:${completion.text}`
  if (request.lastDiagnosticShown === signature) return
  request.lastDiagnosticShown = signature
  recordDocumentCursorCompletionDiagnostic('suggestion.shown', {
    requestId: request.diagnosticId,
    position: completion.position,
    replaceCharacters: completion.position - (completion.replaceFrom ?? completion.position),
    suggestionLength: Array.from(completion.text).length,
    suggestion: documentCursorCompletionSnippet(completion.text),
    completionMode: completion.mode ?? 'inline',
  })
}

const cursorCompletionKey = new PluginKey<DocumentCursorCompletionState | null>('documentCursorCompletion')
export const DOCUMENT_CURSOR_COMPLETION_DELAY_MS = 700
export const DOCUMENT_CURSOR_COMPLETION_PARAGRAPH_DELAY_MS = 1500
const MIN_TYPED_CHARACTERS = 2
const NEARBY_BLOCK_LIMIT = 3
const NEARBY_NODE_VISIT_LIMIT = 64
/** 段落档生成长文本：总超时放宽到 15s，首建议 deadline 维持 4s（TTFB 不变）。 */
const PARAGRAPH_STREAM_TIMEOUT_MS = 15_000
/** 段落档上下文窗口比行内宽（数据组装侧，不影响指令前缀字节稳定）。 */
const PARAGRAPH_PREFIX_CODEPOINTS = 400
/** 同一 requestKey 的"重写"上限；超过视为模型在该位置已无更好的提案。 */
const REGENERATE_LIMIT_PER_REQUEST = 3
const REGENERATE_CACHE_LIMIT = 64

/** 双档调度：每个 timer 回调只清自己的槽位，requestCompletion 不碰 timer。 */
interface CompletionTimers {
  inline: number | null
  paragraph: number | null
}

function clearCompletionTimerSlot(timers: CompletionTimers, tier: keyof CompletionTimers): void {
  const handle = timers[tier]
  if (handle === null) return
  window.clearTimeout(handle)
  timers[tier] = null
}

function clearCompletionTimers(timers: CompletionTimers, reason?: string): void {
  const hadTimers = timers.inline !== null || timers.paragraph !== null
  clearCompletionTimerSlot(timers, 'inline')
  clearCompletionTimerSlot(timers, 'paragraph')
  if (hadTimers && reason) {
    recordDocumentCursorCompletionDiagnostic('schedule.cancelled', { reason })
  }
}

/** 灯泡气泡"重写"计数：requestKey → 已重生成次数，按插入序裁剪防泄漏。 */
const regenerateCounts = new Map<string, number>()

/** 气泡"重写"按钮点击时冒泡的 DOM 事件名；hook 在编辑器根上监听并触发 regenerate。 */
export const DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT = 'document-cursor-completion-retry'
/** 气泡"接受/拒绝"菜单项点击时冒泡的 DOM 事件名（与"重写"同一条通路）。 */
export const DOCUMENT_CURSOR_COMPLETION_ACCEPT_EVENT = 'document-cursor-completion-accept'
export const DOCUMENT_CURSOR_COMPLETION_DISMISS_EVENT = 'document-cursor-completion-dismiss'

/** lucide Lightbulb 图标（项目已依赖 lucide-react，同源 SVG path）。 */
function lightbulbIcon(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const path of ['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4']) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    element.setAttribute('d', path)
    svg.appendChild(element)
  }
  return svg
}

/**
 * ghost DOM 构造：先设 textContent 再 append 子元素（后设 textContent 会清掉子节点）。
 * 尾部是 VSCode 式灯泡：点击弹小气泡，选项依次为 接受(Tab)/拒绝(Esc)/重写。
 * pointerdown 必须 preventDefault + stopPropagation——hook 在编辑器根上监听
 * pointerdown 做 cancelPending（pointerdown 早于 mousedown 触发），PM 也靠它移
 * 选区；任何一条路走到都会立刻清掉 ghost 与气泡。menu 是 bulb 的子节点，事件
 * 冒泡经过 bulb，点菜单内容同样被拦下。click 不受 preventDefault 影响，仍会触发。
 * 点击编辑器其他位置的关闭路径天然存在：选区变化 → ghost 销毁 → 气泡随之消失。
 */
export function buildDocumentCursorCompletionGhost(
  completion: DocumentCursorCompletionState,
): HTMLElement {
  const ghost = document.createElement('span')
  ghost.className = 'context-room-document-cursor-completion'
  ghost.dataset.documentCursorCompletion = 'true'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.setAttribute('contenteditable', 'false')
  ghost.setAttribute('role', 'presentation')
  if (completion.activeMarks?.length) {
    ghost.dataset.activeMarks = completion.activeMarks.join(' ')
  }
  ghost.textContent = completion.text

  const swallowPointer = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const menu = document.createElement('span')
  menu.className = 'context-room-document-cursor-completion-menu'
  menu.setAttribute('role', 'menu')
  menu.hidden = true

  // 快捷键提示跟在文案右侧：Tab/Esc 键名不随 locale 变化，不需要走 i18n。
  const menuItem = (label: string, eventName: string, keyHint?: string) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'context-room-document-cursor-completion-menu-item'
    item.setAttribute('role', 'menuitem')
    item.setAttribute('contenteditable', 'false')
    const labelText = document.createElement('span')
    labelText.textContent = label
    item.appendChild(labelText)
    if (keyHint) {
      const hint = document.createElement('span')
      hint.className = 'context-room-document-cursor-completion-menu-item-key'
      hint.setAttribute('aria-hidden', 'true')
      hint.textContent = keyHint
      item.appendChild(hint)
    }
    item.addEventListener('pointerdown', swallowPointer)
    item.addEventListener('mousedown', swallowPointer)
    item.addEventListener('click', (event) => {
      event.stopPropagation()
      menu.hidden = true
      bulb.setAttribute('aria-expanded', 'false')
      ghost.dispatchEvent(new CustomEvent(eventName, { bubbles: true }))
    })
    return item
  }
  menu.appendChild(menuItem(completion.acceptLabel || 'Accept', DOCUMENT_CURSOR_COMPLETION_ACCEPT_EVENT, 'Tab'))
  menu.appendChild(menuItem(completion.dismissLabel || 'Dismiss', DOCUMENT_CURSOR_COMPLETION_DISMISS_EVENT, 'Esc'))
  menu.appendChild(menuItem(completion.retryLabel || 'Retry', DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT))

  const bulb = document.createElement('span')
  bulb.className = 'context-room-document-cursor-completion-bulb'
  bulb.setAttribute('role', 'button')
  bulb.setAttribute('aria-haspopup', 'menu')
  bulb.setAttribute('aria-expanded', 'false')
  bulb.setAttribute('contenteditable', 'false')
  bulb.appendChild(lightbulbIcon())
  bulb.addEventListener('pointerdown', swallowPointer)
  bulb.addEventListener('mousedown', swallowPointer)
  // 最后一行向下弹会把滚动区撑出额外高度（绝对定位盒超出可视底边即计入
  // scrollHeight）：打开时量下方空间，不足则加 up 类改为向上弹。
  const placeMenu = () => {
    menu.classList.remove('context-room-document-cursor-completion-menu-up')
    const boundary = ghost.closest('.context-room-tiptap-scroll')
      ?? ghost.closest('.context-room-tiptap-content')
    if (!boundary) return
    const boundaryRect = boundary.getBoundingClientRect()
    if (boundaryRect.height === 0) return // 非渲染环境（测试）零矩形，不做布局决策
    const spaceBelow = boundaryRect.bottom - bulb.getBoundingClientRect().bottom
    if (spaceBelow < menu.offsetHeight + 8) {
      menu.classList.add('context-room-document-cursor-completion-menu-up')
    }
  }
  bulb.addEventListener('click', (event) => {
    event.stopPropagation()
    menu.hidden = !menu.hidden
    if (!menu.hidden) placeMenu()
    bulb.setAttribute('aria-expanded', String(!menu.hidden))
  })
  bulb.appendChild(menu)

  ghost.appendChild(bulb)
  return ghost
}

function completionDecorations(
  doc: Parameters<typeof DecorationSet.create>[0],
  completion: DocumentCursorCompletionState,
): DecorationSet {
  const decorations: Decoration[] = []
  if (completion.replaceFrom !== undefined && completion.replaceFrom < completion.position) {
    decorations.push(Decoration.inline(completion.replaceFrom, completion.position, {
      class: 'context-room-document-cursor-correction',
      'data-document-cursor-correction': 'true',
    }))
  }
  decorations.push(Decoration.widget(completion.position, () => (
    buildDocumentCursorCompletionGhost(completion)
  ), {
    // key 不含 retryLabel：locale 切换只换文案，不必重建 widget。
    key: `document-cursor-completion:${completion.replaceFrom ?? completion.position}:${completion.position}:${completion.text}`,
    side: 1,
    ignoreSelection: true,
    relaxedSide: true,
  }))
  return DecorationSet.create(doc, decorations)
}

/** 接受建议的共享事务：Tab 键与气泡"接受"菜单项同一条通路，行为/诊断完全一致。 */
function completionAcceptTransaction(
  state: EditorState,
  completion: DocumentCursorCompletionState,
): Transaction {
  const replaceFrom = completion.replaceFrom ?? completion.position
  recordDocumentCursorCompletionDiagnostic('suggestion.accepted', {
    position: completion.position,
    replaceCharacters: completion.position - replaceFrom,
    suggestionLength: Array.from(completion.text).length,
    suggestion: documentCursorCompletionSnippet(completion.text),
  })
  return closeHistory(state.tr
    .insertText(completion.text, replaceFrom, completion.position)
    .setMeta(cursorCompletionKey, null))
}

/** 拒绝建议的共享事务：Esc 键/导航键/气泡"拒绝"菜单项同一条通路。 */
function completionDismissTransaction(
  state: EditorState,
  completion: DocumentCursorCompletionState,
  reason: string,
): Transaction {
  recordDocumentCursorCompletionDiagnostic('suggestion.dismissed', {
    reason,
    position: completion.position,
    suggestionLength: Array.from(completion.text).length,
    suggestion: documentCursorCompletionSnippet(completion.text),
  })
  return state.tr.setMeta(cursorCompletionKey, null)
}

export const DocumentCursorCompletionExtension = Extension.create({
  name: 'documentCursorCompletion',
  priority: 1_000,
  addProseMirrorPlugins() {
    return [new Plugin<DocumentCursorCompletionState | null>({
      key: cursorCompletionKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const update = transaction.getMeta(cursorCompletionKey) as DocumentCursorCompletionState | null | undefined
          if (update !== undefined) return update
          if (!current) return null
          if (transaction.docChanged) {
            if (current.replaceFrom !== undefined) return null
            const from = transaction.mapping.map(current.position, -1)
            const to = transaction.mapping.map(current.position, 1)
            const insertedLength = to - from
            const isPlainInsertionAtCursor = from === current.position
              && insertedLength > 0
              && transaction.doc.content.size === transaction.before.content.size + insertedLength
              && transaction.selection.empty
              && transaction.selection.from === to
            if (!isPlainInsertionAtCursor) return null
            const insertedText = transaction.doc.textBetween(from, to, '', '')
            if (!insertedText || !current.text.startsWith(insertedText)) return null
            const remainingText = current.text.slice(insertedText.length)
            // spread 必须保留 menu 文案/labels/mode：前缀消费只改 position/text，灯泡气泡与档位随 ghost 存活。
            return remainingText ? { ...current, position: to, text: remainingText } : null
          }
          if (transaction.selectionSet) return null
          return current
        },
      },
      props: {
        decorations(state) {
          const completion = cursorCompletionKey.getState(state)
          return completion ? completionDecorations(state.doc, completion) : null
        },
        handleKeyDown(view, event) {
          const completion = cursorCompletionKey.getState(view.state)
          if (!completion) return false
          if (event.isComposing || view.composing) return false
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            view.dispatch(completionDismissTransaction(view.state, completion, `navigation:${event.key}`))
            return false
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            view.dispatch(completionDismissTransaction(view.state, completion, 'escape'))
            return true
          }
          if (event.key !== 'Tab'
            || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return false
          }
          event.preventDefault()
          view.dispatch(completionAcceptTransaction(view.state, completion))
          return true
        },
      },
    })]
  },
})

export function currentDocumentCursorCompletion(
  editor: Editor,
): DocumentCursorCompletionState | null {
  return editor.isDestroyed ? null : cursorCompletionKey.getState(editor.state) ?? null
}

export function showDocumentCursorCompletion(
  editor: Editor,
  completion: DocumentCursorCompletionState,
): void {
  if (!completion.text || editor.isDestroyed || !editor.state.selection.empty
    || editor.view.composing
    || editor.state.selection.from !== completion.position
    || (completion.replaceFrom !== undefined
      && (completion.replaceFrom < editor.state.selection.$from.start()
        || completion.replaceFrom > completion.position))) return
  editor.view.dispatch(editor.state.tr.setMeta(cursorCompletionKey, completion))
}

export function clearDocumentCursorCompletion(editor: Editor): void {
  if (editor.isDestroyed || !cursorCompletionKey.getState(editor.state)) return
  editor.view.dispatch(editor.state.tr.setMeta(cursorCompletionKey, null))
}

/** 气泡"接受"菜单项入口：与 Tab 键同一事务。返回是否有建议被接受。 */
export function acceptDocumentCursorCompletion(editor: Editor): boolean {
  const completion = currentDocumentCursorCompletion(editor)
  if (!completion || editor.view.composing) return false
  editor.view.dispatch(completionAcceptTransaction(editor.state, completion))
  return true
}

/** 气泡"拒绝"菜单项入口：与 Esc 键同一事务。返回是否有建议被拒绝。 */
export function dismissDocumentCursorCompletion(editor: Editor, reason = 'menu'): boolean {
  const completion = currentDocumentCursorCompletion(editor)
  if (!completion || editor.view.composing) return false
  editor.view.dispatch(completionDismissTransaction(editor.state, completion, reason))
  return true
}

function nearbyBlockAttrs(ancestors: ProseMirrorNode[]): Record<string, string | number | boolean | null> {
  const attrs: Record<string, string | number | boolean | null> = {}
  for (const ancestor of ancestors) {
    if (ancestor.type.name === 'heading' && typeof ancestor.attrs.level === 'number') {
      attrs.level = ancestor.attrs.level
    } else if (ancestor.type.name === 'codeBlock') {
      attrs.language = typeof ancestor.attrs.language === 'string'
        ? ancestor.attrs.language
        : null
    } else if (ancestor.type.name === 'orderedList'
      && typeof ancestor.attrs.start === 'number') {
      attrs.start = ancestor.attrs.start
    } else if (ancestor.type.name === 'taskItem'
      && typeof ancestor.attrs.checked === 'boolean') {
      attrs.checked = ancestor.attrs.checked
    }
  }
  return attrs
}

function nearbyBlockSnapshot(
  node: ProseMirrorNode,
  ancestors: ProseMirrorNode[],
  relation: DocumentCursorCompletionNearbyBlock['relation'],
): DocumentCursorCompletionNearbyBlock {
  return {
    relation,
    type: node.type.name,
    text: Array.from(node.textContent).slice(0, 320).join(''),
    ancestorTypes: ancestors.map((ancestor) => ancestor.type.name),
    attrs: nearbyBlockAttrs(ancestors),
  }
}

function collectNearbyTextblocks(
  node: ProseMirrorNode,
  ancestors: ProseMirrorNode[],
  relation: 'previous' | 'next',
  reverse: boolean,
  output: DocumentCursorCompletionNearbyBlock[],
  budget: { visited: number },
): void {
  if (output.length >= NEARBY_BLOCK_LIMIT || budget.visited >= NEARBY_NODE_VISIT_LIMIT) return
  budget.visited += 1
  const nodeAncestors = [...ancestors, node]
  if (node.isTextblock) {
    output.push(nearbyBlockSnapshot(node, nodeAncestors, relation))
    return
  }
  if (reverse) {
    for (let index = node.childCount - 1; index >= 0; index -= 1) {
      collectNearbyTextblocks(node.child(index), nodeAncestors, relation, reverse, output, budget)
      if (output.length >= NEARBY_BLOCK_LIMIT || budget.visited >= NEARBY_NODE_VISIT_LIMIT) return
    }
    return
  }
  for (let index = 0; index < node.childCount; index += 1) {
    collectNearbyTextblocks(node.child(index), nodeAncestors, relation, reverse, output, budget)
    if (output.length >= NEARBY_BLOCK_LIMIT || budget.visited >= NEARBY_NODE_VISIT_LIMIT) return
  }
}

function nearbyDocumentBlocks(
  ancestorNodes: ProseMirrorNode[],
  selection: TextSelection,
): DocumentCursorCompletionNearbyBlock[] {
  const previousBlocks: DocumentCursorCompletionNearbyBlock[] = []
  const nextBlocks: DocumentCursorCompletionNearbyBlock[] = []
  const previousBudget = { visited: 0 }
  const nextBudget = { visited: 0 }

  for (let parentDepth = selection.$from.depth - 1;
    parentDepth >= 0 && previousBlocks.length < NEARBY_BLOCK_LIMIT
      && previousBudget.visited < NEARBY_NODE_VISIT_LIMIT;
    parentDepth -= 1) {
    const parent = selection.$from.node(parentDepth)
    const ancestors = ancestorNodes.slice(0, parentDepth + 1)
    for (let index = selection.$from.index(parentDepth) - 1;
      index >= 0 && previousBlocks.length < NEARBY_BLOCK_LIMIT
        && previousBudget.visited < NEARBY_NODE_VISIT_LIMIT;
      index -= 1) {
      collectNearbyTextblocks(
        parent.child(index),
        ancestors,
        'previous',
        true,
        previousBlocks,
        previousBudget,
      )
    }
  }

  for (let parentDepth = selection.$from.depth - 1;
    parentDepth >= 0 && nextBlocks.length < NEARBY_BLOCK_LIMIT
      && nextBudget.visited < NEARBY_NODE_VISIT_LIMIT;
    parentDepth -= 1) {
    const parent = selection.$from.node(parentDepth)
    const ancestors = ancestorNodes.slice(0, parentDepth + 1)
    for (let index = selection.$from.index(parentDepth) + 1;
      index < parent.childCount && nextBlocks.length < NEARBY_BLOCK_LIMIT
        && nextBudget.visited < NEARBY_NODE_VISIT_LIMIT;
      index += 1) {
      collectNearbyTextblocks(
        parent.child(index),
        ancestors,
        'next',
        false,
        nextBlocks,
        nextBudget,
      )
    }
  }

  return [
    ...previousBlocks.reverse(),
    nearbyBlockSnapshot(selection.$from.parent, ancestorNodes, 'current'),
    ...nextBlocks,
  ]
}

/**
 * EditorState 是不可变值——同一 state 引用的上下文提取结果必然相同。
 * 每个击键会触发 2-3 次全量提取（2400 字符 textBetween + nearbyBlocks
 * 遍历 + requestKey 序列化），流式回调还会更频繁，按 state 引用记忆化。
 */
const completionContextCache = new WeakMap<EditorState, DocumentCursorCompletionContext | null>()

export function documentCursorCompletionContext(
  editor: Editor,
): DocumentCursorCompletionContext | null {
  const state = editor.state
  const cached = completionContextCache.get(state)
  if (cached !== undefined) return cached
  const context = computeDocumentCursorCompletionContext(state)
  completionContextCache.set(state, context)
  return context
}

function computeDocumentCursorCompletionContext(
  state: EditorState,
): DocumentCursorCompletionContext | null {
  const selection = state.selection
  if (!(selection instanceof TextSelection) || !selection.empty) return null
  const position = selection.from
  const parent = selection.$from.parent
  if (!parent.isTextblock) return null
  if (Array.from(state.doc.textContent.replace(/\s/gu, '')).length < MIN_TYPED_CHARACTERS) {
    return null
  }
  const blockPrefix = parent.textBetween(0, selection.$from.parentOffset, '\n', '\n')
  const blockSuffix = parent.textBetween(
    selection.$from.parentOffset,
    parent.content.size,
    '\n',
    '\n',
  )
  const ancestorNodes = Array.from(
    { length: selection.$from.depth + 1 },
    (_, depth) => selection.$from.node(depth),
  )
  const ancestorTypes = ancestorNodes.map((node) => node.type.name)
  const codeBlock = [...ancestorNodes].reverse()
    .find((node) => node.type.name === 'codeBlock')
  const listNodes = ancestorNodes.filter((node) =>
    node.type.name === 'bulletList'
    || node.type.name === 'orderedList'
    || node.type.name === 'taskList')
  const nearestList = listNodes.at(-1)
  const listItem = [...ancestorNodes].reverse()
    .find((node) => node.type.name === 'listItem' || node.type.name === 'taskItem')
  const activeMarks = Array.from(new Set(
    (state.storedMarks ?? selection.$from.marks()).map((mark) => mark.type.name),
  ))
  const formatContext: DocumentCursorCompletionFormatContext = {
    ancestorTypes,
    activeMarks,
    ...(codeBlock ? {
      codeLanguage: typeof codeBlock.attrs.language === 'string'
        ? codeBlock.attrs.language
        : null,
      codeLinePrefix: Array.from(blockPrefix.slice(blockPrefix.lastIndexOf('\n') + 1))
        .slice(-200)
        .join(''),
    } : {}),
    ...(parent.type.name === 'heading' && typeof parent.attrs.level === 'number'
      ? { headingLevel: parent.attrs.level }
      : {}),
    ...(nearestList && listItem ? {
      list: {
        type: nearestList.type.name as DocumentCursorCompletionListType,
        depth: listNodes.length,
        itemType: listItem.type.name as 'listItem' | 'taskItem',
        ...(typeof listItem.attrs.checked === 'boolean'
          ? { checked: listItem.attrs.checked }
          : {}),
        ...(nearestList.type.name === 'orderedList' && typeof nearestList.attrs.start === 'number'
          ? { orderedStart: nearestList.attrs.start }
          : {}),
      },
    } : {}),
  }
  const contextBefore = state.doc.textBetween(
    Math.max(0, position - 1_600),
    position,
    '\n',
    '\n',
  )
  const contextAfter = state.doc.textBetween(
    position,
    Math.min(state.doc.content.size, position + 800),
    '\n',
    '\n',
  )
  const nearbyBlocks = nearbyDocumentBlocks(ancestorNodes, selection)
  return {
    position,
    contextBefore,
    contextAfter,
    blockPrefix,
    blockSuffix,
    blockType: parent.type.name,
    formatContext,
    nearbyBlocks,
    requestKey: `${position}:${state.doc.content.size}:${JSON.stringify(formatContext)}:${contextBefore}:${contextAfter}:${JSON.stringify(nearbyBlocks)}`,
  }
}

function plainInsertionAtPosition(transaction: Transaction, position: number): string | null {
  if (!transaction.docChanged) return null
  const from = transaction.mapping.map(position, -1)
  const to = transaction.mapping.map(position, 1)
  const insertedLength = to - from
  const isPlainInsertion = from === position
    && insertedLength > 0
    && transaction.doc.content.size === transaction.before.content.size + insertedLength
    && transaction.selection.empty
    && transaction.selection.from === to
  if (!isPlainInsertion) return null
  return transaction.doc.textBetween(from, to, '', '') || null
}

function completionAfterContinuedTyping(
  suggestion: DocumentCursorCompletionSuggestion,
  typedSinceRequest: string,
): DocumentCursorCompletionSuggestion | 'pending' | 'mismatch' {
  if (!typedSinceRequest) return suggestion
  if (typedSinceRequest.startsWith(suggestion.text)) return 'pending'
  if (!suggestion.text.startsWith(typedSinceRequest)) return 'mismatch'
  return {
    text: suggestion.text.slice(typedSinceRequest.length),
    replaceCharacters: 0,
  }
}

function completionState(
  context: DocumentCursorCompletionContext,
  suggestion: DocumentCursorCompletionSuggestion,
  options: {
    retryLabel?: string
    acceptLabel?: string
    dismissLabel?: string
    mode?: DocumentCursorCompletionMode
  } = {},
): DocumentCursorCompletionState {
  const replaceCharacters = validatedDocumentCursorReplacement(
    context.blockPrefix,
    suggestion.text,
    suggestion.replaceCharacters,
  )
  const replacedText = replaceCharacters > 0
    ? Array.from(context.blockPrefix).slice(-replaceCharacters).join('')
    : ''
  return {
    position: context.position,
    text: suggestion.text,
    ...(replacedText ? { replaceFrom: context.position - replacedText.length } : {}),
    ...(context.formatContext.activeMarks.length > 0
      ? { activeMarks: context.formatContext.activeMarks }
      : {}),
    ...(options.retryLabel ? { retryLabel: options.retryLabel } : {}),
    ...(options.acceptLabel ? { acceptLabel: options.acceptLabel } : {}),
    ...(options.dismissLabel ? { dismissLabel: options.dismissLabel } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  }
}

function insertedCharacterCount(event: InputEvent): number {
  if (event.inputType !== 'insertText' && event.inputType !== 'insertCompositionText') return 0
  return Array.from(event.data ?? '').length
}

function isCompletionDeletion(event: InputEvent): boolean {
  return event.inputType.startsWith('delete')
    && !event.inputType.toLowerCase().includes('composition')
}

function isCompletionTextInsertion(event: InputEvent): boolean {
  return event.inputType.startsWith('insert')
    && event.inputType !== 'insertParagraph'
    && event.inputType !== 'insertLineBreak'
}

function isMiddleOfTextBlock(context: DocumentCursorCompletionContext | null): boolean {
  return Boolean(context?.blockSuffix.length)
}

function shouldCompleteAfterCursorMove(context: DocumentCursorCompletionContext | null): boolean {
  if (!context) return false
  const prefix = context.blockPrefix.trimEnd()
  if (Array.from(prefix.replace(/\s/gu, '')).length < MIN_TYPED_CHARACTERS) return false
  const suffix = context.blockSuffix.trimStart()
  if (!suffix) {
    return !/[.!?。！？][)）\]】}"'”’]*$/u.test(prefix)
  }

  const beforeCursor = Array.from(context.blockPrefix).at(-1) ?? ''
  const afterCursor = Array.from(context.blockSuffix)[0] ?? ''
  return /\s/u.test(beforeCursor)
    || /\s/u.test(afterCursor)
    || ',，:：;；、(（[【{=+-*/>'.includes(beforeCursor)
    || ',，.。!?！？;；:：、)）]】}=+-*/<'.includes(afterCursor)
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'name' in error && error.name === 'AbortError'
}

/**
 * 统计文本块（叶子文本容器）数量：用户按回车分块会让它 +1，而列表项
 * outdent/lift、代码块内换行、hardBreak 插入都不会改变计数——用计数差
 * 区分"Enter 真正开了新块"与其他结构变化，避免把粘贴/程序化插入误判成分块。
 */
function textBlockCount(doc: ProseMirrorNode): number {
  let count = 0
  doc.descendants((node) => {
    if (node.isTextblock) {
      count += 1
      return false
    }
    return true
  })
  return count
}

/** 块内非空白字符是否已达到补全所需的最少量（去掉全部空白后计数）。 */
function hasMinimumBlockContent(prefix: string): boolean {
  return Array.from(prefix.replace(/\s/gu, '')).length >= MIN_TYPED_CHARACTERS
}

/**
 * 词界判定：光标紧跟在空白后、且空白前本块已有 ≥2 个非空白字符。
 * 英文写作"打完词 + 空格 + 停顿"是自然的补全点，但空格只贡献 1 个
 * typed 字符，撞不进 MIN_TYPED_CHARACTERS 门槛——词界状态从编辑器
 * 现势判定（不另存标志位，随 typedCharacters 一同归零的位点免改）。
 */
function isAtWordBoundary(context: DocumentCursorCompletionContext | null): boolean {
  if (!context || !/\s$/u.test(context.blockPrefix)) return false
  return hasMinimumBlockContent(context.blockPrefix)
}

export function useDocumentCursorCompletion({
  editor,
  roomId,
  roomTitle,
  documentName,
  enabled,
  paragraphEnabled = true,
}: {
  editor: Editor | null
  roomId: string
  roomTitle: string
  documentName: string
  enabled: boolean
  /** 段落档开关；关闭后仅保留行内短补全。 */
  paragraphEnabled?: boolean
}): boolean {
  const { locale } = useLocale()
  const [running, setRunning] = useState(false)
  const enabledRef = useRef(enabled)
  const paragraphEnabledRef = useRef(paragraphEnabled)
  const requestRef = useRef<ActiveCompletionRequest | null>(null)
  const timers = useRef<CompletionTimers>({ inline: null, paragraph: null })
  const typedCharacters = useRef(0)
  const deletedContent = useRef(false)
  enabledRef.current = enabled
  paragraphEnabledRef.current = paragraphEnabled

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const editorElement = editor.view.dom
    // 会话/订阅复用通道：effect 生命周期内一份，卸载时拆除。
    let completionChannel: DocumentCursorCompletionSessionChannel | null = null
    const fixedT = i18n.getFixedT(locale, 'common')
    const retryLabel = fixedT('contextRoom:documentCursorCompletionAgent.retryLabel')
    const acceptLabel = fixedT('contextRoom:documentCursorCompletionAgent.acceptLabel')
    const dismissLabel = fixedT('contextRoom:documentCursorCompletionAgent.dismissLabel')

    const cancelPending = (clearSuggestion: boolean, reason = 'cancelled') => {
      clearCompletionTimers(timers.current, reason)
      const activeRequest = requestRef.current
      if (activeRequest) abortCompletionRequest(activeRequest, reason)
      if (requestRef.current === activeRequest) {
        requestRef.current = null
        setRunning(false)
      }
      if (clearSuggestion) {
        const completion = currentDocumentCursorCompletion(editor)
        if (completion) {
          recordDocumentCursorCompletionDiagnostic('suggestion.dismissed', {
            reason,
            position: completion.position,
            suggestionLength: Array.from(completion.text).length,
            suggestion: documentCursorCompletionSnippet(completion.text),
          })
        }
        clearDocumentCursorCompletion(editor)
      }
    }

    const requestCompletion = (
      trigger: DocumentCursorCompletionTrigger,
      options: { completionMode?: DocumentCursorCompletionMode; avoidText?: string } = {},
    ) => {
      // 档位单调：活跃段落流在途时，行内 timer 的重触发升级为段落档，
      // 不把 300 字 ghost 的后续流降级杀掉。
      const completionMode: DocumentCursorCompletionMode = options.completionMode === 'paragraph'
        || requestRef.current?.completionMode === 'paragraph'
        ? 'paragraph'
        : 'inline'
      const avoidText = options.avoidText
      const circuitCooldownMs = documentCursorCompletionCircuitBreaker.cooldownRemainingMs()
      const skipReason = !enabledRef.current
        ? 'disabled'
        : editor.isDestroyed
          ? 'editor_destroyed'
          : !editor.isEditable
            ? 'editor_readonly'
            : !editor.view.hasFocus()
              ? 'editor_blurred'
              : editor.view.composing
                ? 'composing'
                : circuitCooldownMs > 0 ? 'circuit_open' : null
      if (skipReason) {
        recordDocumentCursorCompletionDiagnostic('request.skipped', {
          trigger,
          reason: skipReason,
          ...(skipReason === 'circuit_open' ? { cooldownMs: circuitCooldownMs } : {}),
        })
        return
      }
      const context = documentCursorCompletionContext(editor)
      const api = window.nxcore?.cursorCompletionAgent
      if (!context || !api) {
        recordDocumentCursorCompletionDiagnostic('request.skipped', {
          trigger,
          reason: context ? 'agent_api_unavailable' : 'no_completion_context',
        })
        return
      }
      // 防御兜底：idle 路径不会在代码块挂段落 timer，重生成路径在此降级。
      const effectiveMode = completionMode === 'paragraph' && context.blockType === 'codeBlock'
        ? 'inline'
        : completionMode
      if (effectiveMode !== completionMode) {
        recordDocumentCursorCompletionDiagnostic('request.degraded', {
          trigger,
          reason: 'paragraph_unsupported_block',
          blockType: context.blockType,
        })
      }
      completionChannel ??= new DocumentCursorCompletionSessionChannel(api, {
        roomId,
        roomTitle,
        documentName,
        responseLanguage: locale,
      })

      if (requestRef.current) abortCompletionRequest(requestRef.current, 'superseded')
      const controller = new AbortController()
      const request: ActiveCompletionRequest = {
        controller,
        diagnosticEnded: false,
        diagnosticId: nextDocumentCursorCompletionRequestId(),
        diagnosticStartedAt: Date.now(),
        diagnosticTrigger: trigger,
        lastDiagnosticShown: null,
        lastDiagnosticSuggestion: null,
        currentRequestKey: context.requestKey,
        position: context.position,
        typedSinceRequest: '',
        visibleText: null,
        visibleReplacement: false,
        completionMode: effectiveMode,
      }
      requestRef.current = request
      setRunning(true)
      recordDocumentCursorCompletionDiagnostic('request.started', {
        requestId: request.diagnosticId,
        trigger,
        roomId,
        documentName: documentCursorCompletionSnippet(documentName, 80),
        position: context.position,
        blockType: context.blockType,
        completionMode: effectiveMode,
        ...(avoidText ? { avoidTextLength: Array.from(avoidText).length } : {}),
        blockPrefixLength: Array.from(context.blockPrefix).length,
        blockSuffixLength: Array.from(context.blockSuffix).length,
        prefixTail: documentCursorCompletionSnippet(Array.from(context.blockPrefix).slice(-120).join('')),
        suffixHead: documentCursorCompletionSnippet(Array.from(context.blockSuffix).slice(0, 120).join('')),
        contextBeforeLength: Array.from(context.contextBefore).length,
        contextAfterLength: Array.from(context.contextAfter).length,
      })
      void streamDocumentCursorCompletion(api, {
        roomId,
        roomTitle,
        documentName,
        contextBefore: context.contextBefore,
        contextAfter: context.contextAfter,
        blockPrefix: Array.from(context.blockPrefix).slice(
          -(effectiveMode === 'paragraph' ? PARAGRAPH_PREFIX_CODEPOINTS : 200),
        ).join(''),
        blockSuffix: Array.from(context.blockSuffix).slice(0, 200).join(''),
        blockType: context.blockType,
        formatContext: context.formatContext,
        nearbyBlocks: context.nearbyBlocks,
        completionMode: effectiveMode,
        ...(avoidText ? { avoidText } : {}),
      }, {
        signal: controller.signal,
        responseLanguage: locale,
        resolveWritingStyleBlock: loadCompletionWritingStyleBlock,
        ...(effectiveMode === 'paragraph' ? { timeoutMs: PARAGRAPH_STREAM_TIMEOUT_MS } : {}),
        channel: completionChannel ?? undefined,
        onSuggestion: (suggestion) => {
          const active = requestRef.current
          const currentContext = documentCursorCompletionContext(editor)
          const suggestionSignature = `${suggestion.replaceCharacters}:${suggestion.text}`
          if (request.lastDiagnosticSuggestion !== suggestionSignature) {
            request.lastDiagnosticSuggestion = suggestionSignature
            recordDocumentCursorCompletionDiagnostic('suggestion.received', {
              requestId: request.diagnosticId,
              active: active === request,
              contextMatches: active?.currentRequestKey === currentContext?.requestKey,
              replaceCharacters: suggestion.replaceCharacters,
              suggestionLength: Array.from(suggestion.text).length,
              suggestion: documentCursorCompletionSnippet(suggestion.text),
            })
          }
          if (!suggestion.text || active !== request
            || active.currentRequestKey !== currentContext?.requestKey) return
          const resolved = completionAfterContinuedTyping(suggestion, active.typedSinceRequest)
          if (resolved === 'pending') return
          if (resolved === 'mismatch') {
            abortCompletionRequest(request, 'continued_typing_mismatch')
            if (requestRef.current === request) {
              requestRef.current = null
              setRunning(false)
            }
            clearDocumentCursorCompletion(editor)
            return
          }
          if (!resolved.text) {
            clearDocumentCursorCompletion(editor)
            return
          }
          const completion = completionState(currentContext, resolved, {
            retryLabel,
            acceptLabel,
            dismissLabel,
            mode: effectiveMode,
          })
          active.visibleText = completion.text
          active.visibleReplacement = completion.replaceFrom !== undefined
          showDocumentCursorCompletion(editor, completion)
          recordShownCompletion(request, completion)
        },
      }).then((suggestion) => {
        documentCursorCompletionCircuitBreaker.recordSuccess()
        if (!request.diagnosticEnded) {
          request.diagnosticEnded = true
          recordDocumentCursorCompletionDiagnostic('request.completed', {
            requestId: request.diagnosticId,
            trigger: request.diagnosticTrigger,
            durationMs: Date.now() - request.diagnosticStartedAt,
            replaceCharacters: suggestion.replaceCharacters,
            suggestionLength: Array.from(suggestion.text).length,
            suggestion: documentCursorCompletionSnippet(suggestion.text),
          })
        }
        const active = requestRef.current
        const currentContext = documentCursorCompletionContext(editor)
        if (active !== request || active.currentRequestKey !== currentContext?.requestKey) return
        const resolved = completionAfterContinuedTyping(suggestion, active.typedSinceRequest)
        if (resolved === 'pending' || resolved === 'mismatch' || !resolved.text) return
        const completion = completionState(currentContext, resolved, {
          retryLabel,
          acceptLabel,
          dismissLabel,
          mode: effectiveMode,
        })
        if (avoidText && completion.text === avoidText) {
          // 模型没理会 avoidText：照常展示（用户还能 Esc/再重生成），但记录可观测信号。
          recordDocumentCursorCompletionDiagnostic('suggestion.regenerate_repeated', {
            requestId: request.diagnosticId,
            suggestionLength: Array.from(completion.text).length,
          })
        }
        active.visibleText = completion.text
        active.visibleReplacement = completion.replaceFrom !== undefined
        showDocumentCursorCompletion(editor, completion)
        recordShownCompletion(request, completion)
      }).catch((error: unknown) => {
        const errorKind = classifyDocumentCursorCompletionError(error)
        // abort 是调用方主动取消；session 失联已由通道内重建、session_busy 已由
        // 通道内退避重试兜住（重试耗尽也只是暂态竞态）——三者不计熔断。
        // no_completion 是模型正常表示「此处无话可补」（KEEP 协议），链路本身
        // 端到端跑通：按成功清零失败连击——否则快速编辑中连续三次"没得补"
        // 就把熔断打开，真正的补全也被跳过。
        if (errorKind === 'no_completion') {
          documentCursorCompletionCircuitBreaker.recordSuccess()
        } else if (errorKind !== 'aborted' && errorKind !== 'session_not_found' && errorKind !== 'session_busy') {
          documentCursorCompletionCircuitBreaker.recordFailure()
        }
        if (!request.diagnosticEnded) {
          request.diagnosticEnded = true
          recordDocumentCursorCompletionDiagnostic(
            isAbortError(error) ? 'request.cancelled' : 'request.failed',
            {
              requestId: request.diagnosticId,
              trigger: request.diagnosticTrigger,
              reason: isAbortError(error) ? 'upstream_abort' : 'stream_error',
              errorKind,
              durationMs: Date.now() - request.diagnosticStartedAt,
              ...(error instanceof Error ? { message: error.message.slice(0, 500) } : {}),
            },
            isAbortError(error) ? 'info' : errorKind === 'no_completion' ? 'warn' : 'error',
          )
        }
        if (!isAbortError(error)) {
          clearDocumentCursorCompletion(editor)
        }
      }).finally(() => {
        if (requestRef.current === request) {
          requestRef.current = null
          setRunning(false)
        }
      })
    }

    const scheduleCompletion = ({
      preserveActiveRequest = false,
      forceRequest = false,
      trigger = 'typing',
    }: {
      preserveActiveRequest?: boolean
      forceRequest?: boolean
      trigger?: DocumentCursorCompletionTrigger
    } = {}) => {
      // A matching manual insertion can consume the streamed prefix while the
      // same FIM run continues producing the remainder.
      clearCompletionTimers(timers.current)
      if (!preserveActiveRequest) {
        const activeRequest = requestRef.current
        if (activeRequest) abortCompletionRequest(activeRequest, `rescheduled:${trigger}`)
        if (requestRef.current === activeRequest) {
          requestRef.current = null
          setRunning(false)
        }
      }
      if (!enabledRef.current) return
      const scheduledContext = documentCursorCompletionContext(editor)
      const armParagraph = paragraphEnabledRef.current
        && scheduledContext !== null
        && scheduledContext.blockType !== 'codeBlock'
        && !isMiddleOfTextBlock(scheduledContext)
      recordDocumentCursorCompletionDiagnostic('schedule.created', {
        trigger,
        delayMs: DOCUMENT_CURSOR_COMPLETION_DELAY_MS,
        forceRequest,
        tiers: armParagraph ? ['inline', 'paragraph'] : ['inline'],
        typedCharacters: typedCharacters.current,
        deletion: deletedContent.current,
        position: scheduledContext?.position ?? null,
        blockType: scheduledContext?.blockType ?? null,
      })
      timers.current.inline = window.setTimeout(() => {
        clearCompletionTimerSlot(timers.current, 'inline')
        // 词界豁免：光标停在"词 + 空格"后是英文写作的自然补全点，
        // 单个空格只攒 1 个 typed 字符，不该被字符门槛拦下。
        if (!forceRequest
          && typedCharacters.current < MIN_TYPED_CHARACTERS
          && !deletedContent.current
          && !isAtWordBoundary(documentCursorCompletionContext(editor))) {
          typedCharacters.current = 0
          deletedContent.current = false
          // 行内门槛不过时连带撤掉段落 timer：1500ms 只会再撞同一门槛，白记一条诊断。
          clearCompletionTimerSlot(timers.current, 'paragraph')
          recordDocumentCursorCompletionDiagnostic('request.skipped', {
            trigger,
            reason: 'minimum_typed_characters',
          })
          return
        }
        typedCharacters.current = 0
        deletedContent.current = false
        requestCompletion(trigger)
      }, DOCUMENT_CURSOR_COMPLETION_DELAY_MS)
      if (armParagraph) {
        timers.current.paragraph = window.setTimeout(() => {
          clearCompletionTimerSlot(timers.current, 'paragraph')
          // 条件升级：行内请求还在等首 token（无 ghost）时不再另起段落请求——
          // 模型首 token 实测秒级，杀掉重发只会把延迟清零再付一遍，还制造
          // session_busy 竞态；让它跑完自然交付（行内 4s 首建议/10s 总预算）。
          // 行内已上屏才升级：段落流首个 partial 原子替换 inline ghost，渐进不闪。
          if (requestRef.current?.completionMode === 'inline'
            && !currentDocumentCursorCompletion(editor)) {
            recordDocumentCursorCompletionDiagnostic('request.skipped', {
              trigger: 'paragraph-idle',
              reason: 'inline_pending',
            })
            return
          }
          requestCompletion('paragraph-idle', { completionMode: 'paragraph' })
        }, DOCUMENT_CURSOR_COMPLETION_PARAGRAPH_DELAY_MS)
      }
    }

    let composing = false
    let pendingBeforeInputText: string | null = null
    let preserveRequestForNextInput = false
    let pendingDeletionIntent: { timer: number | null } | null = null
    let pendingSplitIntent: { timer: number | null } | null = null
    let compositionCommit: {
      data: string
      counted: boolean
      timer: number | null
    } | null = null
    const clearCompositionCommit = () => {
      const commit = compositionCommit
      if (commit && commit.timer !== null) {
        window.clearTimeout(commit.timer)
      }
      compositionCommit = null
    }
    const clearDeletionIntent = () => {
      if (pendingDeletionIntent && pendingDeletionIntent.timer !== null) {
        window.clearTimeout(pendingDeletionIntent.timer)
      }
      pendingDeletionIntent = null
    }
    const armDeletionIntent = () => {
      clearDeletionIntent()
      const intent = { timer: null as number | null }
      pendingDeletionIntent = intent
      intent.timer = window.setTimeout(() => {
        if (pendingDeletionIntent === intent) pendingDeletionIntent = null
      }, 0)
    }
    // 回车分块意图：PM 对 Enter 一律 preventDefault（captureKeyDown 里
    // keyCode 13 直接 return true），真实浏览器不会产生 beforeinput/input
    // 事件——回车只能在 keydown（capture，先于 PM 的 bubble 监听）预埋
    // 意图，再到 transaction 里按文本块计数差匹配，与删除意图同一套路。
    const clearSplitIntent = () => {
      if (pendingSplitIntent && pendingSplitIntent.timer !== null) {
        window.clearTimeout(pendingSplitIntent.timer)
      }
      pendingSplitIntent = null
    }
    const armSplitIntent = () => {
      clearSplitIntent()
      const intent = { timer: null as number | null }
      pendingSplitIntent = intent
      intent.timer = window.setTimeout(() => {
        if (pendingSplitIntent === intent) pendingSplitIntent = null
      }, 0)
    }
    const countCompositionCommit = (commit: NonNullable<typeof compositionCommit>) => {
      if (commit.counted || compositionCommit !== commit) return
      commit.counted = true
      typedCharacters.current += Array.from(commit.data).length
      // IME 单字上屏（的/了/好…）只攒 1 个 typed 字符，撞不进字符门槛；
      // 候选词是用户的明确抉择，块尾且前文充足时按词界同权放行。
      const context = documentCursorCompletionContext(editor)
      const committedAtBlockEnd = context !== null && !context.blockSuffix.length
        && hasMinimumBlockContent(context.blockPrefix)
      scheduleCompletion({
        forceRequest: isMiddleOfTextBlock(context) || committedAtBlockEnd,
        trigger: 'composition',
      })
    }
    const handleBeforeInput = (event: Event) => {
      if (!(event instanceof InputEvent) || composing || event.isComposing) {
        pendingBeforeInputText = null
        return
      }
      pendingBeforeInputText = insertedCharacterCount(event) > 0 ? event.data : null
      if (isCompletionDeletion(event)) armDeletionIntent()
    }
    const handleInput = (event: Event) => {
      pendingBeforeInputText = null
      if (!(event instanceof InputEvent)) {
        typedCharacters.current = 0
        deletedContent.current = false
        clearCompositionCommit()
        cancelPending(true, 'unsupported_input')
        return
      }
      if (composing || event.isComposing) return
      if (compositionCommit) {
        const commit = compositionCommit
        const isFinalCompositionInput = event.inputType === 'insertText'
          || event.inputType === 'insertCompositionText'
          || event.inputType === 'insertFromComposition'
        if (isFinalCompositionInput) {
          if (commit.timer !== null) window.clearTimeout(commit.timer)
          countCompositionCommit(commit)
          commit.timer = window.setTimeout(() => {
            if (compositionCommit === commit) compositionCommit = null
          }, 0)
          return
        }
        clearCompositionCommit()
      }
      if (isCompletionDeletion(event)) {
        typedCharacters.current = 0
        deletedContent.current = true
        scheduleCompletion({ forceRequest: true, trigger: 'deletion' })
        return
      }
      const inserted = insertedCharacterCount(event)
      if (inserted === 0) {
        // 分块的 input 事件（若浏览器补发）不能反杀 transaction 路径刚挂的
        // paragraph-break 调度——分块触发只认 keydown 意图 + 文本块计数差。
        if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') return
        const context = documentCursorCompletionContext(editor)
        if (isCompletionTextInsertion(event) && isMiddleOfTextBlock(context)) {
          typedCharacters.current = 0
          deletedContent.current = false
          scheduleCompletion({ forceRequest: true, trigger: 'middle-edit' })
          return
        }
        typedCharacters.current = 0
        deletedContent.current = false
        cancelPending(true)
        return
      }
      typedCharacters.current += inserted
      const preserveActiveRequest = preserveRequestForNextInput
      const middleEdit = isMiddleOfTextBlock(documentCursorCompletionContext(editor))
      scheduleCompletion({
        preserveActiveRequest,
        forceRequest: !preserveActiveRequest && middleEdit,
        trigger: preserveActiveRequest
          ? 'continued-typing'
          : middleEdit ? 'middle-edit' : 'typing',
      })
      preserveRequestForNextInput = false
    }
    const handleCompositionStart = () => {
      composing = true
      clearCompositionCommit()
      clearDeletionIntent()
      clearSplitIntent()
      typedCharacters.current = 0
      deletedContent.current = false
      cancelPending(true, 'composition_start')
    }
    const handleCompositionEnd = (event: CompositionEvent) => {
      composing = false
      const data = event.data ?? ''
      if (!data) return
      const commit = { data, counted: false, timer: null as number | null }
      compositionCommit = commit
      commit.timer = window.setTimeout(() => {
        countCompositionCommit(commit)
        if (compositionCommit !== commit) return
        commit.timer = window.setTimeout(() => {
          if (compositionCommit === commit) compositionCommit = null
        }, 0)
      }, 0)
    }
    const handlePointerDown = () => {
      typedCharacters.current = 0
      deletedContent.current = false
      clearCompositionCommit()
      clearDeletionIntent()
      clearSplitIntent()
      cancelPending(true, 'pointer_down')
    }
    const handleKeyDownCapture = (event: KeyboardEvent) => {
      if (!composing && !event.isComposing
        && (event.key === 'Backspace' || event.key === 'Delete')) {
        armDeletionIntent()
        typedCharacters.current = 0
        deletedContent.current = true
        cancelPending(true, 'deletion')
        return
      }
      // 纯 Enter / Shift+Enter：只预埋意图，是否真分块由 transaction 的
      // 文本块计数差决定（空列表项回车是 outdent，hardBreak 不加块）。
      // 带 Cmd/Ctrl/Alt 的组合键不是用户分块输入，不预埋。
      if (!composing && !event.isComposing
        && event.key === 'Enter'
        && !event.altKey && !event.ctrlKey && !event.metaKey) {
        armSplitIntent()
        return
      }
      // 导航键必须在 capture 阶段清理：PM 对方向键的处理在它自己的
      // keydown（bubble，注册早于本 hook）里同步 dispatch 选区事务，
      // handleTransaction 随之挂上 cursor-move 调度——若清场动作放在
      // bubble 阶段（注册序在 PM 之后），会把刚挂好的调度反手杀掉，
      // 方向键移动光标将永远无法触发补全（鼠标/End 事务是异步路径不受影响）。
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) {
        typedCharacters.current = 0
        deletedContent.current = false
        clearCompositionCommit()
        clearDeletionIntent()
        clearSplitIntent()
        cancelPending(true, `navigation:${event.key}`)
      }
    }
    // 灯泡气泡"重写"按钮经 CustomEvent 冒泡到这里（见 buildDocumentCursorCompletionGhost）。
    const handleRetry = () => {
      const ghost = currentDocumentCursorCompletion(editor)
      if (!ghost) return
      const context = documentCursorCompletionContext(editor)
      const requestKey = context?.requestKey ?? ''
      const regenerations = regenerateCounts.get(requestKey) ?? 0
      if (regenerations >= REGENERATE_LIMIT_PER_REQUEST) {
        recordDocumentCursorCompletionDiagnostic('request.skipped', {
          trigger: 'regenerate',
          reason: 'regenerate_limit',
        })
        return
      }
      regenerateCounts.set(requestKey, regenerations + 1)
      if (regenerateCounts.size > REGENERATE_CACHE_LIMIT) {
        const oldestKey = regenerateCounts.keys().next().value
        if (oldestKey !== undefined) regenerateCounts.delete(oldestKey)
      }
      clearCompletionTimers(timers.current, 'regenerate')
      // 上下文现算（WeakMap 缓存必命中）；已消费的前缀已进 blockPrefix，
      // 剩余 ghost 文本才是被否决的提案。
      requestCompletion('regenerate', {
        completionMode: ghost.mode ?? 'inline',
        avoidText: ghost.text,
      })
    }
    // 气泡"接受/拒绝"菜单项经 CustomEvent 冒泡到这里；事务与 Tab/Esc 键同一通路。
    const handleAccept = () => {
      // 接受样例要在应用前取（accept 会清掉补全状态）；仅显式接受计入反馈。
      const acceptedCompletion = currentDocumentCursorCompletion(editor)
      if (!acceptDocumentCursorCompletion(editor)) return
      recordCompletionAcceptance(acceptedCompletion?.text)
      clearCompletionTimers(timers.current, 'accepted')
      const activeRequest = requestRef.current
      if (activeRequest) abortCompletionRequest(activeRequest, 'accepted')
      if (requestRef.current === activeRequest) {
        requestRef.current = null
        setRunning(false)
      }
    }
    const handleDismiss = () => {
      if (!dismissDocumentCursorCompletion(editor, 'menu')) return
      recordCompletionRejection()
      clearCompletionTimers(timers.current, 'dismissed')
      const activeRequest = requestRef.current
      if (activeRequest) abortCompletionRequest(activeRequest, 'dismissed')
      if (requestRef.current === activeRequest) {
        requestRef.current = null
        setRunning(false)
      }
    }
    const handleFocusOut = () => {
      typedCharacters.current = 0
      deletedContent.current = false
      clearCompositionCommit()
      clearDeletionIntent()
      clearSplitIntent()
      cancelPending(true, 'focus_out')
    }
    const handleTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged && !transaction.selectionSet
        && transaction.getMeta(cursorCompletionKey) !== null) return
      if (transaction.docChanged && compositionCommit !== null) return
      const deletionFromUserIntent = pendingDeletionIntent !== null
        && transaction.docChanged
        && transaction.doc.content.size < transaction.before.content.size
        && transaction.getMeta(cursorCompletionKey) === undefined
      if (deletionFromUserIntent) {
        clearDeletionIntent()
        typedCharacters.current = 0
        deletedContent.current = true
        scheduleCompletion({ forceRequest: true, trigger: 'deletion' })
        return
      }
      // 回车分块（列表新条目/新段落）：forceRequest 与删除同权——新空块的
      // blockPrefix 必然是空的，字符门槛不可能靠 typed 计数过。
      const splitFromUserIntent = pendingSplitIntent !== null
        && transaction.docChanged
        && transaction.getMeta(cursorCompletionKey) === undefined
        && textBlockCount(transaction.doc) > textBlockCount(transaction.before)
      if (splitFromUserIntent) {
        clearSplitIntent()
        typedCharacters.current = 0
        deletedContent.current = false
        scheduleCompletion({ forceRequest: true, trigger: 'paragraph-break' })
        return
      }
      const activeRequest = requestRef.current
      if (activeRequest && transaction.docChanged
        && transaction.getMeta(cursorCompletionKey) === undefined) {
        const insertedText = plainInsertionAtPosition(transaction, activeRequest.position)
        const currentContext = insertedText ? documentCursorCompletionContext(editor) : null
        const matchesVisibleCompletion = activeRequest.visibleText === null
          || activeRequest.visibleText === ''
          || (!activeRequest.visibleReplacement
            && activeRequest.visibleText.startsWith(insertedText ?? ''))
        if (insertedText && insertedText === pendingBeforeInputText
          && currentContext && matchesVisibleCompletion
          && currentContext.position === activeRequest.position + insertedText.length) {
          activeRequest.position += insertedText.length
          activeRequest.typedSinceRequest += insertedText
          activeRequest.visibleText = activeRequest.visibleText?.slice(insertedText.length) ?? null
          activeRequest.currentRequestKey = currentContext.requestKey
          preserveRequestForNextInput = true
          return
        }
      }
      const shouldScheduleForNewSelection = transaction.selectionSet
        && !transaction.docChanged
        && transaction.getMeta(cursorCompletionKey) === undefined
      typedCharacters.current = 0
      deletedContent.current = false
      cancelPending(!currentDocumentCursorCompletion(editor), transaction.docChanged ? 'document_changed' : 'selection_changed')
      if (shouldScheduleForNewSelection
        && shouldCompleteAfterCursorMove(documentCursorCompletionContext(editor))) {
        scheduleCompletion({ forceRequest: true, trigger: 'cursor-move' })
      }
    }

    editorElement.addEventListener('beforeinput', handleBeforeInput, true)
    editorElement.addEventListener('input', handleInput)
    editorElement.addEventListener('compositionstart', handleCompositionStart)
    editorElement.addEventListener('compositionend', handleCompositionEnd)
    editorElement.addEventListener('pointerdown', handlePointerDown)
    editorElement.addEventListener('keydown', handleKeyDownCapture, true)
    editorElement.addEventListener(DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT, handleRetry)
    editorElement.addEventListener(DOCUMENT_CURSOR_COMPLETION_ACCEPT_EVENT, handleAccept)
    editorElement.addEventListener(DOCUMENT_CURSOR_COMPLETION_DISMISS_EVENT, handleDismiss)
    editorElement.addEventListener('focusout', handleFocusOut)
    editor.on('transaction', handleTransaction)
    return () => {
      clearCompositionCommit()
      clearDeletionIntent()
      clearSplitIntent()
      cancelPending(true, 'unmounted')
      completionChannel?.dispose()
      editorElement.removeEventListener('beforeinput', handleBeforeInput, true)
      editorElement.removeEventListener('input', handleInput)
      editorElement.removeEventListener('compositionstart', handleCompositionStart)
      editorElement.removeEventListener('compositionend', handleCompositionEnd)
      editorElement.removeEventListener('pointerdown', handlePointerDown)
      editorElement.removeEventListener('keydown', handleKeyDownCapture, true)
      editorElement.removeEventListener(DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT, handleRetry)
      editorElement.removeEventListener(DOCUMENT_CURSOR_COMPLETION_ACCEPT_EVENT, handleAccept)
      editorElement.removeEventListener(DOCUMENT_CURSOR_COMPLETION_DISMISS_EVENT, handleDismiss)
      editorElement.removeEventListener('focusout', handleFocusOut)
      editor.off('transaction', handleTransaction)
    }
  }, [documentName, editor, locale, roomId])

  useEffect(() => {
    if (enabled || !editor) return
    typedCharacters.current = 0
    deletedContent.current = false
    clearCompletionTimers(timers.current, 'disabled')
    const activeRequest = requestRef.current
    if (activeRequest) abortCompletionRequest(activeRequest, 'disabled')
    if (requestRef.current === activeRequest) {
      requestRef.current = null
      setRunning(false)
    }
    clearDocumentCursorCompletion(editor)
  }, [editor, enabled])

  useEffect(() => {
    if (paragraphEnabled || !editor) return
    clearCompletionTimerSlot(timers.current, 'paragraph')
    const activeRequest = requestRef.current
    if (activeRequest?.completionMode === 'paragraph') {
      abortCompletionRequest(activeRequest, 'paragraph_disabled')
      if (requestRef.current === activeRequest) {
        requestRef.current = null
        setRunning(false)
      }
      clearDocumentCursorCompletion(editor)
    }
  }, [editor, paragraphEnabled])

  return running
}
