// @vitest-environment happy-dom
/**
 * 充值面板(TopupPanel)回归:
 * 1) 未配置 aiRelay(后端未接 new-api)时不渲染——充值入口跟随额度条;
 * 2) 档位加载后可选,下单走 billing.topup;mock 渠道自动提交模拟批准;
 * 3) pending 轮询到 completed 后展示到账文案。
 * 只 mock preload 桥 window.nxcore,真实渲染 SettingsPage 内的 TopupPanel。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '../src/renderer/src/i18n/i18next'
import { TopupPanel } from '../src/renderer/src/components/pages/SettingsPage'

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
    ]),
    topup: vi.fn().mockResolvedValue({ orderId: 'order-1', approvalUrl: 'mock://checkout/order-1', provider: 'mock' }),
    topupStatus: vi.fn().mockResolvedValue({ status: 'completed' as const, amountCents: 1000 }),
    topupMockApprove: vi.fn().mockResolvedValue({ status: 'completed' as const, amountCents: 1000 }),
    ...overrides,
  }
  ;(window as unknown as { nxcore: unknown }).nxcore = { billing }
  return { billing }
}

describe('TopupPanel', () => {
  let container: HTMLElement | null = null
  let root: Root | null = null

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    act(() => { root?.unmount() })
    container?.remove()
    ;(window as unknown as { nxcore: unknown }).nxcore = undefined
  })

  function mount(props: { aiRelayConfigured: boolean; onSettled?: () => void }) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => { root!.render(<TopupPanel {...props} />) })
  }

  it('renders nothing when aiRelay is not configured', async () => {
    installBridge()
    mount({ aiRelayConfigured: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(container?.textContent).toBe('')
  })

  it('loads packs, starts a mock topup and settles to completed via polling', async () => {
    const bridge = installBridge()
    const onSettled = vi.fn()
    mount({ aiRelayConfigured: true, onSettled })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const select = container?.querySelector('.topup-pack-select') as HTMLSelectElement | null
    expect(select).toBeTruthy()
    expect(select?.options.length).toBe(2)
    const buy = container?.querySelector('.topup-buy-button') as HTMLButtonElement | null
    act(() => { buy?.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(bridge.billing.topup).toHaveBeenCalledWith('pack_10')
    expect(bridge.billing.topupMockApprove).toHaveBeenCalledWith('order-1')
    // 轮询 2s 后 completed 文案出现
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(bridge.billing.topupStatus).toHaveBeenCalledWith('order-1')
    expect(container?.textContent).toContain(i18n.t('surface:settings.topupCompleted'))
  })

  it('keeps polling pending without failing on transient errors', async () => {
    const bridge = installBridge({
      topupStatus: vi.fn()
        .mockResolvedValueOnce({ status: 'pending' as const, amountCents: 1000 })
        .mockResolvedValueOnce({ status: 'pending' as const, amountCents: 1000 })
        .mockResolvedValue({ status: 'failed' as const, amountCents: 1000 }),
    })
    mount({ aiRelayConfigured: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const buy = container?.querySelector('.topup-buy-button') as HTMLButtonElement | null
    act(() => { buy?.click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { await vi.advanceTimersByTimeAsync(6500) })
    expect(bridge.billing.topupStatus.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(container?.textContent).toContain(i18n.t('surface:settings.topupFailed'))
  })
})
