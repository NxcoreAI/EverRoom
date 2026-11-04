// @vitest-environment happy-dom
/**
 * 充值弹窗(TopupModal)回归:
 * 1) 打开时拉档位并过滤 productKind==='credits',渲染「X 积分 · $Y」卡片;
 * 2) 点卡片下单走 billing.topup;mock 渠道自动提交模拟批准;
 * 3) pending 轮询到 completed 后展示到账文案并回调 onSettled;
 * 4) 暂时性轮询错误不致失败,pending→failed 有失败文案。
 * 只 mock preload 桥 window.nxcore,真实渲染 TopupModal。
 * Radix Dialog.Portal 挂到 document.body,断言一律查 body 而非挂载容器。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../src/renderer/src/i18n/i18next'
import { TopupModal } from '../src/renderer/src/workbench/shell/TopupModal'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface PanelBridge {
  billing: {
    packs: ReturnType<typeof vi.fn>
    topup: ReturnType<typeof vi.fn>
    topupStatus: ReturnType<typeof vi.fn>
    topupMockApprove: ReturnType<typeof vi.fn>
  }
}

function installBridge(overrides: Partial<Record<keyof PanelBridge['billing'], ReturnType<typeof vi.fn>>> = {}): PanelBridge {
  const billing = {
    packs: vi.fn().mockResolvedValue([
      { id: 'p1', code: 'pack_10', name: 'Credits $10', amountCents: 1000, grantQuota: 5000000, active: true },
      { id: 'p2', code: 'pack_20', name: 'Credits $20', amountCents: 2000, grantQuota: 10000000, active: true },
      { id: 'p3', code: 'pro_month', name: 'Pro', amountCents: 2000, grantQuota: 0, active: true, productKind: 'pro_month' },
    ]),
    topup: vi.fn().mockResolvedValue({ orderId: 'order-1', approvalUrl: 'mock://checkout/order-1', provider: 'mock' }),
    topupStatus: vi.fn().mockResolvedValue({ status: 'completed' as const, amountCents: 1000 }),
    topupMockApprove: vi.fn().mockResolvedValue({ status: 'completed' as const, amountCents: 1000 }),
    ...overrides,
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = { billing }
  return { billing }
}

describe('TopupModal', () => {
  let container: HTMLElement | null = null
  let root: Root | null = null

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    act(() => { root?.unmount() })
    container?.remove()
    document.body.innerHTML = ''
    ;(window as unknown as { nxcore: unknown }).nxcore = undefined
  })

  function mount(props: { onSettled?: () => void } = {}) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root!.render(<TopupModal open onOpenChange={() => undefined} {...props} />) })
  }

  function packCards(): HTMLElement[] {
    return Array.from(document.body.querySelectorAll('.plan-card'))
  }

  it('loads credit packs only and renders credits/price cards', async () => {
    installBridge()
    mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const cards = packCards()
    // pro_month 被过滤,只剩两个积分档位
    expect(cards.length).toBe(2)
    // 1 积分 = $0.1:$10 → 100 积分
    expect(cards[0].textContent).toContain('100')
    expect(cards[0].textContent).toContain('$10')
    expect(cards[1].textContent).toContain('200')
    expect(cards[1].textContent).toContain('$20')
  })

  it('starts a mock topup from a card and settles to completed via polling', async () => {
    const bridge = installBridge()
    const onSettled = vi.fn()
    mount({ onSettled })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const cards = packCards()
    const secondCta = cards[1].querySelector('.plan-card-cta') as HTMLButtonElement | null
    expect(secondCta).toBeTruthy()
    act(() => { secondCta?.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(bridge.billing.topup).toHaveBeenCalledWith('pack_20')
    expect(bridge.billing.topupMockApprove).toHaveBeenCalledWith('order-1')
    // 轮询 2s 后 completed 文案出现,onSettled 触发外层刷新
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(bridge.billing.topupStatus).toHaveBeenCalledWith('order-1')
    expect(document.body.textContent).toContain(i18n.t('surface:settings.topupCompleted'))
    expect(onSettled).toHaveBeenCalled()
  })

  it('keeps polling pending without failing on transient errors', async () => {
    const bridge = installBridge({
      topupStatus: vi.fn()
        .mockResolvedValueOnce({ status: 'pending' as const, amountCents: 1000 })
        .mockResolvedValueOnce({ status: 'pending' as const, amountCents: 1000 })
        .mockResolvedValue({ status: 'failed' as const, amountCents: 1000 }),
    })
    mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const cta = packCards()[0].querySelector('.plan-card-cta') as HTMLButtonElement | null
    act(() => { cta?.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6500) })
    expect(bridge.billing.topupStatus.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(document.body.textContent).toContain(i18n.t('surface:settings.topupFailed'))
  })

  it('shows load-failure message when packs request rejects', async () => {
    installBridge({ packs: vi.fn().mockRejectedValue(new Error('offline')) })
    mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(packCards().length).toBe(0)
    expect(document.body.textContent).toContain(i18n.t('surface:settings.topupLoadFailed'))
  })
})
