// @vitest-environment happy-dom
/**
 * AgentComposer 思考档位选择器渲染回归：
 * 1) 非渠道会话显示切换钮，点击后 listbox 出现 5 个选项（默认/关闭/低/中/高）；
 * 2) 点「高」立即回调 'high' 并收起弹层；
 * 3) 会话值展示：max 等未暴露档位回落到「高」仍能正确选中；
 * 4) 渠道会话（CLI/ACP）不显示该切换钮。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentComposer } from '../src/renderer/src/components/agent/AgentComposer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const onSelectThinkingLevel = vi.fn()

function baseProps(over: Partial<React.ComponentProps<typeof AgentComposer>> = {}) {
  return {
    contextSummary: '',
    contextItems: [],
    hasSelectedText: false,
    resetKey: 0,
    value: '',
    active: false,
    available: true,
    loading: false,
    selectedExternalConversation: null,
    localAgents: [],
    modelPreference: 'smart' as const,
    loadModelAvailability: async () => ({ lite: true, primary: true }),
    onSelectModelPreference: () => undefined,
    onChange: () => undefined,
    onSelectExternalConversation: () => undefined,
    onClearContext: () => undefined,
    onRemoveContext: () => undefined,
    onStop: () => undefined,
    onSubmit: () => undefined,
    ...over,
  }
}

async function render(props: Partial<React.ComponentProps<typeof AgentComposer>> = {}): Promise<void> {
  await act(async () => {
    root.render(<AgentComposer {...baseProps(props)} />)
  })
}

function toggle(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.agent-thinking-level-toggle')
}

function options(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.agent-thinking-level-picker [role="option"]')]
}

beforeEach(() => {
  onSelectThinkingLevel.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.localStorage.clear()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
  window.localStorage.clear()
})

describe('AgentComposer 思考档位选择器', () => {
  it('显示切换钮，打开后有 5 个选项且默认项选中', async () => {
    await render({ thinkingLevel: null, onSelectThinkingLevel })
    const trigger = toggle()
    expect(trigger, '非渠道会话应渲染思考档位切换钮').not.toBeNull()
    expect(trigger!.textContent).toContain('默认')

    await act(async () => {
      trigger!.click()
    })
    expect(options().map((option) => option.querySelector('strong')?.textContent)).toEqual([
      '默认',
      '关闭',
      '低',
      '中',
      '高',
    ])
    expect(options()[0].getAttribute('aria-selected')).toBe('true')
  })

  it('点「高」回调 high 并收起弹层', async () => {
    await render({ thinkingLevel: null, onSelectThinkingLevel })
    await act(async () => {
      toggle()!.click()
    })
    const high = options().find((option) => option.dataset.level === 'high')
    expect(high).not.toBeUndefined()
    await act(async () => {
      high!.click()
    })
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('high')
    expect(container.querySelector('.agent-thinking-level-picker')).toBeNull()
  })

  it('max 等未暴露档位回落到「高」展示并选中', async () => {
    await render({ thinkingLevel: 'max', onSelectThinkingLevel })
    expect(toggle()!.textContent).toContain('高')
    await act(async () => {
      toggle()!.click()
    })
    const selected = options().filter((option) => option.getAttribute('aria-selected') === 'true')
    expect(selected.map((option) => option.dataset.level)).toEqual(['high'])
  })

  it('会话值无需回调时也按会话值展示，不回落到默认项', async () => {
    await render({ thinkingLevel: 'off', onSelectThinkingLevel })
    expect(toggle()!.textContent).toContain('关闭')
  })

  it('渠道会话不显示思考档位切换钮', async () => {
    await render({ thinkingLevel: null, onSelectThinkingLevel, channelAgentId: 'codex:/usr/local/bin/codex' })
    expect(toggle()).toBeNull()
  })
})