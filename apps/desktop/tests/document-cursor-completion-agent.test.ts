import type { AgentEvent, AgentRun, AgentSession } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import {
  buildDocumentCursorCompletionPrompt,
  parseDocumentCursorCompletion,
  sanitizeDocumentCursorCompletion,
  streamDocumentCursorCompletion,
  type DocumentCursorCompletionAgentApi,
  type DocumentCursorCompletionFormatContext,
  type DocumentCursorCompletionRequest,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/documentCursorCompletionAgent'

function session(): AgentSession {
  return {
    id: 'completion-session',
    roomId: 'room-1',
    pageLabel: 'AI 补全',
    runtimeId: 'pi',
    title: null,
    status: 'idle',
    createdAt: '2026-08-18T00:00:00.000Z',
    updatedAt: '2026-08-18T00:00:00.000Z',
  }
}

function run(): AgentRun {
  return {
    id: 'completion-run',
    sessionId: 'completion-session',
    status: 'running',
    prompt: 'complete',
    lastEventSeq: 0,
    error: null,
    startedAt: '2026-08-18T00:00:00.000Z',
    completedAt: null,
    createdAt: '2026-08-18T00:00:00.000Z',
  }
}

function event(seq: number, type: AgentEvent['type'], payload: unknown): AgentEvent {
  return {
    id: `event-${String(seq)}`,
    sessionId: 'completion-session',
    runId: 'completion-run',
    seq,
    type,
    occurredAt: '2026-08-18T00:00:00.000Z',
    payload,
  }
}

function request(
  blockType = 'paragraph',
  formatContext: DocumentCursorCompletionFormatContext = {
    ancestorTypes: ['doc', blockType],
    activeMarks: [],
  },
): DocumentCursorCompletionRequest {
  return {
    roomId: 'room-1',
    documentName: '产品计划',
    contextBefore: '前文最后一句',
    contextAfter: '后文第一句',
    blockPrefix: '前文最后一句',
    blockType,
    formatContext,
  }
}

describe('document cursor completion Agent stream', () => {
  it('builds a local output-only prompt and sanitizes prose and code independently', () => {
    const prompt = buildDocumentCursorCompletionPrompt(request())
    expect(prompt).toContain('使用 document-cursor-completion Skill')
    expect(prompt).toContain('<CURSOR />')
    expect(prompt).toContain('<PREFIX>\n前文最后一句\n</PREFIX>')
    expect(prompt).toContain('<CURSOR />')
    expect(prompt).toContain('<SUFFIX>\n后文第一句\n</SUFFIX>')

    expect(sanitizeDocumentCursorCompletion('补全内容：前文最后一句，自然结束。', '前文最后一句'))
      .toBe('，自然结束。')
    expect(sanitizeDocumentCursorCompletion('第一行\n第二行', '')).toBe('第一行 第二行')
    expect(sanitizeDocumentCursorCompletion('第一句。第二句。', '')).toBe('第一句。')
    expect(sanitizeDocumentCursorCompletion('补全部分后文第一句', '', 'paragraph', '后文第一句'))
      .toBe('补全部分')
    expect(Array.from(sanitizeDocumentCursorCompletion('字'.repeat(100), '')).length).toBe(80)
    expect(sanitizeDocumentCursorCompletion('```ts\n  return value\n}\n```', '', 'codeBlock'))
      .toBe('  return value\n}')
    expect(Array.from(sanitizeDocumentCursorCompletion('x'.repeat(200), '', 'codeBlock')).length).toBe(160)
    expect(parseDocumentCursorCompletion('KEEP\n自然结束。', request())).toEqual({
      text: '自然结束。',
      replaceCharacters: 0,
    })
    expect(parseDocumentCursorCompletion('REPLACE:3\nthe sentence.', {
      ...request(),
      blockPrefix: 'This is teh',
    })).toEqual({
      text: 'the sentence.',
      replaceCharacters: 3,
    })
    expect(parseDocumentCursorCompletion('REPLACE:99\n修正', {
      ...request(),
      blockPrefix: '错字',
    })).toEqual({
      text: '修正',
      replaceCharacters: 0,
    })
    expect(parseDocumentCursorCompletion('REPLA', request())).toEqual({
      text: '',
      replaceCharacters: 0,
    })

    const structuredPrompt = buildDocumentCursorCompletionPrompt({
      ...request(),
      blockSuffix: '当前块后半段',
      nearbyBlocks: [{
        relation: 'previous',
        type: 'heading',
        text: '背景',
        ancestorTypes: ['doc', 'heading'],
        attrs: { level: 2 },
      }],
    })
    expect(structuredPrompt).toContain('<CURRENT_BLOCK_SUFFIX>\n当前块后半段')
    expect(structuredPrompt).toContain('<TIPTAP_NEARBY_BLOCKS>')
    expect(structuredPrompt).toContain('"type":"heading"')
  })

  it('allows only locally verified token corrections', () => {
    expect(parseDocumentCursorCompletion('REPLACE:32\nfunction()', {
      ...request('codeBlock'),
      blockPrefix: 'const fucntion',
    })).toEqual({
      text: 'function()',
      replaceCharacters: 8,
    })
    expect(parseDocumentCursorCompletion('REPLACE:3\nthe sentence.', {
      ...request(),
      blockPrefix: 'This is teh',
    })).toEqual({
      text: 'the sentence.',
      replaceCharacters: 3,
    })
    expect(parseDocumentCursorCompletion('REPLACE:10\n错误', {
      ...request(),
      blockPrefix: 'TypeScript 允许你在变量、函数参数和返回值上添加类型注解。这有助于在编译时捕获潜在',
    })).toEqual({
      text: '错误',
      replaceCharacters: 0,
    })
    expect(parseDocumentCursorCompletion('REPLACE:2\n应该继续', {
      ...request(),
      blockPrefix: '这个功能因该',
    })).toEqual({
      text: '应该继续',
      replaceCharacters: 0,
    })
    expect(parseDocumentCursorCompletion('REPLACE:7\nrewrite', {
      ...request(),
      blockPrefix: 'Keep this correct phrase',
    })).toEqual({
      text: 'rewrite',
      replaceCharacters: 0,
    })
  })

  it('builds format-aware rules without allowing new document structures', () => {
    const codePrompt = buildDocumentCursorCompletionPrompt(request('codeBlock', {
      ancestorTypes: ['doc', 'codeBlock'],
      activeMarks: [],
      codeLanguage: 'typescript',
      codeLinePrefix: '  return val',
    }))
    expect(codePrompt).toContain('typescript 代码块')
    expect(codePrompt).toContain('依据 codeLinePrefix 保持当前行缩进')
    expect(codePrompt).toContain('"codeLinePrefix":"  return val"')

    const listPrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'bulletList', 'listItem', 'paragraph'],
      activeMarks: ['bold'],
      list: { type: 'bulletList', depth: 1, itemType: 'listItem' },
    }))
    expect(listPrompt).toContain('第 1 层无序列表的当前条目')
    expect(listPrompt).toContain('不要输出列表标记、复选框或创建下一条目')
    expect(listPrompt).toContain('当前文字 marks 为 bold')

    const taskPrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'taskList', 'taskItem', 'paragraph'],
      activeMarks: [],
      list: { type: 'taskList', depth: 1, itemType: 'taskItem', checked: true },
    }))
    expect(taskPrompt).toContain('任务列表')
    expect(taskPrompt).toContain('当前任务已完成')

    const headingPrompt = buildDocumentCursorCompletionPrompt(request('heading', {
      ancestorTypes: ['doc', 'heading'],
      activeMarks: ['code'],
      headingLevel: 2,
    }))
    expect(headingPrompt).toContain('2 级标题')
    expect(headingPrompt).toContain('不要输出 #')
    expect(headingPrompt).toContain('不要添加反引号')

    const quotePrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'blockquote', 'paragraph'],
      activeMarks: [],
    }))
    expect(quotePrompt).toContain('光标位于引用块')
    expect(quotePrompt).toContain('不要输出 >')

    const tablePrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'table', 'tableRow', 'tableCell', 'paragraph'],
      activeMarks: [],
    }))
    expect(tablePrompt).toContain('光标位于表格单元格')
    expect(tablePrompt).toContain('不要输出表格分隔符')
  })

  it('strips accidental structure markers from block-local suggestions', () => {
    const listRequest = request('paragraph', {
      ancestorTypes: ['doc', 'taskList', 'taskItem', 'paragraph'],
      activeMarks: [],
      list: { type: 'taskList', depth: 1, itemType: 'taskItem', checked: false },
    })
    expect(parseDocumentCursorCompletion('KEEP\n- [ ] 继续当前任务', listRequest)).toEqual({
      text: '继续当前任务',
      replaceCharacters: 0,
    })

    const headingRequest = request('heading', {
      ancestorTypes: ['doc', 'heading'],
      activeMarks: ['code'],
      headingLevel: 2,
    })
    expect(parseDocumentCursorCompletion('KEEP\n## `接口约定`', headingRequest)).toEqual({
      text: '接口约定',
      replaceCharacters: 0,
    })

    const quoteRequest = request('paragraph', {
      ancestorTypes: ['doc', 'blockquote', 'paragraph'],
      activeMarks: [],
    })
    expect(parseDocumentCursorCompletion('KEEP\n> 继续引用', quoteRequest)).toEqual({
      text: '继续引用',
      replaceCharacters: 0,
    })

    const markedRequest = request('paragraph', {
      ancestorTypes: ['doc', 'paragraph'],
      activeMarks: ['bold', 'italic', 'strike', 'link'],
    })
    expect(parseDocumentCursorCompletion('KEEP\n***重点***', markedRequest)).toEqual({
      text: '重点',
      replaceCharacters: 0,
    })
    expect(parseDocumentCursorCompletion('KEEP\n[链接文字](https://example.com)', markedRequest)).toEqual({
      text: '链接文字',
      replaceCharacters: 0,
    })

    const tableRequest = request('paragraph', {
      ancestorTypes: ['doc', 'table', 'tableRow', 'tableCell', 'paragraph'],
      activeMarks: [],
    })
    expect(parseDocumentCursorCompletion('KEEP\n| 单元格内容 |', tableRequest)).toEqual({
      text: '单元格内容',
      replaceCharacters: 0,
    })
  })

  it('streams sanitized text with memory and tools disabled, then deletes the session', async () => {
    const batches = [
      [event(1, 'message.delta', { delta: 'KEEP\n自然' })],
      [
        event(2, 'message.delta', { delta: '结束。' }),
        event(3, 'message.completed', { content: 'KEEP\n自然结束。' }),
        event(4, 'run.completed', {}),
      ],
    ]
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockImplementation(async () => batches.shift() ?? []),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const received: Array<{ text: string; replaceCharacters: number }> = []

    const result = await streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onSuggestion: (suggestion) => received.push(suggestion),
    })

    expect(result).toEqual({ text: '自然结束。', replaceCharacters: 0 })
    expect(received).toEqual([
      { text: '自然', replaceCharacters: 0 },
      { text: '自然结束。', replaceCharacters: 0 },
      { text: '自然结束。', replaceCharacters: 0 },
    ])
    expect(api.startRun).toHaveBeenCalledWith('completion-session', expect.objectContaining({
      captureMemory: false,
      recallMemory: false,
      toolsEnabled: false,
    }))
    expect(api.cancelRun).not.toHaveBeenCalled()
    expect(api.deleteSession).toHaveBeenCalledWith('completion-session')
  })

  it('cancels the run and deletes the temporary session on timeout', async () => {
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn()
        .mockRejectedValueOnce(new Error('agent_session_busy'))
        .mockResolvedValue(undefined),
    }

    await expect(streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      timeoutMs: 0,
      onSuggestion: vi.fn(),
    })).rejects.toThrow('Agent 补全超时')

    expect(api.cancelRun).toHaveBeenCalledWith('completion-run')
    expect(api.deleteSession).toHaveBeenCalledTimes(2)
    expect(api.deleteSession).toHaveBeenLastCalledWith('completion-session')
  })

  it('cancels a run that finishes starting after the caller aborts', async () => {
    let releaseStart: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const startReleased = new Promise<void>((resolvePromise) => { releaseStart = resolvePromise })
    const startEntered = new Promise<void>((resolvePromise) => { markStarted = resolvePromise })
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockImplementation(async () => {
        markStarted?.()
        await startReleased
        return run()
      }),
      getEvents: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const controller = new AbortController()
    const completion = streamDocumentCursorCompletion(api, request(), {
      signal: controller.signal,
      onSuggestion: vi.fn(),
    })

    await startEntered
    controller.abort()
    releaseStart?.()

    await expect(completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(api.cancelRun).toHaveBeenCalledWith('completion-run')
    expect(api.deleteSession).toHaveBeenCalledWith('completion-session')
  })

  it('deletes the temporary session when the run fails', async () => {
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockResolvedValue([
        event(1, 'run.failed', { message: 'gateway failed' }),
      ]),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }

    await expect(streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onSuggestion: vi.fn(),
    })).rejects.toThrow('gateway failed')

    expect(api.deleteSession).toHaveBeenCalledWith('completion-session')
  })
})
