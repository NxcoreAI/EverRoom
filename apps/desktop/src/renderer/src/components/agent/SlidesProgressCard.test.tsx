import React from 'react'
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/LocaleContext', () => ({
  useLocale: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (!params) return key
      return `${key}?${Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')}`
    },
  }),
}))

import type { DisplayAgentToolCall } from './agentRunActivity'
import { SlidesProgressCard, slidesProgressFromToolCall, type SlidesProgressState } from './SlidesProgressCard'
import { selectSlidesTasks, type SlidesTaskEntry } from './slides/slidesState'

const KEY = 'surface:agentChat.'

function wrap(details: unknown, overrides: Partial<DisplayAgentToolCall> = {}): DisplayAgentToolCall {
  return {
    id: 'tool-1',
    runId: 'run-1',
    name: 'slides_draft',
    args: {},
    status: 'running',
    startedAt: '2026-09-30T00:00:00.000Z',
    partialResult: { details },
    ...overrides,
  }
}

function flattenText(node: unknown): string {
  if (Array.isArray(node)) return node.map(flattenText).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node && typeof node === 'object') {
    if ('children' in node) return flattenText((node as { children?: unknown }).children)
    if ('props' in node) return flattenText((node as { props?: { children?: unknown } }).props?.children)
  }
  return ''
}

function buttonWithText(root: ReactTestInstance, text: string): ReactTestInstance {
  const buttons = root.findAllByType('button')
  const found = buttons.find((button) => flattenText(button.props.children) === text)
  if (!found) throw new Error(`button not found: ${text}; have: ${buttons.map((b) => flattenText(b.props.children)).join(' | ')}`)
  return found
}

function buttonContaining(root: ReactTestInstance, text: string): ReactTestInstance {
  const buttons = root.findAllByType('button')
  const found = buttons.find((button) => flattenText(button.props.children).includes(text))
  if (!found) throw new Error(`button not found containing: ${text}`)
  return found
}

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

const reviewState: SlidesProgressState = {
  stage: 'page_images_review',
  title: '季度汇报',
  documentId: 'doc-draft-1',
  generation: 1,
  totalPages: 3,
  doneCount: 3,
  pages: [
    { title: '封面', url: 'everroom-material://aa', pageIndex: 0 },
    { title: '业绩', url: 'everroom-material://bb', pageIndex: 1 },
    { title: '计划', url: 'everroom-material://cc', pageIndex: 2 },
  ],
}

const styleState: SlidesProgressState = {
  stage: 'style_images_ready',
  title: '季度汇报',
  documentId: 'doc-draft-1',
  styleSessionId: 'style-9',
  styleCandidates: [
    { url: 'everroom-material://s0', label: '深色杂志', generation: 1 },
    { url: 'everroom-material://s1', label: '暖纸手作', generation: 1 },
  ],
}

const cardFixture = (overrides: Partial<React.ComponentProps<typeof SlidesProgressCard>> = {}) => (
  <SlidesProgressCard state={draftState} toolRunning={false} {...overrides} />
)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('slidesProgressFromToolCall', () => {
  it('新增长等待阶段（drafting/style_generating/style_extracting/planning）都识别为任务', () => {
    for (const stage of ['drafting', 'style_generating', 'style_extracting', 'planning'] as const) {
      const progress = slidesProgressFromToolCall(wrap({ stage, title: '季度汇报', documentId: 'doc-1' }))
      expect(progress?.stage).toBe(stage)
      expect(progress?.title).toBe('季度汇报')
    }
  })

  it('failed 无 pages 也保留（失败卡不许消失），未知 stage 返回 null', () => {
    const failed = slidesProgressFromToolCall(wrap({
      stage: 'failed',
      errorCode: 'slides_layout_tail_failed',
      errorMessage: '排版收尾失败',
      retryable: true,
      failedPages: [1, 'x', 3],
    }))
    expect(failed?.stage).toBe('failed')
    expect(failed?.errorCode).toBe('slides_layout_tail_failed')
    expect(failed?.retryable).toBe(true)
    expect(failed?.failedPages).toEqual([1, 3])
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_gate', pages: [] }))).toBeNull()
    expect(slidesProgressFromToolCall(wrap({ stage: 'whatever' }))).toBeNull()
    expect(slidesProgressFromToolCall(undefined)).toBeNull()
    expect(slidesProgressFromToolCall({ ...wrap({ stage: 'drafting' }), name: 'bash' })).toBeNull()
  })

  it('工具直接报错（无阶段载荷）兜底成失败卡；非 slides_draft 不兜底', () => {
    expect(slidesProgressFromToolCall(wrap(undefined, { status: 'error' }))?.stage).toBe('failed')
    const bash = { ...wrap(undefined, { status: 'error' }), name: 'bash' }
    expect(slidesProgressFromToolCall(bash)).toBeNull()
  })

  it('参数校验拒绝（调用从未开始）不渲染失败卡', () => {
    expect(slidesProgressFromToolCall(wrap(undefined, {
      status: 'error',
      error: 'Validation failed for tool "slides_draft":\n  - targetPages: must be >= 4',
    }))).toBeNull()
  })

  it('进度阶段要求 pages，配图阶段要求 documentId，风格阶段要求 styleSessionId', () => {
    expect(slidesProgressFromToolCall(wrap({ stage: 'draft_ready', pages: [] }))?.stage).toBe('draft_ready')
    expect(slidesProgressFromToolCall(wrap({ stage: 'draft_ready' }))).toBeNull()
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_images', pages: [{ title: '封面' }] }))?.stage).toBe('page_images')
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_images' }))).toBeNull()
    expect(slidesProgressFromToolCall(wrap({ stage: 'page_images_confirm', pages: [] }))).toBeNull()
    expect(slidesProgressFromToolCall(wrap({
      stage: 'page_images_review',
      documentId: 'doc-1',
      generation: 2,
      pages: [{ title: '封面', url: 'everroom-material://aa', pageIndex: 0 }],
    }))?.generation).toBe(2)
    expect(slidesProgressFromToolCall(wrap({ stage: 'style_images_ready' }))).toBeNull()
  })

  it('风格阶段字段兼容映射：candidates→styleCandidates、顶层风格卡→styleCard', () => {
    const images = slidesProgressFromToolCall(wrap({
      stage: 'style_images_ready',
      styleSessionId: 's1',
      candidates: [{ url: 'everroom-material://abc', generation: 1 }],
    }))
    expect(images?.styleCandidates).toHaveLength(1)
    const card = slidesProgressFromToolCall(wrap({
      stage: 'style_card_ready',
      styleSessionId: 's1',
      swatches: [{ hex: '#1e3a5f', label: '主色' }],
      typography: [{ label: '正文', value: '14pt' }],
      demoImageUrl: 'everroom-material://dd',
      effectLines: ['主色 深藏青'],
    }))
    expect(card?.styleCard?.swatches[0]?.hex).toBe('#1e3a5f')
    expect(card?.styleCard?.demoImageUrl).toBe('everroom-material://dd')
  })
})

function entryOf(state: SlidesProgressState, options: {
  id?: string
  startedAt?: string
  status?: string
  completed?: boolean
} = {}): SlidesTaskEntry {
  return {
    tool: {
      id: options.id ?? `tool-${state.stage}`,
      runId: 'run-1',
      name: 'slides_draft',
      args: {},
      status: (options.status ?? 'completed') as SlidesTaskEntry['tool']['status'],
      startedAt: options.startedAt ?? '2026-09-30T00:00:00.000Z',
    },
    progress: state,
  }
}

describe('selectSlidesTasks', () => {
  const base = '2026-09-30T00:00:00.000Z'
  const at = (minutes: number) => new Date(Date.parse(base) + minutes * 60_000).toISOString()

  it('最新一张为主卡，等待态保留，已完成旧卡收成回执', () => {
    const selection = selectSlidesTasks([
      entryOf({ ...styleState }, { id: 't3', startedAt: at(3) }),
      entryOf({ ...draftState }, { id: 't2', startedAt: at(2) }),
      entryOf({ stage: 'page_applied', title: '旧 PPT', documentId: 'doc-old', fileEntryId: 'file-1', completed: true }, { id: 't1', startedAt: at(1) }),
    ])
    expect(selection.primary?.tool.id).toBe('t3')
    // 草稿卡与最新挑图卡是同一文档：已被新调用顶掉，不再重复展示。
    expect(selection.waiting).toHaveLength(0)
    expect(selection.receipts).toHaveLength(1)
    expect(selection.receipts[0]?.progress.fileEntryId).toBe('file-1')
    expect(selection.foldedCount).toBe(0)
  })

  it('最新一张已完成时不留完整卡，直接收成一行回执', () => {
    const selection = selectSlidesTasks([
      entryOf({ stage: 'page_applied', title: '新 PPT', documentId: 'doc-new', fileEntryId: 'file-2', completed: true }, { id: 't2', startedAt: at(2) }),
      entryOf({ stage: 'page_applied', title: '旧 PPT', documentId: 'doc-old', fileEntryId: 'file-1', completed: true }, { id: 't1', startedAt: at(1) }),
    ])
    expect(selection.primary).toBeNull()
    expect(selection.waiting).toHaveLength(0)
    expect(selection.receipts.map((entry) => entry.tool.id)).toEqual(['t2', 't1'])
  })

  it('失败任务也收成一行回执（带错误人话），不再留大卡片', () => {
    const selection = selectSlidesTasks([
      entryOf({ stage: 'failed', title: '失败的 PPT', documentId: 'doc-f', errorCode: 'slides_layout_apply_failed', retryable: true }, { id: 't1', startedAt: at(1), status: 'error' }),
    ])
    expect(selection.primary).toBeNull()
    expect(selection.receipts).toHaveLength(1)
  })

  it('失败回执已被更新的调用重试过：剥掉 retryable，不再显示「再试一次」', () => {
    // 网关失败载荷没有 documentId/title，key 是 tool:id——agent 自动重试的新调用顶不掉它。
    const failed = entryOf({ stage: 'failed', errorCode: 'slides_layout_apply_failed', errorMessage: '全部页面落页失败', retryable: true }, { id: 't1', startedAt: at(1), status: 'error' })
    expect(selectSlidesTasks([failed]).receipts[0]?.progress.retryable).toBe(true)
    const selection = selectSlidesTasks([
      entryOf({ stage: 'planning', title: '失败的 PPT', documentId: 'doc-r' }, { id: 't2', startedAt: at(2) }),
      failed,
    ])
    expect(selection.primary?.tool.id).toBe('t2')
    const receipt = selection.receipts.find((entry) => entry.tool.id === 't1')
    expect(receipt).toBeDefined()
    expect(receipt?.progress.retryable).toBe(false)
  })

  it('被取消的任务也收成回执，不再常驻完整卡', () => {
    const selection = selectSlidesTasks([
      entryOf({ stage: 'planning', title: '被中止的 PPT', documentId: 'doc-x' }, { id: 't1', startedAt: at(1), status: 'stopped' }),
    ])
    expect(selection.primary).toBeNull()
    expect(selection.receipts).toHaveLength(1)
  })

  it('不同文档的等待态并存，超过 3 张折叠计数；展开后全部返回', () => {
    const entries = [1, 2, 3, 4, 5].map((index) => entryOf(
      { stage: 'page_images_confirm', title: `deck-${index}`, documentId: `doc-${index}` },
      { id: `t${index}`, startedAt: at(index) },
    )).reverse()
    const collapsed = selectSlidesTasks(entries)
    expect(collapsed.primary?.progress.documentId).toBe('doc-5')
    expect(1 + collapsed.waiting.length).toBe(3)
    expect(collapsed.foldedCount).toBe(2)
    const expanded = selectSlidesTasks(entries, Number.MAX_SAFE_INTEGER)
    expect(1 + expanded.waiting.length).toBe(5)
    expect(expanded.foldedCount).toBe(0)
  })
})

describe('SlidesProgressCard 长等待阶段（P0-2）', () => {
  it('drafting 阶段：标题 + 人话阶段名 + 已用时 + 不确定进度条，不出现「正在调用工具」', () => {
    const startedAt = new Date(Date.now() - 65_000).toISOString()
    const renderer = TestRenderer.create(
      cardFixture({ state: { stage: 'drafting', documentId: 'doc-1' }, toolRunning: true, startedAt }),
    )
    expect(renderer.root.findByProps({ className: 'agent-slides-card-phase' }).children).toContain(`${KEY}SLIDES_PHASE_DRAFTING`)
    // 后端没给 title：用「演示文稿」兜底（走 i18n key）。
    expect(renderer.root.findByProps({ className: 'agent-slides-card-title' }).children).toContain(`${KEY}SLIDES_DEFAULT_TITLE`)
    const time = String(renderer.root.findByProps({ className: 'agent-slides-card-time' }).children)
    expect(time).toContain(`${KEY}SLIDES_ELAPSED?time=`)
    expect(time).toMatch(/time=\d{2}:\d{2}$/)
    expect(renderer.root.findByProps({ className: 'agent-slides-progress-line is-indeterminate' })).toBeTruthy()
    expect(JSON.stringify(renderer.toJSON())).not.toContain('callingATool')
  })

  it('style_generating / style_extracting / planning 各有阶段名', () => {
    const cases = [
      ['style_generating', 'SLIDES_PHASE_STYLE_GENERATING'],
      ['style_extracting', 'SLIDES_PHASE_STYLE_EXTRACTING'],
      ['planning', 'SLIDES_PHASE_PLANNING'],
    ] as const
    for (const [stage, key] of cases) {
      const renderer = TestRenderer.create(
        cardFixture({ state: { stage, title: '季度汇报' } as SlidesProgressState, toolRunning: true }),
      )
      expect(renderer.root.findByProps({ className: 'agent-slides-card-phase' }).children.join('')).toContain(`${KEY}${key}`)
      renderer.unmount()
    }
  })

  it('阶段名走 aria-live=polite，播报阶段变化', () => {
    const renderer = TestRenderer.create(cardFixture({ state: { stage: 'planning' } as SlidesProgressState, toolRunning: true }))
    expect(renderer.root.findByProps({ className: 'agent-slides-card-phase' }).props['aria-live']).toBe('polite')
  })
})

describe('SlidesProgressCard 草稿与动作语义（P1-1/P1-2）', () => {
  it('草稿卡：内容稿文案 + 「内容确认，去选风格」，动作两段式且不再暴露 task=', () => {
    const onAction = vi.fn()
    const onOpenDraft = vi.fn()
    const renderer = TestRenderer.create(cardFixture({ onAction, onOpenDraft }))

    expect(renderer.root.findByProps({ className: 'agent-slides-card-hint' }).children).toContain(`${KEY}SLIDES_DRAFT_HINT`)
    act(() => renderer.root.findByProps({ className: 'agent-slides-actions' }).findAllByType('button')[0]!.props.onClick())
    expect(onOpenDraft).toHaveBeenCalledWith('doc-draft-1')

    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_CONFIRM_CONTENT`).props.onClick())
    expect(onAction).toHaveBeenCalledTimes(1)
    const [hiddenPrompt, displayText] = onAction.mock.calls[0] as [string, string]
    expect(hiddenPrompt).toBe(`${KEY}SLIDES_CONFIRM_CONTENT_PROMPT?documentId=doc-draft-1&title=季度汇报`)
    expect(displayText).toBe(`${KEY}SLIDES_CONFIRM_CONTENT_DISPLAY`)
    // 明确选择后卡片立即收起：工作继续跑，但不在对话区留一张常驻卡。
    expect(renderer.toJSON()).toBeNull()
  })

  it('卡片可手动关闭（× 本地状态）', () => {
    const renderer = TestRenderer.create(cardFixture())
    act(() => renderer.root.findByProps({ className: 'agent-slides-card-close' }).props.onClick())
    expect(renderer.toJSON()).toBeNull()
  })
})

describe('SlidesProgressCard 完成与失败（P0-3/P0-5/P0-6）', () => {
  it('page_applied + completed：给「打开 PPT」「继续修改」；打开直接走 files.openOriginal（可编辑）', () => {
    const openOriginal = vi.fn().mockResolvedValue({ openedWith: 'office' })
    vi.stubGlobal('window', { nxcore: { files: { openOriginal } } })
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({
      state: {
        stage: 'page_applied',
        title: '季度汇报',
        completed: true,
        doneCount: 8,
        totalPages: 8,
        fileEntryId: 'file-9',
        fileName: '季度汇报.pptx',
      },
      toolRunning: false,
      onAction,
      startedAt: '2026-09-30T00:00:00.000Z',
      completedAt: '2026-09-30T00:02:00.000Z',
    }))
    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_OPEN_PPT`).props.onClick())
    expect(openOriginal).toHaveBeenCalledWith('file-9', '季度汇报.pptx', undefined, { editable: true })
    // 完成卡显示总用时。
    expect(String(renderer.root.findByProps({ className: 'agent-slides-card-time' }).children))
      .toContain(`${KEY}SLIDES_ELAPSED_DONE?time=02:00`)

    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_CONTINUE_EDIT`).props.onClick())
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toContain(`${KEY}SLIDES_CONTINUE_EDIT_PROMPT?`)
    expect(prompt).toContain('fileEntryId=file-9')
    expect(display).toContain(`${KEY}SLIDES_CONTINUE_EDIT_DISPLAY?title=季度汇报`)
  })

  it('final 载荷没有 fileEntryId：不显示打开按钮，也不报错', () => {
    const renderer = TestRenderer.create(cardFixture({
      state: { stage: 'page_applied', title: '季度汇报', completed: true, doneCount: 3, totalPages: 3 },
      toolRunning: false,
    }))
    expect(renderer.root.findAll((node) => flattenText(node.props?.children) === `${KEY}SLIDES_OPEN_PPT`)).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-error-note' })).toHaveLength(0)
  })

  it('completed=false：部分完成 + failedPages 高亮列出（第 N 页）', () => {
    const renderer = TestRenderer.create(cardFixture({
      state: {
        stage: 'page_applied',
        title: '季度汇报',
        completed: false,
        doneCount: 2,
        totalPages: 4,
        documentId: 'doc-1',
        failedPages: [1, 3],
        warnings: ['第 2 页视觉复检未通过，已放行', '第 4 页布局树未收敛，已用兜底版式'],
      },
      toolRunning: false,
    }))
    const failed = renderer.root.findByProps({ className: 'agent-slides-failed-pages' })
    expect(flattenText(failed.props.children)).toContain(`${KEY}SLIDES_FAILED_PAGE_ITEM?page=2`)
    expect(flattenText(failed.props.children)).toContain(`${KEY}SLIDES_FAILED_PAGE_ITEM?page=4`)
    // warnings 收进可展开的中性小字里。
    const warnings = renderer.root.findByProps({ className: 'agent-slides-warnings' })
    expect(flattenText(warnings.findByType('summary').props.children)).toContain(`${KEY}SLIDES_WARNINGS_SUMMARY?count=2`)
  })

  it('落页按完成顺序：按页号集合打勾，不把未落的前页算成已完成', () => {
    const payload = { stage: 'page_applied', title: '季度汇报', totalPages: 3, pages: [{ title: '封面' }], appliedPages: [1, 2] }
    expect(slidesProgressFromToolCall(wrap(payload))?.appliedPages).toEqual([1, 2])
    const renderer = TestRenderer.create(cardFixture({
      state: {
        stage: 'page_applied',
        title: '季度汇报',
        doneCount: 2,
        appliedPages: [1, 2],
        totalPages: 3,
        documentId: 'doc-1',
        pages: [{ title: '封面' }, { title: '业绩' }, { title: '计划' }],
      },
      toolRunning: true,
    }))
    // 第 2、3 页先落（第 1 页还在排）：打勾的只有这两页，第 1 页仍是无标记的待定页。
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-status is-done' })).toHaveLength(2)
    expect(renderer.root.findAllByProps({ className: 'agent-slides-page-head' })).toHaveLength(3)
  })

  it('failed：已知 errorCode 人话化，retryable 给「再试一次」并带重试指令', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({
      state: {
        stage: 'failed',
        title: '季度汇报',
        errorCode: 'slides_layout_tail_failed',
        errorMessage: '技术原因',
        retryable: true,
        doneCount: 3,
        totalPages: 8,
      },
      toolRunning: false,
      onAction,
    }))
    expect(renderer.root.findByProps({ className: 'agent-slides-failure' }).findByType('strong').children)
      .toContain(`${KEY}SLIDES_ERROR_LAYOUT_TAIL`)
    expect(renderer.root.findByProps({ className: 'agent-slides-card-phase' }).children)
      .toContain(`${KEY}SLIDES_FAILED_PHASE`)
    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_RETRY`).props.onClick())
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toContain(`${KEY}SLIDES_RETRY_PROMPT?`)
    expect(prompt).toContain('reason=')
    expect(display).toBe(`${KEY}SLIDES_RETRY_DISPLAY`)
  })

  it('failed：未知 errorCode 回落 errorMessage，不可重试时给「继续上次」提示而非假按钮', () => {
    const renderer = TestRenderer.create(cardFixture({
      state: { stage: 'failed', title: '季度汇报', errorCode: 'mystery_code', errorMessage: '排版时连接断了', retryable: false },
      toolRunning: false,
    }))
    expect(renderer.root.findByProps({ className: 'agent-slides-failure' }).findByType('strong').children).toContain('排版时连接断了')
    expect(renderer.root.findAllByProps({ className: 'agent-slides-error-note' })).toHaveLength(0)
    expect(flattenText(renderer.toJSON())).toContain(`${KEY}SLIDES_RETRY_HINT`)
    // 没有伪造「再试一次」按钮。
    expect(renderer.root.findAll((node) => flattenText(node.props?.children) === `${KEY}SLIDES_RETRY`)).toHaveLength(0)
  })

  it('已停止/被中断：显示对应状态而不是永远生成中（含 tool.status=stopped 兜底）', () => {
    const stoppedRenderer = TestRenderer.create(cardFixture({
      state: { stage: 'planning', doneCount: 2, totalPages: 5 },
      toolRunning: false,
      runId: 'run-1',
      cancelledRunIds: new Set(['run-1']),
      toolStatus: 'stopped',
    }))
    expect(stoppedRenderer.root.findByProps({ className: 'agent-slides-card-phase' }).children)
      .toContain(`${KEY}SLIDES_STOPPED`)
    expect(stoppedRenderer.root.findByProps({ className: 'agent-slides-state-banner' })).toBeTruthy()

    const interruptedRenderer = TestRenderer.create(cardFixture({
      state: { stage: 'page_images', doneCount: 1, totalPages: 5 },
      toolRunning: false,
      runId: 'run-2',
      interruptedRunIds: new Set(['run-2']),
    }))
    expect(interruptedRenderer.root.findByProps({ className: 'agent-slides-card-phase' }).children)
      .toContain(`${KEY}SLIDES_INTERRUPTED`)
  })

  it('已完成旧卡紧凑回执：一行「已完成《标题》· 打开」，无 fileEntryId 时不显示打开', () => {
    const withFile = TestRenderer.create(cardFixture({
      state: { stage: 'page_applied', title: '旧 PPT', completed: true, fileEntryId: 'file-1' },
      toolRunning: false,
      compact: true,
    }))
    expect(flattenText(withFile.toJSON())).toContain(`${KEY}SLIDES_RECEIPT_DONE?title=旧 PPT`)
    expect(buttonWithText(withFile.root, `${KEY}SLIDES_RECEIPT_OPEN`)).toBeTruthy()

    const withoutFile = TestRenderer.create(cardFixture({
      state: { stage: 'page_applied', title: '旧 PPT', completed: true },
      toolRunning: false,
      compact: true,
    }))
    expect(withoutFile.root.findAllByType('button')).toHaveLength(0)
  })
})

describe('SlidesProgressCard 配图过目批量提交（P1-5/P2-5）', () => {
  it('九宫格显示「第 N 页 · 标题」，勾选不用/换一张后一次提交批量参数', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({ state: reviewState, toolRunning: false, onAction }))
    expect(renderer.root.findAllByProps({ className: 'agent-slides-image-cell' })).toHaveLength(3)
    expect(flattenText(renderer.root.findByProps({ className: 'agent-slides-images' })))
      .toContain(`${KEY}SLIDES_IMAGES_PAGE_LABEL?page=1&title=封面`)

    act(() => renderer.root.findByProps({
      'aria-label': `${KEY}SLIDES_IMAGES_DROP_LABEL?page=2&title=业绩`,
    }).props.onClick())
    act(() => renderer.root.findByProps({
      'aria-label': `${KEY}SLIDES_IMAGES_REPLACE_LABEL?page=3&title=计划`,
    }).props.onClick())

    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_IMAGES_APPLY?count=2`).props.onClick())
    expect(onAction).toHaveBeenCalledTimes(1)
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toBe(`${KEY}SLIDES_IMAGES_APPLY_PROMPT?documentId=doc-draft-1&rejects=, rejectPageImages=[2]&regenerates=, regeneratePageImages=[3]&restores=`)
    expect(display).toBe(`${KEY}SLIDES_IMAGES_APPLY_DISPLAY?count=2`)
  })

  it('「用这些图生成」= accept，一次回合提交', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({ state: reviewState, toolRunning: false, onAction }))
    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_IMAGES_ACCEPT`).props.onClick())
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toBe(`${KEY}SLIDES_IMAGES_ACCEPT_PROMPT?documentId=doc-draft-1`)
    expect(display).toBe(`${KEY}SLIDES_IMAGES_ACCEPT_DISPLAY`)
  })

  it('「全部不用，直接生成页面」必须二次确认，danger 文案说明配图会被丢弃', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({ state: reviewState, toolRunning: false, onAction }))
    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_IMAGES_ALL_DROP`).props.onClick())
    expect(renderer.root.findByProps({ className: 'agent-slides-danger-confirm' })).toBeTruthy()
    expect(flattenText(renderer.root.findByProps({ className: 'agent-slides-danger-confirm' })))
      .toContain(`${KEY}SLIDES_IMAGES_ALL_DROP_HINT`)
    expect(onAction).not.toHaveBeenCalled()

    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_IMAGES_ALL_DROP_CONFIRM`).props.onClick())
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toBe(`${KEY}SLIDES_IMAGES_SKIP_PROMPT?documentId=doc-draft-1`)
    expect(display).toBe(`${KEY}SLIDES_IMAGES_ALL_DROP_DISPLAY`)
  })
})

describe('SlidesProgressCard 风格大图选择器（P1-3）', () => {
  it('style_images_ready 自动打开大浮层：大图 + 「用这套 / 都不太合适，再换一批 / 关闭」', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({ state: styleState, toolRunning: false, onAction }))
    const overlay = renderer.root.findByProps({ className: 'agent-slides-style-overlay' })
    expect(overlay.findByProps({ role: 'dialog' })).toBeTruthy()
    expect(overlay.findByProps({ className: 'agent-slides-style-overlay-figure' }).findByType('img').props.src)
      .toBe('everroom-material://s0')
    // 大图下只给方向短名，不给 hex。
    expect(flattenText(overlay)).toContain('深色杂志')

    act(() => buttonWithText(overlay, `${KEY}SLIDES_STYLE_USE`).props.onClick())
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toBe(`${KEY}SLIDES_STYLE_PICK_PROMPT?index=1&sessionId=style-9`)
    expect(display).toBe(`${KEY}SLIDES_STYLE_PICK_DISPLAY?index=1`)
    // 选完浮层关闭，卡片也一起收起（选择即完成，不留常驻卡）。
    expect(renderer.root.findAllByProps({ className: 'agent-slides-style-overlay' })).toHaveLength(0)
    expect(renderer.root.findAll((node) => node.props?.className === 'agent-slides-card')).toHaveLength(0)
  })

  it('点第三张缩略图：大浮层显示第三张，「用这套」发 index=3（不能回落到第一张）', () => {
    const onAction = vi.fn()
    const threeCandidates = {
      ...styleState,
      styleCandidates: [
        { url: 'everroom-material://s0', label: '深色杂志', generation: 1 },
        { url: 'everroom-material://s1', label: '暖纸手作', generation: 1 },
        { url: 'everroom-material://s2', label: '冷静商务', generation: 1 },
      ],
    }
    const renderer = TestRenderer.create(cardFixture({ state: threeCandidates, toolRunning: false, onAction }))
    // 自动弹出的浮层先关掉，走「缩略图 → 大浮层」路径。
    const overlay0 = renderer.root.findByProps({ className: 'agent-slides-style-overlay' })
    act(() => overlay0.findByProps({ className: 'agent-slides-style-overlay-close' }).props.onClick())
    expect(renderer.root.findAllByProps({ className: 'agent-slides-style-overlay' })).toHaveLength(0)

    const thumbs = renderer.root.findAll((node) => typeof node.props?.className === 'string' && node.props.className.includes('agent-slides-style-thumb'))
    expect(thumbs).toHaveLength(3)
    act(() => thumbs[2]!.props.onClick())

    const overlay = renderer.root.findByProps({ className: 'agent-slides-style-overlay' })
    expect(overlay.findByProps({ className: 'agent-slides-style-overlay-figure' }).findByType('img').props.src)
      .toBe('everroom-material://s2')
    act(() => buttonWithText(overlay, `${KEY}SLIDES_STYLE_USE`).props.onClick())
    expect(onAction.mock.calls[0]![0]).toBe(`${KEY}SLIDES_STYLE_PICK_PROMPT?index=3&sessionId=style-9`)
  })

  it('「都换一批」带 regenerate=true 的 hiddenPrompt（含 documentId）', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({ state: styleState, toolRunning: false, onAction }))
    const overlay = renderer.root.findByProps({ className: 'agent-slides-style-overlay' })
    act(() => buttonWithText(overlay, `${KEY}SLIDES_STYLE_REGENERATE`).props.onClick())
    const [prompt, display] = onAction.mock.calls[0] as [string, string]
    expect(prompt).toBe(`${KEY}SLIDES_STYLE_REGENERATE_PROMPT?documentId=doc-draft-1`)
    expect(display).toBe(`${KEY}SLIDES_STYLE_REGENERATE_DISPLAY`)
  })

  it('documentId 缺失时「换一批」退化为纯人话指令', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({
      state: { ...styleState, documentId: undefined },
      toolRunning: false,
      onAction,
    }))
    const overlay = renderer.root.findByProps({ className: 'agent-slides-style-overlay' })
    act(() => buttonWithText(overlay, `${KEY}SLIDES_STYLE_REGENERATE`).props.onClick())
    expect(onAction.mock.calls[0]![0]).toBe(`${KEY}SLIDES_STYLE_REGENERATE_PROMPT_NO_DOC`)
  })

  it('style_card_ready：演示页大图优先，hex/pt 收进「配色与字号细节」，effectLines 作「这套风格意味着…」', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({
      state: {
        stage: 'style_card_ready',
        title: '季度汇报',
        styleSessionId: 'style-9',
        styleCard: {
          swatches: [{ hex: '#1e3a5f', label: '主色' }],
          typography: [{ label: '正文', value: '14pt' }],
          wireframes: [{ role: 'cover', label: '封面 P1a', svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }],
          demoImageUrl: 'everroom-material://dd',
          effectLines: ['主色低调、留白多'],
        },
      },
      toolRunning: false,
      onAction,
    }))
    expect(renderer.root.findByProps({ className: 'agent-slides-style-demo' }).props.src).toBe('everroom-material://dd')
    expect(flattenText(renderer.root.findByProps({ className: 'agent-slides-style-meaning' })))
      .toContain(`${KEY}SLIDES_STYLE_MEANING`)
    // 原始色值不裸露，折叠在细节里。
    const details = renderer.root.findByProps({ className: 'agent-slides-style-details-toggle' })
    expect(details.findAllByProps({ className: 'agent-slides-style-swatch' })).toHaveLength(1)
    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_STYLE_CONFIRM`).props.onClick())
    expect(onAction.mock.calls[0]![0]).toBe(`${KEY}SLIDES_STYLE_CONFIRM_PROMPT?sessionId=style-9`)
  })

  it('compact 失败回执：一行错误人话 + 「再试一次」，不再是整张大卡', () => {
    const onAction = vi.fn()
    const renderer = TestRenderer.create(cardFixture({
      state: {
        stage: 'failed',
        title: '季度汇报',
        errorCode: 'slides_layout_apply_failed',
        retryable: true,
        doneCount: 2,
        totalPages: 8,
      },
      toolRunning: false,
      compact: true,
      onAction,
    }))
    expect(renderer.root.findAll((node) => node.props?.className === 'agent-slides-card')).toHaveLength(0)
    const receipt = renderer.root.findByProps({ className: 'agent-slides-receipt' })
    expect(receipt.props['data-tone']).toBe('failed')
    expect(flattenText(receipt)).toContain(`${KEY}SLIDES_ERROR_LAYOUT_APPLY`)
    act(() => buttonWithText(renderer.root, `${KEY}SLIDES_RETRY`).props.onClick())
    expect(onAction.mock.calls[0]![0]).toContain(`${KEY}SLIDES_RETRY_PROMPT?`)
  })

  it('三层结构：head / body / actions 分层，长页列表在卡片内单独滚动', () => {
    // 卡片落在 360px 级气泡里：页列表必须自带滚动容器，不能靠卡片被撑高来容纳内容。
    const renderer = TestRenderer.create(<SlidesProgressCard state={draftState} toolRunning={false} />)
    expect(renderer.root.findAll((node) => node.props?.className === 'agent-slides-card-head')).toHaveLength(1)
    const body = renderer.root.findAll((node) => node.props?.className === 'agent-slides-card-body')
    expect(body).toHaveLength(1)
    // 页列表是卡内独立滚动层（CSS max-height + overflow:auto），多页不会把卡片拉长。
    expect(body[0]!.findAllByProps({ className: 'agent-slides-progress-pages' })).toHaveLength(1)
    // 操作区是卡片里紧随正文的独立一层，不在可滚区域内。
    const actions = renderer.root.findAll((node) => node.props?.className === 'agent-slides-actions')
    expect(actions).toHaveLength(1)
  })
})
