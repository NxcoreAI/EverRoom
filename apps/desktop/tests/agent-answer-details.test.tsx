// @vitest-environment happy-dom
/**
 * AgentAnswerDetails 回归：分级答复（answer-tiering）的 L2 折叠区。
 *
 * 1) 有内容才渲染：空详情串不占位。
 * 2) 默认折叠：<details> 初始 open=false，summary 显示「查看详情」。
 * 3) 展开后可读：详情正文进 .agent-answer-details-body。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocaleProvider } from '../src/renderer/src/i18n/LocaleContext'
import { AgentAnswerDetails } from '../src/renderer/src/components/agent/AgentAnswerDetails'

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

describe('AgentAnswerDetails', () => {
  it('空白详情不渲染任何节点', () => {
    render(<AgentAnswerDetails details="   " />)
    expect(container.querySelector('details.agent-answer-details')).toBeNull()
  })

  it('默认折叠，summary 是「查看详情」', () => {
    render(<AgentAnswerDetails details="报告分七章：1. 核心结论 2. 基本情况" />)
    const element = container.querySelector('details.agent-answer-details') as HTMLDetailsElement
    expect(element).not.toBeNull()
    expect(element.open).toBe(false)
    expect(element.querySelector('summary')?.textContent).toContain('查看详情')
  })

  it('展开后正文渲染在 body 内', async () => {
    render(<AgentAnswerDetails details={'第一章 核心结论\n\n两家公司无关联。'} />)
    const element = container.querySelector('details.agent-answer-details') as HTMLDetailsElement
    await act(async () => {
      element.open = true
      element.dispatchEvent(new Event('toggle'))
    })
    const body = element.querySelector('.agent-answer-details-body')
    expect(body).not.toBeNull()
    expect(body?.textContent).toContain('两家公司无关联')
  })
})
