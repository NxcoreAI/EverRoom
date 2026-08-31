import { describe, expect, it } from 'vitest'

import {
  CURSOR_COMPLETION_AGENT_ERROR_KEY,
  isCursorCompletionAgentErrorPayload,
} from '../src/shared/cursor-completion'

describe('cursor completion agent IPC error payload', () => {
  it('recognizes the sentinel payload and pins the wire key shared by main and preload', () => {
    // main 构造、preload 识别共用这一个常量；写死字面量钉住线上格式，防手滑漂移。
    expect(CURSOR_COMPLETION_AGENT_ERROR_KEY).toBe('__cursorCompletionAgentError')
    expect(isCursorCompletionAgentErrorPayload({
      __cursorCompletionAgentError: 'Agent session already has an active run',
    })).toBe(true)
  })

  it('rejects normal IPC results with the same shape rules', () => {
    expect(isCursorCompletionAgentErrorPayload(null)).toBe(false)
    expect(isCursorCompletionAgentErrorPayload(undefined)).toBe(false)
    expect(isCursorCompletionAgentErrorPayload([])).toBe(false)
    expect(isCursorCompletionAgentErrorPayload({ id: 'completion-run' })).toBe(false)
    expect(isCursorCompletionAgentErrorPayload({ __cursorCompletionAgentError: 409 })).toBe(false)
  })
})
