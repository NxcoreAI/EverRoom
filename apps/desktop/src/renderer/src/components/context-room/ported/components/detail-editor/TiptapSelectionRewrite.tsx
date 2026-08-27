import type { DocumentOperation, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Extension, type Editor, type JSONContent } from '@tiptap/react'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Check, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale } from '../../../../../i18n/LocaleContext'

import { streamSelectionRewrite } from './selectionRewriteAgent'
import type { SelectionRewriteFormatContext } from './selectionRewriteAgent'
import { useDocumentOperations } from '../../../operations'
import { stripDocumentTitle } from '@nxcore/document-model'

interface RewriteAnchor {
  from: number
  to: number
}

interface RewriteDecoration extends RewriteAnchor {
  variant: 'prompt' | 'original'
}

interface RewritePreviewState extends RewriteAnchor {
  originalText: string
  replacementText: string
  registeredReplacementText: string | null
  instruction: string
  formatContext: SelectionRewriteFormatContext
  phase: 'requesting' | 'ready' | 'submitting' | 'error'
  error: string | null
  invocationId: string | null
  operationId: string | null
  revision: number | null
  left: number
  top: number
}

const rewriteDecorationKey = new PluginKey<RewriteDecoration | null>('selectionRewritePreview')

export const SelectionRewritePreviewExtension = Extension.create({
  name: 'selectionRewritePreview',
  addProseMirrorPlugins() {
    return [new Plugin<RewriteDecoration | null>({
      key: rewriteDecorationKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const next = transaction.getMeta(rewriteDecorationKey) as RewriteDecoration | null | undefined
          if (next !== undefined) return next
          if (!current) return null
          return {
            from: transaction.mapping.map(current.from, 1),
            to: transaction.mapping.map(current.to, -1),
            variant: current.variant,
          }
        },
      },
      props: {
        decorations(state) {
          const anchor = rewriteDecorationKey.getState(state)
          if (!anchor || anchor.from >= anchor.to || anchor.to > state.doc.content.size) return null
          return DecorationSet.create(state.doc, [
            Decoration.inline(anchor.from, anchor.to, {
              class: anchor.variant === 'prompt'
                ? 'context-room-tiptap-rewrite-prompt'
                : 'context-room-tiptap-rewrite-original',
              'data-selection-rewrite': anchor.variant,
            }),
          ])
        },
      },
    })]
  },
})

function setRewriteDecoration(editor: Editor, anchor: RewriteDecoration | null): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(rewriteDecorationKey, anchor))
}

export function showSelectionRewritePromptDecoration(editor: Editor): boolean {
  if (editor.isDestroyed) return false
  const { selection } = editor.state
  if (!(selection instanceof TextSelection) || selection.empty) {
    return false
  }
  setRewriteDecoration(editor, {
    from: selection.from,
    to: selection.to,
    variant: 'prompt',
  })
  return true
}

export function clearSelectionRewritePromptDecoration(editor: Editor): void {
  if (editor.isDestroyed || rewriteDecorationKey.getState(editor.state)?.variant !== 'prompt') return
  setRewriteDecoration(editor, null)
}

function previewPosition(editor: Editor, to: number): { left: number; top: number } {
  try {
    const coordinates = editor.view.coordsAtPos(Math.min(to, editor.state.doc.content.size))
    const width = Math.min(440, Math.max(280, window.innerWidth - 32))
    return {
      left: Math.max(12, Math.min(coordinates.left, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(coordinates.bottom + 9, window.innerHeight - 230)),
    }
  } catch {
    return { left: 16, top: 16 }
  }
}

function selectionText(editor: Editor, from: number, to: number): string {
  return editor.state.doc.textBetween(from, to, '\n', '\n')
}

interface SelectedTextBlockRange {
  from: number
  to: number
}

function selectedTextBlockRanges(editor: Editor, from: number, to: number): SelectedTextBlockRange[] {
  const ranges: SelectedTextBlockRange[] = []
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isTextblock) return
    const contentFrom = Math.max(from, position + 1)
    const contentTo = Math.min(to, position + node.nodeSize - 1)
    if (contentFrom < contentTo) ranges.push({ from: contentFrom, to: contentTo })
  })
  return ranges
}

function replaceSelectionText(editor: Editor, from: number, to: number, replacementText: string) {
  const ranges = selectedTextBlockRanges(editor, from, to)
  if (ranges.length <= 1) return editor.state.tr.insertText(replacementText, from, to)

  const lines = replacementText.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length !== ranges.length) return editor.state.tr.insertText(replacementText, from, to)

  // Replace from the end so earlier document positions stay valid. This keeps
  // list-item and paragraph wrappers intact while each selected block changes.
  const transaction = editor.state.tr
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]
    transaction.insertText(lines[index], range.from, range.to)
  }
  return transaction
}

function replaceSelectionMarkdown(
  editor: Editor,
  from: number,
  to: number,
  replacementMarkdown: string,
) {
  const parsed = editor.storage.markdown.manager.parse(replacementMarkdown) as JSONContent
  const parsedDocument = editor.schema.nodeFromJSON(parsed)
  const content = parsedDocument.content
  if (content.childCount === 1 && content.firstChild?.type.name === 'paragraph') {
    return editor.state.tr.replaceWith(from, to, content.firstChild.content)
  }
  return editor.state.tr.replaceRange(from, to, new Slice(Fragment.from(content), 0, 0))
}

export function proposedSelectionRewriteContent(
  editor: Editor,
  from: number,
  to: number,
  replacementText: string,
  formatContext?: SelectionRewriteFormatContext,
): TiptapJsonContent {
  const insideCodeBlock = formatContext?.blockType === 'codeBlock'
    || formatContext?.ancestorTypes.includes('codeBlock') === true
  const transaction = insideCodeBlock
    ? replaceSelectionText(editor, from, to, replacementText)
    : replaceSelectionMarkdown(editor, from, to, replacementText)
  return transaction.doc.toJSON() as TiptapJsonContent
}

function selectionFormatContext(editor: Editor, from: number): SelectionRewriteFormatContext {
  const resolved = editor.state.doc.resolve(from)
  const ancestorTypes: string[] = []
  for (let depth = 1; depth <= resolved.depth; depth += 1) {
    ancestorTypes.push(resolved.node(depth).type.name)
  }
  const parent = resolved.parent
  const codeBlock = [parent, ...Array.from({ length: resolved.depth }, (_, index) => resolved.node(resolved.depth - index))]
    .find((node) => node.type.name === 'codeBlock')
  return {
    blockType: parent.type.name,
    ancestorTypes,
    ...(codeBlock ? { codeLanguage: codeBlock.attrs.language ?? null } : {}),
  }
}

export function useTiptapSelectionRewrite({
  editor,
  roomId,
  documentId,
  documentName,
  prepareDocument,
  onDocumentApplied,
  externallyLocked,
}: {
  editor: Editor | null
  roomId: string
  documentId: string
  documentName: string
  prepareDocument: () => Promise<number>
  onDocumentApplied: (document: RoomDocument) => void
  externallyLocked: boolean
}) {
  const { locale, t } = useLocale()
  const { executeResult, load, start } = useDocumentOperations()
  const [preview, setPreview] = useState<RewritePreviewState | null>(null)
  const previewRef = useRef(preview)
  const operationRef = useRef<{
    id: string
    controller: AbortController
    wasEditable: boolean
    startingOperation: boolean
  } | null>(null)
  previewRef.current = preview

  const rewriteErrorMessage = useCallback((error: unknown): string => {
    const message = error instanceof Error ? error.message : t('contextRoom:tiptapSelectionRewrite.documentOperationFailedTryAgain')
    if (/DOCUMENT_CONFLICT|VERSION(?:_MISMATCH| HAS CHANGED)/i.test(message)) {
      return t('contextRoom:tiptapSelectionRewrite.theDocumentHasChangedSelectTheTextAgain')
    }
    if (/DOCUMENT_BUSY/i.test(message)) return t('contextRoom:tiptapSelectionRewrite.theDocumentIsProcessingAnotherChangeTryAgain')
    return message
  }, [t])

  const restoreEditor = useCallback((wasEditable: boolean) => {
    if (!editor || editor.isDestroyed) return
    setRewriteDecoration(editor, null)
    if (wasEditable && !externallyLocked) editor.setEditable(true)
  }, [editor, externallyLocked])

  const finish = useCallback((wasEditable: boolean) => {
    operationRef.current = null
    previewRef.current = null
    restoreEditor(wasEditable)
    setPreview(null)
  }, [restoreEditor])

  const preservePreviewError = useCallback(async (
    current: RewritePreviewState,
    error: unknown,
  ): Promise<void> => {
    let revision = current.revision
    if (current.operationId) {
      try {
        const refreshed = await load(current.operationId)
        if (refreshed) revision = refreshed.revision
      } catch {
        // The original command error is more useful than a secondary refresh failure.
      }
    }
    setPreview((value) => value ? {
      ...value,
      revision,
      phase: value.replacementText ? 'ready' : 'error',
      error: rewriteErrorMessage(error),
    } : value)
  }, [load, rewriteErrorMessage])

  const cancel = useCallback(() => {
    const current = previewRef.current
    const operation = operationRef.current
    operation?.controller.abort()
    if (current?.operationId && current.revision !== null) {
      setPreview({ ...current, phase: 'submitting', error: null })
      void executeResult(
        current.operationId,
        current.phase === 'requesting' ? 'operation.cancel' : 'review.reject',
      ).then((result) => {
        if (!result) throw new Error(t('contextRoom:tiptapSelectionRewrite.theDocumentOperationIsStillProcessing'))
        finish(operation?.wasEditable ?? true)
      }).catch((error: unknown) => {
        void preservePreviewError(current, error)
      })
      return
    }
    finish(operation?.wasEditable ?? true)
  }, [executeResult, finish, preservePreviewError])

  const createOperation = useCallback(async (current: RewritePreviewState): Promise<DocumentOperation> => {
    if (!editor || editor.isDestroyed || !current.invocationId) {
      throw new Error(t('contextRoom:tiptapSelectionRewrite.theDocumentOperationServiceIsUnavailable'))
    }
    if (selectionText(editor, current.from, current.to) !== current.originalText) {
      throw new Error(t('contextRoom:tiptapSelectionRewrite.theOriginalSelectionHasChangedSelectItAgain'))
    }
    const localOperation = operationRef.current
    if (localOperation) localOperation.startingOperation = true
    let operation
    try {
      const baseVersion = await prepareDocument()
      if (operationRef.current?.id !== localOperation?.id) {
        throw new DOMException('Selection rewrite cancelled', 'AbortError')
      }
      if (selectionText(editor, current.from, current.to) !== current.originalText) {
        throw new Error(t('contextRoom:tiptapSelectionRewrite.theOriginalSelectionHasChangedSelectItAgain'))
      }
      operation = await start({
        capabilityId: 'document.selection-rewrite',
        context: {
          roomId,
          documentId,
          invocationId: current.invocationId,
        },
        input: {
          baseVersion,
          proposedContentJson: proposedSelectionRewriteContent(
            editor,
            current.from,
            current.to,
            current.replacementText,
            current.formatContext,
          ),
          originalText: current.originalText,
          replacementText: current.replacementText,
          instruction: current.instruction.trim() || t('contextRoom:selectionRewriteAgent.defaultInstruction'),
        },
      })
      if (!operation) throw new Error(t('contextRoom:tiptapSelectionRewrite.theDocumentOperationServiceIsUnavailable'))
    } finally {
      const activeOperation = operationRef.current
      if (activeOperation && activeOperation.id === localOperation?.id) activeOperation.startingOperation = false
    }
    return operation
  }, [documentId, editor, prepareDocument, roomId, start, t])

  const startOperation = useCallback(async (current: RewritePreviewState): Promise<void> => {
    const operation = await createOperation(current)
    const active = previewRef.current
    if (!active || active.invocationId !== current.invocationId) {
      await executeResult(operation.id, 'operation.cancel')
      return
    }
    setPreview((value) => value ? {
      ...value,
      operationId: operation.id,
      revision: operation.revision,
      registeredReplacementText: current.replacementText,
      phase: 'ready',
      error: null,
    } : value)
  }, [createOperation, executeResult])

  const runRewrite = useCallback((
    anchor: RewriteAnchor,
    originalText: string,
    instruction: string,
    formatContext: SelectionRewriteFormatContext,
  ) => {
    if (!editor || editor.isDestroyed) return
    const api = window.nxcore?.contextRooms
    const position = previewPosition(editor, anchor.to)
    setRewriteDecoration(editor, { ...anchor, variant: 'original' })
    if (!api) {
      setPreview({
        ...anchor,
        originalText,
        replacementText: '',
        registeredReplacementText: null,
        instruction,
        formatContext,
        phase: 'error',
        error: t('contextRoom:tiptapSelectionRewrite.agentServiceDesktopOnly'),
        invocationId: null,
        operationId: null,
        revision: null,
        ...position,
      })
      return
    }

    const previous = operationRef.current
    previous?.controller.abort()
    const operation = {
      id: crypto.randomUUID(),
      controller: new AbortController(),
      wasEditable: previous?.wasEditable ?? editor.isEditable,
      startingOperation: false,
    }
    operationRef.current = operation
    editor.setEditable(false)
    setPreview({
      ...anchor,
      originalText,
      replacementText: '',
      registeredReplacementText: null,
      instruction,
      formatContext,
      phase: 'requesting',
      error: null,
      invocationId: null,
      operationId: null,
      revision: null,
      ...position,
    })

    const contextBefore = selectionText(editor, Math.max(0, anchor.from - 600), anchor.from)
    const contextAfter = selectionText(
      editor,
      anchor.to,
      Math.min(editor.state.doc.content.size, anchor.to + 600),
    )
    void streamSelectionRewrite(api, {
      roomId,
      documentName,
      selectedText: originalText,
      instruction,
      contextBefore,
      contextAfter,
      formatContext,
    }, {
      signal: operation.controller.signal,
      responseLanguage: locale,
      onText: (replacementText) => {
        if (operationRef.current?.id !== operation.id) return
        setPreview((current) => current ? { ...current, replacementText } : current)
      },
    }).then(async ({ replacementText, invocationId }) => {
      if (operationRef.current?.id !== operation.id) return
      const current = previewRef.current
      if (!current) return
      const generated: RewritePreviewState = {
        ...current,
        replacementText,
        invocationId,
        phase: 'requesting',
        error: null,
      }
      setPreview(generated)
      await startOperation(generated)
    }).catch((error: unknown) => {
      if (operationRef.current?.id !== operation.id) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      restoreEditor(operation.wasEditable)
      setPreview((current) => current ? {
        ...current,
        phase: 'error',
        error: rewriteErrorMessage(error),
      } : current)
    })
  }, [documentName, editor, locale, restoreEditor, rewriteErrorMessage, roomId, startOperation, t])

  const requestRewrite = useCallback((instruction: string) => {
    if (!editor || editor.isDestroyed || externallyLocked) return
    const { selection } = editor.state
    if (!(selection instanceof TextSelection) || selection.empty) return
    const originalText = selectionText(editor, selection.from, selection.to)
    if (!originalText.trim()) return
    runRewrite(
      { from: selection.from, to: selection.to },
      originalText,
      instruction,
      selectionFormatContext(editor, selection.from),
    )
  }, [editor, externallyLocked, runRewrite])

  const retry = useCallback(() => {
    const current = previewRef.current
    if (!current || !editor || editor.isDestroyed) return
    if (selectionText(editor, current.from, current.to) !== current.originalText) {
      setPreview({ ...current, phase: 'error', error: t('contextRoom:tiptapSelectionRewrite.theOriginalSelectionHasChangedSelectItAgain') })
      return
    }
    if (current.replacementText && current.invocationId && !current.operationId) {
      editor.setEditable(false)
      setPreview({ ...current, phase: 'requesting', error: null })
      void startOperation(current).catch((error: unknown) => {
        restoreEditor(operationRef.current?.wasEditable ?? true)
        setPreview((value) => value ? {
          ...value,
          phase: 'error',
          error: rewriteErrorMessage(error),
        } : value)
      })
      return
    }
    runRewrite(current, current.originalText, current.instruction, current.formatContext)
  }, [editor, restoreEditor, rewriteErrorMessage, runRewrite, startOperation])

  const accept = useCallback(() => {
    const current = previewRef.current
    const operation = operationRef.current
    if (!current || current.phase !== 'ready' || !current.operationId || current.revision === null
      || !current.replacementText || !editor || editor.isDestroyed) return
    if (selectionText(editor, current.from, current.to) !== current.originalText) {
      restoreEditor(operation?.wasEditable ?? true)
      setPreview({ ...current, phase: 'error', error: t('contextRoom:tiptapSelectionRewrite.theOriginalSelectionHasChangedSelectItAgain') })
      return
    }
    setPreview({ ...current, phase: 'submitting', error: null })
    void (async () => {
      let operationId = current.operationId!
      if (current.registeredReplacementText !== current.replacementText) {
        const replacementOperation = await createOperation(current)
        const rejected = await executeResult(operationId, 'review.reject')
        if (!rejected) {
          await executeResult(replacementOperation.id, 'operation.cancel')
          throw new Error(t('contextRoom:tiptapSelectionRewrite.unableToReplaceThePreviousRewriteCandidate'))
        }
        operationId = replacementOperation.id
        setPreview((value) => value ? {
          ...value,
          operationId,
          revision: replacementOperation.revision,
          registeredReplacementText: current.replacementText,
          phase: 'submitting',
          error: null,
        } : value)
      }
      return executeResult(operationId, 'review.apply')
    })().then((result) => {
      if (!result?.document) throw new Error(t('contextRoom:tiptapSelectionRewrite.theDocumentOperationDidNotReturnTheAuthoritative'))
      const scrollElement = editor.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
      const scrollPosition = scrollElement
        ? { top: scrollElement.scrollTop, left: scrollElement.scrollLeft }
        : null
      editor.commands.setContent(stripDocumentTitle(result.document.contentJson).content, { emitUpdate: false })
      onDocumentApplied(result.document)
      finish(operation?.wasEditable ?? true)
      if (scrollElement && scrollPosition) {
        scrollElement.scrollTo({ ...scrollPosition, behavior: 'auto' })
        window.requestAnimationFrame(() => {
          scrollElement.scrollTo({ ...scrollPosition, behavior: 'auto' })
        })
      }
    }).catch((error: unknown) => {
      void preservePreviewError(current, error)
    })
  }, [createOperation, editor, executeResult, finish, onDocumentApplied, preservePreviewError, restoreEditor])

  const updateReplacementText = useCallback((replacementText: string) => {
    setPreview((current) => current?.phase === 'ready'
      ? { ...current, replacementText, error: null }
      : current)
  }, [])

  useEffect(() => {
    if (!preview || !editor) return
    const updatePosition = () => {
      const current = previewRef.current
      if (!current || editor.isDestroyed) return
      const next = previewPosition(editor, current.to)
      setPreview((value) => value && (value.left !== next.left || value.top !== next.top)
        ? { ...value, ...next }
        : value)
    }
    window.addEventListener('resize', updatePosition)
    document.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      document.removeEventListener('scroll', updatePosition, true)
    }
  }, [editor, preview?.from, preview?.to])

  useEffect(() => {
    if (!preview) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
      } else if (event.key === 'Tab' && previewRef.current?.phase === 'ready') {
        event.preventDefault()
        accept()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [accept, cancel, preview])

  useEffect(() => {
    if (externallyLocked && preview) cancel()
  }, [cancel, externallyLocked, preview])

  useEffect(() => () => {
    const operation = operationRef.current
    operationRef.current = null
    operation?.controller.abort()
    if (editor && !editor.isDestroyed) {
      setRewriteDecoration(editor, null)
      if (operation?.wasEditable && !externallyLocked) editor.setEditable(true)
    }
  }, [editor, externallyLocked])

  return { accept, cancel, preview, requestRewrite, retry, updateReplacementText }
}

export function TiptapSelectionRewritePreview({
  preview,
  onAccept,
  onCancel,
  onChange,
  onRetry,
}: {
  preview: RewritePreviewState | null
  onAccept: () => void
  onCancel: () => void
  onChange: (replacementText: string) => void
  onRetry: () => void
}) {
  const { t } = useLocale()
  if (!preview) return null

  return (
    <section
      className="context-room-tiptap-rewrite-preview"
      data-phase={preview.phase}
      style={{ left: preview.left, top: preview.top }}
      aria-label={t('contextRoom:tiptapSelectionRewrite.aiRewritePreview')}
      aria-live="polite"
    >
      <header>
        {preview.phase === 'requesting' || preview.phase === 'submitting' ? <LoaderCircle className="is-spinning" /> : <Sparkles />}
        <span>{preview.phase === 'requesting'
          ? t('contextRoom:tiptapSelectionRewrite.rewriting')
          : t(preview.phase === 'submitting' ? 'contextRoom:tiptapSelectionRewrite.submitting' : preview.phase === 'ready' ? 'contextRoom:tiptapSelectionRewrite.suggestedEdit' : 'contextRoom:tiptapSelectionRewrite.rewriteFailed')}</span>
        <div>
          {preview.phase === 'error' ? (
            <button type="button" aria-label={t('contextRoom:tiptapSelectionRewrite.rewriteAgain')} title={t('contextRoom:tiptapSelectionRewrite.rewriteAgain')} onClick={onRetry}><RotateCcw /></button>
          ) : null}
          <button type="button" disabled={preview.phase === 'submitting'} aria-label={t('contextRoom:tiptapSelectionRewrite.cancelRewrite')} title={t('contextRoom:tiptapSelectionRewrite.cancelRewrite')} onClick={onCancel}><X /></button>
        </div>
      </header>
      {preview.phase === 'ready' || preview.phase === 'submitting' || preview.replacementText ? (
        <textarea
          className="context-room-tiptap-rewrite-text"
          aria-label={t('contextRoom:tiptapSelectionRewrite.editRewrittenText')}
          value={preview.replacementText}
          maxLength={65_536}
          disabled={preview.phase !== 'ready'}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="context-room-tiptap-rewrite-text" data-empty>
          {preview.phase === 'error'
            ? preview.error
            : <span className="context-room-tiptap-rewrite-caret" />}
        </div>
      )}
      {preview.error && preview.replacementText ? <p role="alert">{preview.error}</p> : null}
      {preview.phase === 'ready' ? (
        <footer>
          <button
            type="button"
            aria-label={t('contextRoom:tiptapSelectionRewrite.applyRewrite')}
            title={t('contextRoom:tiptapSelectionRewrite.applyRewrite')}
            disabled={!preview.replacementText.trim()}
            onClick={onAccept}
          ><Check /></button>
        </footer>
      ) : null}
    </section>
  )
}
