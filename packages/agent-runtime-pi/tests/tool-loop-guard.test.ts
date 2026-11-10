import { describe, expect, it } from 'vitest'

import {
  createRepeatedCallState,
  DEFAULT_MAX_REPEATED_CALLS,
  resolveStallAction,
  trackRepeatedCall,
} from '../src/tool-loop-guard.js'

describe('重复调用守卫', () => {
  it('同一条命令连续重复到上限才触发', () => {
    const state = createRepeatedCallState()
    const command = { command: 'python3 - <<EOF\nprint(1)\nEOF' }
    for (let i = 1; i < DEFAULT_MAX_REPEATED_CALLS; i += 1) {
      expect(trackRepeatedCall(state, 'bash', command)).toBe(false)
    }
    expect(trackRepeatedCall(state, 'bash', command)).toBe(true)
  })

  it('中间插入一次不同调用就清零', () => {
    const state = createRepeatedCallState()
    const loop = { command: 'cat a.xml' }
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(false)
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(false)
    expect(trackRepeatedCall(state, 'bash', { command: 'ls' })).toBe(false)
    // 重新计数：第 5 次才到上限
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(false)
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(false)
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(false)
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(false)
    expect(trackRepeatedCall(state, 'bash', loop)).toBe(true)
  })

  it('参数相同但工具不同不算重复', () => {
    const state = createRepeatedCallState()
    const args = { fileId: 'f1' }
    for (let i = 0; i < DEFAULT_MAX_REPEATED_CALLS - 1; i += 1) {
      expect(trackRepeatedCall(state, 'file_read', args)).toBe(false)
    }
    expect(trackRepeatedCall(state, 'slides_read', args)).toBe(false)
  })

  it('对象键顺序不同但内容相同视为重复（避免假阴性）', () => {
    const state = createRepeatedCallState()
    expect(trackRepeatedCall(state, 'bash', { command: 'x', timeout: 1 })).toBe(false)
    expect(trackRepeatedCall(state, 'bash', { timeout: 1, command: 'x' })).toBe(false)
    expect(trackRepeatedCall(state, 'bash', { command: 'x', timeout: 1 })).toBe(false)
    expect(trackRepeatedCall(state, 'bash', { timeout: 1, command: 'x' })).toBe(false)
    expect(trackRepeatedCall(state, 'bash', { command: 'x', timeout: 1 })).toBe(true)
  })

  it('上限设为 0 时关闭守卫', () => {
    const state = createRepeatedCallState()
    for (let i = 0; i < 20; i += 1) {
      expect(trackRepeatedCall(state, 'bash', { command: 'x' }, 0)).toBe(false)
    }
  })
})

describe('打转处置：先纠偏，再犯才中止', () => {
  it('没命中什么都不做', () => {
    expect(resolveStallAction(false, false)).toBe('none')
    expect(resolveStallAction(false, true)).toBe('none')
  })

  it('第一次命中只纠偏', () => {
    expect(resolveStallAction(true, false)).toBe('steer')
  })

  it('已经纠偏过还犯就中止', () => {
    expect(resolveStallAction(true, true)).toBe('abort')
  })
})
