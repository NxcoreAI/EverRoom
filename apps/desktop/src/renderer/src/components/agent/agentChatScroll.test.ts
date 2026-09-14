import { describe, expect, it } from 'vitest'

import { AGENT_CHAT_PIN_THRESHOLD_PX, isScrolledToBottom } from './agentChatScroll'

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
})
