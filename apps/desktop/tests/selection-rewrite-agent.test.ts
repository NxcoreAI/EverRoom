import type { SubagentInvocation } from '@nxcore/agent-contract'
import { describe, expect, it, vi } from 'vitest'

import {
  sanitizeSelectionRewriteOutput,
  streamSelectionRewrite,
  type SelectionRewriteAgentApi,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/selectionRewriteAgent'

function invocation(overrides: Partial<SubagentInvocation>): SubagentInvocation {
  return {
    id: 'invocation-1',
    agentDefinitionId: 'context-room',
    agentRevisionId: 'revision-1',
    source: 'internal_workflow',
    parentSessionId: null,
    parentRunId: null,
    task: '改写文档选区',
    input: null,
    status: 'running',
    result: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    startedAt: '2026-08-15T00:00:01.000Z',
    completedAt: null,
    ...overrides,
  }
}

function completedInvocation(text: string): SubagentInvocation {
  return invocation({
    status: 'completed',
    completedAt: '2026-08-15T00:00:02.000Z',
    result: { text },
  })
}

describe('selection rewrite Agent dispatch', () => {
  it('cleans common model wrappers from the replacement text', () => {
    expect(sanitizeSelectionRewriteOutput('```text\n改写后的文本：新文本\n```')).toBe('新文本')
    expect(sanitizeSelectionRewriteOutput('重写后的文档选区内容如下：\n新文本')).toBe('新文本')
    expect(sanitizeSelectionRewriteOutput('```ts\nconst value = 1\n```'))
      .toBe('```ts\nconst value = 1\n```')
    expect(sanitizeSelectionRewriteOutput('  if (ok) {\n    return value\n  }\n', { preserveWhitespace: true }))
      .toBe('  if (ok) {\n    return value\n  }\n')
    expect(sanitizeSelectionRewriteOutput('```ts\n  return value\n```', { preserveWhitespace: true }))
      .toBe('  return value\n')
  })

  it('dispatches the rewrite task and resolves the completed invocation text', async () => {
    const states = [
      invocation({ status: 'accepted' }),
      completedInvocation('改写后的内容'),
    ]
    const api: SelectionRewriteAgentApi = {
      dispatchSelectionRewrite: vi.fn().mockResolvedValue({ invocationId: 'invocation-1' }),
      getSubagentInvocation: vi.fn().mockImplementation(async () => states.shift() ?? completedInvocation('')),
      cancelSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
    }
    const received: string[] = []

    const result = await streamSelectionRewrite(api, {
      roomId: 'room-1',
      documentName: '计划',
      selectedText: '原文',
      instruction: '重写',
      contextBefore: '前文',
      contextAfter: '后文',
    }, {
      signal: new AbortController().signal,
      onText: (text) => received.push(text),
      pollIntervalMs: 0,
    })

    expect(result).toEqual({ replacementText: '改写后的内容', invocationId: 'invocation-1' })
    expect(received).toEqual(['改写后的内容'])
    expect(api.dispatchSelectionRewrite).toHaveBeenCalledWith(expect.objectContaining({
      roomId: 'room-1',
      documentName: '计划',
      selectedText: '原文',
      instruction: '重写',
      contextBefore: '前文',
      contextAfter: '后文',
    }))
    expect(api.cancelSubagentInvocation).not.toHaveBeenCalled()
  })

  it('preserves code indentation for a code-block rewrite', async () => {
    const api: SelectionRewriteAgentApi = {
      dispatchSelectionRewrite: vi.fn().mockResolvedValue({ invocationId: 'invocation-1' }),
      getSubagentInvocation: vi.fn().mockResolvedValue(completedInvocation('  if (ok) {\n    return value\n  }\n')),
      cancelSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
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
      invocationId: 'invocation-1',
    })
    expect(api.dispatchSelectionRewrite).toHaveBeenCalledWith(expect.objectContaining({
      blockType: 'codeBlock',
    }))
  })

  it('rejects with the invocation error when the dispatch fails', async () => {
    const api: SelectionRewriteAgentApi = {
      dispatchSelectionRewrite: vi.fn().mockResolvedValue({ invocationId: 'invocation-1' }),
      getSubagentInvocation: vi.fn().mockResolvedValue(invocation({
        status: 'failed',
        errorCode: 'runtime_error',
        errorMessage: '模型不可用',
        completedAt: '2026-08-15T00:00:02.000Z',
      })),
      cancelSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
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
      pollIntervalMs: 0,
    })).rejects.toThrow('模型不可用')

    expect(api.cancelSubagentInvocation).not.toHaveBeenCalled()
  })

  it('cancels the invocation when aborted while polling', async () => {
    const controller = new AbortController()
    const api: SelectionRewriteAgentApi = {
      dispatchSelectionRewrite: vi.fn().mockResolvedValue({ invocationId: 'invocation-1' }),
      getSubagentInvocation: vi.fn().mockImplementation(async () => {
        controller.abort()
        return invocation({ status: 'running' })
      }),
      cancelSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
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

    expect(api.cancelSubagentInvocation).toHaveBeenCalledWith('invocation-1')
  })

  it('cancels the invocation when polling fails', async () => {
    const api: SelectionRewriteAgentApi = {
      dispatchSelectionRewrite: vi.fn().mockResolvedValue({ invocationId: 'invocation-1' }),
      getSubagentInvocation: vi.fn().mockRejectedValue(new Error('gateway unavailable')),
      cancelSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
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
      pollIntervalMs: 0,
    })).rejects.toThrow('gateway unavailable')

    expect(api.cancelSubagentInvocation).toHaveBeenCalledWith('invocation-1')
  })

  it('maps a cancelled invocation to an abort error', async () => {
    const api: SelectionRewriteAgentApi = {
      dispatchSelectionRewrite: vi.fn().mockResolvedValue({ invocationId: 'invocation-1' }),
      getSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
      cancelSubagentInvocation: vi.fn().mockResolvedValue(invocation({ status: 'cancelled' })),
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
      pollIntervalMs: 0,
    })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
