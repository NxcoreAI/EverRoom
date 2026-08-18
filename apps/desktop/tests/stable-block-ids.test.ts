import StarterKit from '@tiptap/starter-kit'
import { Slice } from '@tiptap/pm/model'
import { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ensureStableBlockIds,
  StableBlockIds,
  stripStableBlockIdsFromPaste,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/StableBlockIds'

const editors: Editor[] = []

function createEditor(content: Record<string, unknown>): Editor {
  const editor = new Editor({ extensions: [StarterKit, StableBlockIds], content })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

function paragraphIds(editor: Editor): string[] {
  return (editor.getJSON().content ?? [])
    .filter((node) => node.type === 'paragraph')
    .map((node) => String(node.attrs?.id ?? ''))
}

describe('StableBlockIds', () => {
  it('preserves an existing id and fills missing ids', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'kept' }, content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    })
    ensureStableBlockIds(editor)
    const ids = paragraphIds(editor)
    expect(ids[0]).toBe('kept')
    expect(ids[1]).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('keeps the first id and assigns a fresh id after a split', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { id: 'original' },
        content: [{ type: 'text', text: 'hello' }],
      }],
    })
    editor.chain().setTextSelection(3).splitBlock().run()
    const ids = paragraphIds(editor)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe('original')
    expect(ids[1]).not.toBe('original')
    expect(ids[1]).toBeTruthy()
  })

  it('freshens duplicate ids while keeping the original block stable', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { id: 'original' },
        content: [{ type: 'text', text: 'hello' }],
      }],
    })
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: 'paragraph',
      attrs: { id: 'original' },
      content: [{ type: 'text', text: 'copy' }],
    })
    const ids = paragraphIds(editor)
    expect(ids[0]).toBe('original')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('remaps pasted block ids and inline links that target the pasted tree', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph', attrs: { id: 'source' }, content: [{
          type: 'text',
          text: 'linked',
          marks: [{ type: 'link', attrs: { href: 'everroom://room/room-1/doc-1/source' } }],
        }],
      }],
    })
    const slice = new Slice(editor.state.doc.content, 0, 0)
    const pasted = stripStableBlockIdsFromPaste(slice, 'doc-1')
    const paragraph = pasted.content.firstChild!
    const nextId = String(paragraph.attrs.id)
    expect(nextId).not.toBe('source')
    expect(paragraph.firstChild?.marks[0]?.attrs.href).toContain(`/${nextId}`)
  })

  it('does not remap an external link that happens to use the same block id', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph', attrs: { id: 'source' }, content: [{
          type: 'text',
          text: 'external',
          marks: [{ type: 'link', attrs: { href: 'everroom://room/room-1/other-doc/source' } }],
        }],
      }],
    })
    const pasted = stripStableBlockIdsFromPaste(new Slice(editor.state.doc.content, 0, 0), 'doc-1')
    expect(pasted.content.firstChild?.firstChild?.marks[0]?.attrs.href)
      .toBe('everroom://room/room-1/other-doc/source')
  })
})
