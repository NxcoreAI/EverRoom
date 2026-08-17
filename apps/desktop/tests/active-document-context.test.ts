import { describe, expect, it } from 'vitest'

import {
  buildActiveDocumentRunContext,
  createCursorAnchorCandidate,
  cursorAnchorCandidateFromEditorState,
  hasExplicitCurrentPositionIntent,
} from '../src/renderer/src/components/agent/activeDocumentContext'
import {
  buildAgentDocumentSelectionRunRequest,
  findPendingAgentDocumentSelection,
  parseAgentDocumentSelectionResult,
} from '../src/renderer/src/components/agent/agentDocumentSelection'

const activeDocument = {
  roomId: ' room-1 ',
  documentId: ' document-1 ',
  title: ' 文档标题 ',
  version: 4,
  cursorAnchorCandidate: createCursorAnchorCandidate(' block-1 ', 7.8),
}

describe('active document Agent context', () => {
  it('defaults ordinary continuation prompts to the end of the document', () => {
    expect(buildActiveDocumentRunContext(activeDocument, '继续写完这篇文档')).toEqual({
      roomId: 'room-1',
      documentId: 'document-1',
      title: '文档标题',
      version: 4,
      defaultAnchor: 'end',
    })
  })

  it('only includes a cursor candidate for explicit current-position intent', () => {
    expect(buildActiveDocumentRunContext(activeDocument, '请从当前光标处续写')).toEqual({
      roomId: 'room-1',
      documentId: 'document-1',
      title: '文档标题',
      version: 4,
      defaultAnchor: 'end',
      cursorAnchorCandidate: { blockId: 'block-1', offset: 7, affinity: 'after' },
    })
    expect(hasExplicitCurrentPositionIntent('Continue writing this document')).toBe(false)
    expect(hasExplicitCurrentPositionIntent('Continue from the current cursor')).toBe(true)
  })

  it('supports the dedicated in-editor cursor action without text heuristics', () => {
    expect(buildActiveDocumentRunContext(activeDocument, '帮我续写', { anchorMode: 'cursor' }))
      .toMatchObject({ cursorAnchorCandidate: { blockId: 'block-1', offset: 7 } })
    expect(buildActiveDocumentRunContext(activeDocument, '请从当前光标处续写', { anchorMode: 'end' }))
      .not.toHaveProperty('cursorAnchorCandidate')
  })

  it('derives a UTF-16 cursor offset from the deepest stable block', () => {
    const nodes = [
      { attrs: {}, textContent: '父节点' },
      { attrs: { blockId: 'block-parent' }, textContent: '前缀abc' },
      { attrs: { blockId: 'block-deep' }, textContent: 'abc' },
    ]
    expect(cursorAnchorCandidateFromEditorState({
      selection: {
        empty: true,
        from: 13,
        to: 13,
        $from: {
          depth: 2,
          node: (depth) => nodes[depth],
          start: (depth) => depth === 2 ? 10 : 5,
        },
      },
      doc: {
        textBetween: (from, to) => 'x'.repeat(to - from),
      },
    })).toEqual({ blockId: 'block-deep', offset: 3, affinity: 'after' })
  })

  it('does not expose an anchor for a non-collapsed selection', () => {
    expect(cursorAnchorCandidateFromEditorState({
      selection: {
        empty: false,
        from: 10,
        to: 12,
        $from: { depth: 0, node: () => ({ attrs: {}, textContent: '' }), start: () => 0 },
      },
      doc: { textBetween: () => '' },
    })).toBeUndefined()
  })
})

describe('Agent document selection result', () => {
  it('parses details and normalizes id/documentId without leaking malformed items', () => {
    expect(parseAgentDocumentSelectionResult({
      details: {
        selectionRequired: true,
        documents: [
          { id: 'doc-1', roomId: 'room-1', title: '第一篇', version: 2, status: 'active' },
          { documentId: 'doc-2', roomId: 'room-1', title: '第二篇' },
          { id: 'missing-room', title: '无效' },
        ],
      },
    })).toEqual({
      selectionRequired: true,
      documents: [
        { documentId: 'doc-1', roomId: 'room-1', title: '第一篇', version: 2, status: 'active' },
        { documentId: 'doc-2', roomId: 'room-1', title: '第二篇' },
      ],
    })
  })

  it('supports direct and JSON text tool results and ignores non-selection results', () => {
    expect(parseAgentDocumentSelectionResult({
      selectionRequired: true,
      documents: [],
    })).toEqual({ selectionRequired: true, documents: [] })
    expect(parseAgentDocumentSelectionResult({
      content: [{ type: 'text', text: JSON.stringify({
        selectionRequired: true,
        documents: [{ documentId: 'doc-1', roomId: 'room-1', title: '文档' }],
      }) }],
    })?.documents).toHaveLength(1)
    expect(parseAgentDocumentSelectionResult({ selectionRequired: false, documents: [] })).toBeNull()
  })

  it('associates only the newest pending picker with its same-run original prompt', () => {
    const result = (documentId: string) => ({
      details: {
        selectionRequired: true,
        documents: [{ documentId, roomId: 'room-1', title: documentId }],
      },
    })
    const tools = [
      {
        id: 'tool-old', runId: 'run-old', name: 'context_room_document_list', status: 'completed',
        result: result('doc-old'), startedAt: '2026-08-17T01:00:00.000Z', completedAt: '2026-08-17T01:00:02.000Z',
      },
      {
        id: 'tool-new', runId: 'run-new', name: 'context_room_document_list', status: 'completed',
        result: result('doc-new'), startedAt: '2026-08-17T02:00:00.000Z', completedAt: '2026-08-17T02:00:02.000Z',
      },
    ]
    const messages = [
      { runId: 'run-old', role: 'user', content: '旧指令', createdAt: '2026-08-17T01:00:00.000Z' },
      {
        runId: 'run-new',
        role: 'user',
        content: '把错误处理章节补充两个示例',
        createdAt: '2026-08-17T02:00:00.000Z',
      },
    ]

    expect(findPendingAgentDocumentSelection(tools, messages, new Set())).toMatchObject({
      toolId: 'tool-new',
      runId: 'run-new',
      originalPrompt: '把错误处理章节补充两个示例',
      documents: [{ documentId: 'doc-new' }],
    })
    expect(findPendingAgentDocumentSelection(tools, messages, new Set(['tool-new']))).toBeNull()
  })

  it('expires a picker after any later user message instead of reviving history', () => {
    expect(findPendingAgentDocumentSelection([{
      id: 'tool-1',
      runId: 'run-1',
      name: 'context_room_document_list',
      status: 'completed',
      result: {
        selectionRequired: true,
        documents: [{ documentId: 'doc-1', roomId: 'room-1', title: '文档' }],
      },
      startedAt: '2026-08-17T01:00:00.000Z',
      completedAt: '2026-08-17T01:00:02.000Z',
    }], [
      { runId: 'run-1', role: 'user', content: '原始修改指令', createdAt: '2026-08-17T01:00:00.000Z' },
      { runId: 'run-2', role: 'user', content: '另一条消息', createdAt: '2026-08-17T01:00:03.000Z' },
    ], new Set())).toBeNull()
  })

  it('replays the original prompt with the freshly fetched authoritative document context', () => {
    expect(buildAgentDocumentSelectionRunRequest('  把错误处理章节补充两个示例  ', {
      id: 'doc-authoritative',
      roomId: 'room-authoritative',
      title: '权威标题',
      version: 9,
      status: 'active',
      activeTransactionId: null,
      contentJson: { type: 'doc', content: [] },
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T01:00:00.000Z',
    })).toEqual({
      prompt: '把错误处理章节补充两个示例',
      activeDocument: {
        roomId: 'room-authoritative',
        documentId: 'doc-authoritative',
        title: '权威标题',
        version: 9,
        defaultAnchor: 'end',
      },
    })
  })
})
