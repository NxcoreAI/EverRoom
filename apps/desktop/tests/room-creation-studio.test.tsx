import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => (
        actual.translate('zh-CN', message, values)
      ),
    }),
  }
})

import { RoomCreationStudio } from '../src/renderer/src/components/context-room/ported/components/RoomCreationStudio'
import { ROOM_RECOMMENDATION_RUN_EVENT } from '../src/renderer/src/components/context-room/ported/roomRecommendationRun'

// Node 环境兜底：组件用全局 CustomEvent 交接事件详情。
if (typeof CustomEvent === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CustomEvent = class CustomEvent<T> {
    constructor(public type: string, public detail?: T) {}
  }
}

function installBridge(picked: string[] = ['/docs/讲义.md', '/docs/实验.md']) {
  const files = {
    pickPaths: vi.fn(() => Promise.resolve(picked)),
  }
  const dispatchEvent = vi.fn()
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent,
    setTimeout: (fn: () => void) => { fn(); return 0 },
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    nxcore: { files },
  })
  return { files, dispatchEvent }
}

describe('RoomCreationStudio：暂存选择 + 提交交接（推荐在首页卡片生成）', () => {
  let renderer: TestRenderer.ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.unstubAllGlobals()
  })

  const render = async (onOpenChange = vi.fn()) => {
    await act(async () => {
      renderer = TestRenderer.create(
        <RoomCreationStudio open onOpenChange={onOpenChange} />,
      )
    })
    return { renderer: renderer!, onOpenChange }
  }

  it('弹窗=描述框 + 暂存选择：选择不导入，未选时提交禁用', async () => {
    const { files } = installBridge()
    const { renderer } = await render()
    expect(renderer.root.findByType('textarea')).toBeTruthy()
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-creation-dropzone' })).toBeTruthy()
    // 选择只暂存路径，不走导入链路
    expect(files.pickPaths).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ role: 'tab' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-creation-start' }).props.disabled).toBe(true)
  })

  it('选择→暂存清单；提交时携带路径与描述交接会话并关闭弹窗', async () => {
    const { files, dispatchEvent } = installBridge()
    const onOpenChange = vi.fn()
    const { renderer } = await render(onOpenChange)

    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'context-room-creation-dropzone' }).props.onClick()
    })
    expect(files.pickPaths).toHaveBeenCalledOnce()
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-creation-filelist' }).children).toHaveLength(2)
    expect(JSON.stringify(renderer.toJSON())).toContain('讲义.md')

    await act(async () => {
      renderer.root.findByType('textarea').props.onChange({ target: { value: '汇编语言课程设计' } })
    })
    const submit = renderer.root.findByProps({ 'data-testid': 'context-room-creation-start' })
    expect(submit.props.disabled).toBe(false)
    act(() => submit.props.onClick())

    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent<{ paths: string[]; intent: string | null }>
    expect(event.type).toBe(ROOM_RECOMMENDATION_RUN_EVENT)
    expect(event.detail?.paths).toEqual(['/docs/讲义.md', '/docs/实验.md'])
    expect(event.detail?.intent).toBe('汇编语言课程设计')
    // 提交即关弹窗：导入与推荐进度不在弹窗内
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('描述留空时 intent 为 null；可移除暂存项', async () => {
    const { dispatchEvent } = installBridge()
    const { renderer } = await render()

    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'context-room-creation-dropzone' }).props.onClick()
    })
    act(() => {
      renderer.root.findAllByProps({ className: 'context-room-creation-file-remove' })[0]!.props.onClick()
    })
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-creation-filelist' }).children).toHaveLength(1)

    act(() => renderer.root.findByProps({ 'data-testid': 'context-room-creation-start' }).props.onClick())
    const event = dispatchEvent.mock.calls[0]![0] as CustomEvent<{ paths: string[]; intent: string | null }>
    expect(event.detail?.paths).toEqual(['/docs/实验.md'])
    expect(event.detail?.intent).toBeNull()
  })

  it('选择框取消返回空时不改动暂存清单', async () => {
    const { files } = installBridge([])
    const { renderer } = await render()
    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'context-room-creation-dropzone' }).props.onClick()
    })
    expect(files.pickPaths).toHaveBeenCalledOnce()
    expect(renderer.root.findAllByProps({ 'data-testid': 'context-room-creation-filelist' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'data-testid': 'context-room-creation-start' }).props.disabled).toBe(true)
  })
})
