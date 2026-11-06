import { describe, expect, it } from 'vitest'

import {
  createToolResultDedupeState,
  dedupeToolResult,
  TOOL_RESULT_DEDUPE_MIN_CHARS,
} from '../src/tool-result-dedupe.js'

const big = (marker: string): string => `${marker}${'数据'.repeat(2_000)}`

describe('重复工具结果折叠', () => {
  it('同一份大结果第二次起只留占位说明', () => {
    const state = createToolResultDedupeState()
    const text = big('工作簿快照')
    expect(dedupeToolResult(state, 'sheets_agent_read', text)).toBe(text)

    const second = dedupeToolResult(state, 'sheets_agent_read', text)
    expect(second).not.toBe(text)
    expect(second).toContain('已省略重复结果')
    expect(second).toContain('第 1 次')

    // 第三次仍折叠，不会再新增编号
    expect(dedupeToolResult(state, 'sheets_agent_read', text)).toContain('第 1 次')
  })

  it('内容不同就不折叠', () => {
    const state = createToolResultDedupeState()
    const a = big('A')
    const b = big('B')
    expect(dedupeToolResult(state, 'read', a)).toBe(a)
    expect(dedupeToolResult(state, 'read', b)).toBe(b)
  })

  it('小回执重复出现时保持原文', () => {
    const state = createToolResultDedupeState()
    const small = 'ok\n'
    expect(small.length).toBeLessThan(TOOL_RESULT_DEDUPE_MIN_CHARS)
    expect(dedupeToolResult(state, 'bash', small)).toBe(small)
    expect(dedupeToolResult(state, 'bash', small)).toBe(small)
  })

  it('编号按"首次出现"递增，便于模型回溯', () => {
    const state = createToolResultDedupeState()
    const a = big('A')
    const b = big('B')
    dedupeToolResult(state, 'read', a)
    dedupeToolResult(state, 'read', b)
    expect(dedupeToolResult(state, 'read', b)).toContain('第 2 次')
    expect(dedupeToolResult(state, 'read', a)).toContain('第 1 次')
  })
})
