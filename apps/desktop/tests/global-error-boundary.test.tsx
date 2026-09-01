// @vitest-environment happy-dom
import TestRenderer, { act } from 'react-test-renderer'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GlobalErrorBoundary } from '../src/renderer/src/components/GlobalErrorBoundary'
import { CONTEXT_ROOM_LOCAL_STATE_KEY } from '../src/renderer/src/components/context-room/ported/contextRoomLocalState'

vi.mock('@sentry/electron/renderer', () => ({ captureException: vi.fn(), init: vi.fn() }))

function Boom(): React.ReactElement {
  throw new Error('合并后残缺数据导致渲染崩溃')
}

describe('GlobalErrorBoundary（合并后白屏的最终兜底）', () => {
  afterEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('子组件渲染崩溃时降级为错误页而不是白屏', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <GlobalErrorBoundary>
          <Boom />
        </GlobalErrorBoundary>,
      )
    })
    const json = renderer!.toJSON() as { props: { role?: string }; children: unknown[] }
    expect(json.props.role).toBe('alert')
    const flatten = (node: unknown): string =>
      typeof node === 'string' ? node
        : Array.isArray(node) ? node.map(flatten).join('')
        : node && typeof node === 'object' && 'children' in node
          ? flatten((node as { children: unknown }).children)
          : ''
    expect(flatten(json)).toContain('界面渲染出现异常')
    expect(flatten(json)).toContain('重置并重载')
  })

  it('正常子树不受影响', () => {
    let renderer: TestRenderer.ReactTestRenderer | undefined
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <GlobalErrorBoundary>
          <div data-ok="1">正常内容</div>
        </GlobalErrorBoundary>,
      )
    })
    expect(renderer!.toJSON()).toMatchObject({ props: { 'data-ok': '1' } })
  })

  it('「重置并重载」清掉本地工作区状态（阻断持久化崩溃轮回）', () => {
    window.localStorage.setItem(CONTEXT_ROOM_LOCAL_STATE_KEY, JSON.stringify({ rooms: [] }))
    const reload = vi.fn()
    Object.defineProperty(window, 'location', { value: { ...window.location, reload }, writable: true })
    let renderer: TestRenderer.ReactTestRenderer | undefined
    TestRenderer.act(() => {
      renderer = TestRenderer.create(
        <GlobalErrorBoundary>
          <Boom />
        </GlobalErrorBoundary>,
      )
    })
    const boundary = renderer!.root.findByType(GlobalErrorBoundary).instance as GlobalErrorBoundary & {
      resetWorkspaceAndReload: () => void
    }
    expect(window.localStorage.getItem(CONTEXT_ROOM_LOCAL_STATE_KEY)).not.toBeNull()
    act(() => {
      boundary.resetWorkspaceAndReload()
    })
    expect(window.localStorage.getItem(CONTEXT_ROOM_LOCAL_STATE_KEY)).toBeNull()
    expect(reload).toHaveBeenCalled()
  })
})
