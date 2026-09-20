// @vitest-environment happy-dom

import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ROOM_RECOMMENDATION_RUN_EVENT, type RoomRecommendationRunPayload } from '../roomRecommendationRun'
import { RoomCreationStudio } from './RoomCreationStudio'

vi.mock('../../../../i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}))

const noop = () => {}

function renderStudio(onOpenChange: (open: boolean) => void = noop) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(<RoomCreationStudio open onOpenChange={onOpenChange} />)
  })
  return renderer
}

const submitButtonOf = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByProps({ 'data-testid': 'context-room-creation-start' })[0]

const typeIntent = (renderer: TestRenderer.ReactTestRenderer, value: string) => {
  const textarea = renderer.root.findByType('textarea')
  act(() => {
    textarea.props.onChange({ target: { value } })
  })
}

describe('RoomCreationStudio（#241 手动创建 Room 不再强制选择文件）', () => {
  const listeners: Array<(event: Event) => void> = []
  const toasts: Array<{ title: string }> = []
  const onToast = (event: Event) => {
    toasts.push((event as CustomEvent<{ title: string }>).detail)
  }

  const captureRuns = () => {
    const runs: RoomRecommendationRunPayload[] = []
    const listener = (event: Event) => {
      runs.push((event as CustomEvent<RoomRecommendationRunPayload>).detail)
    }
    listeners.push(listener)
    window.addEventListener(ROOM_RECOMMENDATION_RUN_EVENT, listener)
    return runs
  }

  beforeEach(() => {
    window.addEventListener('everroom:toast', onToast)
  })

  afterEach(() => {
    window.removeEventListener('everroom:toast', onToast)
    toasts.length = 0
    while (listeners.length) {
      const listener = listeners.pop()!
      window.removeEventListener(ROOM_RECOMMENDATION_RUN_EVENT, listener)
    }
    vi.restoreAllMocks()
    delete (window as { nxcore?: unknown }).nxcore
  })

  it('无文件且无描述：提交按钮禁用（不能创建无名空 Room）', () => {
    const renderer = renderStudio()
    expect(submitButtonOf(renderer).props.disabled).toBe(true)
  })

  it('无文件但有描述：允许提交，payload.paths 为空，弹窗关闭', () => {
    const runs = captureRuns()
    const onOpenChange = vi.fn()
    const renderer = renderStudio(onOpenChange)
    typeIntent(renderer, '每周复盘整理')

    expect(submitButtonOf(renderer).props.disabled).toBe(false)
    act(() => {
      submitButtonOf(renderer).props.onClick()
    })

    expect(runs).toHaveLength(1)
    expect(runs[0]!.paths).toEqual([])
    expect(runs[0]!.intent).toBe('每周复盘整理')
    expect(toasts.some((toast) => toast.title === 'contextRoom:creation.emptySubmitted')).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('只有空白描述仍视为未填写：按钮保持禁用', () => {
    const renderer = renderStudio()
    typeIntent(renderer, '   ')
    expect(submitButtonOf(renderer).props.disabled).toBe(true)
  })

  it('有文件无描述：行为不变，payload 携带所选路径', async () => {
    const runs = captureRuns()
    ;(window as { nxcore?: unknown }).nxcore = {
      files: { pickPaths: async () => ['/tmp/material/a.md'] },
    }
    const renderer = renderStudio()

    const dropzone = renderer.root.findAllByProps({ 'data-testid': 'context-room-creation-dropzone' })[0]
    await act(async () => {
      dropzone.props.onClick()
    })
    await act(async () => {})

    expect(submitButtonOf(renderer).props.disabled).toBe(false)
    act(() => {
      submitButtonOf(renderer).props.onClick()
    })

    expect(runs).toHaveLength(1)
    expect(runs[0]!.paths).toEqual(['/tmp/material/a.md'])
    expect(runs[0]!.intent).toBeNull()
    expect(toasts.some((toast) => toast.title === 'contextRoom:creation.submitted')).toBe(true)
  })
})
