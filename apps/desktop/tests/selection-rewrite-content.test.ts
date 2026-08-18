import { Markdown } from '@tiptap/markdown'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'

import { proposedSelectionRewriteContent } from '../src/renderer/src/components/context-room/ported/components/detail-editor/TiptapSelectionRewrite'

const editors: Editor[] = []

function createEditor(content: Record<string, unknown>): Editor {
  const editor = new Editor({ extensions: [StarterKit, Markdown], content })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('selection rewrite content', () => {
  it('turns a Markdown list replacement into list nodes', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: '第一项和第二项' }],
      }],
    })

    const content = proposedSelectionRewriteContent(
      editor,
      1,
      editor.state.doc.content.size - 1,
      '- 第一项\n- 第二项',
      { blockType: 'paragraph', ancestorTypes: ['paragraph'] },
    )

    expect(content.content).toEqual([expect.objectContaining({
      type: 'bulletList',
      content: [
        expect.objectContaining({ type: 'listItem' }),
        expect.objectContaining({ type: 'listItem' }),
      ],
    })])
  })

  it('renders inline Markdown without replacing the paragraph wrapper', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: '原文内容' }],
      }],
    })

    const content = proposedSelectionRewriteContent(
      editor,
      1,
      editor.state.doc.content.size - 1,
      '**重点内容**',
      { blockType: 'paragraph', ancestorTypes: ['paragraph'] },
    )

    expect(content.content).toEqual([{
      type: 'paragraph',
      content: [{ type: 'text', marks: [{ type: 'bold' }], text: '重点内容' }],
    }])
  })

  it('builds the accepted document from the user-edited candidate', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: '原文内容' }],
      }],
    })

    const content = proposedSelectionRewriteContent(
      editor,
      1,
      editor.state.doc.content.size - 1,
      '用户编辑后的 **最终内容**',
      { blockType: 'paragraph', ancestorTypes: ['paragraph'] },
    )

    expect(content.content).toEqual([{
      type: 'paragraph',
      content: [
        { type: 'text', text: '用户编辑后的 ' },
        { type: 'text', marks: [{ type: 'bold' }], text: '最终内容' },
      ],
    }])
    expect(editor.getText()).toBe('原文内容')
  })

  it('replaces a multi-paragraph selection with a Markdown list', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '保留段落' }] },
      ],
    })
    const secondParagraph = editor.state.doc.child(1)
    const selectedTo = editor.state.doc.child(0).nodeSize + secondParagraph.nodeSize - 1

    const content = proposedSelectionRewriteContent(
      editor,
      1,
      selectedTo,
      '- 第一项\n- 第二项',
      { blockType: 'paragraph', ancestorTypes: ['paragraph'] },
    )

    expect(content.content?.map((node) => node.type)).toEqual(['bulletList', 'paragraph'])
    expect(content.content?.[1]).toMatchObject({
      type: 'paragraph',
      content: [{ type: 'text', text: '保留段落' }],
    })
  })

  it('keeps code-block rewrites as raw code text', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [{ type: 'text', text: 'const value = 1' }],
      }],
    })

    const content = proposedSelectionRewriteContent(
      editor,
      1,
      editor.state.doc.content.size - 1,
      'const values = [\n  "- raw",\n]',
      { blockType: 'codeBlock', ancestorTypes: ['codeBlock'], codeLanguage: 'ts' },
    )

    expect(content.content?.[0]).toMatchObject({
      type: 'codeBlock',
      content: [{ type: 'text', text: 'const values = [\n  "- raw",\n]' }],
    })
  })
})
