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

  it('配图生成阶段（page_images）按普通进度载荷识别，缺 pages 不认', () => {
    const wrap = (details: unknown) => ({
      id: 'tool-1',
      name: 'slides_draft',
      status: 'running',
      startedAt: '2026-09-30T00:00:00.000Z',
      partialResult: { details },
    })
    const images = slidesProgressFromToolCall(wrap({
      stage: 'page_images',
      title: '季度汇报',
      totalPages: 3,
      doneCount: 1,
      pages: [{ title: '封面' }, { title: '业绩' }, { title: '计划' }],
    }) as never)
    expect(images?.stage).toBe('page_images')
    expect(images?.totalPages).toBe(3)
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_images' }) as never)).toBeNull()
  })

  it('配图确认/过目阶段要求 documentId 与 pages，缺一不认', () => {
    const wrap = (details: unknown) => ({
      id: 'tool-1',
      name: 'slides_draft',
      status: 'running',
      startedAt: '2026-09-30T00:00:00.000Z',
      partialResult: { details },
    })
    const confirm = slidesProgressFromToolCall(wrap({
      stage: 'page_images_confirm',
      documentId: 'doc-1',
      totalPages: 2,
      pages: [{ title: '封面', imagePrompt: '深蓝城市天际线' }],
    }) as never)
    expect(confirm?.stage).toBe('page_images_confirm')
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_images_confirm', pages: [] }) as never)).toBeNull()
    const review = slidesProgressFromToolCall(wrap({
      stage: 'page_images_review',
      documentId: 'doc-1',
      generation: 2,
      pages: [{ title: '封面', url: 'everroom-material://aa' }],
    }) as never)
    expect(review?.stage).toBe('page_images_review')
    expect(review?.generation).toBe(2)
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_images_review', documentId: 'doc-1' }) as never)).toBeNull()
  })

  it('风格阶段载荷要求 styleSessionId，不要求 pages', () => {
    const wrap = (details: unknown) => ({
      id: 'tool-1',
      name: 'slides_draft',
      status: 'running',
      startedAt: '2026-09-30T00:00:00.000Z',
      partialResult: { details },
    })
    const images = slidesProgressFromToolCall(wrap({
      stage: 'style_images_ready',
      styleSessionId: 's1',
      styleCandidates: [{ url: 'everroom-material://abc', generation: 1 }],
    }) as never)
    expect(images?.stage).toBe('style_images_ready')
    expect(images?.styleCandidates).toHaveLength(1)
    // 缺 styleSessionId 的风格载荷不认。
    expect(slidesProgressFromToolCall(wrap({ stage: 'style_images_ready' }) as never)).toBeNull()
  })
})

describe('SlidesProgressCard', () => {
  it('草稿卡：打开草稿回传文档 id，确认合成 style 阶段消息（无选项表单）', () => {
    const onOpenDraft = vi.fn()
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onOpenDraft={onOpenDraft} onGenerate={onGenerate} />,
    )

    act(() => renderer.root.findByProps({ className: 'agent-slides-open-draft' }).props.onClick())
    expect(onOpenDraft).toHaveBeenCalledWith('doc-draft-1')
    // 无三个下拉选项。
    expect(renderer.root.findAllByType('select')).toHaveLength(0)

    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    const message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesGenerateMessage?')
    expect(message).toContain('documentId=doc-draft-1')
    expect(message).toContain('title=季度汇报')
  })

  it('点「生成」后折成短卡：动作消失，头部按钮可重展页列表但不回显动作', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    )

    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    expect(onGenerate).toHaveBeenCalledTimes(1)

    // 确认后只剩短卡头部（按钮），页列表与动作都收起。
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page' })).toHaveLength(0)
    const header = renderer.root.findByProps({ className: 'agent-slides-progress-header' })
    expect(header.type).toBe('button')
    expect(header.props['aria-expanded']).toBe(false)

    // 重展：页列表回来，动作不回显。
    act(() => header.props.onClick())
    expect(header.props['aria-expanded']).toBe(true)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page' })).toHaveLength(2)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-generate' })).toHaveLength(0)
  })

  it('新一轮 draft_ready 到来：折起的卡片重新展开并恢复动作', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    )
    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    expect(renderer.root.findAllByProps({ className: 'agent-slides-generate' })).toHaveLength(0)

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
    expect(renderer.root.findAllByProps({ className: 'agent-slides-generate' })).toHaveLength(0)
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-header' }).type).toBe('button')

    // 新一轮草稿确认到来 → 恢复展开 + 动作（与标题无关，看阶段翻转）。
    act(() => renderer.update(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    ))
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-header' }).type).toBe('header')
    expect(renderer.root.findAllByProps({ className: 'agent-slides-generate' })).toHaveLength(1)
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
    // 未展开：无动作无页列表，头部是可点的按钮。
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page' })).toHaveLength(0)
    const header = renderer.root.findByProps({ className: 'agent-slides-progress-header' })
    expect(header.type).toBe('button')

    act(() => header.props.onClick())
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-title' }).children).toEqual([
      expect.anything(),
      expect.anything(),
    ])
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-done' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-running' })).toHaveLength(1)
  })

  it('配图生成卡：头部标签显示张数进度，页列表按 doneCount 打勾转圈', () => {
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'page_images',
          title: '季度汇报',
          totalPages: 3,
          doneCount: 1,
          pages: [{ title: '封面' }, { title: '业绩' }, { title: '计划' }],
        }}
        toolRunning={true}
      />,
    )
    const title = renderer.root.findByProps({ className: 'agent-slides-progress-title' })
    const small = title.children[1] as { children: unknown[] }
    expect(String(small.children[0])).toContain('slidesImagesProgress?done=1&total=3')
    // 默认折起，点头部展开后按 doneCount 打勾、当前张转圈。
    const header = renderer.root.findByProps({ className: 'agent-slides-progress-header' })
    act(() => header.props.onClick())
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-done' })).toHaveLength(1)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-running' })).toHaveLength(1)
  })

  it('配图确认卡：两按钮合成 generate/skip 消息（嵌工具调用与文档 id）', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'page_images_confirm',
          title: '季度汇报',
          documentId: 'doc-draft-1',
          totalPages: 2,
          pages: [
            { title: '封面', imagePrompt: '深蓝城市天际线' },
            { title: '计划', imagePrompt: '团队白板特写' },
          ],
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    )
    const generate = renderer.root.findByProps({ className: 'agent-slides-generate' })
    act(() => generate.props.onClick())
    let message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesPageImagesGenerateMessage?')
    expect(message).toContain('documentId=doc-draft-1')
    expect(message).toContain('title=季度汇报')

    // 确认后折叠：动作消失。
    expect(renderer.root.findAllByProps({ className: 'agent-slides-generate' })).toHaveLength(0)
  })

  it('配图过目卡：图上重生成按钮与确认落页按钮合成消息；generation 变化重开卡', () => {
    const onGenerate = vi.fn()
    const reviewState: SlidesProgressState = {
      stage: 'page_images_review',
      title: '季度汇报',
      documentId: 'doc-draft-1',
      generation: 1,
      totalPages: 2,
      pages: [
        { title: '封面', url: 'everroom-material://aa', imagePrompt: '深蓝城市天际线' },
        { title: '计划', url: 'everroom-material://bb', imagePrompt: '团队白板特写' },
      ],
    }
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={reviewState} toolRunning={false} onGenerate={onGenerate} />,
    )
    const images = renderer.root.findAllByType('img')
    expect(images).toHaveLength(2)
    expect(images[0]?.props.src).toBe('everroom-material://aa')

    const regenerateButtons = renderer.root.findAllByProps({ className: 'agent-slides-page-regenerate' })
    expect(regenerateButtons).toHaveLength(2)
    act(() => regenerateButtons[1]!.props.onClick())
    let message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesPageImagesRegenerateMessage?')
    expect(message).toContain('index=2')
    expect(message).toContain('documentId=doc-draft-1')
    // 点完折叠：重生成按钮收起。
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-regenerate' })).toHaveLength(0)

    // 重生成后同 stage 新 generation 载荷到来：卡片必须重开（同 key 不重开的坑）。
    act(() => renderer.update(
      <SlidesProgressCard state={{ ...reviewState, generation: 2 }} toolRunning={false} onGenerate={onGenerate} />,
    ))
    const reopened = renderer.root.findAllByProps({ className: 'agent-slides-page-regenerate' })
    expect(reopened).toHaveLength(2)

    act(() => renderer.root.findByProps({ className: 'agent-slides-style-confirm' }).props.onClick())
    message = onGenerate.mock.calls[1]![0] as string
    expect(message).toContain('slidesPageImagesAcceptMessage?')
    expect(message).toContain('documentId=doc-draft-1')
  })

  it('过目卡打回：不折叠连续审核，打回后显示恢复按钮', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'page_images_review',
          title: '季度汇报',
          documentId: 'doc-draft-1',
          generation: 1,
          totalPages: 2,
          pages: [
            { title: '封面', url: 'everroom-material://aa', imagePrompt: '深蓝城市天际线' },
            { title: '计划', url: 'everroom-material://bb', imagePrompt: '团队白板特写' },
          ],
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    )

    const rejectButtons = renderer.root.findAllByProps({ className: 'agent-slides-page-reject' })
    expect(rejectButtons).toHaveLength(2)
    act(() => rejectButtons[0]!.props.onClick())
    const message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesPageImagesRejectMessage?')
    expect(message).toContain('index=1')
    expect(message).toContain('documentId=doc-draft-1')
    // 打回不折叠：其余张的打回按钮仍在，可继续审核。
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-reject' })).toHaveLength(2)

    // 打回载荷到来：该张按钮变「恢复使用」，图容器置灰。
    act(() => renderer.update(
      <SlidesProgressCard
        state={{
          stage: 'page_images_review',
          title: '季度汇报',
          documentId: 'doc-draft-1',
          generation: 1,
          totalPages: 2,
          pages: [
            { title: '封面', url: 'everroom-material://aa', imagePrompt: '深蓝城市天际线', rejected: true },
            { title: '计划', url: 'everroom-material://bb', imagePrompt: '团队白板特写' },
          ],
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    ))
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-reject' })).toHaveLength(1)
    const restore = renderer.root.findByProps({ className: 'agent-slides-page-restore' })
    const rejectedWrap = renderer.root.findAllByProps({ className: 'agent-slides-page-review is-rejected' })
    expect(rejectedWrap).toHaveLength(1)
    act(() => restore.props.onClick())
    const restoreMessage = onGenerate.mock.calls[1]![0] as string
    expect(restoreMessage).toContain('slidesPageImagesRestoreMessage?')
    expect(restoreMessage).toContain('index=1')
  })

  it('过目卡生成中：未出图的页显示占位行，头部显示张数进度，失败页可重生成', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'page_images_review',
          title: '季度汇报',
          documentId: 'doc-draft-1',
          generation: 1,
          totalPages: 3,
          doneCount: 1,
          pages: [
            { title: '封面', url: 'everroom-material://aa', imagePrompt: '深蓝城市天际线' },
            { title: '业绩', imagePrompt: '车间实拍' },
            { title: '计划', imagePrompt: '白板特写', failed: true },
          ],
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    )

    // 未全部完成：头部用「配图生成中 x/y」标签。
    const title = renderer.root.findByProps({ className: 'agent-slides-progress-title' })
    const small = title.children[1] as { children: unknown[] }
    expect(String(small.children[0])).toContain('slidesImagesProgress?done=1&total=3')

    // 已出的图渲染；未出的渲染占位行（生成中/失败）。
    expect(renderer.root.findAllByType('img')).toHaveLength(1)
    const isReviewRow = (className: unknown): boolean =>
      className === 'agent-slides-page-review'
      || (typeof className === 'string' && className.startsWith('agent-slides-page-review is-'))
    const reviewRows = renderer.root.findAll((node) => isReviewRow(node.props?.className))
    expect(reviewRows).toHaveLength(3)
    expect(reviewRows.filter((node) => String(node.props.className).includes('is-pending'))).toHaveLength(2)
    expect(reviewRows.filter((node) => String(node.props.className).includes('is-failed'))).toHaveLength(1)

    // 失败页的占位行上有重生成按钮，合成消息带序号。
    const regenerateButtons = renderer.root.findAllByProps({ className: 'agent-slides-page-regenerate' })
    expect(regenerateButtons).toHaveLength(2) // 已出图 1 个 + 失败占位 1 个
    act(() => regenerateButtons[1]!.props.onClick())
    const message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesPageImagesRegenerateMessage?')
    expect(message).toContain('index=3')
  })

  it('挑图卡：候选出图，点第二张图即选定并合成 style_select 消息并收起', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'style_images_ready',
          title: '季度汇报',
          styleSessionId: 'style-9',
          styleCandidates: [
            { url: 'everroom-material://aa', generation: 1 },
            { url: 'everroom-material://bb', generation: 1 },
          ],
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    )
    // 图即按钮：候选本体就是可点的 button。
    const candidates = renderer.root.findAllByProps({ className: 'agent-slides-style-candidate' })
    expect(candidates).toHaveLength(2)
    expect(candidates.every((node) => node.type === 'button')).toBe(true)

    act(() => candidates[1]!.props.onClick())
    const message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesStylePickMessage?')
    expect(message).toContain('index=2')
    expect(message).toContain('sessionId=style-9')
    // 选完即收起候选。
    expect(renderer.root.findAllByProps({ className: 'agent-slides-style-candidate' })).toHaveLength(0)
  })

  it('连续等待阶段（草稿确认 → 挑图）：上一阶段的折叠锁必须解开，候选重新展示', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard state={draftState} toolRunning={false} onGenerate={onGenerate} />,
    )
    // 草稿确认：点「生成 PPT」→ 卡片折叠锁定。
    act(() => renderer.root.findByProps({ className: 'agent-slides-generate' }).props.onClick())
    expect(renderer.root.findAllByProps({ className: 'agent-slides-generate' })).toHaveLength(0)

    // 下一阶段直接是挑图（四步流程里等待阶段连续）：必须自动重新展开并显示候选。
    act(() => renderer.update(
      <SlidesProgressCard
        state={{
          stage: 'style_images_ready',
          title: draftState.title,
          styleSessionId: 'style-9',
          styleCandidates: [{ url: 'everroom-material://aa', generation: 1 }],
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    ))
    const candidates = renderer.root.findAllByProps({ className: 'agent-slides-style-candidate' })
    expect(candidates).toHaveLength(1)
    act(() => candidates[0]!.props.onClick())
    expect(onGenerate).toHaveBeenCalledTimes(2)
    const message = onGenerate.mock.calls[1]![0] as string
    expect(message).toContain('index=1')
  })

  it('风格卡：色块/字号/线框/演示页齐上，确认按钮合成 generate 消息', () => {
    const onGenerate = vi.fn()
    const renderer = TestRenderer.create(
      <SlidesProgressCard
        state={{
          stage: 'style_card_ready',
          title: '季度汇报',
          styleSessionId: 'style-9',
          styleCard: {
            swatches: [
              { hex: '#f5f2ec', label: '底色' },
              { hex: '#1e3a5f', label: '主色' },
            ],
            typography: [{ label: '正文', value: '14pt' }],
            wireframes: [{ role: 'cover', label: '封面 P1a', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }],
            demoImageUrl: 'everroom-material://dd',
            effectLines: ['主色 深藏青 #1E3A5F'],
          },
        }}
        toolRunning={false}
        onGenerate={onGenerate}
      />,
    )
    expect(renderer.root.findAllByProps({ className: 'agent-slides-style-swatch' })).toHaveLength(2)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-style-wireframe' })).toHaveLength(1)
    expect(renderer.root.findByProps({ className: 'agent-slides-style-demo' }).props.src).toBe('everroom-material://dd')

    act(() => renderer.root.findByProps({ className: 'agent-slides-style-confirm' }).props.onClick())
    const message = onGenerate.mock.calls[0]![0] as string
    expect(message).toContain('slidesStyleConfirmMessage?')
    expect(message).toContain('sessionId=style-9')
  })
})
