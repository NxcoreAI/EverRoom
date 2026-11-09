import type { DocumentMutationTarget } from '@nxcore/agent-contract'
import Image from '@tiptap/extension-image'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Editor, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Check, CheckCheck, MessageSquareX, Send, X } from 'lucide-react'
import { createElement, Fragment as ReactFragment, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import i18n from '@/i18n/i18next'
import type { DocumentContinuationCandidate } from './presenterRegistry'
import {
  continuationRevealScrollTop,
  groupContinuationCandidates,
  shouldHandleContinuationTab,
} from './documentContinuationState'

interface DocumentContinuationDecorationState {
  blocks: DocumentContinuationCandidate[]
  currentBlockId: string
  queuedDecisions: Record<string, 'accepted' | 'rejected' | undefined>
  markdownDrafts: Record<string, string>
  busy: boolean
  autoReveal: boolean
  onAccept: (blockIds: string[]) => Promise<void>
  onAcceptAll: () => Promise<void>
  onRevise: (blockIds: string[], feedback: string) => Promise<void>
  onDraftChange: (blockId: string, markdown: string) => void
}

const continuationKey = new PluginKey<DocumentContinuationDecorationState | null>('documentContinuation')
const continuationActionRoots = new WeakMap<Node, Root>()
const continuationMarkdownEditors = new WeakMap<Node, Editor[]>()
const MAX_CONTINUATION_MARKDOWN_LENGTH = 65_536

export function createContinuationMarkdownEditor({
  element,
  markdown,
  editable,
  onChange,
}: {
  element?: HTMLElement
  markdown: string
  editable: boolean
  onChange: (markdown: string) => void
}): Editor {
  let lastAcceptedMarkdown = markdown
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: false }),
      Markdown,
    ],
    content: markdown,
    contentType: 'markdown',
    editable,
    injectCSS: false,
    editorProps: {
      attributes: {
        class: 'document-continuation-markdown-editor',
        'aria-label': i18n.t('contextRoom:documentContinuation.editCandidate'),
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor }) => {
      const nextMarkdown = editor.getMarkdown()
      if (nextMarkdown.length > MAX_CONTINUATION_MARKDOWN_LENGTH) {
        editor.commands.setContent(lastAcceptedMarkdown, {
          contentType: 'markdown',
          emitUpdate: false,
        })
        return
      }
      lastAcceptedMarkdown = nextMarkdown
      onChange(nextMarkdown)
    },
  })
}

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
      placeholder: i18n.t('contextRoom:documentContinuation.feedbackPlaceholder'),
      'aria-label': i18n.t('contextRoom:documentContinuation.feedback'),
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setFeedback(event.target.value),
    }),
    createElement('div', { className: 'document-continuation-feedback-actions' },
      createElement('button', {
        type: 'button',
        title: i18n.t('contextRoom:documentContinuation.cancelFeedback'),
        'aria-label': i18n.t('contextRoom:documentContinuation.cancelFeedback'),
        disabled: busy || submitting,
        onClick: () => setFeedbackOpen(false),
      }, createElement(X, { 'aria-hidden': true })),
      createElement('button', {
        type: 'submit',
        className: 'is-submit',
        title: i18n.t('contextRoom:documentContinuation.reviseWithFeedback'),
        'aria-label': i18n.t('contextRoom:documentContinuation.reviseWithFeedback'),
        disabled: busy || submitting,
      }, createElement(Send, { 'aria-hidden': true }), i18n.t('contextRoom:documentContinuation.revise')),
    ))
  }

  return createElement(ReactFragment, null,
    createElement('button', {
      type: 'button',
      className: 'is-accept',
      title: i18n.t('contextRoom:documentContinuation.acceptCurrentBlock'),
      'aria-label': i18n.t('contextRoom:documentContinuation.acceptCurrentBlock'),
      disabled: busy,
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
      onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void onAccept() },
    }, createElement(Check, { 'aria-hidden': true }), i18n.t('contextRoom:documentContinuation.acceptCurrent')),
    createElement('button', {
      type: 'button',
      className: 'is-accept-all',
      title: i18n.t('contextRoom:documentContinuation.acceptAllFollowing'),
      'aria-label': i18n.t('contextRoom:documentContinuation.acceptAllFollowing'),
      disabled: busy,
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
      onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void onAcceptAll() },
    }, createElement(CheckCheck, { 'aria-hidden': true }), i18n.t('contextRoom:documentContinuation.acceptAllFollowingShort')),
    createElement('button', {
      type: 'button',
      className: 'is-reject',
      title: i18n.t('contextRoom:documentContinuation.rejectAndGiveFeedback'),
      'aria-label': i18n.t('contextRoom:documentContinuation.rejectAndGiveFeedback'),
      disabled: busy,
      onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
      onClick: (event: ReactMouseEvent) => { event.stopPropagation(); setFeedbackOpen(true) },
    }, createElement(MessageSquareX, { 'aria-hidden': true }), i18n.t('contextRoom:documentContinuation.reject')),
  )
}

function continuationDecorations(
  doc: ProseMirrorNode,
  state: DocumentContinuationDecorationState,
): DecorationSet {
  const currentBlocks = groupContinuationCandidates(state.blocks, state.currentBlockId)
  const currentBlock = currentBlocks[0]
  if (!currentBlock) return DecorationSet.empty
  const blockIds = currentBlocks.map((block) => block.blockId)
  const position = continuationTargetPosition(doc, currentBlock.target)
  return DecorationSet.create(doc, [Decoration.widget(position, (view) => {
    const candidate = document.createElement('div')
    candidate.className = 'document-continuation-candidate'
    candidate.dataset.blockId = currentBlock.blockId
    candidate.dataset.blockIds = blockIds.join(',')
    candidate.dataset.grouped = String(currentBlocks.length > 1)
    candidate.dataset.busy = String(state.busy)
    candidate.dataset.documentContinuationCandidate = 'true'
    candidate.tabIndex = 0
    candidate.contentEditable = 'false'
    candidate.setAttribute('role', 'region')
    candidate.setAttribute('aria-label', i18n.t('contextRoom:documentContinuation.candidate'))
    const blocksRoot = document.createElement('div')
    blocksRoot.className = 'document-continuation-blocks'
    const markdownEditors: Editor[] = []
    for (const [index, block] of currentBlocks.entries()) {
      const blockElement = document.createElement('section')
      blockElement.className = 'document-continuation-block'
      blockElement.dataset.blockId = block.blockId
      blockElement.dataset.current = index === 0 ? 'true' : 'false'
      const content = document.createElement('div')
      content.className = 'document-continuation-candidate-content'
      const editorShell = document.createElement('div')
      editorShell.className = 'document-continuation-markdown-editor-shell'
      editorShell.dataset.disabled = String(state.busy)
      const editorHost = document.createElement('div')
      editorShell.append(editorHost)
      markdownEditors.push(createContinuationMarkdownEditor({
        element: editorHost,
        markdown: state.markdownDrafts[block.blockId] ?? block.textPreview,
        editable: !state.busy,
        onChange: (markdown) => state.onDraftChange(block.blockId, markdown),
      }))
      content.append(editorShell)
      blockElement.append(content)
      blocksRoot.append(blockElement)
    }
    candidate.append(blocksRoot)
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
        await state.onAccept(blockIds)
      },
      onAcceptAll: async () => {
        if (!setBusy()) return
        await state.onAcceptAll()
      },
      onRevise: async (feedback: string) => {
        if (!setBusy()) return
        await state.onRevise(blockIds, feedback)
      },
    }))
    candidate.append(actions)
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
      void state.onAccept(blockIds)
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
    continuationMarkdownEditors.set(candidate, markdownEditors)
    continuationActionRoots.set(candidate, actionsRoot)
    return candidate
  }, {
    key: `continuation:${currentBlocks.map((block) => `${block.blockId}:${block.textPreview}`).join('|')}:${state.busy}`,
    side: 1,
    ignoreSelection: true,
    stopEvent: () => true,
    destroy: (node) => {
      const root = continuationActionRoots.get(node)
      const markdownEditor = continuationMarkdownEditors.get(node)
      continuationActionRoots.delete(node)
      continuationMarkdownEditors.delete(node)
      window.setTimeout(() => {
        markdownEditor?.forEach((editor) => editor.destroy())
        root?.unmount()
      })
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
  onAccept: (blockIds: string[]) => Promise<void>,
  onAcceptAll: () => Promise<void>,
  onRevise: (blockIds: string[], feedback: string) => Promise<void>,
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
