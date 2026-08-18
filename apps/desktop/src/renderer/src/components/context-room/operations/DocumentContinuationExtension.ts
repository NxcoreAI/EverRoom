import type { DocumentMutationTarget } from '@nxcore/agent-contract'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Extension, type Editor } from '@tiptap/react'
import { Check, CheckCheck, MessageSquareX, Send, X } from 'lucide-react'
import { createElement, Fragment as ReactFragment, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DocumentContinuationCandidate } from './presenterRegistry'
import {
  continuationRevealScrollTop,
  shouldHandleContinuationTab,
} from './documentContinuationState'

interface DocumentContinuationDecorationState {
  blocks: DocumentContinuationCandidate[]
  currentBlockId: string
  queuedDecisions: Record<string, 'accepted' | 'rejected' | undefined>
  markdownDrafts: Record<string, string>
  busy: boolean
  autoReveal: boolean
  onAccept: (blockId: string) => Promise<void>
  onAcceptAll: () => Promise<void>
  onRevise: (blockId: string, feedback: string) => Promise<void>
  onDraftChange: (blockId: string, markdown: string) => void
}

const continuationKey = new PluginKey<DocumentContinuationDecorationState | null>('documentContinuation')
const continuationActionRoots = new WeakMap<Node, Root>()

function blockId(node: ProseMirrorNode): string {
  const value = node.attrs.id ?? node.attrs.blockId
  return typeof value === 'string' ? value : ''
}

function textOffsetPosition(node: ProseMirrorNode, nodePosition: number, offset: number): number {
  let remaining = Math.max(0, offset)
  let result = nodePosition + 1
  node.descendants((child, relativePosition) => {
    if (!child.isText) return
    const length = child.text?.length ?? 0
    if (remaining <= length) {
      result = nodePosition + 1 + relativePosition + remaining
      return false
    }
    remaining -= length
    result = nodePosition + 1 + relativePosition + length
  })
  return result
}

export function continuationTargetPosition(
  doc: ProseMirrorNode,
  target: DocumentMutationTarget,
): number {
  if ('at' in target) return doc.content.size
  const wantedId = 'toBlockId' in target ? target.toBlockId : target.blockId
  let result = doc.content.size
  doc.descendants((node, position) => {
    if (blockId(node) !== wantedId) return
    if ('edge' in target) result = target.edge === 'before' ? position : position + node.nodeSize
    else if ('fromOffset' in target || 'toOffset' in target) {
      result = textOffsetPosition(node, position, target.fromOffset ?? target.toOffset ?? node.textContent.length)
    } else result = position + node.nodeSize
    return false
  })
  return result
}

export function DocumentContinuationActions({
  busy,
  onAccept,
  onAcceptAll,
  onRevise,
}: {
  busy: boolean
  onAccept: () => Promise<void>
  onAcceptAll: () => Promise<void>
  onRevise: (feedback: string) => Promise<void>
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submitFeedback = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = feedback.trim()
    if (busy || submitting) return
    setSubmitting(true)
    try {
      await onRevise(normalized)
    } catch {
      setSubmitting(false)
    }
  }

  if (feedbackOpen) {
    return createElement('form', {
      className: 'document-continuation-feedback',
      onSubmit: submitFeedback,
      onMouseDown: (event: ReactMouseEvent) => { event.stopPropagation() },
    },
    createElement('textarea', {
      value: feedback,
      maxLength: 1000,
      autoFocus: true,
      disabled: busy || submitting,
      placeholder: '告诉 Agent 接下来怎么改（可选）',
      'aria-label': '续写修改意见',
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setFeedback(event.target.value),
    }),
    createElement('div', { className: 'document-continuation-feedback-actions' },
      createElement('button', {
        type: 'button',
        title: '取消修改意见',
        'aria-label': '取消修改意见',
        disabled: busy || submitting,
        onClick: () => setFeedbackOpen(false),
      }, createElement(X, { 'aria-hidden': true })),
      createElement('button', {
        type: 'submit',
        className: 'is-submit',
        title: '按意见重新续写',
        'aria-label': '按意见重新续写',
        disabled: busy || submitting,
      }, createElement(Send, { 'aria-hidden': true }), '重新续写'),
    ))
  }

  return createElement(ReactFragment, null,
    createElement('button', {
      type: 'button',
      className: 'is-accept',
      title: '同意当前这块',
      'aria-label': '同意当前这块',
      disabled: busy,
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
      onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void onAccept() },
    }, createElement(Check, { 'aria-hidden': true }), '同意当前'),
    createElement('button', {
      type: 'button',
      className: 'is-accept-all',
      title: '同意后面所有续写',
      'aria-label': '同意后面所有续写',
      disabled: busy,
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
      onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void onAcceptAll() },
    }, createElement(CheckCheck, { 'aria-hidden': true }), '同意后面所有'),
    createElement('button', {
      type: 'button',
      className: 'is-reject',
      title: '不同意并提出修改意见',
      'aria-label': '不同意并提出修改意见',
      disabled: busy,
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
      onClick: (event: ReactMouseEvent) => { event.stopPropagation(); setFeedbackOpen(true) },
    }, createElement(MessageSquareX, { 'aria-hidden': true }), '不同意'),
  )
}

function continuationDecorations(
  doc: ProseMirrorNode,
  state: DocumentContinuationDecorationState,
): DecorationSet {
  const currentBlock = state.blocks.find((block) => block.blockId === state.currentBlockId)
  if (!currentBlock) return DecorationSet.empty
  const position = continuationTargetPosition(doc, currentBlock.target)
  return DecorationSet.create(doc, [Decoration.widget(position, (view) => {
    const candidate = document.createElement('div')
    candidate.className = 'document-continuation-candidate'
    candidate.dataset.blockId = currentBlock.blockId
    candidate.dataset.busy = String(state.busy)
    candidate.dataset.documentContinuationCandidate = 'true'
    candidate.tabIndex = 0
    candidate.contentEditable = 'false'
    candidate.setAttribute('role', 'region')
    candidate.setAttribute('aria-label', 'Agent 续写候选内容')
    const blockElement = document.createElement('section')
    blockElement.className = 'document-continuation-block'
    blockElement.dataset.blockId = currentBlock.blockId
    blockElement.dataset.current = 'true'
    const content = document.createElement('div')
    content.className = 'document-continuation-candidate-content'
    const editor = document.createElement('textarea')
    editor.className = 'document-continuation-candidate-editor'
    editor.value = state.markdownDrafts[currentBlock.blockId] ?? currentBlock.textPreview
    editor.rows = 3
    editor.maxLength = 65_536
    editor.disabled = state.busy
    editor.spellcheck = true
    editor.setAttribute('aria-label', '编辑 Agent 续写候选内容')
    editor.addEventListener('mousedown', (event) => event.stopPropagation())
    editor.addEventListener('keydown', (event) => event.stopPropagation())
    editor.addEventListener('input', () => state.onDraftChange(currentBlock.blockId, editor.value))
    content.append(editor)
    const actions = document.createElement('div')
    actions.className = 'document-continuation-candidate-actions'
    const actionsRoot = createRoot(actions)
    const setBusy = () => {
      if (state.busy) return false
      view.dispatch(view.state.tr.setMeta(continuationKey, {
        ...state,
        busy: true,
        autoReveal: false,
      }))
      return true
    }
    actionsRoot.render(createElement(DocumentContinuationActions, {
      busy: state.busy,
      onAccept: async () => {
        if (!setBusy()) return
        await state.onAccept(currentBlock.blockId)
      },
      onAcceptAll: async () => {
        if (!setBusy()) return
        await state.onAcceptAll()
      },
      onRevise: async (feedback: string) => {
        if (!setBusy()) return
        await state.onRevise(currentBlock.blockId, feedback)
      },
    }))
    blockElement.append(content, actions)
    candidate.append(blockElement)
    candidate.addEventListener('keydown', (event) => {
      if (event.target !== candidate) return
      if (!shouldHandleContinuationTab({
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        candidateVisible: candidate.isConnected,
        busy: state.busy,
      })) return
      event.preventDefault()
      event.stopPropagation()
      view.dispatch(view.state.tr.setMeta(continuationKey, {
        ...state,
        busy: true,
        autoReveal: false,
      }))
      void state.onAccept(state.currentBlockId)
    })
    if (state.autoReveal) {
      window.requestAnimationFrame(() => {
        if (!candidate.isConnected || document.visibilityState === 'hidden') return
        const scrollElement = candidate.closest<HTMLElement>('.context-room-tiptap-scroll')
        if (scrollElement) {
          const scrollBounds = scrollElement.getBoundingClientRect()
          const candidateBounds = candidate.getBoundingClientRect()
          const top = continuationRevealScrollTop({
            scrollTop: scrollElement.scrollTop,
            scrollHeight: scrollElement.scrollHeight,
            clientHeight: scrollElement.clientHeight,
            candidateTop: candidateBounds.top - scrollBounds.top + scrollElement.scrollTop,
            candidateBottom: candidateBounds.bottom - scrollBounds.top + scrollElement.scrollTop,
          })
          if (Math.abs(top - scrollElement.scrollTop) >= 1) {
            scrollElement.scrollTo({ top, behavior: 'auto' })
          }
        } else {
          candidate.scrollIntoView({ behavior: 'auto', block: 'nearest' })
        }
      })
    }
    continuationActionRoots.set(candidate, actionsRoot)
    return candidate
  }, {
    key: `continuation:${state.currentBlockId}:${currentBlock.textPreview}:${state.busy}`,
    side: 1,
    ignoreSelection: true,
    stopEvent: () => true,
    destroy: (node) => {
      const root = continuationActionRoots.get(node)
      continuationActionRoots.delete(node)
      window.setTimeout(() => root?.unmount())
    },
  })])
}

export const DocumentContinuationExtension = Extension.create({
  name: 'documentContinuation',
  addProseMirrorPlugins() {
    return [new Plugin<DocumentContinuationDecorationState | null>({
      key: continuationKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const update = transaction.getMeta(continuationKey) as DocumentContinuationDecorationState | null | undefined
          return update === undefined ? current : update
        },
      },
      props: {
        decorations(state) {
          const continuation = continuationKey.getState(state)
          return continuation ? continuationDecorations(state.doc, continuation) : null
        },
      },
    })]
  },
})

export function showDocumentContinuation(
  editor: Editor,
  blocks: DocumentContinuationCandidate[],
  currentBlockId: string,
  queuedDecisions: Record<string, 'accepted' | 'rejected' | undefined>,
  markdownDrafts: Record<string, string>,
  busy: boolean,
  autoReveal: boolean,
  onAccept: (blockId: string) => Promise<void>,
  onAcceptAll: () => Promise<void>,
  onRevise: (blockId: string, feedback: string) => Promise<void>,
  onDraftChange: (blockId: string, markdown: string) => void,
): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(continuationKey, {
    blocks,
    currentBlockId,
    queuedDecisions,
    markdownDrafts,
    busy,
    autoReveal,
    onAccept,
    onAcceptAll,
    onRevise,
    onDraftChange,
  }))
}

export function clearDocumentContinuation(editor: Editor): void {
  if (editor.isDestroyed || !continuationKey.getState(editor.state)) return
  editor.view.dispatch(editor.state.tr.setMeta(continuationKey, null))
}
