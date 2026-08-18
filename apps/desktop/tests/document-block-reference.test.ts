import { describe, expect, it } from 'vitest'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

import { DocumentBlockReference } from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentBlockReference'
import {
  createEverroomBlockReferenceUrl,
  documentBlockReferenceToMarkdown,
  documentBlockResolutionLabel,
  isSameRoomBlockReference,
  parseDocumentBlockReferenceMarkdown,
  parseEverroomBlockReferenceUrl,
  parseSameRoomBlockReferenceLink,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentBlockReferenceLink'

describe('document block references', () => {
  const reference = {
    roomId: 'room/a',
    documentId: 'doc 1',
    blockId: 'block-1',
    fallbackTitle: '计划 [草案]',
    fallbackPreview: '第一阶段：调研',
  }

  it('round trips the canonical everroom deep link', () => {
    const url = createEverroomBlockReferenceUrl(reference)
    expect(url).toContain('everroom://room/room%2Fa/doc%201/block-1?')
    expect(parseEverroomBlockReferenceUrl(url)).toEqual(reference)
  })

  it('round trips an exported Markdown reference', () => {
    const markdown = documentBlockReferenceToMarkdown(reference)
    expect(markdown.startsWith('[计划 \\[草案\\]](everroom://room/')).toBe(true)
    expect(parseDocumentBlockReferenceMarkdown(`${markdown}\n`)).toEqual(reference)
  })

  it('registers with the Tiptap Markdown parser and serializer', () => {
    const manager = new MarkdownManager({
      extensions: [StarterKit, DocumentBlockReference.configure({ sourceRoomId: 'room/a' })],
    })
    const markdown = documentBlockReferenceToMarkdown(reference)
    const parsed = manager.parse(markdown)
    expect(parsed.content?.[0]).toMatchObject({
      type: 'documentBlockReference',
      attrs: {
        targetRoomId: reference.roomId,
        targetDocumentId: reference.documentId,
        targetBlockId: reference.blockId,
        fallbackTitle: reference.fallbackTitle,
        fallbackPreview: reference.fallbackPreview,
      },
    })
    expect(manager.serialize(parsed)).toBe(markdown)
  })

  it('uses the Markdown label as fallback for a manually authored link', () => {
    const url = createEverroomBlockReferenceUrl({
      roomId: 'room-1',
      documentId: 'doc-1',
      blockId: 'block-1',
    })
    expect(parseDocumentBlockReferenceMarkdown(`[会议结论](${url})`)).toMatchObject({
      fallbackTitle: '会议结论',
      fallbackPreview: null,
    })
  })

  it('rejects ordinary and malformed links', () => {
    expect(parseEverroomBlockReferenceUrl('https://example.com')).toBeNull()
    expect(parseEverroomBlockReferenceUrl('everroom://room/only/two')).toBeNull()
    expect(parseEverroomBlockReferenceUrl('everroom://room/%E0%A4%A/doc/block')).toBeNull()
    expect(parseDocumentBlockReferenceMarkdown('[网页](https://example.com)')).toBeNull()
  })

  it('enforces same-Room references and describes broken states', () => {
    expect(isSameRoomBlockReference('room-1', { roomId: 'room-1' })).toBe(true)
    expect(isSameRoomBlockReference('room-1', { roomId: 'room-2' })).toBe(false)
    expect(documentBlockResolutionLabel({ status: 'block_missing' })).toBe('原内容块已不存在')
    expect(documentBlockResolutionLabel({ status: 'document_trashed' })).toBe('文档在回收站')
  })

  it('recognizes only same-Room deep links for inline navigation', () => {
    const url = createEverroomBlockReferenceUrl(reference)
    expect(parseSameRoomBlockReferenceLink(url, reference.roomId)).toEqual(reference)
    expect(parseSameRoomBlockReferenceLink(url, 'another-room')).toBeNull()
    expect(parseSameRoomBlockReferenceLink('https://example.com', reference.roomId)).toBeNull()
  })
})
