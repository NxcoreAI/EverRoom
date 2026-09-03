import StarterKit from '@tiptap/starter-kit'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import { Editor } from '@tiptap/react'
import { Slice } from '@tiptap/pm/model'
import { afterEach, describe, expect, it } from 'vitest'

import { BlockIndexMark } from '../src/renderer/src/components/context-room/ported/components/detail-editor/BlockIndexMark'
import { DocumentBlockReference } from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentBlockReference'
import {
  BLOCK_INDEX_MARK_NODE,
  blockIndexTargetFromClipboardText,
  findIndexMarkHost,
  fromBlockIndexMarkNodeAttrs,
  insertBlockIndexMark,
  toBlockIndexMarkNodeAttrs,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/blockIndexLink'
import {
  StableBlockIds,
  stripStableBlockIdsFromPaste,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/StableBlockIds'

const editors: Editor[] = []

function createEditor(content: Record<string, unknown>): Editor {
  const editor = new Editor({
    extensions: [StarterKit, Markdown, StableBlockIds, DocumentBlockReference, BlockIndexMark],
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('block index mark', () => {
  it('parses an inline index mark at the end of a paragraph and round trips it', () => {
    const manager = new MarkdownManager({
      extensions: [
        StarterKit,
        DocumentBlockReference.configure({ sourceRoomId: 'room-1' }),
        BlockIndexMark,
      ],
    })
    const markdown = '本段来自既有结论^[来源草稿](everroom://room/room-1/doc-1/block-1)'
    const parsed = manager.parse(markdown)

    const paragraph = parsed.content?.[0]
    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.content).toHaveLength(2)
    expect(paragraph?.content?.[1]).toMatchObject({
      type: BLOCK_INDEX_MARK_NODE,
      attrs: {
        kind: 'document',
        targetRoomId: 'room-1',
        targetDocumentId: 'doc-1',
        targetBlockId: 'block-1',
        fallbackTitle: '来源草稿',
      },
    })
    expect(manager.serialize(parsed)).toBe(markdown)
  })

  it('round trips memory index marks', () => {
    const manager = new MarkdownManager({ extensions: [StarterKit, BlockIndexMark] })
    const markdown = '参考记忆^[用户偏好](everroom://memory/room-1/room-1-memory-2?preview=%E5%81%8F%E5%A5%BD)'
    const parsed = manager.parse(markdown)
    expect(parsed.content?.[0]?.content?.[1]).toMatchObject({
      type: BLOCK_INDEX_MARK_NODE,
      attrs: {
        kind: 'memory',
        targetRoomId: 'room-1',
        targetMemoryId: 'room-1-memory-2',
        fallbackPreview: '偏好',
      },
    })
    expect(manager.serialize(parsed)).toBe(markdown)
  })

  it('keeps plain everroom links as link marks and block references intact', () => {
    const manager = new MarkdownManager({
      extensions: [
        StarterKit,
        DocumentBlockReference.configure({ sourceRoomId: 'room-1' }),
        BlockIndexMark,
      ],
    })
    const inline = manager.parse('见[链接](everroom://room/room-1/doc-1/block-1)处')
    const inlineChildren = inline.content?.[0]?.content ?? []
    const linkedText = inlineChildren.find(
      (node) => node.marks?.some((mark) => mark.type === 'link'
        && mark.attrs?.href === 'everroom://room/room-1/doc-1/block-1'),
    )
    expect(linkedText?.text).toBe('链接')
    expect(inlineChildren.some((node) => node.type === BLOCK_INDEX_MARK_NODE)).toBe(false)

    const blockLevel = manager.parse('[引用](everroom://room/room-1/doc-1/block-1)\n')
    expect(blockLevel.content?.[0]?.type).toBe('documentBlockReference')
  })

  it('round trips index marks through the editor markdown storage', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: '内容' },
          { type: BLOCK_INDEX_MARK_NODE, attrs: toBlockIndexMarkNodeAttrs({
            kind: 'document',
            roomId: 'room-1',
            documentId: 'doc-1',
            blockId: 'block-1',
            fallbackTitle: '来源',
          }) },
        ],
      }],
    })
    const markdown = editor.storage.markdown.manager.serialize(editor.getJSON())
    expect(markdown).toContain('内容^[来源](everroom://room/room-1/doc-1/block-1)')

    const restored = createEditor({ type: 'doc', content: [] })
    const parsed = restored.storage.markdown.manager.parse(markdown)
    restored.commands.setContent(parsed)
    expect(restored.getJSON().content?.[0]?.content?.[1]?.type).toBe(BLOCK_INDEX_MARK_NODE)
  })

  it('converts node attrs to targets and back, dropping broken ones', () => {
    const documentTarget = {
      kind: 'document' as const,
      roomId: 'r',
      documentId: 'd',
      blockId: 'b',
      fallbackTitle: null,
      fallbackPreview: null,
    }
    expect(fromBlockIndexMarkNodeAttrs(toBlockIndexMarkNodeAttrs(documentTarget))).toEqual(documentTarget)

    const memoryTarget = {
      kind: 'memory' as const,
      roomId: 'r',
      memoryId: 'm',
      fallbackTitle: null,
      fallbackPreview: null,
    }
    expect(fromBlockIndexMarkNodeAttrs(toBlockIndexMarkNodeAttrs(memoryTarget))).toEqual(memoryTarget)
    expect(fromBlockIndexMarkNodeAttrs({ kind: 'document', targetRoomId: 'r', targetDocumentId: '', targetBlockId: '' })).toBeNull()
  })

  it('finds the last eligible textblock host within a block', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '直接段落' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '一' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: '二' }] }] },
        ] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'code' }] },
      ],
    })
    const [paragraph, list, codeBlock] = editor.state.doc.content.content
    expect(findIndexMarkHost(paragraph)?.textContent).toBe('直接段落')
    expect(findIndexMarkHost(list)?.textContent).toBe('二')
    expect(findIndexMarkHost(codeBlock)).toBeNull()
  })

  it('inserts a mark at the end of the host textblock', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: '宿主段落' }] },
      ],
    })
    const paragraph = editor.state.doc.content.child(0)
    const inserted = insertBlockIndexMark(editor, 0, paragraph, {
      kind: 'memory',
      roomId: 'room-1',
      memoryId: 'm-1',
      fallbackTitle: '记忆',
    })
    expect(inserted).toBe(true)
    const updated = editor.getJSON().content?.[0]?.content
    expect(updated?.[updated.length - 1]).toMatchObject({
      type: BLOCK_INDEX_MARK_NODE,
      attrs: { kind: 'memory', targetMemoryId: 'm-1' },
    })
  })

  it('parses block links from clipboard text in all supported shapes', () => {
    // 复制块引用写剪贴板的裸 URL,带 title/preview query。
    expect(blockIndexTargetFromClipboardText(
      'everroom://room/room-1/doc-2/block-7?title=%E7%9B%AE%E6%A0%87%E6%96%87%E6%A1%A3&preview=%E9%A2%84%E8%A7%88',
    )).toEqual({
      kind: 'document',
      roomId: 'room-1',
      documentId: 'doc-2',
      blockId: 'block-7',
      fallbackTitle: '目标文档',
      fallbackPreview: '预览',
    })
    // markdown 链接形式,label 兜底 fallbackTitle。
    expect(blockIndexTargetFromClipboardText(
      '[目标文档](everroom://room/room-1/doc-2/block-7)',
    )).toMatchObject({
      kind: 'document',
      roomId: 'room-1',
      documentId: 'doc-2',
      blockId: 'block-7',
      fallbackTitle: '目标文档',
    })
    // 索引标记自身的语法(前后空白容忍)。
    expect(blockIndexTargetFromClipboardText(
      '  ^[用户偏好](everroom://memory/room-1/room-1-memory-2)  ',
    )).toMatchObject({
      kind: 'memory',
      roomId: 'room-1',
      memoryId: 'room-1-memory-2',
      fallbackTitle: '用户偏好',
    })
    // 非链接载荷 / 混合内容一律不认,走普通粘贴。
    expect(blockIndexTargetFromClipboardText('普通文本')).toBeNull()
    expect(blockIndexTargetFromClipboardText('')).toBeNull()
    expect(blockIndexTargetFromClipboardText(
      '说明文字 everroom://room/room-1/doc-2/block-7',
    )).toBeNull()
    expect(blockIndexTargetFromClipboardText('[外部](https://example.com)')).toBeNull()
  })

  it('remaps same-document mark targets when pasting copied blocks', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'target-block' },
          content: [{ type: 'text', text: '目标块' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'host-block' },
          content: [
            { type: 'text', text: '带索引的段落' },
            { type: BLOCK_INDEX_MARK_NODE, attrs: toBlockIndexMarkNodeAttrs({
              kind: 'document',
              roomId: 'room-1',
              documentId: 'doc-1',
              blockId: 'target-block',
              fallbackTitle: '目标',
            }) },
          ],
        },
      ],
    })
    const freshened = stripStableBlockIdsFromPaste(
      new Slice(editor.state.doc.content, 0, 0),
      'doc-1',
    )
    const markNode = findMarkInFragment(freshened.content)
    expect(markNode).not.toBeNull()
    expect(markNode?.attrs?.targetBlockId).not.toBe('target-block')
    // The remapped id must match the pasted copy of the target block.
    expect(markNode?.attrs?.targetBlockId).toBe(freshened.content.child(0).attrs?.id)
  })

  it('keeps memory mark targets untouched when pasting', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'host-block' },
          content: [
            { type: 'text', text: '记忆段落' },
            { type: BLOCK_INDEX_MARK_NODE, attrs: toBlockIndexMarkNodeAttrs({
              kind: 'memory',
              roomId: 'room-1',
              memoryId: 'room-1-memory-1',
            }) },
          ],
        },
      ],
    })
    const freshened = stripStableBlockIdsFromPaste(
      new Slice(editor.state.doc.content, 0, 0),
      'doc-1',
    )
    const markNode = findMarkInFragment(freshened.content)
    expect(markNode?.attrs?.targetMemoryId).toBe('room-1-memory-1')
  })
})

interface TestNode {
  type: { name: string }
  attrs?: Record<string, unknown>
  content?: TestNode[]
}

function findMarkInFragment(fragment: { forEach: (cb: (node: TestNode) => void) => void }): TestNode | null {
  let found: TestNode | null = null
  const visit = (node: TestNode) => {
    if (node.type.name === BLOCK_INDEX_MARK_NODE) found = node
    node.content?.forEach(visit)
  }
  fragment.forEach(visit)
  return found
}
