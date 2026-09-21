import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({ refreshFromBackend: vi.fn().mockResolvedValue(undefined) }),
}))

import type { RoomOverviewProjection } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'
import { OverviewDashboard } from '../src/renderer/src/components/context-room/ported/components/detail-panels/OverviewDashboard'

function projectionFixture(): RoomOverviewProjection {
  return {
    roomId: 'room-fail',
    revision: 1,
    generatedAt: '2026-09-21T08:00:00.000Z',
    stale: false,
    overview: [],
    status: [],
    entities: [],
    appliedCorrectionIds: [],
    timeline: [],
    nextSteps: [],
  }
}

function findLoadError(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find((node) => node.props?.['data-testid'] === 'context-room-overview-load-error')
}

function findRetryButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find((node) => node.props?.['data-testid'] === 'context-room-overview-retry')
}

async function renderDashboard(overview: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', {
    ...globalThis,
    nxcore: { contextRooms: { overview } },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  let renderer: TestRenderer.ReactTestRenderer | null = null
  await act(async () => {
    renderer = TestRenderer.create(
      <OverviewDashboard
        room={createContextRoomFixture('room-fail', '加载失败 Room')}
        backendDocuments={[]}
        knowledgeFiles={[]}
        onSelectResource={() => {}}
        onOpenObject={() => {}}
        onToggleTask={() => {}}
      />,
    )
  })
  return renderer!
}

describe('概览面板：打开 Room 拉取失败的原因展示与重试（#259）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('拉取失败时面板内展示失败原因与重试入口，不再静默降级', async () => {
    const overview = vi.fn().mockRejectedValue(new Error('Context Room overview failed to build; please retry'))
    const renderer = await renderDashboard(overview)
    const banner = findLoadError(renderer)
    expect(String(banner.props.role)).toBe('alert')
    const texts = banner.findAll((node) => typeof node.props?.children === 'string').map((node) => String(node.props.children).trim())
    expect(texts.join(' ')).toContain('概览加载失败')
    expect(texts.join(' ')).toContain('Context Room overview failed to build; please retry')
    // 重试按钮存在且文案为「重试」
    const retryLabels = findRetryButton(renderer).findAll((node) => typeof node.props?.children === 'string')
      .map((node) => String(node.props.children))
    expect(retryLabels.join('')).toBe('重试')
  })

  it('点击重试重新拉取：成功后错误条消失、投影数据上屏', async () => {
    // 挂载阶段可能触发多次拉取（React 批处理行为），因此用开关控制成败，
    // 并对调用次数做相对断言（重试恰好多拉一次），不依赖绝对次数。
    let healthy = false
    const overview = vi.fn(async () => {
      if (!healthy) throw new Error('Context Room overview failed to build; please retry')
      return projectionFixture()
    })
    const renderer = await renderDashboard(overview)
    expect(findLoadError(renderer)).toBeTruthy()
    const callsBeforeRetry = overview.mock.calls.length
    healthy = true
    await act(async () => { findRetryButton(renderer).props.onClick() })
    expect(overview.mock.calls.length).toBe(callsBeforeRetry + 1)
    expect(renderer.root.findAll((node) => node.props?.['data-testid'] === 'context-room-overview-load-error')).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-pane-overview' })).toBeTruthy()
  })

  it('重试仍失败：错误条保留，不崩渲染', async () => {
    const overview = vi.fn(async () => {
      throw new Error('An internal gateway error occurred')
    })
    const renderer = await renderDashboard(overview)
    const callsBeforeRetry = overview.mock.calls.length
    await act(async () => { findRetryButton(renderer).props.onClick() })
    expect(overview.mock.calls.length).toBe(callsBeforeRetry + 1)
    expect(findLoadError(renderer)).toBeTruthy()
    // 失败原因随重试更新为最新一次的错误信息
    const texts = findLoadError(renderer).findAll((node) => typeof node.props?.children === 'string')
      .map((node) => String(node.props.children).trim())
    expect(texts.join(' ')).toContain('An internal gateway error occurred')
  })

  it('投影缺段（旧版本落库行）不崩渲染：缺段按空数组归一化', async () => {
    // 合并完成/旧版本落库窗口投影可能缺 overview/status 等段（#154 同族），
    // 此前裸 .status.map/.overview.find 会抛 TypeError 白屏。
    const partial = projectionFixture() as unknown as Record<string, unknown>
    delete partial.status
    delete partial.overview
    const overview = vi.fn().mockResolvedValue(partial as unknown as RoomOverviewProjection)
    const renderer = await renderDashboard(overview)
    expect(renderer.root.findAll((node) => node.props?.['data-testid'] === 'context-room-overview-load-error')).toHaveLength(0)
    // 面板主体仍在（Room overview 卡片正常渲染）
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-pane-overview' })).toBeTruthy()
  })
})
