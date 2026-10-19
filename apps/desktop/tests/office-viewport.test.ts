/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  attachOfficeViewport,
  type OfficeViewportAttachment,
} from '../src/renderer/src/components/context-room/ported/officeViewport'

const REAL_RECT = { x: 10, y: 20, width: 300, height: 200, top: 20, right: 310, bottom: 220, left: 10 }
const ZERO_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 }

function installBridge(): { setWorkspaceBounds: ReturnType<typeof vi.fn> } {
  const setWorkspaceBounds = vi.fn()
  ;(window as unknown as { nxcore: unknown }).nxcore = {
    office: { setWorkspaceBounds },
  }
  return { setWorkspaceBounds }
}

function installHost(rect: typeof REAL_RECT): { host: HTMLDivElement; overlay: HTMLDivElement; setTopElement: (el: HTMLElement) => void } {
  const host = document.createElement('div')
  const overlay = document.createElement('div')
  document.body.append(host, overlay)
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
  let topElement: HTMLElement = host
  ;(document as unknown as { elementsFromPoint: (x: number, y: number) => Element[] }).elementsFromPoint =
    (x: number, y: number) => [topElement]
  return { host, overlay, setTopElement: (el) => { topElement = el } }
}

function dispatchPointerDown(): void {
  window.dispatchEvent(new Event('pointerdown'))
}

describe('officeViewport：原生视图显隐时序', () => {
  let attachment: OfficeViewportAttachment | null = null

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    })
  })

  afterEach(() => {
    attachment?.detach()
    attachment = null
    document.body.replaceChildren()
    delete (window as unknown as { nxcore?: unknown }).nxcore
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('挂载双帧确认后上报真实矩形', async () => {
    const { setWorkspaceBounds } = installBridge()
    const { host } = installHost(REAL_RECT)

    attachment = attachOfficeViewport(host)
    // 未过双帧前不上报（主进程视图初始即隐藏，不会闪现）。
    expect(setWorkspaceBounds).not.toHaveBeenCalled()

    await vi.waitFor(() => {
      expect(setWorkspaceBounds).toHaveBeenCalledWith(
        expect.objectContaining({ x: 10, y: 20, width: 300, height: 200 }),
      )
    })
  })

  it('弹层盖住多数采样点 → 发零尺寸隐藏；撤掉后恢复真实矩形', async () => {
    const { setWorkspaceBounds } = installBridge()
    const { host, overlay, setTopElement } = installHost(REAL_RECT)

    attachment = attachOfficeViewport(host)
    await vi.waitFor(() => {
      expect(setWorkspaceBounds).toHaveBeenCalledWith(
        expect.objectContaining({ width: 300, height: 200 }),
      )
    })

    setTopElement(overlay)
    dispatchPointerDown()
    expect(setWorkspaceBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 0, height: 0 }),
    )

    setTopElement(host)
    dispatchPointerDown()
    await vi.waitFor(() => {
      expect(setWorkspaceBounds).toHaveBeenLastCalledWith(
        expect.objectContaining({ x: 10, y: 20, width: 300, height: 200 }),
      )
    })
  })

  it('宿主矩形归零（面板收起）→ resize 重报零尺寸隐藏', () => {
    const { setWorkspaceBounds } = installBridge()
    const { host } = installHost(REAL_RECT)

    attachment = attachOfficeViewport(host)
    window.dispatchEvent(new Event('resize'))
    expect(setWorkspaceBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 300, height: 200 }),
    )

    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue(ZERO_RECT as DOMRect)
    window.dispatchEvent(new Event('resize'))
    expect(setWorkspaceBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 0, height: 0 }),
    )
  })

  it('detach 立即发零尺寸：页签切换当帧隐藏', () => {
    const { setWorkspaceBounds } = installBridge()
    const { host } = installHost(REAL_RECT)

    const local = attachOfficeViewport(host)
    local.detach()
    expect(setWorkspaceBounds).toHaveBeenCalledWith(
      expect.objectContaining({ width: 0, height: 0 }),
    )
    // detach 后不再受后续事件影响。
    setWorkspaceBounds.mockClear()
    window.dispatchEvent(new Event('resize'))
    dispatchPointerDown()
    expect(setWorkspaceBounds).not.toHaveBeenCalled()
  })
})
