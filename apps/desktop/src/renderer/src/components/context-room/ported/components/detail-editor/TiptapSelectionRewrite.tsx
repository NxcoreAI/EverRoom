import { Extension, type Editor } from '@tiptap/react'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Check, LoaderCircle, RotateCcw, Sparkles, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { streamSelectionRewrite } from './selectionRewriteAgent'

interface RewriteAnchor {
  from: number
  to: number
}

interface RewritePreviewState extends RewriteAnchor {
  originalText: string
  replacementText: string
  instruction: string
  phase: 'requesting' | 'ready' | 'error'
  error: string | null
  left: number
  top: number
}

const rewriteDecorationKey = new PluginKey<RewriteAnchor | null>('selectionRewritePreview')

export const SelectionRewritePreviewExtension = Extension.create({
  name: 'selectionRewritePreview',
  addProseMirrorPlugins() {
    return [new Plugin<RewriteAnchor | null>({
      key: rewriteDecorationKey,
      state: {
        init: () => null,
        apply(transaction, current) {
          const next = transaction.getMeta(rewriteDecorationKey) as RewriteAnchor | null | undefined
          if (next !== undefined) return next
          if (!current) return null
          return {
            from: transaction.mapping.map(current.from, 1),
            to: transaction.mapping.map(current.to, -1),
          }
        },
      },
      props: {
        decorations(state) {
          const anchor = rewriteDecorationKey.getState(state)
          if (!anchor || anchor.from >= anchor.to || anchor.to > state.doc.content.size) return null
          return DecorationSet.create(state.doc, [
            Decoration.inline(anchor.from, anchor.to, {
              class: 'context-room-tiptap-rewrite-original',
              'data-selection-rewrite': 'original',
            }),
          ])
        },
      },
    })]
  },
})

function setRewriteDecoration(editor: Editor, anchor: RewriteAnchor | null): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(rewriteDecorationKey, anchor))
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

export function useTiptapSelectionRewrite({
  editor,
  roomId,
  documentName,
  externallyLocked,
}: {
  editor: Editor | null
  roomId: string
  documentName: string
  externallyLocked: boolean
}) {
  const [preview, setPreview] = useState<RewritePreviewState | null>(null)
  const previewRef = useRef(preview)
  const operationRef = useRef<{ id: string; controller: AbortController; wasEditable: boolean } | null>(null)
  previewRef.current = preview

  const restoreEditor = useCallback((wasEditable: boolean) => {
    if (!editor || editor.isDestroyed) return
    setRewriteDecoration(editor, null)
    if (wasEditable && !externallyLocked) editor.setEditable(true)
  }, [editor, externallyLocked])

  const cancel = useCallback(() => {
    const operation = operationRef.current
    operationRef.current = null
    operation?.controller.abort()
    if (editor) restoreEditor(operation?.wasEditable ?? true)
    setPreview(null)
  }, [editor, restoreEditor])

  const runRewrite = useCallback((anchor: RewriteAnchor, originalText: string, instruction: string) => {
    if (!editor || editor.isDestroyed) return
    const api = window.nxcore?.agent
    const position = previewPosition(editor, anchor.to)
    if (!api) {
      setPreview({
        ...anchor,
        originalText,
        replacementText: '',
        instruction,
        phase: 'error',
        error: 'Agent 服务仅在桌面应用中可用。',
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
    }
    operationRef.current = operation
    setRewriteDecoration(editor, anchor)
    editor.setEditable(false)
    setPreview({
      ...anchor,
      originalText,
      replacementText: '',
      instruction,
      phase: 'requesting',
      error: null,
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
    }, {
      signal: operation.controller.signal,
      onText: (replacementText) => {
        if (operationRef.current?.id !== operation.id) return
        setPreview((current) => current ? { ...current, replacementText } : current)
      },
    }).then((replacementText) => {
      if (operationRef.current?.id !== operation.id) return
      setPreview((current) => current ? {
        ...current,
        replacementText,
        phase: 'ready',
      } : current)
    }).catch((error: unknown) => {
      if (operationRef.current?.id !== operation.id) return
      if (error instanceof DOMException && error.name === 'AbortError') return
      restoreEditor(operation.wasEditable)
      setPreview((current) => current ? {
        ...current,
        phase: 'error',
        error: error instanceof Error ? error.message : 'Agent 重写失败。',
      } : current)
    })
  }, [documentName, editor, restoreEditor, roomId])

  const requestRewrite = useCallback((instruction: string) => {
    if (!editor || editor.isDestroyed || externallyLocked) return
    const { selection } = editor.state
    if (!(selection instanceof TextSelection) || selection.empty || !selection.$from.sameParent(selection.$to)) return
    const originalText = selectionText(editor, selection.from, selection.to)
    if (!originalText.trim()) return
    runRewrite({ from: selection.from, to: selection.to }, originalText, instruction)
  }, [editor, externallyLocked, runRewrite])

  const retry = useCallback(() => {
    const current = previewRef.current
    if (!current || !editor || editor.isDestroyed) return
    if (selectionText(editor, current.from, current.to) !== current.originalText) {
      setPreview({ ...current, phase: 'error', error: '原选区已经变化，请重新选择。' })
      return
    }
    runRewrite(current, current.originalText, current.instruction)
  }, [editor, runRewrite])

  const accept = useCallback(() => {
    const current = previewRef.current
    const operation = operationRef.current
    if (!current || current.phase !== 'ready' || !current.replacementText || !editor || editor.isDestroyed) return
    if (selectionText(editor, current.from, current.to) !== current.originalText) {
      restoreEditor(operation?.wasEditable ?? true)
      setPreview({ ...current, phase: 'error', error: '原选区已经变化，请重新选择。' })
      return
    }
    const transaction = editor.state.tr
      .insertText(current.replacementText, current.from, current.to)
      .setMeta(rewriteDecorationKey, null)
    editor.view.dispatch(transaction)
    operationRef.current = null
    restoreEditor(operation?.wasEditable ?? true)
    setPreview(null)
    editor.commands.focus(Math.min(current.from + current.replacementText.length, editor.state.doc.content.size))
  }, [editor, restoreEditor])

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

  return { accept, cancel, preview, requestRewrite, retry }
}

export function TiptapSelectionRewritePreview({
  preview,
  onAccept,
  onCancel,
  onRetry,
}: {
  preview: RewritePreviewState | null
  onAccept: () => void
  onCancel: () => void
  onRetry: () => void
}) {
  if (!preview) return null

  return (
    <section
      className="context-room-tiptap-rewrite-preview"
      data-phase={preview.phase}
      style={{ left: preview.left, top: preview.top }}
      aria-label="AI 重写预览"
      aria-live="polite"
    >
      <header>
        {preview.phase === 'requesting' ? <LoaderCircle className="is-spinning" /> : <Sparkles />}
        <span>{preview.phase === 'requesting' ? '正在重写' : preview.phase === 'ready' ? '建议修改' : '重写失败'}</span>
        <div>
          {preview.phase !== 'requesting' ? (
            <button type="button" aria-label="重新重写" title="重新重写" onClick={onRetry}><RotateCcw /></button>
          ) : null}
          <button type="button" aria-label="取消重写" title="取消重写" onClick={onCancel}><X /></button>
        </div>
      </header>
      <div className="context-room-tiptap-rewrite-text" data-empty={!preview.replacementText}>
        {preview.phase === 'error'
          ? preview.error
          : preview.replacementText || <span className="context-room-tiptap-rewrite-caret" />}
      </div>
      {preview.phase === 'ready' ? (
        <footer>
          <button type="button" aria-label="应用重写" title="应用重写" onClick={onAccept}><Check /></button>
        </footer>
      ) : null}
    </section>
  )
}
