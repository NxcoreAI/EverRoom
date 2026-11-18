import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContentsView } from 'electron'

import { OfficeViewFirstFrameGate } from '../src/main/office/office-view-first-frame'

class FakeContents extends EventEmitter {
  destroyed = false
  id = 7
  isDestroyed(): boolean {
    return this.destroyed
  }
}

class FakeView {
  readonly contents = new FakeContents()
  readonly setBounds = vi.fn()
  readonly setVisible = vi.fn()
  get webContents(): FakeContents {
    return this.contents
  }
}

class FakeWindow extends EventEmitter {
  destroyed = false
  focused = true
  isDestroyed(): boolean {
    return this.destroyed
  }
  isFocused(): boolean {
    return this.focused
  }
  isVisible(): boolean {
    return true
  }
}

const BOUNDS = { x: 220, y: 48, width: 940, height: 852 }

function makeGate(): {
  gate: OfficeViewFirstFrameGate
  view: FakeView
  window: FakeWindow
} {
  const view = new FakeView()
  const window = new FakeWindow()
  const gate = new OfficeViewFirstFrameGate(
    view as unknown as WebContentsView,
    window as unknown as BrowserWindow,
  )
  return { gate, view, window }
}

describe('OfficeViewFirstFrameGate：首帧前不显示空视图', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('激活 + 有边界但页面尚未 dom-ready：保持隐藏', () => {
    const { gate, view } = makeGate()
    gate.setBounds(BOUNDS)
    gate.setActive(true)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('dom-ready 后显示，并做一次 1px 几何校准再还原', () => {
    vi.useFakeTimers()
    const { gate, view } = makeGate()
    gate.setBounds(BOUNDS)
    gate.setActive(true)

    view.contents.emit('dom-ready')
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
    expect(view.setBounds).toHaveBeenLastCalledWith({ ...BOUNDS, width: BOUNDS.width - 1 })

    vi.advanceTimersByTime(40)
    expect(view.setBounds).toHaveBeenLastCalledWith(BOUNDS)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('未激活的实例即便页面就绪也不显示', () => {
    const { gate, view } = makeGate()
    gate.setBounds(BOUNDS)
    gate.setActive(false)
    view.contents.emit('dom-ready')
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('页面迟迟不来 dom-ready：4s 兜底后仍会显示（不至于永远隐藏）', () => {
    vi.useFakeTimers()
    const { gate, view } = makeGate()
    gate.setBounds(BOUNDS)
    gate.setActive(true)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)

    vi.advanceTimersByTime(4_050)
    expect(view.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('首次显示后窗口才获得焦点：focus 时补一次显隐与几何', () => {
    const { gate, view, window } = makeGate()
    gate.setBounds(BOUNDS)
    gate.setActive(true)
    view.contents.emit('dom-ready')
    view.setVisible.mockClear()
    view.setBounds.mockClear()

    window.emit('focus')
    expect(view.setVisible).toHaveBeenCalledWith(true)
    expect(view.setBounds).toHaveBeenCalledWith(BOUNDS)
  })

  it('dispose 后不再响应事件、也不再动视图', () => {
    const { gate, view, window } = makeGate()
    gate.setBounds(BOUNDS)
    gate.setActive(true)
    gate.dispose()
    view.setVisible.mockClear()
    view.contents.emit('dom-ready')
    window.emit('focus')
    expect(view.setVisible).not.toHaveBeenCalled()
    expect(window.listenerCount('focus')).toBe(0)
  })
})
