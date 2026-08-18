import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  setEditorContentPreservingView,
  shouldApplyBackendDocumentSnapshot,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentEditorSync'

const editors: Editor[] = []

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('document editor backend synchronization', () => {
  const idleSnapshot = {
    incomingVersion: 4,
    currentVersion: 4,
    editRevision: 7,
    persistedEditRevision: 7,
    saveInFlight: false,
    hasPendingSave: false,
    composing: false,
  }

  it('rejects save snapshots while newer local input is pending', () => {
    expect(shouldApplyBackendDocumentSnapshot({
      ...idleSnapshot,
      editRevision: 8,
    })).toBe(false)
    expect(shouldApplyBackendDocumentSnapshot({
      ...idleSnapshot,
      saveInFlight: true,
    })).toBe(false)
    expect(shouldApplyBackendDocumentSnapshot({
      ...idleSnapshot,
      hasPendingSave: true,
    })).toBe(false)
  })

  it('rejects stale versions and snapshots arriving during composition', () => {
    expect(shouldApplyBackendDocumentSnapshot({
      ...idleSnapshot,
      incomingVersion: 3,
    })).toBe(false)
    expect(shouldApplyBackendDocumentSnapshot({
      ...idleSnapshot,
      composing: true,
    })).toBe(false)
    expect(shouldApplyBackendDocumentSnapshot(idleSnapshot)).toBe(true)
  })

  it('preserves the cursor and scroll position for an accepted remote replacement', () => {
    const schemaEditor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '第一段文字' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '正在编辑的位置' }] },
          { type: 'paragraph', content: [{ type: 'text', text: '文档末尾' }] },
        ],
      },
    })
    editors.push(schemaEditor)
    let state = EditorState.create({
      schema: schemaEditor.schema,
      doc: schemaEditor.state.doc,
    })
    const cursorPosition = 11
    state = state.apply(state.tr.setSelection(
      TextSelection.create(state.doc, cursorPosition),
    ))
    const scrollElement = { scrollTop: 180, scrollLeft: 12 } as HTMLElement
    const editor = {
      get state() {
        return state
      },
      commands: {
        setContent(content: Record<string, unknown>) {
          const doc = schemaEditor.schema.nodeFromJSON(content)
          state = EditorState.create({
            schema: schemaEditor.schema,
            doc,
            selection: TextSelection.atEnd(doc),
          })
          return true
        },
      },
      view: {
        dom: { closest: () => scrollElement },
        dispatch(transaction: Transaction) {
          state = state.apply(transaction)
        },
      },
    } as unknown as Editor

    setEditorContentPreservingView(editor, {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段文字' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '正在编辑的新位置' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '新的文档末尾' }] },
      ],
    })

    expect(editor.state.selection.from).toBe(cursorPosition)
    expect(editor.state.selection.from).toBeLessThan(editor.state.doc.content.size)
    expect(scrollElement.scrollTop).toBe(180)
    expect(scrollElement.scrollLeft).toBe(12)
  })
})
