import type { DocumentPatch, DocumentPatchHunk } from '@nxcore/agent-contract'
import { Extension, type Editor } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Check, X } from 'lucide-react'
import { createElement, Fragment as ReactFragment, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { DocumentPatchDecisionMap } from './documentPatchState'

interface PatchReviewDecorationState {
  patch: DocumentPatch
  decisions: DocumentPatchDecisionMap
  currentHunkId: string | null
  busy: boolean
  onDecision: (hunkId: string, decision: 'accepted' | 'rejected') => Promise<void>
  onAcceptAll: () => Promise<void>
}

const patchReviewDecorationKey = new PluginKey<PatchReviewDecorationState | null>('documentPatchReview')
const patchActionRoots = new WeakMap<Node, Root>()

function hunkTargetBlockIds(hunk: DocumentPatchHunk): string[] {
  const target = hunk.target
  if ('blockId' in target) return [target.blockId]
  if ('fromBlockId' in target) return [target.fromBlockId, target.toBlockId]
  return []
}

function jsonText(nodes: DocumentPatchHunk['after']): string {
  const read = (node: DocumentPatchHunk['after'][number]): string => {
    if (node.type === 'text') return node.text ?? ''
    const text = (node.content ?? []).map(read).join('')
    return node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem' || node.type === 'taskItem'
      ? `${text}\n`
      : text
  }
  return nodes.map(read).join('').trim()
}

function targetPreviewPosition(doc: ProseMirrorNode, hunk: DocumentPatchHunk): number {
  const target = hunk.target
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

function reviewDecorations(doc: ProseMirrorNode, state: PatchReviewDecorationState): DecorationSet {
  const decorations: Decoration[] = []
  const lastTopLevelPosition = doc.childCount > 0 ? doc.content.size - doc.lastChild!.nodeSize : null

  for (const hunk of state.patch.hunks) {
    const targetIds = hunkTargetBlockIds(hunk)
    const target = hunk.target
    const ids = 'fromBlockId' in target
      ? rangeBlockIds(doc, target.fromBlockId, target.toBlockId)
      : new Set(targetIds)
    const operationClass = hunk.operation === 'delete' || hunk.operation === 'replace'
      ? 'document-patch-review-deleted'
      : ''
    const classes = [
      operationClass,
      hunk.id === state.currentHunkId ? 'document-patch-review-current' : '',
      state.decisions[hunk.id] === 'rejected' ? 'document-patch-review-hunk-rejected' : '',
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
        'data-patch-hunk-id': hunk.id,
        'data-patch-decision': state.decisions[hunk.id] ?? 'undecided',
      }))
    })

    const proposedText = jsonText(hunk.after) || hunk.markdown.trim()
    if (hunk.operation === 'delete' || proposedText) {
      const position = targetPreviewPosition(doc, hunk)
      decorations.push(Decoration.widget(position, () => {
        const preview = document.createElement('div')
        preview.className = [
          'document-patch-review-proposed',
          hunk.id === state.currentHunkId ? 'document-patch-review-current' : '',
          state.decisions[hunk.id] === 'rejected' ? 'document-patch-review-hunk-rejected' : '',
        ].filter(Boolean).join(' ')
        preview.dataset.patchHunkId = hunk.id
        preview.dataset.patchDecision = state.decisions[hunk.id] ?? 'undecided'
        preview.tabIndex = 0
        preview.setAttribute('role', 'region')
        preview.setAttribute('aria-label', `文档改动 ${hunk.sequence}`)
        const content = document.createElement('div')
        content.className = 'document-patch-review-proposed-content'
        content.textContent = proposedText || '删除此处内容'
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
            onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void state.onDecision(hunk.id, 'accepted') },
          }, createElement(Check, { 'aria-hidden': true })),
          createElement('button', {
            type: 'button',
            className: 'is-reject',
            title: '拒绝此处改动',
            'aria-label': '拒绝此处改动',
            disabled: state.busy,
            onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
            onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void state.onDecision(hunk.id, 'rejected') },
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
          void state.onDecision(hunk.id, 'accepted')
        })
        patchActionRoots.set(preview, root)
        return preview
      }, {
        key: `patch-proposed:${hunk.id}:${state.decisions[hunk.id] ?? 'undecided'}:${state.busy}`,
        side: 1,
        destroy: (node) => window.setTimeout(() => patchActionRoots.get(node)?.unmount(), 0),
      }))
    }
  }
  return DecorationSet.create(doc, decorations)
}

export const DocumentPatchReviewExtension = Extension.create({
  name: 'documentPatchReview',
  addProseMirrorPlugins() {
    return [new Plugin<PatchReviewDecorationState | null>({
      key: patchReviewDecorationKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const update = transaction.getMeta(patchReviewDecorationKey) as PatchReviewDecorationState | null | undefined
          return update === undefined ? current : update
        },
      },
      props: {
        decorations(state) {
          const review = patchReviewDecorationKey.getState(state)
          return review ? reviewDecorations(state.doc, review) : null
        },
      },
    })]
  },
})

export function showDocumentPatchReview(
  editor: Editor,
  patch: DocumentPatch,
  decisions: DocumentPatchDecisionMap,
  currentHunkId: string | null,
  busy: boolean,
  onDecision: (hunkId: string, decision: 'accepted' | 'rejected') => Promise<void>,
  onAcceptAll: () => Promise<void>,
): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(patchReviewDecorationKey, {
    patch,
    decisions,
    currentHunkId,
    busy,
    onDecision,
    onAcceptAll,
  } satisfies PatchReviewDecorationState))
}

export function clearDocumentPatchReview(editor: Editor): void {
  if (editor.isDestroyed || !patchReviewDecorationKey.getState(editor.state)) return
  editor.view.dispatch(editor.state.tr.setMeta(patchReviewDecorationKey, null))
}

export function currentDocumentPatchReview(editor: Editor): PatchReviewDecorationState | null {
  return editor.isDestroyed ? null : patchReviewDecorationKey.getState(editor.state) ?? null
}
