import { describe, expect, it } from 'vitest'
import type { TiptapJsonContent } from '@nxcore/agent-contract'
import {
  AppliedSequenceTracker,
  assignStableBlockIds,
  countTiptapTextCharacters,
  documentStreamCharactersPerFrame,
  documentStreamRevealDelay,
  hasVisibleTiptapContent,
  isAgentDocumentAwaitingContent,
  isEmptyTiptapParagraph,
  isEmptyTiptapTable,
  MarkdownBlockBuffer,
  operationStreamChunksToApply,
  revealTiptapNode,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/markdownStream'
import {
  isNearDocumentStreamEnd,
  isSelectionOutsideViewport,
  nextDocumentStreamFollowState,
  setScrollElementScrolling,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/useTransientEditorInteractions'

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

  it('filters empty Agent tables without hiding populated tables', () => {
    const emptyCell = { type: 'tableCell', content: [{ type: 'paragraph' }] }
    expect(isEmptyTiptapTable({
      type: 'table',
      content: [{ type: 'tableRow', content: [emptyCell, emptyCell] }],
    })).toBe(true)
    expect(isEmptyTiptapTable({
      type: 'table',
      content: [{
        type: 'tableRow',
        content: [{
          type: 'tableCell',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }],
        }],
      }],
    })).toBe(false)
    expect(isEmptyTiptapTable({ type: 'paragraph' })).toBe(false)
  })

  it('shows the Agent overlay only before the first visible content is persisted', () => {
    const emptyDraft = {
      status: 'draft' as const,
      activeTransactionId: 'tx-1',
      contentJson: { type: 'doc', content: [{ type: 'paragraph' }] },
    }
    expect(hasVisibleTiptapContent(emptyDraft.contentJson)).toBe(false)
    expect(isAgentDocumentAwaitingContent(emptyDraft)).toBe(true)
    expect(isAgentDocumentAwaitingContent({
      ...emptyDraft,
      contentJson: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文开始' }] }],
      },
    })).toBe(false)
    expect(isAgentDocumentAwaitingContent({
      ...emptyDraft,
      status: 'active',
      activeTransactionId: null,
    })).toBe(false)
  })

  it('deduplicates retried transaction sequences independently of event IDs', () => {
    const tracker = new AppliedSequenceTracker()
    expect(tracker.record(1)).toBe(true)
    expect(tracker.has(1)).toBe(true)
    expect(tracker.record(1)).toBe(false)
    expect(tracker.record(2)).toBe(true)
  })

  it('baselines persisted operation chunks when the editor mounts from an authoritative draft', () => {
    const chunks = [
      { id: 'chunk-1', sequence: 1 },
      { id: 'chunk-2', sequence: 2 },
    ]
    const lateMount = new AppliedSequenceTracker()
    expect(operationStreamChunksToApply(chunks, lateMount, true)).toEqual([])
    expect(lateMount.has(1)).toBe(true)
    expect(lateMount.has(2)).toBe(true)

    const mountedAtBegin = new AppliedSequenceTracker()
    expect(operationStreamChunksToApply(chunks, mountedAtBegin, false)).toEqual(chunks)
  })

  it('flushes a completed operation only after all ordered chunks reach the Markdown buffer', async () => {
    const buffer = new MarkdownBlockBuffer()
    const revealed: string[] = []
    const chunks = [
      { sequence: 1, markdown: '# 标题\n\n尾段还' },
      { sequence: 2, markdown: '没有结束' },
    ]
    let queue = Promise.resolve()
    for (const chunk of chunks) {
      queue = queue.then(() => { revealed.push(...buffer.append(chunk.markdown)) })
    }
    queue = queue.then(() => { revealed.push(...buffer.append('', true)) })
    await queue

    expect(revealed).toEqual(['# 标题', '尾段还没有结束'])
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
    expect(documentStreamRevealDelay('ab', () => 0)).toBe(38)
    expect(documentStreamRevealDelay('好。', () => 0)).toBe(113)
    expect(documentStreamRevealDelay('line\n', () => 0)).toBe(143)
    expect(documentStreamRevealDelay('ab', () => 0.999)).toBe(54)
  })

  it('follows streamed content only while the reader remains near the document end', () => {
    expect(isNearDocumentStreamEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: 500 })).toBe(true)
    expect(isNearDocumentStreamEnd({ scrollTop: 1_320, clientHeight: 600, scrollHeight: 2_000 })).toBe(true)
    expect(isNearDocumentStreamEnd({ scrollTop: 900, clientHeight: 600, scrollHeight: 2_000 })).toBe(false)

    expect(nextDocumentStreamFollowState({
      wasFollowing: true,
      previousScrollTop: 1_400,
      scrollTop: 1_380,
      clientHeight: 600,
      scrollHeight: 2_000,
    })).toBe(false)
    expect(nextDocumentStreamFollowState({
      wasFollowing: false,
      previousScrollTop: 900,
      scrollTop: 1_320,
      clientHeight: 600,
      scrollHeight: 2_000,
    })).toBe(true)
  })

  it('updates scrollbar activity without requiring an editor rerender', () => {
    const scrollElement = { dataset: {} } as unknown as HTMLElement
    setScrollElementScrolling(scrollElement, true)
    expect(scrollElement.dataset.scrolling).toBe('true')
    setScrollElementScrolling(scrollElement, false)
    expect(scrollElement.dataset.scrolling).toBe('false')
  })

  it('clears a selection only after the whole selection leaves the scroll viewport', () => {
    const viewport = { viewportTop: 100, viewportBottom: 500 }
    expect(isSelectionOutsideViewport({
      ...viewport,
      startTop: 120,
      startBottom: 145,
      endTop: 460,
      endBottom: 485,
    })).toBe(false)
    expect(isSelectionOutsideViewport({
      ...viewport,
      startTop: 40,
      startBottom: 75,
      endTop: 70,
      endBottom: 95,
    })).toBe(true)
    expect(isSelectionOutsideViewport({
      ...viewport,
      startTop: 505,
      startBottom: 530,
      endTop: 560,
      endBottom: 585,
    })).toBe(true)
  })
})
