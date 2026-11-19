import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isAiRelayNotReadyError } from './useAiRelayQuotaExhausted'

vi.mock('./useLinkedAgentRun', () => ({
  useLinkedAgentRun: () => ({
    completedAt: undefined,
    documentPending: false,
    error: null,
    messages: [],
    reasoning: '',
    status: null,
    tools: [],
  }),
}))

vi.mock('../context-room/RoomDocumentsProvider', () => ({
  useRoomDocumentsState: () => ({ documentsByRoom: {} }),
}))

vi.mock('../../i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      locale: 'zh-CN',
      setLocale: vi.fn(),
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
      formatNumber: (value: number) => value.toLocaleString('zh-CN'),
      formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => (
        new Intl.DateTimeFormat('zh-CN', options).format(new Date(value))
      ),
    }),
  }
})

import { AgentChatView } from './AgentChatView'

const relayNotReadyError = '503: {"message":"AI relay session is not active","type":"ai_relay_not_ready","code":"ai_relay_not_ready"}'

type RelayListener = (event: { type: string }) => void

function stubAiRelay(relayListeners: Set<RelayListener>) {
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    clearTimeout,
    dispatchEvent: vi.fn(),
    matchMedia: () => ({ matches: true }),
    nxcore: {
      aiRelay: {
        verdict: vi.fn().mockResolvedValue({ quotaExhausted: true }),
        onEvent: (listener: RelayListener) => {
          relayListeners.add(listener)
          return () => relayListeners.delete(listener)
        },
      },
    },
    removeEventListener: vi.fn(),
    setTimeout,
  })
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    visibilityState: 'visible',
  })
}

function renderView(error: string | null) {
  return (
    <AgentChatView
      activeDocument={null}
      activeRunId={null}
      agentIdByRun={{}}
      agentNamesById={{}}
      activityByRun={{}}
      availableRooms={[]}
      composer={null}
      currentSessionId="session-1"
      draftHasContent={false}
      error={error}
      loading={false}
      messages={[]}
      onOpenSessionLink={vi.fn()}
      onRejectDocumentIntent={vi.fn()}
      onRetryPrompt={vi.fn()}
      onSelectDocument={vi.fn()}
      onSelectPrompt={vi.fn()}
      onSelectRoom={vi.fn().mockResolvedValue(undefined)}
      pendingNavigationByRun={{}}
      runCompletedAtByRun={{}}
      runStartedAtByRun={{}}
      scopeReady
      sessionLinks={[]}
      submitting={false}
      toolCallsByRun={{}}
    />
  )
}

describe('AgentChatView quota-exhausted notice', () => {
  beforeEach(() => {
    stubAiRelay(new Set())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recognizes the ai relay not-ready error payload', () => {
    expect(isAiRelayNotReadyError(relayNotReadyError)).toBe(true)
    expect(isAiRelayNotReadyError('Agent invocation failed')).toBe(false)
  })

  it('renders a grey notice instead of the red error bar when quota is exhausted', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(renderView(relayNotReadyError))
    })
    const notice = renderer.root.findByProps({ className: 'agent-error is-notice' })
    expect(notice.props.role).toBe('status')
    expect(notice.children).toContain('本周期 LLM 额度已用尽，可在设置中查看或充值后继续使用。')
    act(() => renderer.unmount())
  })

  it('keeps the red error bar for other failures', async () => {
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(renderView('Agent invocation failed: gateway unreachable'))
    })
    const errorBar = renderer.root.findByProps({ className: 'agent-error' })
    expect(errorBar.props.role).toBe('alert')
    const errorText = renderer.root.findByProps({ className: 'agent-error' }).findAllByType('span')
    expect(errorText.some((node) => node.children.join('') === 'Agent invocation failed: gateway unreachable')).toBe(true)
    act(() => renderer.unmount())
  })
})
