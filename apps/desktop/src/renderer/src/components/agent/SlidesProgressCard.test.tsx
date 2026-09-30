import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string, params?: Record<string, unknown>) => {
    if (!params) return key
    return `${key}?${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')}`
  } }),
}))

import { SlidesProgressCard, slidesProgressFromToolCall, type SlidesProgressState } from './SlidesProgressCard'

const draftState: SlidesProgressState = {
  stage: 'draft_ready',
  title: '季度汇报',
  totalPages: 2,
  doneCount: 0,
  documentId: 'doc-draft-1',
  pages: [
    { title: '封面', points: ['季度汇报'], materialHints: '简洁封面' },
    { title: '业绩', data: 'Q1: 1.2 亿；Q2: 1.5 亿' },
  ],
}

describe('slidesProgressFromToolCall', () => {
  it('只认 slides_draft 的三段进度载荷，其余返回 null', () => {
    const wrap = (details: unknown) => ({
      id: 'tool-1',
      name: 'slides_draft',
      status: 'running',
      startedAt: '2026-09-30T00:00:00.000Z',
      partialResult: { details },
    })
    expect(slidesProgressFromToolCall(wrap({ stage: 'draft_ready', pages: [] }) as never)?.stage).toBe('draft_ready')
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_applied', pages: [] }) as never)?.stage).toBe('page_applied')
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_gate', pages: [] }) as never)).toBeNull()
    expect(slidesProgressFromToolCall(wrap({ stage: 'draft_ready' }) as never)).toBeNull()
    expect(slidesProgressFromToolCall({ ...wrap({ stage: 'draft_ready', pages: [] }), name: 'bash' } as never)).toBeNull()
    expect(slidesProgressFromToolCall(undefined)).toBeNull()
  })
})

describe('SlidesProgressCard', () => {
  it('草稿卡：打开草稿回传文档 id，确认表单合成 generate 消息（含风格）', () => {
    const onOpenDraft = vi.fn()
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onOpenDraft={onOpenDraft} onGenerate={onGenerate} />,
    )

    act(() => renderer.root.findByProps({ className: 'agent-slides-open-draft' }).props.onClick())
    expect(onOpenDraft).toHaveBeenCalledWith('doc-draft-1')

    // 换风格 → 带风格键的模板。
    const selects = renderer.root.findAllByType('select')
    act(() => selects[2]!.props.onChange({ target: { value: 'japanese-style' } }))
    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    const styledMessage = onGenerate.mock.calls[0]![0] as string
    expect(styledMessage).toContain('slidesGenerateMessageStyled?')
    expect(styledMessage).toContain('style=japanese-style')
  })

  it('点「生成」后折成短卡：表单消失，头部按钮可重展页列表但不回显表单', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    )

    // 默认档（受众=领导汇报/时长=15 分钟/风格=自动/详略=均衡）→ 不带 style 的模板。
    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    expect(onGenerate).toHaveBeenCalledTimes(1)
    const message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesGenerateMessage?')
    expect(message).toContain('documentId=doc-draft-1')
    expect(message).toContain('title=季度汇报')
    expect(message).not.toContain('Styled')

    // 确认后只剩短卡头部（按钮），页列表与表单都收起。
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page' })).toHaveLength(0)
    const header = renderer.root.findByProps({ className: 'agent-slides-progress-header' })
    expect(header.type).toBe('button')
    expect(header.props['aria-expanded']).toBe(false)

    // 重展：页列表回来，确认表单不回显。
    act(() => header.props.onClick())
    expect(header.props['aria-expanded']).toBe(true)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page' })).toHaveLength(2)
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
  })

  it('新一轮 draft_ready 到来：折起的卡片重新展开并恢复确认表单', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    )
    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    expect(renderer.root.findAllByType('select')).toHaveLength(0)

    // 生成中（plan_ready）：折叠保持。
    const planState: SlidesProgressState = {
      stage: 'plan_ready',
      title: draftState.title,
      totalPages: 2,
      doneCount: 0,
      pages: draftState.pages,
    }
    act(() => renderer.update(
      <SlidesProgressCard state={planState} toolRunning={true} onGenerate={onGenerate} />,
    ))
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-header' }).type).toBe('button')

    // 新一轮草稿确认到来 → 恢复展开 + 确认表单（与标题无关，看阶段翻转）。
    act(() => renderer.update(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    ))
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-header' }).type).toBe('header')
    expect(renderer.root.findAllByType('select')).toHaveLength(4)
  })

  it('生成卡：默认折成短卡，点头部展开看页进度（按 doneCount 打勾，进行中的页转圈）', () => {
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'page_applied',
          title: '季度汇报',
          totalPages: 3,
          doneCount: 1,
          pages: [{ title: '封面' }, { title: '业绩' }, { title: '计划' }],
        }}
        toolRunning={true}
      />,
    )
    // 未展开：无表单无页列表，头部是可点的按钮。
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page' })).toHaveLength(0)
    const header = renderer.root.findByProps({ className: 'agent-slides-progress-header' })
    expect(header.type).toBe('button')

    act(() => header.props.onClick())
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-title' }).children).toEqual([
      expect.anything(),
      expect.anything(),
    ])
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-done' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-running' })).toHaveLength(1)
  })
})
