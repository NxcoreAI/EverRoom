import { describe, expect, it } from 'vitest'

import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract'

import {
  LINK_GRAPH_ROOT_ID,
  buildLinkGraphData,
  filterLinkGraphData,
  linkGraphBlockNodeId,
} from '../src/renderer/src/components/context-room/ported/components/linkGraphModel'

const ROOM_ID = 'room-1'

function paragraph(text: string, blockId: string, marks: string[] = []): TiptapJsonContent {
  return {
    type: 'paragraph',
    attrs: { id: blockId },
    content: [
      { type: 'text', text },
      ...marks.map((raw) => JSON.parse(raw) as TiptapJsonContent),
    ],
  }
}

function documentMark(targetDocumentId: string, targetBlockId: string, label: string): string {
  return JSON.stringify({
    type: 'blockIndexMark',
    attrs: {
      kind: 'document',
      targetRoomId: ROOM_ID,
      targetDocumentId,
      targetBlockId,
      targetMemoryId: '',
      fallbackTitle: label,
      fallbackPreview: null,
    },
  })
}

function memoryMark(targetMemoryId: string, label: string, targetRoomId = ROOM_ID): string {
  return JSON.stringify({
    type: 'blockIndexMark',
    attrs: {
      kind: 'memory',
      targetRoomId,
      targetDocumentId: '',
      targetBlockId: '',
      targetMemoryId,
      fallbackTitle: label,
      fallbackPreview: null,
    },
  })
}

function doc(id: string, title: string, content: TiptapJsonContent[]): RoomDocument {
  return {
    id,
    roomId: ROOM_ID,
    title,
    contentJson: { type: 'doc', content },
    contentSchemaVersion: 1,
    version: 1,
    status: 'active',
    activeTransactionId: null,
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }
}

const room = {
  id: ROOM_ID,
  title: '测试 Room',
  memoryItems: [
    { id: 'mem-1', memoryId: 'mem-1', attributed: true, content: 'PyTorch 是主流深度学习框架。', type: '事实', status: '已确认' },
    { id: 'mem-2', memoryId: 'mem-2', attributed: true, content: '另一条从未被引用的记忆。', type: '事实', status: '已确认' },
  ],
}

describe('buildLinkGraphData（块级星系模型）', () => {
  it('宿主块与目标块都入图，边为 块→目标块 / 块→记忆', () => {
    const documents = [
      doc('doc-a', '汇编语言', [
        paragraph('复述来源内容第一处。', 'p-a1', [documentMark('doc-b', 'blk-1', '来源文档')]),
        paragraph('复述来源内容第二处。', 'p-a2', [documentMark('doc-b', 'blk-1', '来源文档')]),
        paragraph('改写自某条记忆的段落。', 'p-a3', [memoryMark('mem-1', '事实')]),
      ]),
      doc('doc-b', '来源文档', [
        paragraph('被引用的原始内容，长度足够成为独立段落。', 'blk-1'),
        paragraph('与建联无关的段落。', 'blk-2'),
      ]),
    ]

    const data = buildLinkGraphData(room, documents)

    expect(data.totals).toEqual({ documents: 2, memories: 2, links: 3, dangling: 0 })
    // 三条块级边：两个块各一条指向目标块（同目标不同源块不合并），一条指向记忆。
    expect(data.edges).toHaveLength(3)
    const docEdges = data.edges.filter((edge) => edge.kind === 'document')
    expect(docEdges.map((edge) => edge.sourceBlockId).sort()).toEqual(['p-a1', 'p-a2'])
    expect(docEdges.every((edge) => edge.targetDocumentId === 'doc-b' && edge.targetBlockId === 'blk-1')).toBe(true)
    const memEdge = data.edges.find((edge) => edge.kind === 'memory')!
    expect(memEdge).toMatchObject({ sourceDocumentId: 'doc-a', sourceBlockId: 'p-a3', targetMemoryId: 'mem-1' })

    // 节点：根 + 两篇文档 + 三个宿主块 + 目标块 blk-1（blk-2 无关不进图）+ 被引用记忆。
    const ids = data.nodes.map((node) => node.id)
    expect(ids).toContain(LINK_GRAPH_ROOT_ID)
    expect(ids).toContain('doc:doc-a')
    expect(ids).toContain('doc:doc-b')
    expect(ids).toContain(linkGraphBlockNodeId('doc-a', 'p-a1'))
    expect(ids).toContain(linkGraphBlockNodeId('doc-a', 'p-a3'))
    expect(ids).toContain(linkGraphBlockNodeId('doc-b', 'blk-1'))
    expect(ids).not.toContain(linkGraphBlockNodeId('doc-b', 'blk-2'))
    expect(ids).toContain('memory:mem-1')
    // 未被引用的记忆不进图。
    expect(ids).not.toContain('memory:mem-2')
    // 目标块标签取自目标文档的段落文本。
    expect(data.nodes.find((node) => node.id === linkGraphBlockNodeId('doc-b', 'blk-1'))?.label)
      .toContain('被引用的原始内容')
  })

  it('同源块重复指向同一目标计数合并', () => {
    const documents = [
      doc('doc-a', '汇编语言', [
        {
          type: 'paragraph',
          attrs: { id: 'p-a1' },
          content: [
            { type: 'text', text: '一段同时挂两个相同目标的标记。' },
            JSON.parse(documentMark('doc-b', 'blk-1', '来源')),
            JSON.parse(documentMark('doc-b', 'blk-1', '来源')),
          ],
        },
      ]),
      doc('doc-b', '来源文档', [paragraph('被引用段落。', 'blk-1')]),
    ]

    const data = buildLinkGraphData(room, documents)

    expect(data.edges).toHaveLength(1)
    expect(data.edges[0]!.count).toBe(2)
  })

  it('跨 Room 标记整条跳过；悬空目标（文档消失/块消失）生成灰显节点', () => {
    const documents = [
      doc('doc-a', '汇编语言', [
        paragraph('跨房间引用。', 'p-a1', [memoryMark('mem-9', '别家记忆', 'room-other')]),
        paragraph('指向已消失文档。', 'p-a2', [documentMark('doc-gone', 'blk-x', '已删文档')]),
        paragraph('指向存在文档的消失块。', 'p-a3', [documentMark('doc-b', 'blk-missing', '消失的块')]),
      ]),
      doc('doc-b', '来源文档', [paragraph('正常段落。', 'blk-1')]),
    ]

    const data = buildLinkGraphData(room, documents)

    expect(data.totals.links).toBe(0)
    expect(data.totals.dangling).toBe(2)
    // 跨 Room 不产生任何节点/边。
    expect(data.nodes.find((node) => node.memoryId === 'mem-9')).toBeUndefined()
    // 目标文档消失：悬空文档节点（标题回退 fallback）。
    expect(data.nodes.find((node) => node.id === 'doc:doc-gone')).toMatchObject({ stale: true, label: '已删文档' })
    // 目标块消失：悬空块进入目标文档场。
    expect(data.nodes.find((node) => node.id === linkGraphBlockNodeId('doc-b', 'blk-missing')))
      .toMatchObject({ stale: true, parentDocumentId: 'doc-b' })
  })

  it('回收站文档目标视为悬空，标题可从回收站清单回填', () => {
    const documents = [
      doc('doc-a', '汇编语言', [
        paragraph('引用已进回收站的文档。', 'p-a1', [documentMark('doc-trash', 'blk-1', '')]),
      ]),
    ]
    const trashed = [doc('doc-trash', '旧文档', [paragraph('旧内容。', 'blk-1')])]

    const data = buildLinkGraphData(room, documents, trashed)

    expect(data.totals.dangling).toBe(1)
    expect(data.nodes.find((node) => node.id === 'doc:doc-trash')).toMatchObject({ stale: true, label: '旧文档' })
  })

  it('未参与建联的文档仍作为节点出现', () => {
    const documents = [doc('doc-a', '孤立文档', [paragraph('完全没有任何标记的段落。', 'p-a1')])]

    const data = buildLinkGraphData(room, documents)

    expect(data.edges).toHaveLength(0)
    expect(data.nodes.map((node) => node.id)).toEqual([LINK_GRAPH_ROOT_ID, 'doc:doc-a'])
    expect(data.totals).toEqual({ documents: 1, memories: 2, links: 0, dangling: 0 })
  })

  it('筛选：仅文档剔除记忆与记忆边，仅记忆剔除文档边并修剪不参与的块', () => {
    const documents = [
      doc('doc-a', '汇编语言', [
        paragraph('引用来源文档。', 'p-a1', [documentMark('doc-b', 'blk-1', '来源')]),
        paragraph('引用记忆。', 'p-a2', [memoryMark('mem-1', '事实')]),
        paragraph('无关段落。', 'p-a3'),
      ]),
      doc('doc-b', '来源文档', [paragraph('被引用的原始内容。', 'blk-1')]),
    ]

    const data = buildLinkGraphData(room, documents)

    const documentsOnly = filterLinkGraphData(data, 'documents')
    expect(documentsOnly.edges.every((edge) => edge.kind === 'document')).toBe(true)
    const ids = documentsOnly.nodes.map((node) => node.id)
    expect(ids).not.toContain('memory:mem-1')
    // 只挂记忆标的宿主块 p-a2 被修剪；p-a1（宿主）与 blk-1（目标）保留。
    expect(ids).toContain(linkGraphBlockNodeId('doc-a', 'p-a1'))
    expect(ids).not.toContain(linkGraphBlockNodeId('doc-a', 'p-a2'))
    expect(ids).toContain(linkGraphBlockNodeId('doc-b', 'blk-1'))

    const memoriesOnly = filterLinkGraphData(data, 'memories')
    expect(memoriesOnly.edges.every((edge) => edge.kind === 'memory')).toBe(true)
    const memoryIds = memoriesOnly.nodes.map((node) => node.id)
    expect(memoryIds).toContain('memory:mem-1')
    // 目标块（doc 边专属）被修剪，仅保留挂记忆标的宿主块。
    expect(memoryIds).not.toContain(linkGraphBlockNodeId('doc-b', 'blk-1'))
    expect(memoryIds).toContain(linkGraphBlockNodeId('doc-a', 'p-a2'))
    // 根与文档中心节点保留作锚点。
    expect(memoryIds).toContain('doc:doc-a')
    expect(memoryIds).toContain(LINK_GRAPH_ROOT_ID)
  })

  it('筛选：仅记忆模式剔除悬空文档节点（其边已被过滤）', () => {
    const documents = [
      doc('doc-a', '汇编语言', [
        paragraph('指向已消失文档。', 'p-a1', [documentMark('doc-gone', 'blk-x', '已删')]),
      ]),
    ]
    const data = buildLinkGraphData(room, documents)

    const memoriesOnly = filterLinkGraphData(data, 'memories')
    const ids = memoriesOnly.nodes.map((node) => node.id)
    expect(ids).not.toContain('doc:doc-gone')
    expect(ids).toContain('doc:doc-a')

    const documentsOnly = filterLinkGraphData(data, 'documents')
    expect(documentsOnly.nodes.map((node) => node.id)).toContain('doc:doc-gone')
  })
})
