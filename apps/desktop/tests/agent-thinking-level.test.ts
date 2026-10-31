// @vitest-environment happy-dom
/**
 * 思考档位选择器的纯逻辑回归：
 * 1) 默认档位本地持久化容错（非法/空值 → null，写入后可读，null 清空）；
 * 2) UI 暴露的 5 个选项与顺序（默认/关闭/低/中/高）；
 * 3) 契约七档里未暴露的 minimal/xhigh/max 展示兜底不抛错。
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  THINKING_LEVEL_OPTIONS,
  THINKING_LEVEL_STORAGE_KEY,
  displayThinkingLevel,
  persistThinkingLevel,
  storedThinkingLevel,
  thinkingLevelOption,
} from '../src/renderer/src/components/agent/agentThinkingLevel'

beforeEach(() => {
  window.localStorage.clear()
})

describe('storedThinkingLevel / persistThinkingLevel', () => {
  it('未存过时回落到 null（跟随模型配置）', () => {
    expect(storedThinkingLevel()).toBeNull()
  })

  it('非法值与空串回落到 null', () => {
    window.localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, 'turbo')
    expect(storedThinkingLevel()).toBeNull()
    window.localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, '')
    expect(storedThinkingLevel()).toBeNull()
    window.localStorage.setItem(THINKING_LEVEL_STORAGE_KEY, 'HIGH')
    expect(storedThinkingLevel()).toBeNull()
  })

  it('写入后可读，写 null 会清空', () => {
    persistThinkingLevel('high')
    expect(window.localStorage.getItem(THINKING_LEVEL_STORAGE_KEY)).toBe('high')
    expect(storedThinkingLevel()).toBe('high')

    persistThinkingLevel(null)
    expect(window.localStorage.getItem(THINKING_LEVEL_STORAGE_KEY)).toBeNull()
    expect(storedThinkingLevel()).toBeNull()
  })
})

describe('THINKING_LEVEL_OPTIONS', () => {
  it('暴露 5 项且顺序为 默认 → 关闭 → 低 → 中 → 高', () => {
    expect(THINKING_LEVEL_OPTIONS.map((option) => option.value)).toEqual([
      null,
      'off',
      'low',
      'medium',
      'high',
    ])
  })

  it('每项都有 surface:agentComposer 命名空间下的 label/hint key', () => {
    for (const option of THINKING_LEVEL_OPTIONS) {
      expect(option.labelKey.startsWith('surface:agentComposer.thinkingLevel')).toBe(true)
      expect(option.hintKey.startsWith('surface:agentComposer.thinkingLevel')).toBe(true)
      expect(option.labelKey).not.toBe(option.hintKey)
    }
  })
})

describe('displayThinkingLevel / thinkingLevelOption', () => {
  it('常用档原样返回，null/undefined 表示跟随模型配置', () => {
    expect(displayThinkingLevel('off')).toBe('off')
    expect(displayThinkingLevel('low')).toBe('low')
    expect(displayThinkingLevel('medium')).toBe('medium')
    expect(displayThinkingLevel('high')).toBe('high')
    expect(displayThinkingLevel(null)).toBeNull()
    expect(displayThinkingLevel(undefined)).toBeNull()
  })

  it('minimal/xhigh/max 兜底到最接近的常用档且不抛错', () => {
    expect(displayThinkingLevel('minimal')).toBe('low')
    expect(displayThinkingLevel('xhigh')).toBe('high')
    expect(displayThinkingLevel('max')).toBe('high')
  })

  it('未知值（后端脏数据）回落到默认项且不抛错', () => {
    expect(displayThinkingLevel('turbo' as never)).toBeNull()
    expect(thinkingLevelOption('turbo' as never).value).toBeNull()
    expect(thinkingLevelOption('max').value).toBe('high')
    expect(thinkingLevelOption(null).value).toBeNull()
  })
})