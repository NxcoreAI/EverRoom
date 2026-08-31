import type { AgentEvent, AgentRun, AgentSession, AgentSocketFrame } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import {
  buildDocumentCursorCompletionPrompt,
  classifyDocumentCursorCompletionError,
  DocumentCursorCompletionCircuitBreaker,
  DocumentCursorCompletionSessionChannel,
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

  it('rejects template-marker echoes as prompt leakage instead of showing them', () => {
    // 实测失效形态：模型把请求模板本身当补全输出（2026-08-31 日志 "<CURSOR />" 回显）。
    // 含任何模板标记的输出整条作废 → parse 返回空文本 → no_completion，不进熔断、不留 ghost。
    expect(sanitizeDocumentCursorCompletion('<CURSOR />', '')).toBe('')
    expect(sanitizeDocumentCursorCompletion('KEEP\n<CURSOR />', '')).toBe('')
    expect(sanitizeDocumentCursorCompletion('在当前列表项中续写内容 </PREFIX>', '')).toBe('')
    expect(sanitizeDocumentCursorCompletion('自然结束。</EDITOR_CONTEXT>', '')).toBe('')
    // 正常内容（含普通尖括号标签）不受影响。
    expect(sanitizeDocumentCursorCompletion('自然续写下一项。', '')).toBe('自然续写下一项。')
    expect(parseDocumentCursorCompletion('KEEP\n<CURSOR />', request())).toEqual({
      text: '',
      replaceCharacters: 0,
    })
    // 指令段同步加固：空前缀场景显式要求直接给内容、禁止复述与模板标记。
    expect(buildDocumentCursorCompletionPrompt(request())).toContain('当光标处前缀为空')
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

  it('builds a static instruction block and carries format context as data', () => {
    const codePrompt = buildDocumentCursorCompletionPrompt(request('codeBlock', {
      ancestorTypes: ['doc', 'codeBlock'],
      activeMarks: [],
      codeLanguage: 'typescript',
      codeLinePrefix: '  return val',
    }))
    expect(codePrompt).toContain('格式规则')
    expect(codePrompt).toContain('"codeLanguage":"typescript"')
    expect(codePrompt).toContain('"codeLinePrefix":"  return val"')

    const listPrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'bulletList', 'listItem', 'paragraph'],
      activeMarks: ['bold'],
      list: { type: 'bulletList', depth: 1, itemType: 'listItem' },
    }))
    expect(listPrompt).toContain('不要输出列表标记、复选框或创建下一条目')
    expect(listPrompt).toContain('"list":{"type":"bulletList","depth":1,"itemType":"listItem"}')
    expect(listPrompt).toContain('"activeMarks":["bold"]')

    const taskPrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'taskList', 'taskItem', 'paragraph'],
      activeMarks: [],
      list: { type: 'taskList', depth: 1, itemType: 'taskItem', checked: true },
    }))
    expect(taskPrompt).toContain('"checked":true')

    const headingPrompt = buildDocumentCursorCompletionPrompt(request('heading', {
      ancestorTypes: ['doc', 'heading'],
      activeMarks: ['code'],
      headingLevel: 2,
    }))
    expect(headingPrompt).toContain('不要输出 #')
    expect(headingPrompt).toContain('"headingLevel":2')

    const quotePrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'blockquote', 'paragraph'],
      activeMarks: [],
    }))
    expect(quotePrompt).toContain('不要输出 >')
    expect(quotePrompt).toContain('"blockquote"')

    const tablePrompt = buildDocumentCursorCompletionPrompt(request('paragraph', {
      ancestorTypes: ['doc', 'table', 'tableRow', 'tableCell', 'paragraph'],
      activeMarks: [],
    }))
    expect(tablePrompt).toContain('不要输出表格分隔符')
    expect(tablePrompt).toContain('"tableCell"')
  })

  it('keeps the instruction prefix byte-identical across block types for provider prefix caching', () => {
    const instructionPrefix = (prompt: string) => prompt.slice(0, prompt.indexOf('<PREFIX>'))
    const prompts = [
      request('codeBlock', {
        ancestorTypes: ['doc', 'codeBlock'],
        activeMarks: [],
        codeLanguage: 'typescript',
      }),
      request('heading', {
        ancestorTypes: ['doc', 'heading'],
        activeMarks: [],
        headingLevel: 2,
      }),
      request('paragraph', {
        ancestorTypes: ['doc', 'bulletList', 'listItem', 'paragraph'],
        activeMarks: ['bold'],
        list: { type: 'bulletList', depth: 1, itemType: 'listItem' },
      }),
      request(),
    ].map((input) => buildDocumentCursorCompletionPrompt(input))
    for (const prompt of prompts.slice(1)) {
      expect(instructionPrefix(prompt)).toBe(instructionPrefix(prompts[0]))
    }
  })

  it('keeps the instruction prefix byte-identical across completion modes', () => {
    const instructionPrefix = (prompt: string) => prompt.slice(0, prompt.indexOf('<PREFIX>'))
    const inlinePrompt = buildDocumentCursorCompletionPrompt(request())
    const paragraphPrompt = buildDocumentCursorCompletionPrompt({
      ...request(),
      completionMode: 'paragraph',
      avoidText: '上一条被拒绝的建议',
    })
    expect(instructionPrefix(paragraphPrompt)).toBe(instructionPrefix(inlinePrompt))
    expect(paragraphPrompt).toContain('"completionMode":"paragraph"')
    expect(paragraphPrompt).toContain('"avoidText":"上一条被拒绝的建议"')
    expect(inlinePrompt).toContain('"completionMode":"inline"')
    // formatRules 指令文本会提到 avoidText 这个词，这里断言的是数据字段不序列化
    expect(inlinePrompt).not.toContain('"avoidText"')
  })

  it('sanitizes paragraph-mode suggestions to at most four sentences within 300 code points', () => {
    // 2 句全保留（inline 档会在第 1 句截断——回归防线见上一用例）
    expect(sanitizeDocumentCursorCompletion('第一句。第二句。第三句。', '', 'paragraph', '', undefined, 'paragraph'))
      .toBe('第一句。第二句。第三句。')
    // 第 5 句边界被丢弃：只取前 4 句
    expect(sanitizeDocumentCursorCompletion('一。二。三。四。五。', '', 'paragraph', '', undefined, 'paragraph'))
      .toBe('一。二。三。四。')
    // 超过 300 码点时收缩到最大的可容纳句边界
    const longSentence = '句'.repeat(120)
    const trimmed = sanitizeDocumentCursorCompletion(
      `${longSentence}。${longSentence}。${longSentence}。`,
      '', 'paragraph', '', undefined, 'paragraph',
    )
    expect(Array.from(trimmed).length).toBe(242)
    expect(trimmed.endsWith('。')).toBe(true)
    // 无句末边界：按码点硬切 300
    expect(Array.from(sanitizeDocumentCursorCompletion('字'.repeat(400), '', 'paragraph', '', undefined, 'paragraph')).length)
      .toBe(300)
    // 换行折叠依旧生效：段落档不允许新建块
    expect(sanitizeDocumentCursorCompletion('第一句。\n第二句。', '', 'paragraph', '', undefined, 'paragraph'))
      .toBe('第一句。 第二句。')
    // codeBlock 无视档位，走代码规则
    expect(sanitizeDocumentCursorCompletion('```ts\nreturn value\n}\n```', '', 'codeBlock', '', undefined, 'paragraph'))
      .toBe('return value\n}')
    // parse 透传档位：KEEP 段落文本不被单句截断
    expect(parseDocumentCursorCompletion('KEEP\n第一句。第二句。', {
      ...request(),
      completionMode: 'paragraph',
    })).toEqual({
      text: '第一句。第二句。',
      replaceCharacters: 0,
    })
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

describe('document cursor completion session channel', () => {
  function completedEvents(): AgentEvent[] {
    return [
      event(1, 'message.delta', { delta: 'KEEP\n自然' }),
      event(2, 'message.completed', { content: 'KEEP\n自然结束。' }),
      event(3, 'run.completed', {}),
    ]
  }

  it('reuses one session across requests and deletes it only on dispose', async () => {
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockResolvedValue(completedEvents()),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const channel = new DocumentCursorCompletionSessionChannel(api, {
      roomId: 'room-1',
      documentName: '产品计划',
    })
    const options = {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onSuggestion: vi.fn(),
      channel,
    }
    const first = await streamDocumentCursorCompletion(api, request(), options)
    const second = await streamDocumentCursorCompletion(api, request(), options)
    expect(first).toEqual({ text: '自然结束。', replaceCharacters: 0 })
    expect(second).toEqual({ text: '自然结束。', replaceCharacters: 0 })
    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(api.deleteSession).not.toHaveBeenCalled()

    channel.dispose()
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    expect(api.deleteSession).toHaveBeenCalledWith('completion-session')
  })

  it('consumes pushed events without blind polling', async () => {
    let pushFrame: ((frame: AgentSocketFrame) => void) | null = null
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockImplementation(async () => {
        pushFrame?.({ type: 'event', protocol: 1, event: event(1, 'message.delta', { delta: 'KEEP\n自然' }) })
        pushFrame?.({ type: 'event', protocol: 1, event: event(2, 'message.completed', { content: 'KEEP\n自然结束。' }) })
        pushFrame?.({ type: 'event', protocol: 1, event: event(3, 'run.completed', {}) })
        return run()
      }),
      getEvents: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn().mockImplementation((listener: (frame: AgentSocketFrame) => void) => {
        pushFrame = listener
        return () => {
          pushFrame = null
        }
      }),
    }
    const channel = new DocumentCursorCompletionSessionChannel(api, {
      roomId: 'room-1',
      documentName: '产品计划',
    })
    expect(channel.supportsPush).toBe(true)

    // 对账间隔拉到 60s：若推送链路没接通，请求只会在总超时上失败。
    const result = await streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      onSuggestion: vi.fn(),
      channel,
      reconcileIntervalMs: 60_000,
    })
    expect(result).toEqual({ text: '自然结束。', replaceCharacters: 0 })
    expect(api.subscribe).toHaveBeenCalledWith('completion-session')
    channel.dispose()
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    expect(api.unsubscribe).toHaveBeenCalled()
    expect(api.deleteSession).toHaveBeenCalledWith('completion-session')
  })

  it('recreates the reused session once when the service dropped it', async () => {
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn()
        .mockResolvedValueOnce({ ...session(), id: 'stale-session' })
        .mockResolvedValueOnce({ ...session(), id: 'fresh-session' }),
      startRun: vi.fn()
        .mockRejectedValueOnce(new Error('Agent session not found'))
        .mockResolvedValueOnce(run()),
      getEvents: vi.fn().mockResolvedValue(completedEvents()),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const channel = new DocumentCursorCompletionSessionChannel(api, {
      roomId: 'room-1',
      documentName: '产品计划',
    })

    const result = await streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onSuggestion: vi.fn(),
      channel,
    })
    expect(result).toEqual({ text: '自然结束。', replaceCharacters: 0 })
    expect(api.createSession).toHaveBeenCalledTimes(2)
    expect(api.startRun).toHaveBeenLastCalledWith('fresh-session', expect.anything())
    channel.dispose()
  })

  it('retries the reused session with backoff while the gateway is still releasing the previous run', async () => {
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn()
        .mockRejectedValueOnce(new Error('Agent session already has an active run'))
        .mockResolvedValueOnce(run()),
      getEvents: vi.fn().mockResolvedValue(completedEvents()),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }
    const channel = new DocumentCursorCompletionSessionChannel(api, {
      roomId: 'room-1',
      documentName: '产品计划',
    })

    const result = await streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onSuggestion: vi.fn(),
      channel,
    })

    expect(result).toEqual({ text: '自然结束。', replaceCharacters: 0 })
    // session_busy 是暂态竞态：同会话重试，不换会话、不删会话。
    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(api.startRun).toHaveBeenCalledTimes(2)
    expect(api.startRun).toHaveBeenLastCalledWith('completion-session', expect.anything())
    expect(api.deleteSession).not.toHaveBeenCalled()
    channel.dispose()
  })

  it('gives up after four session_busy retries and rethrows the gateway error', async () => {
    vi.useFakeTimers()
    try {
      const api: DocumentCursorCompletionAgentApi = {
        createSession: vi.fn().mockResolvedValue(session()),
        startRun: vi.fn().mockRejectedValue(new Error('Agent session already has an active run')),
        getEvents: vi.fn().mockResolvedValue([]),
        cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      }
      const channel = new DocumentCursorCompletionSessionChannel(api, {
        roomId: 'room-1',
        documentName: '产品计划',
      })

      const completion = streamDocumentCursorCompletion(api, request(), {
        signal: new AbortController().signal,
        pollIntervalMs: 0,
        onSuggestion: vi.fn(),
        channel,
      })
      const assertion = expect(completion).rejects.toThrow('Agent session already has an active run')
      // 退避总额 150+300+600+1200ms 后仍忙 → 放弃重试原样抛出。
      await vi.advanceTimersByTimeAsync(150 + 300 + 600 + 1200)
      await assertion

      expect(api.startRun).toHaveBeenCalledTimes(5)
      expect(api.createSession).toHaveBeenCalledTimes(1)
      channel.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts early when no usable suggestion arrives within the first-suggestion deadline', async () => {
    const api: DocumentCursorCompletionAgentApi = {
      createSession: vi.fn().mockResolvedValue(session()),
      startRun: vi.fn().mockResolvedValue(run()),
      getEvents: vi.fn().mockResolvedValue([]),
      cancelRun: vi.fn().mockResolvedValue({ ...run(), status: 'cancelled' }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    }

    await expect(streamDocumentCursorCompletion(api, request(), {
      signal: new AbortController().signal,
      pollIntervalMs: 0,
      onSuggestion: vi.fn(),
      timeoutMs: 5_000,
      firstSuggestionMs: 0,
    })).rejects.toMatchObject({ kind: 'first_suggestion_timeout' })

    expect(api.cancelRun).toHaveBeenCalledWith('completion-run')
  })
})

describe('document cursor completion circuit breaker', () => {
  it('opens after consecutive failures with exponential backoff and resets on success', () => {
    const breaker = new DocumentCursorCompletionCircuitBreaker(3, 5_000, 60_000)
    const now = 1_000_000
    expect(breaker.shouldAttempt(now)).toBe(true)

    breaker.recordFailure(now)
    breaker.recordFailure(now)
    expect(breaker.shouldAttempt(now)).toBe(true)

    breaker.recordFailure(now)
    expect(breaker.shouldAttempt(now)).toBe(false)
    expect(breaker.cooldownRemainingMs(now)).toBe(5_000)

    const later = now + 10_000
    breaker.recordFailure(later)
    expect(breaker.cooldownRemainingMs(later)).toBe(10_000)

    breaker.recordSuccess()
    expect(breaker.shouldAttempt(now)).toBe(true)
    expect(breaker.cooldownRemainingMs(now)).toBe(0)
  })

  it('classifies errors for the breaker and session retry paths', () => {
    expect(classifyDocumentCursorCompletionError(new DOMException('x', 'AbortError'))).toBe('aborted')
    expect(classifyDocumentCursorCompletionError(new Error('Agent session not found'))).toBe('session_not_found')
    expect(classifyDocumentCursorCompletionError(new Error('agent_session_not_found'))).toBe('session_not_found')
    expect(classifyDocumentCursorCompletionError(new Error('Agent session already has an active run'))).toBe('session_busy')
    expect(classifyDocumentCursorCompletionError(new Error('agent_session_busy'))).toBe('session_busy')
    expect(classifyDocumentCursorCompletionError(new Error('Remote Agent already has an active run'))).toBe('session_busy')
    expect(classifyDocumentCursorCompletionError(new Error('runtime_config_not_ready'))).toBe('unconfigured')
    expect(classifyDocumentCursorCompletionError(new Error('Agent 请求失败（429）'))).toBe('provider')
    expect(classifyDocumentCursorCompletionError(new Error('fetch failed'))).toBe('network')
    expect(classifyDocumentCursorCompletionError(new Error('完全未知'))).toBe('unknown')
  })
})
