// @vitest-environment happy-dom
/**
 * AgentComposer 模型选择器（DSH 式两级菜单）渲染回归：
 * 1) 触发钮显示模型名 + 推理等级后缀；打开后 root 面板有「模型/推理等级」两行；
 * 2) 进入推理等级行后有 5 个选项（默认/关闭/低/中/高），点「高」回调 'high' 并收起；
 * 3) max 等未暴露档位回落到「高」展示并选中；
 * 4) 渠道会话（CLI/ACP）不提供推理等级行（没有思考档概念）。
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

function modelToggle(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.agent-model-tier-toggle')
}

function modelPicker(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.agent-model-picker')
}

function rootCells(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.agent-model-picker[data-pane="root"] .agent-model-cell')]
}

function effortOptions(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('.agent-model-picker[data-pane="effort"] [role="menuitemradio"]')]
}

async function openPickerAndDrillEffort(): Promise<void> {
  await act(async () => {
    modelToggle()!.click()
  })
  const effortCell = rootCells().find((cell) => cell.textContent?.includes('推理等级'))
  await act(async () => {
    effortCell!.click()
  })
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
  it('触发钮显示推理等级后缀；root 面板有「模型/推理等级」两行入口', async () => {
    await render({ thinkingLevel: null, onSelectThinkingLevel })
    const trigger = modelToggle()
    expect(trigger, '非渠道会话应渲染模型选择触发钮').not.toBeNull()
    expect(trigger!.textContent).toContain('智能')
    expect(trigger!.textContent).toContain('默认')

    await act(async () => {
      trigger!.click()
    })
    const cells = rootCells()
    expect(cells.map((cell) => cell.querySelector('.agent-model-cell-label')?.textContent)).toEqual([
      '模型',
      '推理等级',
    ])
    expect(cells[0]!.querySelector('.agent-model-cell-value')?.textContent).toBe('智能')
    expect(cells[1]!.querySelector('.agent-model-cell-value')?.textContent).toBe('默认')
  })

  it('进入推理等级行后有 5 个选项且默认项选中；点「高」回调 high 并收起', async () => {
    await render({ thinkingLevel: null, onSelectThinkingLevel })
    await openPickerAndDrillEffort()
    expect(effortOptions().map((option) => option.querySelector('strong')?.textContent)).toEqual([
      '默认',
      '关闭',
      '低',
      '中',
      '高',
    ])
    expect(effortOptions()[0].getAttribute('aria-checked')).toBe('true')
    const high = effortOptions().find((option) => option.dataset.level === 'high')
    expect(high).not.toBeUndefined()
    await act(async () => {
      high!.click()
    })
    expect(onSelectThinkingLevel).toHaveBeenCalledWith('high')
    expect(modelPicker()).toBeNull()
  })

  it('max 等未暴露档位回落到「高」展示并选中', async () => {
    await render({ thinkingLevel: 'max', onSelectThinkingLevel })
    expect(modelToggle()!.textContent).toContain('高')
    await openPickerAndDrillEffort()
    const selected = effortOptions().filter((option) => option.getAttribute('aria-checked') === 'true')
    expect(selected.map((option) => option.dataset.level)).toEqual(['high'])
  })

  it('会话值无需回调时也按会话值展示，不回落到默认项', async () => {
    await render({ thinkingLevel: 'off', onSelectThinkingLevel })
    expect(modelToggle()!.textContent).toContain('关闭')
  })

  it('渠道会话不提供推理等级行（触发钮也不显示等级后缀）', async () => {
    await render({ thinkingLevel: null, onSelectThinkingLevel, channelAgentId: 'codex:/usr/local/bin/codex' })
    const trigger = modelToggle()
    expect(trigger).not.toBeNull()
    expect(trigger!.querySelector('.agent-model-tier-effort')).toBeNull()
    await act(async () => {
      trigger!.click()
    })
    const labels = rootCells().map((cell) => cell.querySelector('.agent-model-cell-label')?.textContent)
    expect(labels).toEqual(['模型'])
    expect(labels).not.toContain('推理等级')
  })
})
