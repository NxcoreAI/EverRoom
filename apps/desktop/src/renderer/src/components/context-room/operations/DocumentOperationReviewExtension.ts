import { Extension, type Editor } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Check, X } from 'lucide-react'
import { createElement, Fragment as ReactFragment, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DocumentOperationReviewView, DocumentReviewItem } from './presenterRegistry'
import type { DocumentReviewDecisionMap } from './documentReviewState'

interface OperationReviewDecorationState {
  review: DocumentOperationReviewView
  decisions: DocumentReviewDecisionMap
  markdownDrafts: Record<string, string>
  currentHunkId: string | null
  busy: boolean
  autoReveal: boolean
  onDecision: (hunkId: string, decision: 'accepted' | 'rejected') => Promise<void>
  onAcceptAll: () => Promise<void>
  onDraftChange: (hunkId: string, markdown: string) => void
}

const operationReviewDecorationKey = new PluginKey<OperationReviewDecorationState | null>('documentOperationReview')
const operationActionRoots = new WeakMap<Node, Root>()

function reviewTargetBlockIds(item: DocumentReviewItem): string[] {
  const target = item.target
  if ('blockId' in target) return [target.blockId]
  if ('fromBlockId' in target) return [target.fromBlockId, target.toBlockId]
  return []
}

function jsonText(nodes: DocumentReviewItem['after']): string {
  const read = (node: DocumentReviewItem['after'][number]): string => {
    if (node.type === 'text') return node.text ?? ''
    const text = (node.content ?? []).map(read).join('')
    return node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem' || node.type === 'taskItem'
      ? `${text}\n`
      : text
  }
  return nodes.map(read).join('').trim()
}

function targetPreviewPosition(doc: ProseMirrorNode, item: DocumentReviewItem): number {
  const target = item.target
  if ('at' in target) return doc.content.size
  const wantedId = 'toBlockId' in target ? target.toBlockId : target.blockId
  let result = doc.content.size
  doc.descendants((node, position) => {
    const rawBlockId = node.attrs.id ?? node.attrs.blockId
    if (rawBlockId !== wantedId) return
    result = 'edge' in target && target.edge === 'before' ? position : position + node.nodeSize
    return false
  })
  return result
}

function rangeBlockIds(doc: ProseMirrorNode, fromId: string, toId: string): Set<string> {
  const ids: string[] = []
  doc.descendants((node) => {
    const rawBlockId = node.attrs.id ?? node.attrs.blockId
    const blockId = typeof rawBlockId === 'string' ? rawBlockId : ''
    if (node.isBlock && blockId) ids.push(blockId)
  })
  const from = ids.indexOf(fromId)
  const to = ids.indexOf(toId)
  if (from < 0 || to < 0) return new Set([fromId, toId])
  return new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
}

function reviewDecorations(doc: ProseMirrorNode, state: OperationReviewDecorationState): DecorationSet {
  const decorations: Decoration[] = []
  const lastTopLevelPosition = doc.childCount > 0 ? doc.content.size - doc.lastChild!.nodeSize : null

  for (const item of state.review.items) {
    const targetIds = reviewTargetBlockIds(item)
    const target = item.target
    const ids = 'fromBlockId' in target
      ? rangeBlockIds(doc, target.fromBlockId, target.toBlockId)
      : new Set(targetIds)
    const operationClass = item.operation === 'delete' || item.operation === 'replace'
      ? 'document-patch-review-deleted'
      : ''
    const classes = [
      operationClass,
      item.id === state.currentHunkId ? 'document-patch-review-current' : '',
      state.decisions[item.id] === 'rejected' ? 'document-patch-review-hunk-rejected' : '',
    ].filter(Boolean).join(' ')

    doc.descendants((node, position) => {
      if (!node.isBlock) return
      const rawBlockId = node.attrs.id ?? node.attrs.blockId
      const blockId = typeof rawBlockId === 'string' ? rawBlockId : ''
      const endInsertionTarget = 'at' in target && target.at === 'end' && position === lastTopLevelPosition
      if (!ids.has(blockId) && !endInsertionTarget) return
      if (!operationClass) return
      decorations.push(Decoration.node(position, position + node.nodeSize, {
        class: classes,
        'data-patch-hunk-id': item.id,
        'data-patch-decision': state.decisions[item.id] ?? 'undecided',
      }))
    })

    const proposedText = item.markdown || jsonText(item.after)
    if (item.operation === 'delete' || proposedText.trim()) {
      const position = targetPreviewPosition(doc, item)
      decorations.push(Decoration.widget(position, () => {
        const preview = document.createElement('div')
        preview.className = [
          'document-patch-review-proposed',
          item.id === state.currentHunkId ? 'document-patch-review-current' : '',
          state.decisions[item.id] === 'rejected' ? 'document-patch-review-hunk-rejected' : '',
        ].filter(Boolean).join(' ')
        preview.dataset.patchHunkId = item.id
        preview.dataset.patchDecision = state.decisions[item.id] ?? 'undecided'
        preview.tabIndex = 0
        preview.contentEditable = 'false'
        preview.setAttribute('role', 'region')
        preview.setAttribute('aria-label', `文档改动 ${item.sequence}`)
        const content = document.createElement('div')
        content.className = 'document-patch-review-proposed-content'
        if (item.operation === 'delete') {
          content.textContent = '删除此处内容'
        } else {
          const editor = document.createElement('textarea')
          editor.className = 'document-patch-review-proposed-editor'
          editor.value = state.markdownDrafts[item.id] ?? proposedText
          editor.rows = 3
          editor.maxLength = 65_536
          editor.disabled = state.busy
          editor.spellcheck = true
          editor.setAttribute('aria-label', `编辑文档改动 ${item.sequence}`)
          editor.addEventListener('mousedown', (event) => event.stopPropagation())
          editor.addEventListener('keydown', (event) => event.stopPropagation())
          editor.addEventListener('input', () => state.onDraftChange(item.id, editor.value))
          content.append(editor)
        }
        const actions = document.createElement('div')
        actions.className = 'document-patch-review-proposed-actions'
        const root = createRoot(actions)
        root.render(createElement(ReactFragment, null,
          createElement('button', {
            type: 'button',
            className: 'is-accept',
            title: '接受此处改动',
            'aria-label': '接受此处改动',
            disabled: state.busy,
            onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
            onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void state.onDecision(item.id, 'accepted') },
          }, createElement(Check, { 'aria-hidden': true })),
          createElement('button', {
            type: 'button',
            className: 'is-reject',
            title: '拒绝此处改动',
            'aria-label': '拒绝此处改动',
            disabled: state.busy,
            onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
            onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void state.onDecision(item.id, 'rejected') },
          }, createElement(X, { 'aria-hidden': true })),
          createElement('button', {
            type: 'button',
            className: 'is-accept-all',
            title: '全部接受',
            disabled: state.busy,
            onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
            onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void state.onAcceptAll() },
          }, '全部接受'),
        ))
        preview.append(content, actions)
        preview.addEventListener('keydown', (event) => {
          if (event.target !== preview || event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || state.busy) return
          event.preventDefault()
          event.stopPropagation()
          void state.onDecision(item.id, 'accepted')
        })
        if (state.autoReveal && item.id === state.currentHunkId) {
          window.requestAnimationFrame(() => {
            if (!preview.isConnected || document.visibilityState === 'hidden') return
            preview.scrollIntoView({ behavior: 'smooth', block: 'center' })
            preview.focus({ preventScroll: true })
          })
        }
        operationActionRoots.set(preview, root)
        return preview
      }, {
        key: `patch-proposed:${state.review.id}:${item.id}:${proposedText}:${state.decisions[item.id] ?? 'undecided'}:${state.busy}`,
        side: 1,
        destroy: (node) => window.setTimeout(() => operationActionRoots.get(node)?.unmount(), 0),
      }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export const DocumentOperationReviewExtension = Extension.create({
  name: 'documentOperationReview',
  addProseMirrorPlugins() {
    return [new Plugin<OperationReviewDecorationState | null>({
      key: operationReviewDecorationKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const update = transaction.getMeta(operationReviewDecorationKey) as OperationReviewDecorationState | null | undefined
          return update === undefined ? current : update
        },
      },
      props: {
        decorations(state) {
          const review = operationReviewDecorationKey.getState(state)
          return review ? reviewDecorations(state.doc, review) : null
        },
      },
    })]
  },
})

export function showDocumentOperationReview(
  editor: Editor,
  review: DocumentOperationReviewView,
  decisions: DocumentReviewDecisionMap,
  markdownDrafts: Record<string, string>,
  currentHunkId: string | null,
  busy: boolean,
  autoReveal: boolean,
  onDecision: (hunkId: string, decision: 'accepted' | 'rejected') => Promise<void>,
  onAcceptAll: () => Promise<void>,
  onDraftChange: (hunkId: string, markdown: string) => void,
): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(operationReviewDecorationKey, {
    review,
    decisions,
    markdownDrafts,
    currentHunkId,
    busy,
    autoReveal,
    onDecision,
    onAcceptAll,
    onDraftChange,
  } satisfies OperationReviewDecorationState))
}

export function clearDocumentOperationReview(editor: Editor): void {
  if (editor.isDestroyed || !operationReviewDecorationKey.getState(editor.state)) return
  editor.view.dispatch(editor.state.tr.setMeta(operationReviewDecorationKey, null))
}

export function currentDocumentOperationReview(editor: Editor): OperationReviewDecorationState | null {
  return editor.isDestroyed ? null : operationReviewDecorationKey.getState(editor.state) ?? null
}
