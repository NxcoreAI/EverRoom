import { describe, expect, it } from 'vitest'

import {
  AGENT_CHAT_PIN_THRESHOLD_PX,
  AGENT_CHAT_REPIN_DISTANCE_PX,
  AGENT_CHAT_WHEEL_UP_DETACH_PX,
  canConsumeVerticalWheel,
  isGeometryClampScroll,
  isNestedScrollerWheel,
  isScrolledToBottom,
  wheelDownChaseBand,
} from './agentChatScroll'

function element(geometry: { scrollHeight: number; scrollTop: number; clientHeight: number }): HTMLElement {
  return geometry as HTMLElement
}

describe('agent chat scroll pinning', () => {
  it('treats a position within the threshold as pinned to the bottom', () => {
    const total = 1_000
    const view = 400
    expect(isScrolledToBottom(element({ scrollHeight: total, scrollTop: total - view, clientHeight: view }))).toBe(true)
    expect(isScrolledToBottom(element({
      scrollHeight: total,
      scrollTop: total - view - AGENT_CHAT_PIN_THRESHOLD_PX,
      clientHeight: view,
    }))).toBe(true)
  })

  it('treats positions beyond the threshold as scrolled away', () => {
    const total = 1_000
    const view = 400
    expect(isScrolledToBottom(element({
      scrollHeight: total,
      scrollTop: total - view - AGENT_CHAT_PIN_THRESHOLD_PX - 1,
      clientHeight: view,
    }))).toBe(false)
    expect(isScrolledToBottom(element({ scrollHeight: total, scrollTop: 0, clientHeight: view }))).toBe(false)
  })

  it('keeps gesture repin aligned with the visible-bottom pin threshold', () => {
    // 尾部预留 padding（输入框高度 + 34px ≥ 166px）比旧的 160px 还高：宽阈值会把
    // 空白/被输入框遮住的区域也当成「底部附近」，靠近底部的任何下滚都瞬间贴底。
    expect(AGENT_CHAT_REPIN_DISTANCE_PX).toBe(AGENT_CHAT_PIN_THRESHOLD_PX)
  })
})

describe('browser geometry clamp vs user gesture', () => {
  const base = {
    lastScrollTop: 600,
    scrollTop: 560,
    lastScrollHeight: 1_000,
    scrollHeight: 960,
    lastClientHeight: 400,
    clientHeight: 400,
  }

  it('treats a scrollTop drop that matches the shrink as a clamp, not a gesture', () => {
    // 输入框变矮 → 尾部 padding 收缩 40px → 浏览器把 scrollTop 夹回新的最大值。
    expect(isGeometryClampScroll(base)).toBe(true)
  })

  it('treats viewport growth as a clamp as well', () => {
    expect(isGeometryClampScroll({
      ...base,
      lastScrollHeight: 1_000,
      scrollHeight: 1_000,
      lastClientHeight: 400,
      clientHeight: 440,
    })).toBe(true)
  })

  it('still treats a scrollTop drop beyond the shrink as a user gesture', () => {
    expect(isGeometryClampScroll({ ...base, scrollTop: 500 })).toBe(false)
  })

  it('never classifies sub-pixel or geometry-neutral movement as a clamp', () => {
    expect(isGeometryClampScroll({ ...base, scrollTop: 599.5 })).toBe(false)
    expect(isGeometryClampScroll({
      ...base,
      scrollHeight: 1_000,
      scrollTop: 560,
    })).toBe(false)
  })

  it('recognises a clamp by "still at the new bottom" even without a matching shrink', () => {
    // 输入框 padding 收缩 40px 后，浏览器把 scrollTop 收到新最大值：距新底部为 0。
    expect(isGeometryClampScroll({
      ...base,
      lastScrollHeight: 1_000,
      scrollHeight: 960,
      scrollTop: 560,
    })).toBe(true)
    // 对照：真实上滑会留下可见距离。
    expect(isGeometryClampScroll({
      ...base,
      lastScrollHeight: 1_000,
      scrollHeight: 960,
      scrollTop: 500,
    })).toBe(false)
  })
})

describe('nested scroller wheel guard', () => {
  it('ignores non-element targets and zero deltas', () => {
    const boundary = {} as HTMLElement
    expect(isNestedScrollerWheel(null, boundary, -120)).toBe(false)
    expect(isNestedScrollerWheel(null, boundary, 0)).toBe(false)
  })

  it('only consumes a delta when the inner scroller can still move in that direction', () => {
    const scrollable = { overflowY: 'auto', scrollHeight: 1_000, clientHeight: 200, scrollTop: 300 }
    expect(canConsumeVerticalWheel(scrollable, -120)).toBe(true)
    expect(canConsumeVerticalWheel(scrollable, 120)).toBe(true)

    // 内层到顶/到底：这段位移会链式传给外层，守卫必须放行（返回 false）。
    expect(canConsumeVerticalWheel({ ...scrollable, scrollTop: 0 }, -120)).toBe(false)
    expect(canConsumeVerticalWheel({ ...scrollable, scrollTop: 800 }, 120)).toBe(false)

    // 不可滚动 / overflow 不是 auto|scroll 的元素不吃手势。
    expect(canConsumeVerticalWheel({ ...scrollable, overflowY: 'hidden' }, -120)).toBe(false)
    expect(canConsumeVerticalWheel({ ...scrollable, scrollHeight: 200 }, -120)).toBe(false)
  })

  it('needs a couple of sub-pixel wheel steps before detaching', () => {
    // 触控板慢扫 −0.5px/发：单发低于阈值，累计到 2px 才解除。
    expect(AGENT_CHAT_WHEEL_UP_DETACH_PX).toBeGreaterThan(1)
  })
})

describe('wheelDownChaseBand（流式爆发时的下滚追赶带）', () => {
  it('轻滚不放宽（保持 32px），随位移比例放款，上限 400px', () => {
    expect(wheelDownChaseBand(0.5)).toBe(32)
    expect(wheelDownChaseBand(10)).toBe(32)
    expect(wheelDownChaseBand(40)).toBe(120)
    expect(wheelDownChaseBand(120)).toBe(360)
    expect(wheelDownChaseBand(500)).toBe(400)
    expect(wheelDownChaseBand(-120)).toBe(360)
  })
})
