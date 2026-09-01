/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'

import {
  buildDocumentCursorCompletionGhost,
  DOCUMENT_CURSOR_COMPLETION_ACCEPT_EVENT,
  DOCUMENT_CURSOR_COMPLETION_DISMISS_EVENT,
  DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT,
} from '../src/renderer/src/components/context-room/ported/components/detail-editor/DocumentCursorCompletion'

function menuItems(ghost: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    ghost.querySelectorAll('.context-room-document-cursor-completion-menu-item'),
  ) as HTMLButtonElement[]
}

function itemKeyHint(item: HTMLButtonElement): string | null {
  const hint = item.querySelector('.context-room-document-cursor-completion-menu-item-key')
  return hint === null ? null : hint.textContent
}

describe('document cursor completion ghost builder', () => {
  it('renders the suggestion text with a collapsed options menu behind the lightbulb', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 12,
      text: '第一句。第二句。',
      retryLabel: '重写',
      acceptLabel: '接受',
      dismissLabel: '拒绝',
      mode: 'paragraph',
    })

    expect(ghost.className).toBe('context-room-document-cursor-completion')
    expect(ghost.getAttribute('aria-hidden')).toBe('true')
    expect(ghost.getAttribute('contenteditable')).toBe('false')
    expect(ghost.getAttribute('role')).toBe('presentation')
    // 灯泡是图标按钮，不出现在建议文本里（Tab 接受时不会写进文档）。
    expect(ghost.firstChild?.textContent).toBe('第一句。第二句。')

    const bulb = ghost.querySelector('.context-room-document-cursor-completion-bulb')
    expect(bulb).not.toBeNull()
    expect(bulb?.getAttribute('role')).toBe('button')
    expect(bulb?.getAttribute('aria-haspopup')).toBe('menu')
    expect(bulb?.getAttribute('aria-expanded')).toBe('false')
    expect(bulb?.querySelector('svg[aria-hidden="true"]')).not.toBeNull()

    const menu = ghost.querySelector('.context-room-document-cursor-completion-menu')
    expect(menu).not.toBeNull()
    expect((menu as HTMLElement).hidden).toBe(true)

    // 选项从上到下依次为 接受/拒绝/重写；接受与拒绝右侧带快捷键提示（aria-hidden）。
    const items = menuItems(ghost)
    expect(items.map((item) => item.textContent)).toEqual(['接受Tab', '拒绝Esc', '重写'])
    for (const item of items) {
      expect(item.getAttribute('role')).toBe('menuitem')
      expect(item.getAttribute('contenteditable')).toBe('false')
    }
    expect(itemKeyHint(items[0])).toBe('Tab')
    expect(items[0].querySelector('.context-room-document-cursor-completion-menu-item-key')
      ?.getAttribute('aria-hidden')).toBe('true')
    expect(itemKeyHint(items[1])).toBe('Esc')
    expect(itemKeyHint(items[2])).toBeNull()
  })

  it('toggles the menu and aria-expanded when the bulb is clicked', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 12,
      text: '续写。',
      retryLabel: '重写',
    })
    const bulb = ghost.querySelector('.context-room-document-cursor-completion-bulb') as HTMLElement
    const menu = ghost.querySelector('.context-room-document-cursor-completion-menu') as HTMLElement
    // 模拟 hook 挂在编辑器根上的 pointerdown 监听：冒泡到根即 cancelPending 清 ghost。
    const rootPointerDown = vi.fn()
    const root = document.createElement('div')
    root.appendChild(ghost)
    root.addEventListener('pointerdown', rootPointerDown)

    // pointerdown 早于 mousedown 触发——必须先被拦下，且不冒泡到编辑器根。
    const pointerdown = new Event('pointerdown', { cancelable: true, bubbles: true })
    bulb.dispatchEvent(pointerdown)
    expect(pointerdown.defaultPrevented).toBe(true)
    expect(rootPointerDown).not.toHaveBeenCalled()

    const mousedown = new Event('mousedown', { cancelable: true, bubbles: true })
    bulb.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true)

    bulb.click()
    expect(menu.hidden).toBe(false)
    expect(bulb.getAttribute('aria-expanded')).toBe('true')

    bulb.click()
    expect(menu.hidden).toBe(true)
    expect(bulb.getAttribute('aria-expanded')).toBe('false')
  })

  it('opens the menu upward when the scroll area has no room below the bulb', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 12,
      text: '续写。',
      retryLabel: '重写',
    })
    const bulb = ghost.querySelector('.context-room-document-cursor-completion-bulb') as HTMLElement
    const menu = ghost.querySelector('.context-room-document-cursor-completion-menu') as HTMLElement
    const root = document.createElement('div')
    root.className = 'context-room-tiptap-scroll'
    root.appendChild(ghost)

    const rect = (bottom: number, height: number) => ({ bottom, height }) as DOMRect
    root.getBoundingClientRect = () => rect(320, 320)
    bulb.getBoundingClientRect = () => rect(300, 16)
    Object.defineProperty(menu, 'offsetHeight', { value: 40 })

    // 灯泡底 300、滚动区底 320：下方仅 20px 放不下 40px 高的菜单 → 向上弹。
    bulb.click()
    expect(menu.hidden).toBe(false)
    expect(menu.classList.contains('context-room-document-cursor-completion-menu-up')).toBe(true)

    // 空间充足（滚动区底 500）→ 常规向下弹。
    root.getBoundingClientRect = () => rect(500, 500)
    bulb.click()
    bulb.click()
    expect(menu.classList.contains('context-room-document-cursor-completion-menu-up')).toBe(false)

    // 非渲染环境（零矩形）不做布局决策，保持默认向下。
    root.getBoundingClientRect = () => rect(0, 0)
    bulb.click()
    bulb.click()
    expect(menu.classList.contains('context-room-document-cursor-completion-menu-up')).toBe(false)
  })

  it('dispatches the bubbling retry event and closes the menu when retry is clicked', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 12,
      text: '续写。',
      retryLabel: '重写',
      acceptLabel: '接受',
      dismissLabel: '拒绝',
    })
    const bulb = ghost.querySelector('.context-room-document-cursor-completion-bulb') as HTMLElement
    const menu = ghost.querySelector('.context-room-document-cursor-completion-menu') as HTMLElement
    const retry = menuItems(ghost)[2]
    bulb.click()
    expect(menu.hidden).toBe(false)

    const onRetry = vi.fn()
    const rootPointerDown = vi.fn()
    const root = document.createElement('div')
    root.appendChild(ghost)
    root.addEventListener(DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT, onRetry)
    root.addEventListener('pointerdown', rootPointerDown)

    // 菜单项的 pointerdown 同样不能冒泡：否则点菜单先触发 pointer_down 清 ghost，
    // 气泡随 widget 销毁，click 根本落不到按钮上。
    const pointerdown = new Event('pointerdown', { cancelable: true, bubbles: true })
    retry.dispatchEvent(pointerdown)
    expect(pointerdown.defaultPrevented).toBe(true)
    expect(rootPointerDown).not.toHaveBeenCalled()

    const mousedown = new Event('mousedown', { cancelable: true, bubbles: true })
    retry.dispatchEvent(mousedown)
    expect(mousedown.defaultPrevented).toBe(true)

    retry.click()
    expect(menu.hidden).toBe(true)
    expect(bulb.getAttribute('aria-expanded')).toBe('false')
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('dispatches the bubbling accept event when accept is clicked', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 12,
      text: '续写。',
      acceptLabel: '接受',
    })
    const bulb = ghost.querySelector('.context-room-document-cursor-completion-bulb') as HTMLElement
    const menu = ghost.querySelector('.context-room-document-cursor-completion-menu') as HTMLElement
    const accept = menuItems(ghost)[0]
    bulb.click()

    const onAccept = vi.fn()
    const onRetry = vi.fn()
    const root = document.createElement('div')
    root.appendChild(ghost)
    root.addEventListener(DOCUMENT_CURSOR_COMPLETION_ACCEPT_EVENT, onAccept)
    root.addEventListener(DOCUMENT_CURSOR_COMPLETION_RETRY_EVENT, onRetry)

    const pointerdown = new Event('pointerdown', { cancelable: true, bubbles: true })
    accept.dispatchEvent(pointerdown)
    expect(pointerdown.defaultPrevented).toBe(true)

    accept.click()
    expect(menu.hidden).toBe(true)
    expect(bulb.getAttribute('aria-expanded')).toBe('false')
    expect(onAccept).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('dispatches the bubbling dismiss event when dismiss is clicked', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 12,
      text: '续写。',
      dismissLabel: '拒绝',
    })
    const bulb = ghost.querySelector('.context-room-document-cursor-completion-bulb') as HTMLElement
    const menu = ghost.querySelector('.context-room-document-cursor-completion-menu') as HTMLElement
    const dismiss = menuItems(ghost)[1]
    bulb.click()

    const onDismiss = vi.fn()
    const root = document.createElement('div')
    root.appendChild(ghost)
    root.addEventListener(DOCUMENT_CURSOR_COMPLETION_DISMISS_EVENT, onDismiss)

    const pointerdown = new Event('pointerdown', { cancelable: true, bubbles: true })
    dismiss.dispatchEvent(pointerdown)
    expect(pointerdown.defaultPrevented).toBe(true)

    dismiss.click()
    expect(menu.hidden).toBe(true)
    expect(bulb.getAttribute('aria-expanded')).toBe('false')
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('falls back to default labels when none are provided', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 4,
      text: '自然结束。',
    })

    expect(ghost.textContent).toContain('自然结束。')
    expect(menuItems(ghost).map((item) => item.textContent)).toEqual(['AcceptTab', 'DismissEsc', 'Retry'])
  })

  it('carries active marks as a data attribute for mark-aware styling', () => {
    const ghost = buildDocumentCursorCompletionGhost({
      position: 8,
      text: '加粗续写',
      activeMarks: ['bold', 'italic'],
    })

    expect(ghost.dataset.activeMarks).toBe('bold italic')
  })
})
