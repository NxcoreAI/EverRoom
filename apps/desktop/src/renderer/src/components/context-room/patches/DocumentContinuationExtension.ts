import type { DocumentContinuationBlock, DocumentPatchTarget } from '@nxcore/agent-contract'
import { DOMSerializer, Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Extension, type Editor } from '@tiptap/react'
import { Check, X } from 'lucide-react'
import { createElement, Fragment as ReactFragment, type MouseEvent as ReactMouseEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { shouldHandleContinuationTab } from './documentContinuationState'

interface DocumentContinuationDecorationState {
  blocks: DocumentContinuationBlock[]
  currentBlockId: string
  queuedDecisions: Record<string, 'accepted' | 'rejected' | undefined>
  busy: boolean
  autoReveal: boolean
  onAccept: (blockId: string) => Promise<void>
  onReject: (blockId: string) => Promise<void>
  onAcceptAll: () => Promise<void>
}

const continuationKey = new PluginKey<DocumentContinuationDecorationState | null>('documentContinuation')
const continuationActionRoots = new WeakMap<Node, Root[]>()

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
  target: DocumentPatchTarget,
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

function candidateContent(
  doc: ProseMirrorNode,
  block: DocumentContinuationBlock,
): HTMLElement | DocumentFragment {
  const serializer = DOMSerializer.fromSchema(doc.type.schema)
  const candidate = doc.type.schema.nodeFromJSON(block.contentJson)
  const content = candidate.type.name === 'doc' ? candidate.content : Fragment.from(candidate)
  return serializer.serializeFragment(content)
}

function continuationDecorations(
  doc: ProseMirrorNode,
  state: DocumentContinuationDecorationState,
): DecorationSet {
  const currentBlock = state.blocks.find((block) => block.blockId === state.currentBlockId)
  if (!currentBlock) return DecorationSet.empty
  const position = continuationTargetPosition(doc, currentBlock.target)
  return DecorationSet.create(doc, [Decoration.widget(position, (view) => {
    const actionRoots: Root[] = []
    const candidate = document.createElement('div')
    candidate.className = 'document-continuation-candidate'
    candidate.dataset.blockId = currentBlock.blockId
    candidate.dataset.busy = String(state.busy)
    candidate.dataset.documentContinuationCandidate = 'true'
    candidate.tabIndex = 0
    candidate.setAttribute('role', 'region')
    candidate.setAttribute('aria-label', 'Agent 续写候选内容')
    for (const block of state.blocks) {
      const blockElement = document.createElement('section')
      blockElement.className = 'document-continuation-block'
      blockElement.dataset.blockId = block.blockId
      blockElement.dataset.current = String(block.blockId === state.currentBlockId)
      const queuedDecision = state.queuedDecisions[block.blockId]
      if (queuedDecision) blockElement.dataset.decision = queuedDecision
      const content = document.createElement('div')
      content.className = 'document-continuation-candidate-content'
      try {
        content.append(candidateContent(view.state.doc, block))
      } catch {
        content.textContent = block.textPreview
      }
      const actions = document.createElement('div')
      actions.className = 'document-continuation-candidate-actions'
      const actionsRoot = createRoot(actions)
      actionRoots.push(actionsRoot)
      const action = (decision: 'accepted' | 'rejected') => {
        if (state.busy) return
        view.dispatch(view.state.tr.setMeta(continuationKey, {
          ...state,
          busy: true,
          autoReveal: false,
        }))
        void (decision === 'accepted' ? state.onAccept(block.blockId) : state.onReject(block.blockId))
      }
      actionsRoot.render(createElement(ReactFragment, null,
        createElement('button', {
          type: 'button',
          className: queuedDecision === 'accepted' ? 'is-accept is-selected' : 'is-accept',
          title: '接受这个续写块',
          'aria-label': '接受这个续写块',
          disabled: state.busy,
          onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
          onClick: (event: ReactMouseEvent) => { event.stopPropagation(); action('accepted') },
        }, createElement(Check, { 'aria-hidden': true })),
        createElement('button', {
          type: 'button',
          className: queuedDecision === 'rejected' ? 'is-reject is-selected' : 'is-reject',
          title: '拒绝这个续写块',
          'aria-label': '拒绝这个续写块',
          disabled: state.busy,
          onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
          onClick: (event: ReactMouseEvent) => { event.stopPropagation(); action('rejected') },
        }, createElement(X, { 'aria-hidden': true })),
        createElement('button', {
          type: 'button',
          className: 'is-accept-all',
          title: '接受全部剩余续写块',
          disabled: state.busy,
          onMouseDown: (event: ReactMouseEvent) => { event.preventDefault(); event.stopPropagation() },
          onClick: (event: ReactMouseEvent) => { event.stopPropagation(); void state.onAcceptAll() },
        }, '全部接受'),
      ))
      blockElement.append(content, actions)
      candidate.append(blockElement)
    }
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
        candidate.scrollIntoView({ behavior: 'smooth', block: 'center' })
        candidate.focus({ preventScroll: true })
      })
    }
    continuationActionRoots.set(candidate, actionRoots)
    return candidate
  }, {
    key: `continuation:${state.blocks.map((block) => block.blockId).join(',')}:${state.currentBlockId}:${state.busy}:${state.autoReveal}`,
    side: 1,
    destroy: (node) => {
      const roots = continuationActionRoots.get(node)
      continuationActionRoots.delete(node)
      window.setTimeout(() => roots?.forEach((root) => root.unmount()))
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
  blocks: DocumentContinuationBlock[],
  currentBlockId: string,
  queuedDecisions: Record<string, 'accepted' | 'rejected' | undefined>,
  busy: boolean,
  autoReveal: boolean,
  onAccept: (blockId: string) => Promise<void>,
  onReject: (blockId: string) => Promise<void>,
  onAcceptAll: () => Promise<void>,
): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(continuationKey, {
    blocks,
    currentBlockId,
    queuedDecisions,
    busy,
    autoReveal,
    onAccept,
    onReject,
    onAcceptAll,
  }))
}

export function clearDocumentContinuation(editor: Editor): void {
  if (editor.isDestroyed || !continuationKey.getState(editor.state)) return
  editor.view.dispatch(editor.state.tr.setMeta(continuationKey, null))
}
