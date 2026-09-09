// @vitest-environment happy-dom

import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}))

import { SectionPreviewCard } from './SectionPreviewCard'
import type { SectionPreviewStatus } from './useSectionPreviews'

function render(status: SectionPreviewStatus, onRetry = () => undefined) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <SectionPreviewCard headingText="架构演进" status={status} onRetry={onRetry} />,
    )
  })
  return renderer
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe('SectionPreviewCard', () => {
  it('renders the heading and the ready preview with timestamp', () => {
    const renderer = render({ state: 'ready', preview: '本节介绍模块分层重构。', generatedAt: '2026-09-07T12:00:00.000Z' })
    const json = textOf(renderer)
    expect(json).toContain('架构演进')
    expect(json).toContain('本节介绍模块分层重构。')
    expect(json).toContain('documentSectionPreview.generatedAt')
    expect(json).toContain('documentSectionPreview.aiLabel')
  })

  it('shows the loading spinner state', () => {
    const json = textOf(render({ state: 'loading' }))
    expect(json).toContain('documentSectionPreview.loading')
    expect(json).toContain('context-room-overview-spinning')
  })

  it('shows failure with a retry button that invokes the callback', () => {
    const onRetry = vi.fn()
    const renderer = render({ state: 'failed' }, onRetry)
    expect(textOf(renderer)).toContain('documentSectionPreview.failed')
    const retry = renderer.root.findByProps({ className: 'context-room-tiptap-scale-popover-retry' })
    act(() => retry.props.onClick())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders the unavailable, too-short, idle, and locked hints', () => {
    expect(textOf(render({ state: 'unavailable' }))).toContain('documentSectionPreview.unavailable')
    expect(textOf(render({ state: 'too-short' }))).toContain('documentSectionPreview.tooShort')
    expect(textOf(render({ state: 'idle' }))).toContain('documentSectionPreview.tooShort')
    expect(textOf(render({ state: 'locked' }))).toContain('documentSectionPreview.locked')
  })
})
