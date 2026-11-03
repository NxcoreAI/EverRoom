// @vitest-environment happy-dom
/**
 * 「今日洞察」卡片（最近页顶部）渲染回归：
 * 1) ready：headline / summary / bullets / 动作按钮都来自 `journal.today()`，点动作回调原样抛给页面；
 * 2) empty：当天没有条目时给「今天还没有新的动静。跟我聊几句，我边听边记。」，不是「暂无数据」；
 * 3) 无 preload 桥（`window.nxcore` 不存在）：显示 unavailable 态 + 重试，**不得垫任何 mock 文案**；
 * 4) failed：展示网关给的 lastError + 重试；
 * 5) refresh 失败：旧条目保留，只加一行弱化错误文案；
 * 6) 摘要打字机：首帧只出几个字，跑完即全文；`prefers-reduced-motion: reduce` 下直接全文；
 * 7) 刷新节奏：页面可见时 60s 轮询、focus 立即补拉；卸载后定时器与监听都清掉。
 *
 * 注：本仓库没有引入 @testing-library/react（package.json / pnpm-lock.yaml 里都没有），
 * 与其余 `tests/*.test.tsx` 一致用 `react-dom/client` + `act` + 原生 DOM 断言。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DailyJournalCard } from '../src/renderer/src/workbench/home/DailyJournalCard'
import type { JournalTodayDto } from '../src/shared/sources'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type JournalEntry = NonNullable<JournalTodayDto['entry']>

const HEADLINE = '把周报的骨架定下来'
const SUMMARY = '你今天上午和 Agent 理清了周报的三段结构，下午又把资料库里两份表格的要点合并了一版。'
const LAST_ERROR = '模型档位还没就绪，这次整理没跑通。'

let container: HTMLDivElement
let root: Root | null = null
const realMatchMedia = window.matchMedia

/** 最近页当天日记的 ready 快照（用例按需覆盖单个字段）。 */
function todayDto(over: Partial<JournalTodayDto> = {}): JournalTodayDto {
  const entry: JournalEntry = {
    id: 'journal-1',
    date: '2026-11-03',
    version: 1,
    headline: HEADLINE,
    summary: SUMMARY,
    bullets: [
      { text: '早上敲定了周报的三段结构', sourceIds: ['memory:1'] },
      { text: '下午把两份表格的要点合并成一版', sourceIds: ['memory:2', 'memory:7'] },
    ],
    actions: [
      { label: '打开周报草稿', kind: 'open-file', targetId: 'file:file-1' },
      { label: '接着聊周报', kind: 'ask-agent', targetId: 'memory:1' },
    ],
    model: 'deepseek-chat',
    createdAt: '2026-11-03T09:12:00.000Z',
  }
  return { date: '2026-11-03', entry, status: 'ready', signalCount: 7, lastError: null, ...over }
}

/** 桥：两个 IPC 都返回固定快照；调用次数由用例断言。 */
function stubBridge(dto: JournalTodayDto): { today: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> } {
  const bridge = {
    today: vi.fn(async () => dto),
    refresh: vi.fn(async () => dto),
  }
  vi.stubGlobal('nxcore', { journal: bridge })
  return bridge
}

/** 减少动效偏好：读它的是 `prefers-reduced-motion: reduce` 这条 query。 */
function stubReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

async function render(props: React.ComponentProps<typeof DailyJournalCard> = {}): Promise<void> {
  await act(async () => { root?.render(<DailyJournalCard {...props} />) })
}

function text(selector: string): string {
  return container.querySelector(selector)?.textContent ?? ''
}

function buttons(selector: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>(selector)]
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click() })
}

beforeEach(() => {
  // 默认按「已开启减少动效」跑：摘要直接全文，断言不用等打字机。
  stubReducedMotion(true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) {
    const mounted = root
    root = null
    await act(async () => { mounted.unmount() })
  }
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  window.matchMedia = realMatchMedia
})

describe('DailyJournalCard', () => {
  it('ready：渲染 headline / summary / 要点 / 副标题，动作点击抛给页面', async () => {
    const onAction = vi.fn()
    const bridge = stubBridge(todayDto())

    await render({ onAction })

    expect(text('.wb-journal-name')).toBe('今日洞察')
    expect(text('.wb-journal-sub')).toContain('基于 7 条记忆')
    expect(text('.wb-journal-headline')).toBe(HEADLINE)
    // 减少动效偏好下不做打字机：首帧就是全文。
    expect(text('.wb-journal-body')).toBe(SUMMARY)
    expect(container.querySelector('.wb-journal-caret')).toBeNull()

    const bullets = [...container.querySelectorAll('.wb-journal-bullets li')]
    expect(bullets.map((item) => item.textContent)).toEqual([
      '早上敲定了周报的三段结构',
      '下午把两份表格的要点合并成一版',
    ])
    // 每条的 title 放它自己的全文（来源可追溯留待以后，不解析 sourceIds）。
    expect(bullets[0]?.getAttribute('title')).toBe('早上敲定了周报的三段结构')

    const actions = buttons('.wb-journal-act')
    expect(actions.map((item) => item.textContent)).toEqual(['打开周报草稿', '接着聊周报'])
    await click(actions[1] as HTMLButtonElement)
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith({ label: '接着聊周报', kind: 'ask-agent', targetId: 'memory:1' })

    expect(text('.wb-journal-sign')).toBe('—— 小 E · 你的工作台助理')
    expect(bridge.today).toHaveBeenCalledTimes(1)
    expect(text('.wb-journal-hint')).toBe('')
  })

  it('empty：当天没有条目时给「还没有新的动静」，不是「暂无数据」', async () => {
    stubBridge(todayDto({ entry: null, status: 'pending', signalCount: 0 }))

    await render()

    expect(text('.wb-journal-empty')).toBe('今天还没有新的动静。跟我聊几句，我边听边记。')
    expect(container.querySelector('.wb-journal-headline')).toBeNull()
    expect(buttons('.wb-journal-act')).toHaveLength(0)
    expect(text('.wb-journal-sub')).toContain('基于 0 条记忆')
    // 动作行没内容时只剩署名。
    expect(text('.wb-journal-foot')).toBe('—— 小 E · 你的工作台助理')
  })

  it('无 bridge（浏览器预览/单测）：unavailable 态 + 重试，不造 mock 数据', async () => {
    vi.stubGlobal('nxcore', undefined)

    await render()

    expect(text('.wb-journal-state')).toContain('今日洞察暂时读不到（桌面服务未就绪）。')
    expect(container.querySelector('.wb-journal-headline')).toBeNull()
    expect(container.querySelector('.wb-journal-body')).toBeNull()
    // 不可用态不提条数（数字只能来自真实快照）。
    expect(text('.wb-journal-sub')).not.toContain('条记忆')

    // 桥恢复后点「重试」能读到内容。
    const bridge = stubBridge(todayDto())
    await click(buttons('.wb-journal-state .ui-btn')[0] as HTMLButtonElement)
    expect(bridge.today).toHaveBeenCalledTimes(1)
    expect(text('.wb-journal-headline')).toBe(HEADLINE)
    expect(container.querySelector('.wb-journal-state')).toBeNull()
  })

  it('failed：展示网关的 lastError + 重试', async () => {
    stubBridge(todayDto({ entry: null, status: 'failed', signalCount: 3, lastError: LAST_ERROR }))

    await render()

    expect(text('.wb-journal-state')).toContain(LAST_ERROR)
    expect(buttons('.wb-journal-state .ui-btn')).toHaveLength(1)
    expect(container.querySelector('.wb-journal-headline')).toBeNull()
  })

  it('refresh 失败：旧条目保留，只加一行弱化错误文案', async () => {
    const bridge = stubBridge(todayDto())
    bridge.refresh.mockRejectedValueOnce(new Error('gateway boom'))

    await render()
    await click(container.querySelector<HTMLButtonElement>('.wb-journal-refresh') as HTMLButtonElement)

    expect(bridge.refresh).toHaveBeenCalledTimes(1)
    expect(text('.wb-journal-headline')).toBe(HEADLINE)
    expect(text('.wb-journal-hint')).toBe('重写没成功，稍后可以再试一次。')
    // 失败后按钮回到可点状态（不是一直「整理中」）。
    expect(buttons('.wb-journal-refresh')[0]?.disabled).toBe(false)
  })

  it('摘要逐字出现，跑完即全文（打字机）', async () => {
    stubReducedMotion(false)
    vi.useFakeTimers()
    stubBridge(todayDto())

    await render()

    expect(text('.wb-journal-body')).not.toBe(SUMMARY)
    expect(container.querySelector('.wb-journal-caret')).not.toBeNull()

    await act(async () => { vi.advanceTimersByTime(5_000) })

    expect(text('.wb-journal-body')).toBe(SUMMARY)
    expect(container.querySelector('.wb-journal-caret')).toBeNull()
  })

  it('可见时 60s 轮询 + focus 立即补拉；卸载后定时器与监听都清掉', async () => {
    vi.useFakeTimers()
    const bridge = stubBridge(todayDto())

    await render()
    expect(bridge.today).toHaveBeenCalledTimes(1)

    // 60s 轮询（document.visibilityState === 'visible'）：再拉一次。
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(bridge.today).toHaveBeenCalledTimes(2)

    // 窗口重新聚焦：立即补拉，不等下一个 60s。
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(bridge.today).toHaveBeenCalledTimes(3)

    const mounted = root
    root = null
    await act(async () => { mounted?.unmount() })

    await act(async () => { vi.advanceTimersByTime(180_000) })
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(bridge.today).toHaveBeenCalledTimes(3)
  })
})
