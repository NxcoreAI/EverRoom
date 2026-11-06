import type { TiptapJsonContent } from '@nxcore/agent-contract'
import { Selection, TextSelection } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'

export function shouldApplyBackendDocumentSnapshot({
  incomingVersion,
  currentVersion,
  editRevision,
  persistedEditRevision,
  saveInFlight,
  hasPendingSave,
  composing,
}: {
  incomingVersion: number
  currentVersion: number
  editRevision: number
  persistedEditRevision: number
  saveInFlight: boolean
  hasPendingSave: boolean
  composing: boolean
}): boolean {
  return incomingVersion >= currentVersion
    && editRevision === persistedEditRevision
    && !saveInFlight
    && !hasPendingSave
    && !composing
}

function selectionAfterContentReplacement(
  selection: Selection,
  editor: Editor,
): Selection {
  const doc = editor.state.doc
  const clamp = (position: number) => Math.max(0, Math.min(position, doc.content.size))
  try {
    if (selection instanceof TextSelection) {
      return TextSelection.between(
        doc.resolve(clamp(selection.from)),
        doc.resolve(clamp(selection.to)),
      )
    }
    return selection.getBookmark().resolve(doc)
  } catch {
    return Selection.near(doc.resolve(clamp(selection.from)))
  }
}

export function setEditorContentPreservingView(
  editor: Editor,
  content: TiptapJsonContent,
): void {
  const selection = editor.state.selection
  const scrollElement = editor.view.dom.closest<HTMLElement>('.context-room-tiptap-scroll')
  const scrollPosition = scrollElement
    ? { left: scrollElement.scrollLeft, top: scrollElement.scrollTop }
    : null

  editor.commands.setContent(content, { emitUpdate: false })

  const restoredSelection = selectionAfterContentReplacement(selection, editor)
  if (!restoredSelection.eq(editor.state.selection)) {
    editor.view.dispatch(editor.state.tr
      .setSelection(restoredSelection)
      .setMeta('addToHistory', false)
      .setMeta('preventUpdate', true))
  }

  if (!scrollElement || !scrollPosition) return
  const restoreScroll = () => {
    scrollElement.scrollLeft = scrollPosition.left
    scrollElement.scrollTop = scrollPosition.top
  }
  restoreScroll()
  globalThis.requestAnimationFrame?.(restoreScroll)
}
