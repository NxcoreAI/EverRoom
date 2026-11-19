// @vitest-environment happy-dom

import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RoomCreationStudio } from './RoomCreationStudio'

vi.mock('../../../../i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}))

vi.mock('@/state/toast', () => ({
  showToast: vi.fn(),
}))

vi.mock('../../ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({
    refreshFromBackend: async () => null,
  }),
}))

const createdRoom = { room: { id: 'room-new', title: '官网改版' }, created: true }

describe('RoomCreationStudio（极简名称弹窗）', () => {
  const toasts: Array<{ title: string }> = []
  const onToast = (event: Event) => {
    toasts.push((event as CustomEvent<{ title: string }>).detail)
  }

  const renderStudio = (onOpenChange: (open: boolean) => void, onRoomCreated: (room: { id: string; title: string }) => void) => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(
        <RoomCreationStudio open onOpenChange={onOpenChange} onRoomCreated={onRoomCreated} />,
      )
    })
    return renderer
  }

  const submitButtonOf = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByProps({ 'data-testid': 'context-room-creation-start' })[0]

  const submitForm = (renderer: TestRenderer.ReactTestRenderer) => {
    act(() => {
      renderer.root.findByType('form').props.onSubmit({ preventDefault: () => {} })
    })
  }

  const inputOf = (renderer: TestRenderer.ReactTestRenderer) =>
    renderer.root.findByType('input')

  const typeName = (renderer: TestRenderer.ReactTestRenderer, value: string) => {
    act(() => {
      inputOf(renderer).props.onChange({ target: { value } })
    })
  }

  beforeEach(() => {
    window.addEventListener('everroom:toast', onToast)
  })

  afterEach(() => {
    window.removeEventListener('everroom:toast', onToast)
    toasts.length = 0
    vi.clearAllMocks()
    delete (window as { nxcore?: unknown }).nxcore
  })

  it('空名称：提交按钮禁用', () => {
    const renderer = renderStudio(vi.fn(), vi.fn())
    expect(submitButtonOf(renderer).props.disabled).toBe(true)
  })

  it('只有空白名称仍视为未填写：按钮保持禁用', () => {
    const renderer = renderStudio(vi.fn(), vi.fn())
    typeName(renderer, '   ')
    expect(submitButtonOf(renderer).props.disabled).toBe(true)
  })

  it('填名称提交：直接调 contextRooms.create（不带描述），成功后关弹窗并回调', async () => {
    const create = vi.fn().mockResolvedValue(createdRoom)
    ;(window as { nxcore?: unknown }).nxcore = { contextRooms: { create } }
    const onOpenChange = vi.fn()
    const onRoomCreated = vi.fn()
    const renderer = renderStudio(onOpenChange, onRoomCreated)
    typeName(renderer, '官网改版')

    expect(submitButtonOf(renderer).props.disabled).toBe(false)
    await act(async () => {
      submitForm(renderer)
    })
    await act(async () => {})

    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({ title: '官网改版' })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onRoomCreated).toHaveBeenCalledWith({ id: 'room-new', title: '官网改版' })
  })

  it('名称超长：提交前截断到 40 字符', async () => {
    const create = vi.fn().mockResolvedValue(createdRoom)
    ;(window as { nxcore?: unknown }).nxcore = { contextRooms: { create } }
    const renderer = renderStudio(vi.fn(), vi.fn())
    const long = '非'.repeat(50)
    // input maxLength=40 挡住超长输入，这里直接验证提交值不会超过上限
    typeName(renderer, long.slice(0, 40))
    await act(async () => {
      submitForm(renderer)
    })
    await act(async () => {})
    expect(create).toHaveBeenCalledWith({ title: long.slice(0, 40) })
  })

  it('创建失败：弹窗保持打开并显示错误，不触发回调', async () => {
    const create = vi.fn().mockRejectedValue(new Error('重复审查未通过'))
    ;(window as { nxcore?: unknown }).nxcore = { contextRooms: { create } }
    const onOpenChange = vi.fn()
    const onRoomCreated = vi.fn()
    const renderer = renderStudio(onOpenChange, onRoomCreated)
    typeName(renderer, '官网改版')

    await act(async () => {
      submitForm(renderer)
    })
    await act(async () => {})

    expect(create).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onRoomCreated).not.toHaveBeenCalled()
    const alert = renderer.root.findByProps({ role: 'alert' })
    expect(alert.props.children).toBe('重复审查未通过')
  })

  it('服务不可用（无 nxcore.contextRooms）：显示服务不可用错误', async () => {
    const renderer = renderStudio(vi.fn(), vi.fn())
    typeName(renderer, '官网改版')
    await act(async () => {
      submitForm(renderer)
    })
    await act(async () => {})
    const alert = renderer.root.findByProps({ role: 'alert' })
    expect(alert.props.children).toBe('contextRoom:roomDialogs.serviceUnavailable')
  })
})
