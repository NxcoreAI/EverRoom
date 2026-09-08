// @vitest-environment happy-dom

import type { DocumentOverviewView } from '@nxcore/agent-contract'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../i18n/LocaleContext', () => ({
  useLocale: () => ({
    locale: 'zh-CN',
    t: (key: string) => key,
  }),
}))

import { DocumentOverviewCard } from './DocumentOverviewCard'
import type { DocumentOverviewStatus } from './useDocumentOverview'

function view(overrides: Partial<DocumentOverviewView> = {}): DocumentOverviewView {
  return {
    documentId: 'document-1',
    topic: '项目架构演进方案',
    points: ['模块分层重构', '网关进程拆分'],
    conclusion: '架构已趋于稳定',
    generatedAtVersion: 3,
    generatedAt: '2026-09-07T10:00:00.000Z',
    eligible: true,
    reason: 'ok',
    aiAvailable: true,
    ...overrides,
  }
}

function render(status: DocumentOverviewStatus, expanded = false) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      <DocumentOverviewCard
        status={status}
        expanded={expanded}
        onToggleExpanded={() => undefined}
        onRegenerate={() => undefined}
        regenerateDisabled={false}
      />,
    )
  })
  return renderer
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON())
}

describe('DocumentOverviewCard', () => {
  it('renders nothing for idle and empty documents', () => {
    expect(render({ state: 'idle' }).toJSON()).toBeNull()
    expect(render({ state: 'ineligible', reason: 'empty' }).toJSON()).toBeNull()
  })

  it('renders only a hint bar for too-short documents', () => {
    const renderer = render({ state: 'ineligible', reason: 'too_short' })
    expect(textOf(renderer)).toContain('documentQuickView.tooShort')
    expect(renderer.root.findAllByProps({ className: 'context-room-document-overview-body' })).toHaveLength(0)
  })

  it('shows topic, points, conclusion and the version footer when expanded', () => {
    const renderer = render({ state: 'ready', view: view() }, true)
    const json = textOf(renderer)
    expect(json).toContain('项目架构演进方案')
    expect(json).toContain('模块分层重构')
    expect(json).toContain('网关进程拆分')
    expect(json).toContain('架构已趋于稳定')
    expect(json).toContain('documentQuickView.generatedAt')
    expect(json).toContain('documentQuickView.regenerate')
    expect(json).not.toContain('documentQuickView.staleBadge')
  })

  it('shows the stale badge when the document moved past the generated version', () => {
    const renderer = render({ state: 'stale', view: view() }, true)
    expect(textOf(renderer)).toContain('documentQuickView.staleBadge')
  })

  it('keeps a collapsed entry bar with a topic preview when not expanded', () => {
    const renderer = render({ state: 'ready', view: view() })
    const json = textOf(renderer)
    expect(json).toContain('documentQuickView.entryLabel')
    expect(json).toContain('项目架构演进方案')
    expect(renderer.root.findAllByProps({ className: 'context-room-document-overview-body' })).toHaveLength(0)
  })

  it('shows the generating hint and spinner while generating', () => {
    const renderer = render({ state: 'generating', view: null })
    const json = textOf(renderer)
    expect(json).toContain('documentQuickView.generating')
    expect(json).toContain('context-room-overview-spinning')
  })

  it('shows the unavailable state without a retry button, and the error state with one', () => {
    const unavailable = render({ state: 'failed', kind: 'unavailable' })
    expect(textOf(unavailable)).toContain('documentQuickView.unavailable')
    expect(unavailable.root.findAllByProps({ className: 'context-room-document-overview-retry' })).toHaveLength(0)

    const failed = render({ state: 'failed', kind: 'error' })
    expect(textOf(failed)).toContain('documentQuickView.failed')
    expect(failed.root.findAllByProps({ className: 'context-room-document-overview-retry' })).toHaveLength(1)
  })
})
