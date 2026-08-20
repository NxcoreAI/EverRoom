import type { DocumentOperation } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { createContinuationMarkdownEditor } from '../src/renderer/src/components/context-room/operations/DocumentContinuationExtension'
import {
  buildContinuationRevisionPrompt,
  continuationRevealScrollTop,
  groupContinuationCandidates,
  pendingContinuationBlock,
  pendingContinuationBlocks,
  shouldHandleContinuationTab,
} from '../src/renderer/src/components/context-room/operations/documentContinuationState'
import {
  nextDocumentReviewReveal,
  reviewDecisionCounts,
} from '../src/renderer/src/components/context-room/operations/documentReviewState'
import {
  mergeOperationDetail,
  mergeOperationSummary,
  setOperationDecision,
} from '../src/renderer/src/components/context-room/operations/documentOperationState'
import { classifyDocumentOperationError } from '../src/renderer/src/components/context-room/operations/types'
import {
  getDocumentOperationPresenter,
  operationReviewView,
} from '../src/renderer/src/components/context-room/operations/presenterRegistry'

const operation: DocumentOperation = {
  id: 'operation-1',
  capabilityId: 'document.edit',
  capabilityVersion: 1,
  interactionMode: 'atomic_review',
  presenterKey: 'atomic-diff',
  roomId: 'room-1',
  documentId: 'doc-1',
  documentTitle: '项目计划',
  sessionId: 'session-1',
  runId: 'run-1',
  baseVersion: 3,
  status: 'awaiting_review',
  revision: 2,
  summary: '调整里程碑',
  conflictVersion: null,
  error: null,
  expiresAt: null,
  createdAt: '2026-08-17T00:00:00.000Z',
  updatedAt: '2026-08-17T00:00:01.000Z',
  completedAt: null,
  input: {},
  result: null,
  items: [{
    id: 'item-1',
    operationId: 'operation-1',
    sequence: 1,
    operation: 'insert',
    target: { at: 'end' },
    before: [],
    after: [{ type: 'paragraph', content: [{ type: 'text', text: '新增' }] }],
    markdown: '新增',
    contentHash: 'hash-1',
    status: 'pending',
    appliedVersion: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:01.000Z',
  }, {
    id: 'item-2',
    operationId: 'operation-1',
    sequence: 2,
    operation: 'replace',
    target: { blockId: 'block-1', fromOffset: 0, toOffset: 2 },
    before: [{ type: 'text', text: '原文' }],
    after: [{ type: 'text', text: '替换' }],
    markdown: '替换',
    contentHash: 'hash-2',
    status: 'pending',
    appliedVersion: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:01.000Z',
  }],
}

describe('document operation review presenters', () => {
  it('reveals each operation once and resets after it closes', () => {
    const first = nextDocumentReviewReveal(null, 'operation-1')
    expect(first).toEqual({ operationId: 'operation-1', autoReveal: true })
    expect(nextDocumentReviewReveal(first.operationId, 'operation-1').autoReveal).toBe(false)
    const cleared = nextDocumentReviewReveal('operation-1', null)
    expect(cleared).toEqual({ operationId: null, autoReveal: false })
    expect(nextDocumentReviewReveal(cleared.operationId, 'operation-1').autoReveal).toBe(true)
  })

  it('projects authoritative operation items without recreating the legacy patch aggregate', () => {
    const review = operationReviewView(operation, 'edit')
    expect(review).toMatchObject({
      id: operation.id,
      kind: 'edit',
      status: 'awaiting_review',
      items: operation.items.map((item) => expect.objectContaining({ id: item.id, target: item.target })),
    })
    expect(reviewDecisionCounts(review, { 'item-1': 'accepted' })).toEqual({
      accepted: 1,
      rejected: 0,
      undecided: 1,
    })
  })

  it('keeps local decisions across revision and conflict refreshes', () => {
    const initial = mergeOperationDetail(undefined, operation)
    const decided = setOperationDecision(initial, 'item-1', 'accepted')
    const refreshed = mergeOperationSummary(decided, {
      ...operation,
      status: 'conflicted',
      conflictVersion: 4,
      revision: 3,
      updatedAt: '2026-08-17T00:00:03.000Z',
    })

    expect(refreshed.summary.status).toBe('conflicted')
    expect(refreshed.revision).toBe(3)
    expect(refreshed.decisions).toEqual({ 'item-1': 'accepted' })
  })

  it('registers every built-in presenter', () => {
    expect(getDocumentOperationPresenter('atomic-diff')?.present(mergeOperationDetail(undefined, operation)))
      .toEqual(operationReviewView(operation, 'edit'))
    const continuation = {
      ...operation,
      capabilityId: 'document.continue',
      presenterKey: 'continuation',
      interactionMode: 'incremental_review',
    } as DocumentOperation
    expect(getDocumentOperationPresenter('continuation')?.present(mergeOperationDetail(undefined, continuation)))
      .toEqual(operationReviewView(continuation, 'continue'))
    expect(getDocumentOperationPresenter('selection-rewrite')?.key).toBe('selection-rewrite')
    expect(getDocumentOperationPresenter('streaming-document')?.key).toBe('streaming-document')
  })

  it('orders only undecided continuation candidates', () => {
    const continuation = operationReviewView({
      ...operation,
      capabilityId: 'document.continue',
      presenterKey: 'continuation',
      interactionMode: 'incremental_review',
      items: [{ ...operation.items[0]!, id: 'candidate-2', sequence: 2 }, {
        ...operation.items[0]!,
        id: 'candidate-1',
        sequence: 1,
        status: 'applied',
        appliedVersion: 4,
      }],
    }, 'continue')

    expect(continuation.appliedVersion).toBe(4)
    expect(pendingContinuationBlock(continuation)?.blockId).toBe('candidate-2')
    expect(pendingContinuationBlocks(continuation).map((candidate) => candidate.blockId))
      .toEqual(['candidate-2'])
    expect(pendingContinuationBlock({ ...continuation, status: 'conflicted' })).toBeNull()
  })

  it('groups short continuation candidates by Unicode length and keeps long candidates alone', () => {
    const candidates = [1, 2, 3, 4].map((sequence) => ({
      blockId: `candidate-${sequence}`,
      sequence,
      target: { at: 'end' } as const,
      contentJson: { type: 'paragraph', content: [{ type: 'text', text: '候选' }] },
      textPreview: sequence === 1 ? '短' : sequence === 2 ? '中文续写内容' : sequence === 3 ? '第三块' : '第四块',
      addedCharacters: 2,
    }))
    expect(groupContinuationCandidates(candidates, 'candidate-1', { targetCharacters: 8 })
      .map((candidate) => candidate.blockId)).toEqual(['candidate-1', 'candidate-2', 'candidate-3'])
    expect(groupContinuationCandidates(candidates, 'candidate-1', { targetCharacters: 1 })
      .map((candidate) => candidate.blockId)).toEqual(['candidate-1'])
    expect(groupContinuationCandidates(candidates, 'candidate-2', { targetCharacters: 20, maxBlocks: 2 })
      .map((candidate) => candidate.blockId)).toEqual(['candidate-2', 'candidate-3'])
  })

  it('handles only an unmodified Tab for a visible idle candidate', () => {
    const candidate = { key: 'Tab', candidateVisible: true, busy: false }
    expect(shouldHandleContinuationTab(candidate)).toBe(true)
    expect(shouldHandleContinuationTab({ ...candidate, shiftKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, altKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, ctrlKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, metaKey: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, candidateVisible: false })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, busy: true })).toBe(false)
    expect(shouldHandleContinuationTab({ ...candidate, key: 'Enter' })).toBe(false)
  })

  it('reveals a continuation inside the editor without moving an already visible block', () => {
    const viewport = { scrollHeight: 1600, clientHeight: 600 }
    expect(continuationRevealScrollTop({
      ...viewport,
      scrollTop: 200,
      candidateTop: 420,
      candidateBottom: 560,
    })).toBe(200)
    expect(continuationRevealScrollTop({
      ...viewport,
      scrollTop: 200,
      candidateTop: 760,
      candidateBottom: 900,
    })).toBe(324)
    expect(continuationRevealScrollTop({
      ...viewport,
      scrollTop: 600,
      candidateTop: 500,
      candidateBottom: 640,
    })).toBe(476)
  })

  it('aligns an oversized continuation once and clamps it to the scroll range', () => {
    expect(continuationRevealScrollTop({
      scrollTop: 100,
      scrollHeight: 1800,
      clientHeight: 500,
      candidateTop: 700,
      candidateBottom: 1300,
    })).toBe(676)
    expect(continuationRevealScrollTop({
      scrollTop: 900,
      scrollHeight: 1200,
      clientHeight: 500,
      candidateTop: 1100,
      candidateBottom: 1180,
    })).toBe(700)
  })

  it('renders and serializes editable continuation Markdown', () => {
    const changes: string[] = []
    const editor = createContinuationMarkdownEditor({
      markdown: '## 标题\n\n- 第一项\n- **第二项**',
      editable: true,
      onChange: (markdown) => changes.push(markdown),
    })

    const content = editor.getJSON().content
    expect(content?.map((node) => node.type)).toEqual(['heading', 'bulletList'])
    expect(content?.[1]?.content?.[1]?.content?.[0]?.content?.[0]?.marks).toEqual([{ type: 'bold' }])
    expect(editor.getMarkdown()).toContain('- **第二项**')

    editor.commands.setContent('> 用户修改后的引用', { contentType: 'markdown' })
    expect(changes.at(-1)).toContain('> 用户修改后的引用')
    editor.commands.setContent('x'.repeat(65_537), { contentType: 'markdown' })
    expect(editor.getMarkdown()).toContain('用户修改后的引用')
    editor.destroy()
  })

  it('builds a continuation revision prompt from feedback without accepting old candidates', () => {
    const prompt = buildContinuationRevisionPrompt({
      documentTitle: '项目计划',
      previousSummary: '补充风险章节',
      rejectedText: '风险很低，可以忽略。',
      feedback: '不要弱化风险，补充两个具体例子。',
    })

    expect(prompt).toContain('必须重新读取文档')
    expect(prompt).toContain('创建新的 document.continue 审阅')
    expect(prompt).toContain('<rejected_candidate>\n风险很低，可以忽略。\n</rejected_candidate>')
    expect(prompt).toContain('<feedback>\n不要弱化风险，补充两个具体例子。\n</feedback>')
    expect(prompt).toContain('不要沿用尚未接受的旧候选')
    expect(buildContinuationRevisionPrompt({
      documentTitle: '项目计划',
      previousSummary: '补充风险章节',
      rejectedText: '风险很低，可以忽略。',
      feedback: '',
    })).toContain('<feedback>\n用户未填写具体意见，请换一种表达或展开方向重新续写。\n</feedback>')
  })

  it('classifies version conflicts separately from network failures', () => {
    expect(classifyDocumentOperationError({ response: { status: 409 } }).kind).toBe('conflict')
    expect(classifyDocumentOperationError(new Error('offline')).kind).toBe('network')
  })
})
