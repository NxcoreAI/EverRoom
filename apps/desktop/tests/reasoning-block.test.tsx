// @vitest-environment happy-dom
/**
 * ReasoningBlock 回归：agent 处理任务时思考过程必须可见，但默认折叠。
 *
 * 1) 有内容才渲染：空思考串不占位（不出现空的折叠头）。
 * 2) 默认折叠：无论运行中还是已完成，<details> 初始 open=false（需求原话「默认折叠」）。
 * 3) 折叠头标签：运行中显示「思考中…」，结束后显示「思考过程 · N 字」。
 * 4) 展开可读：点击 summary 后 open=true，能读到分段后的思考正文。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { ReasoningBlock } from '../src/renderer/src/components/agent/ReasoningBlock'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

function render(element: React.ReactElement): void {
  void act(() => {
    root.render(<LocaleProvider>{element}</LocaleProvider>)
  })
}

function details(): HTMLDetailsElement {
  const element = container.querySelector('details.agent-reasoning')
  expect(element, 'reasoning <details> should be rendered').not.toBeNull()
  return element as HTMLDetailsElement
}

describe('ReasoningBlock', () => {
  it('renders nothing without reasoning content', () => {
    render(<ReasoningBlock active content="   " />)
    expect(container.querySelector('details.agent-reasoning')).toBeNull()
  })

  it('is collapsed by default while the run is active', () => {
    render(<ReasoningBlock active content="先拆解用户的需求，再决定调用哪个工具。" />)
    const block = details()
    expect(block.open).toBe(false)
    expect(block.querySelector('summary')?.textContent).toContain('思考中')
  })

  it('is collapsed by default after the run finished', () => {
    render(<ReasoningBlock content={'先拆解需求。'.repeat(3)} />)
    const block = details()
    expect(block.open).toBe(false)
    // 标签只说「思考过程」，不带字数统计。
    expect(block.querySelector('summary')?.textContent).toBe('思考过程')
  })

  it('expands on click and exposes paragraph text', () => {
    render(<ReasoningBlock content={'第一段思考。\n\n第二段思考。'} />)
    const block = details()
    void act(() => {
      block.querySelector('summary')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(block.open).toBe(true)
    const paragraphs = [...block.querySelectorAll('.agent-reasoning-content p')]
    expect(paragraphs.map((paragraph) => paragraph.textContent)).toEqual(['第一段思考。', '第二段思考。'])
  })

  it('segment variant shows the first line of the sealed reasoning as label', () => {
    render(<ReasoningBlock variant="segment" content={'决定先读取文档，看完结构后再总结要点。\n\n第二段不会进标签。'} />)
    const block = details()
    // 封段后：标签直接是思考首行文本，不显示「思考」字样。
    expect(block.className).toContain('agent-reasoning-segment')
    expect(block.open).toBe(false)
    expect(block.querySelector('.agent-reasoning-summary-text')?.textContent)
      .toBe('决定先读取文档，看完结构后再总结要点。')
  })

  it('segment label truncates overlong first lines', () => {
    const longLine = '很'.repeat(80)
    render(<ReasoningBlock variant="segment" content={longLine} />)
    const label = details().querySelector('.agent-reasoning-summary-text')?.textContent ?? ''
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThanOrEqual(61)
  })

  it('live variant shows shimmer label with flowing tail preview', () => {
    render(<ReasoningBlock variant="live" active content="正在流动的思考文本，末尾片段作为预览。" />)
    const block = container.querySelector('details.agent-reasoning-live') as HTMLDetailsElement
    expect(block).not.toBeNull()
    // shimmer 标签 + tail 预览都在 summary 上；默认折叠。
    expect(block.open).toBe(false)
    const label = block.querySelector('.agent-thinking-text')
    expect(label?.textContent).toContain('思考中')
    expect(block.querySelector('.agent-reasoning-live-tail')?.textContent).toContain('末尾片段作为预览')
  })
})
