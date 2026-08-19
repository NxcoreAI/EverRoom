import type { AgentEvent, AgentRun, AgentSession } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import {
  buildSelectionRewritePrompt,
  sanitizeSelectionRewriteOutput,
  streamSelectionRewrite,
  type SelectionRewriteAgentApi,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/selectionRewriteAgent'

function session(): AgentSession {
  return {
    id: 'rewrite-session',
    roomId: 'room-1',
    pageLabel: 'AI 重写',
    runtimeId: 'pi',
    title: null,
    status: 'idle',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  }
}

function run(): AgentRun {
  return {
    id: 'rewrite-run',
    sessionId: 'rewrite-session',
    status: 'running',
    prompt: 'rewrite',
    lastEventSeq: 0,
    error: null,
    startedAt: '2026-08-15T00:00:00.000Z',
    completedAt: null,
    createdAt: '2026-08-15T00:00:00.000Z',
  }
}

function event(seq: number, type: AgentEvent['type'], payload: unknown): AgentEvent {
  return {
    id: `event-${String(seq)}`,
    sessionId: 'rewrite-session',
    runId: 'rewrite-run',
    seq,
    type,
    occurredAt: '2026-08-15T00:00:00.000Z',
    payload,
  }
}

describe('selection rewrite Agent stream', () => {
  it('builds a bounded output-only prompt and cleans common model wrappers', () => {
    const prompt = buildSelectionRewritePrompt({
      roomId: 'room-1',
      documentName: '计划',
      selectedText: '原文',
      instruction: '更简洁',
      contextBefore: '前文',
      contextAfter: '后文',
      formatContext: {
        blockType: 'codeBlock',
        ancestorTypes: ['doc', 'codeBlock'],
        codeLanguage: 'ts',
      },
    })

    expect(prompt).toContain('"selectedText":"原文"')
    expect(prompt).toContain('不要调用任何工具')
    expect(prompt).toContain('最终 Markdown 片段')
    expect(prompt).toContain('如果选区位于代码块内，只输出原始代码并保留缩进、空格和换行')
    expect(prompt).toContain('"blockType":"codeBlock"')
    expect(sanitizeSelectionRewriteOutput('```text\n改写后的文本：新文本\n```')).toBe('新文本')
    expect(sanitizeSelectionRewriteOutput('重写后的文档选区内容如下：\n新文本')).toBe('新文本')
    expect(sanitizeSelectionRewriteOutput('```ts\nconst value = 1\n```'))
      .toBe('```ts\nconst value = 1\n```')
    expect(sanitizeSelectionRewriteOutput('  if (ok) {\n    return value\n  }\n', { preserveWhitespace: true }))
      .toBe('  if (ok) {\n    return value\n  }\n')
    expect(sanitizeSelectionRewriteOutput('```ts\n  return value\n```', { preserveWhitespace: true }))
      .toBe('  return value\n')
  })

  it('streams deltas, resolves the final text, and removes its temporary session', async () => {
    const batches = [
      [event(1, 'message.delta', { delta: '改写后的' })],
      [
        event(2, 'message.delta', { delta: '内容' }),
        event(3, 'message.completed', { content: '改写后的内容' }),
        event(4, 'run.completed', {}),
      ],
    ]
    const api: SelectionRewriteAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockImplementation(async () => batches.shift() ?? []),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const received: string[] = []

    const result = await streamSelectionRewrite(api, {
      roomId: 'room-1',
      documentName: '计划',
      selectedText: '原文',
      instruction: '重写',
      contextBefore: '',
      contextAfter: '',
    }, {
      signal: new AbortController().signal,
      onText: (text) => received.push(text),
      pollIntervalMs: 0,
    })

    expect(result).toEqual({
      replacementText: '改写后的内容',
      sessionId: 'rewrite-session',
      runId: 'rewrite-run',
    })
    expect(received).toEqual(['改写后的', '改写后的内容', '改写后的内容'])
    expect(api.startRun).toHaveBeenCalledWith('rewrite-session', expect.objectContaining({ captureMemory: false }))
    expect(api.deleteSession).not.toHaveBeenCalled()
    expect(api.cancelRun).not.toHaveBeenCalled()
  })

  it('preserves code indentation while streaming a code-block rewrite', async () => {
    const batches = [
      [event(1, 'message.delta', { delta: '  if (ok) {\n    return value\n  }\n' })],
      [event(2, 'run.completed', {})],
    ]
    const api: SelectionRewriteAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockImplementation(async () => batches.shift() ?? []),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }

    await expect(streamSelectionRewrite(api, {
      roomId: 'room-1',
      documentName: '代码',
      selectedText: 'if (ok) {\n  return value\n}',
      instruction: '优化',
      contextBefore: '',
      contextAfter: '',
      formatContext: { blockType: 'codeBlock', ancestorTypes: ['doc', 'codeBlock'], codeLanguage: 'ts' },
    }, {
      signal: new AbortController().signal,
      onText: () => undefined,
      pollIntervalMs: 0,
    })).resolves.toEqual({
      replacementText: '  if (ok) {\n    return value\n  }\n',
      sessionId: 'rewrite-session',
      runId: 'rewrite-run',
    })
  })

  it('cancels the active run and removes its session when aborted', async () => {
    const controller = new AbortController()
    const api: SelectionRewriteAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockImplementation(async () => {
        controller.abort()
        return []
      }),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }

    await expect(streamSelectionRewrite(api, {
      roomId: 'room-1',
      documentName: '计划',
      selectedText: '原文',
      instruction: '重写',
      contextBefore: '',
      contextAfter: '',
    }, {
      signal: controller.signal,
      onText: () => undefined,
      pollIntervalMs: 0,
    })).rejects.toMatchObject({ name: 'AbortError' })

    expect(api.cancelRun).toHaveBeenCalledWith('rewrite-run')
    expect(api.deleteSession).toHaveBeenCalledWith('rewrite-session')
  })

  it('cancels the run when event polling fails', async () => {
    const api: SelectionRewriteAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }

    await expect(streamSelectionRewrite(api, {
      roomId: 'room-1',
      documentName: '计划',
      selectedText: '原文',
      instruction: '重写',
      contextBefore: '',
      contextAfter: '',
    }, {
      signal: new AbortController().signal,
      onText: () => undefined,
    })).rejects.toThrow('gateway unavailable')

    expect(api.cancelRun).toHaveBeenCalledWith('rewrite-run')
    expect(api.deleteSession).toHaveBeenCalledWith('rewrite-session')
  })
})
