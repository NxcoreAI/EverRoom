import { Extension, type Editor } from '@tiptap/react'
import { closeHistory } from '@tiptap/pm/history'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { useEffect, useRef, useState } from 'react'

import {
  streamDocumentCursorCompletion,
  type DocumentCursorCompletionFormatContext,
  type DocumentCursorCompletionListType,
  type DocumentCursorCompletionNearbyBlock,
  type DocumentCursorCompletionSuggestion,
  validatedDocumentCursorReplacement,
} from './documentCursorCompletionAgent'
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
  })
}

const cursorCompletionKey = new PluginKey<DocumentCursorCompletionState | null>('documentCursorCompletion')
export const DOCUMENT_CURSOR_COMPLETION_DELAY_MS = 700
const MIN_TYPED_CHARACTERS = 2
const NEARBY_BLOCK_LIMIT = 3
const NEARBY_NODE_VISIT_LIMIT = 64

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
  decorations.push(Decoration.widget(completion.position, () => {
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
    return ghost
  }, {
    key: `document-cursor-completion:${completion.replaceFrom ?? completion.position}:${completion.position}:${completion.text}`,
    side: 1,
    ignoreSelection: true,
    relaxedSide: true,
  }))
  return DecorationSet.create(doc, decorations)
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
            recordDocumentCursorCompletionDiagnostic('suggestion.dismissed', {
              reason: `navigation:${event.key}`,
              position: completion.position,
              suggestionLength: Array.from(completion.text).length,
              suggestion: documentCursorCompletionSnippet(completion.text),
            })
            view.dispatch(view.state.tr.setMeta(cursorCompletionKey, null))
            return false
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            recordDocumentCursorCompletionDiagnostic('suggestion.dismissed', {
              reason: 'escape',
              position: completion.position,
              suggestionLength: Array.from(completion.text).length,
              suggestion: documentCursorCompletionSnippet(completion.text),
            })
            view.dispatch(view.state.tr.setMeta(cursorCompletionKey, null))
            return true
          }
          if (event.key !== 'Tab'
            || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return false
          }
          event.preventDefault()
          const replaceFrom = completion.replaceFrom ?? completion.position
          recordDocumentCursorCompletionDiagnostic('suggestion.accepted', {
            position: completion.position,
            replaceCharacters: completion.position - replaceFrom,
            suggestionLength: Array.from(completion.text).length,
            suggestion: documentCursorCompletionSnippet(completion.text),
          })
          const transaction = view.state.tr
            .insertText(completion.text, replaceFrom, completion.position)
            .setMeta(cursorCompletionKey, null)
          view.dispatch(closeHistory(transaction))
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

export function documentCursorCompletionContext(
  editor: Editor,
): DocumentCursorCompletionContext | null {
  const selection = editor.state.selection
  if (!(selection instanceof TextSelection) || !selection.empty) return null
  const position = selection.from
  const parent = selection.$from.parent
  if (!parent.isTextblock) return null
  if (Array.from(editor.state.doc.textContent.replace(/\s/gu, '')).length < MIN_TYPED_CHARACTERS) {
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
    (editor.state.storedMarks ?? selection.$from.marks()).map((mark) => mark.type.name),
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
  const contextBefore = editor.state.doc.textBetween(
    Math.max(0, position - 1_600),
    position,
    '\n',
    '\n',
  )
  const contextAfter = editor.state.doc.textBetween(
    position,
    Math.min(editor.state.doc.content.size, position + 800),
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
    requestKey: `${position}:${editor.state.doc.content.size}:${JSON.stringify(formatContext)}:${contextBefore}:${contextAfter}:${JSON.stringify(nearbyBlocks)}`,
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

export function useDocumentCursorCompletion({
  editor,
  roomId,
  documentName,
  enabled,
}: {
  editor: Editor | null
  roomId: string
  documentName: string
  enabled: boolean
}): boolean {
  const [running, setRunning] = useState(false)
  const enabledRef = useRef(enabled)
  const requestRef = useRef<ActiveCompletionRequest | null>(null)
  const timerRef = useRef<number | null>(null)
  const typedCharacters = useRef(0)
  const deletedContent = useRef(false)
  enabledRef.current = enabled

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const editorElement = editor.view.dom

    const cancelPending = (clearSuggestion: boolean, reason = 'cancelled') => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
        recordDocumentCursorCompletionDiagnostic('schedule.cancelled', { reason })
      }
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

    const requestCompletion = (trigger: DocumentCursorCompletionTrigger) => {
      timerRef.current = null
      const skipReason = !enabledRef.current
        ? 'disabled'
        : editor.isDestroyed
          ? 'editor_destroyed'
          : !editor.isEditable
            ? 'editor_readonly'
            : !editor.view.hasFocus()
              ? 'editor_blurred'
              : editor.view.composing ? 'composing' : null
      if (skipReason) {
        recordDocumentCursorCompletionDiagnostic('request.skipped', { trigger, reason: skipReason })
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
        blockPrefixLength: Array.from(context.blockPrefix).length,
        blockSuffixLength: Array.from(context.blockSuffix).length,
        prefixTail: documentCursorCompletionSnippet(Array.from(context.blockPrefix).slice(-120).join('')),
        suffixHead: documentCursorCompletionSnippet(Array.from(context.blockSuffix).slice(0, 120).join('')),
        contextBeforeLength: Array.from(context.contextBefore).length,
        contextAfterLength: Array.from(context.contextAfter).length,
      })
      void streamDocumentCursorCompletion(api, {
        roomId,
        documentName,
        contextBefore: context.contextBefore,
        contextAfter: context.contextAfter,
        blockPrefix: Array.from(context.blockPrefix).slice(-200).join(''),
        blockSuffix: Array.from(context.blockSuffix).slice(0, 200).join(''),
        blockType: context.blockType,
        formatContext: context.formatContext,
        nearbyBlocks: context.nearbyBlocks,
      }, {
        signal: controller.signal,
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
          const completion = completionState(currentContext, resolved)
          active.visibleText = completion.text
          active.visibleReplacement = completion.replaceFrom !== undefined
          showDocumentCursorCompletion(editor, completion)
          recordShownCompletion(request, completion)
        },
      }).then((suggestion) => {
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
        const completion = completionState(currentContext, resolved)
        active.visibleText = completion.text
        active.visibleReplacement = completion.replaceFrom !== undefined
        showDocumentCursorCompletion(editor, completion)
        recordShownCompletion(request, completion)
      }).catch((error: unknown) => {
        if (!request.diagnosticEnded) {
          request.diagnosticEnded = true
          recordDocumentCursorCompletionDiagnostic(
            isAbortError(error) ? 'request.cancelled' : 'request.failed',
            {
              requestId: request.diagnosticId,
              trigger: request.diagnosticTrigger,
              reason: isAbortError(error) ? 'upstream_abort' : 'stream_error',
              durationMs: Date.now() - request.diagnosticStartedAt,
              ...(error instanceof Error ? { message: error.message.slice(0, 500) } : {}),
            },
            isAbortError(error) ? 'info' : 'error',
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
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
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
      recordDocumentCursorCompletionDiagnostic('schedule.created', {
        trigger,
        delayMs: DOCUMENT_CURSOR_COMPLETION_DELAY_MS,
        forceRequest,
        typedCharacters: typedCharacters.current,
        deletion: deletedContent.current,
        position: scheduledContext?.position ?? null,
        blockType: scheduledContext?.blockType ?? null,
      })
      timerRef.current = window.setTimeout(() => {
        if (!forceRequest
          && typedCharacters.current < MIN_TYPED_CHARACTERS
          && !deletedContent.current) {
          typedCharacters.current = 0
          deletedContent.current = false
          timerRef.current = null
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
    }

    let composing = false
    let pendingBeforeInputText: string | null = null
    let preserveRequestForNextInput = false
    let pendingDeletionIntent: { timer: number | null } | null = null
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
    const countCompositionCommit = (commit: NonNullable<typeof compositionCommit>) => {
      if (commit.counted || compositionCommit !== commit) return
      commit.counted = true
      typedCharacters.current += Array.from(commit.data).length
      scheduleCompletion({
        forceRequest: isMiddleOfTextBlock(documentCursorCompletionContext(editor)),
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
      cancelPending(true, 'pointer_down')
    }
    const handleKeyDownCapture = (event: KeyboardEvent) => {
      if (!composing && !event.isComposing
        && (event.key === 'Backspace' || event.key === 'Delete')) {
        armDeletionIntent()
        typedCharacters.current = 0
        deletedContent.current = true
        cancelPending(true, 'deletion')
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape'].includes(event.key)) return
      typedCharacters.current = 0
      deletedContent.current = false
      clearCompositionCommit()
      clearDeletionIntent()
      cancelPending(true, `navigation:${event.key}`)
    }
    const handleFocusOut = () => {
      typedCharacters.current = 0
      deletedContent.current = false
      clearCompositionCommit()
      clearDeletionIntent()
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
    editorElement.addEventListener('keydown', handleKeyDown)
    editorElement.addEventListener('focusout', handleFocusOut)
    editor.on('transaction', handleTransaction)
    return () => {
      clearCompositionCommit()
      clearDeletionIntent()
      cancelPending(true, 'unmounted')
      editorElement.removeEventListener('beforeinput', handleBeforeInput, true)
      editorElement.removeEventListener('input', handleInput)
      editorElement.removeEventListener('compositionstart', handleCompositionStart)
      editorElement.removeEventListener('compositionend', handleCompositionEnd)
      editorElement.removeEventListener('pointerdown', handlePointerDown)
      editorElement.removeEventListener('keydown', handleKeyDownCapture, true)
      editorElement.removeEventListener('keydown', handleKeyDown)
      editorElement.removeEventListener('focusout', handleFocusOut)
      editor.off('transaction', handleTransaction)
    }
  }, [documentName, editor, roomId])

  useEffect(() => {
    if (enabled || !editor) return
    typedCharacters.current = 0
    deletedContent.current = false
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const activeRequest = requestRef.current
    if (activeRequest) abortCompletionRequest(activeRequest, 'disabled')
    if (requestRef.current === activeRequest) {
      requestRef.current = null
      setRunning(false)
    }
    clearDocumentCursorCompletion(editor)
  }, [editor, enabled])

  return running
}
