import type { AgentEvent, AgentRun, AgentSession } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import {
  buildDocumentAiReviewPrompt,
  isSessionBusyError,
  runDocumentAiReview,
  type DocumentAiReviewAgentApi,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/aiReviewAgent'

function fakeApi(options: {
  startRunInput?: (input: unknown) => void
  events?: AgentEvent[]
} = {}): DocumentAiReviewAgentApi {
  const session: AgentSession = {
    id: 'review-session',
    roomId: 'room-1',
    pageLabel: 'AI 审阅 · 测试文档',
    runtimeId: 'pi',
    title: null,
    status: 'idle',
    createdAt: '2026-09-06T00:00:00.000Z',
    updatedAt: '2026-09-06T00:00:00.000Z',
  }
  const run: AgentRun = {
    id: 'review-run',
    sessionId: session.id,
    status: 'running',
    prompt: 'review',
    lastEventSeq: 0,
    error: null,
    startedAt: '2026-09-06T00:00:00.000Z',
    completedAt: null,
    createdAt: '2026-09-06T00:00:00.000Z',
  }
  return {
    createSession: vi.fn(async () => session),
    getSession: vi.fn(async () => ({
      session,
      participants: [],
      activeRun: run,
      messages: [],
      lastEventSeq: 0,
    })),
    startRun: vi.fn(async (_sessionId: string, input: unknown) => {
      options.startRunInput?.(input)
      return run
    }),
    getEvents: vi.fn(async (_sessionId: string, _runId: string, _afterSeq: number) => options.events ?? []),
  }
}

function runEvent(seq: number, type: AgentEvent['type']): AgentEvent {
  return {
    id: `event-${String(seq)}`,
    sessionId: 'review-session',
    runId: 'review-run',
    seq,
    type,
    occurredAt: '2026-09-06T00:00:00.000Z',
    payload: {},
  }
}

describe('document ai review agent', () => {
  it('prompt 包含文档标题、评论工具指令与记忆结合指引', () => {
    const prompt = buildDocumentAiReviewPrompt({ documentTitle: '汇编语言入门' })
    expect(prompt).toContain('汇编语言入门')
    expect(prompt).toContain('context_room_document_comment_add')
    expect(prompt).toContain('context_room_document_read')
    expect(prompt).toContain('Room 记忆')
  })

  it('runDocumentAiReview 发起带文档上下文的 run 并轮询到完成', async () => {
    let captured: Record<string, unknown> | undefined
    const api = fakeApi({
      startRunInput: (input) => {
        captured = input as Record<string, unknown>
      },
      events: [runEvent(1, 'run.completed')],
    })
    const outcome = await runDocumentAiReview(api, {
      sessionId: 'review-session',
      roomId: 'room-1',
      documentId: 'doc-1',
      documentTitle: '测试文档',
      version: 3,
      responseLanguage: 'zh-CN',
    }, { pollIntervalMs: 1 })
    expect(outcome).toBe('completed')
    // 关键：不传 toolsEnabled（默认 true，审阅需要文档工具）；召回 Room 记忆做审阅背景。
    expect(captured).toBeDefined()
    expect(captured!.toolsEnabled).toBeUndefined()
    expect(captured!.captureMemory).toBe(false)
    expect(captured!.recallMemory).toBe(true)
    expect(captured!.memoryScope).toBe('room')
    const context = captured!.context as {
      selectedRoomId: string
      activeDocument: { documentId: string; version: number; defaultAnchor: string }
    }
    expect(context.selectedRoomId).toBe('room-1')
    expect(context.activeDocument.documentId).toBe('doc-1')
    expect(context.activeDocument.version).toBe(3)
    expect(context.activeDocument.defaultAnchor).toBe('end')
  })

  it('终态失败事件解析为 failed；超时也返回 failed 而不 reject', async () => {
    const failed = await runDocumentAiReview(fakeApi({ events: [runEvent(1, 'run.failed')] }), {
      sessionId: 'review-session',
      roomId: 'room-1',
      documentId: 'doc-1',
      documentTitle: 't',
      version: 1,
      responseLanguage: 'zh-CN',
    }, { pollIntervalMs: 1 })
    expect(failed).toBe('failed')

    const timeout = await runDocumentAiReview(fakeApi({ events: [] }), {
      sessionId: 'review-session',
      roomId: 'room-1',
      documentId: 'doc-1',
      documentTitle: 't',
      version: 1,
      responseLanguage: 'zh-CN',
    }, { pollIntervalMs: 1, timeoutMs: 5 })
    expect(timeout).toBe('failed')
  })

  it('识别 session_busy 错误', () => {
    expect(isSessionBusyError(new Error('409 agent_session_busy: Agent session already has an active run'))).toBe(true)
    expect(isSessionBusyError(new Error('network down'))).toBe(false)
  })
})
