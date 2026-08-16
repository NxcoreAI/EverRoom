import { describe, expect, it } from 'vitest'
import type { TiptapJsonContent } from '@nxcore/agent-contract'
import {
  AppliedSequenceTracker,
  assignStableBlockIds,
  countTiptapTextCharacters,
  documentStreamCharactersPerFrame,
  documentStreamRevealDelay,
  eventsAfterLastDocumentTerminal,
  isEmptyTiptapParagraph,
  MarkdownBlockBuffer,
  revealTiptapNode,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/markdownStream'

describe('Markdown stream buffering', () => {
  it('buffers incomplete content across chunks and flushes final Chinese text', () => {
    const buffer = new MarkdownBlockBuffer()
    expect(buffer.append('# 标题\n\n第一段还没')).toEqual(['# 标题'])
    expect(buffer.append('写完。\n\n- 项目一\n- 项目二')).toEqual(['第一段还没写完。'])
    expect(buffer.append('', true)).toEqual(['- 项目一\n- 项目二'])
  })

  it('keeps fenced code together and assigns stable top-level IDs', () => {
    const buffer = new MarkdownBlockBuffer()
    expect(buffer.append('```ts\nconst value = 1')).toEqual([])
    expect(buffer.append('\n```\n')).toEqual(['```ts\nconst value = 1\n```'])

    const assigned = assignStableBlockIds(
      [{ type: 'heading', attrs: { level: 1 } }, { type: 'paragraph' }],
      'tx-1',
      3,
    )
    expect(assigned.nodes.map((node) => node.attrs?.id)).toEqual(['tx-1:3', 'tx-1:4'])
    expect(assigned.nextOrdinal).toBe(5)
  })

  it('normalizes CRLF even when the pair is split across chunks', () => {
    const buffer = new MarkdownBlockBuffer()
    expect(buffer.append('第一段\r')).toEqual([])
    expect(buffer.append('\n\r\n第二段')).toEqual(['第一段'])
    expect(buffer.append('', true)).toEqual(['第二段'])
  })

  it('recognizes only the trailing placeholder paragraph as empty', () => {
    expect(isEmptyTiptapParagraph({ type: 'paragraph' })).toBe(true)
    expect(isEmptyTiptapParagraph({ type: 'paragraph', content: [] })).toBe(true)
    expect(isEmptyTiptapParagraph({
      type: 'paragraph',
      content: [{ type: 'text', text: '正文' }],
    })).toBe(false)
    expect(isEmptyTiptapParagraph({ type: 'heading' })).toBe(false)
  })

  it('deduplicates retried transaction sequences independently of event IDs', () => {
    const tracker = new AppliedSequenceTracker()
    expect(tracker.record(1)).toBe(true)
    expect(tracker.has(1)).toBe(true)
    expect(tracker.record(1)).toBe(false)
    expect(tracker.record(2)).toBe(true)
  })

  it('does not replay append events from a transaction that already committed', () => {
    const events = [
      { id: 'append-1', type: 'document.appended' },
      { id: 'commit-requested', type: 'document.commit-requested' },
      { id: 'committed', type: 'document.committed' },
      { id: 'updated', type: 'document.updated' },
    ]

    expect(eventsAfterLastDocumentTerminal(events)).toEqual([
      { id: 'committed', type: 'document.committed' },
      { id: 'updated', type: 'document.updated' },
    ])
  })

  it('reveals nested Tiptap content without losing structure or marks', () => {
    const node: TiptapJsonContent = {
      type: 'bulletList',
      attrs: { id: 'tx-1:0' },
      content: [
        {
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: '你好', marks: [{ type: 'bold' }] }],
          }],
        },
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'world' }] }],
        },
      ],
    }

    expect(countTiptapTextCharacters(node)).toBe(7)
    expect(revealTiptapNode(node, 4)).toEqual({
      type: 'bulletList',
      attrs: { id: 'tx-1:0' },
      content: [
        {
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: '你好', marks: [{ type: 'bold' }] }],
          }],
        },
        {
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: 'wo' }],
          }],
        },
      ],
    })
    expect(revealTiptapNode(node, 7)).toEqual(node)
    expect(revealTiptapNode(node, 7)).not.toBe(node)
  })

  it('uses fast human typing cadence and adapts very large appends', () => {
    expect(documentStreamCharactersPerFrame(200)).toBe(2)
    expect(documentStreamCharactersPerFrame(2_400)).toBe(3)
    expect(documentStreamRevealDelay('ab', () => 0)).toBe(42)
    expect(documentStreamRevealDelay('好。', () => 0)).toBe(127)
    expect(documentStreamRevealDelay('line\n', () => 0)).toBe(162)
    expect(documentStreamRevealDelay('ab', () => 0.999)).toBe(60)
  })
})
