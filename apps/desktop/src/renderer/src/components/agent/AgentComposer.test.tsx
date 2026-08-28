import type { ExternalConversationSummary } from '@nxcore/agent-contract'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/state/toast', () => ({ showToast: vi.fn() }))
vi.mock('@/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
      formatDate: (value: Date | number | string, options?: Intl.DateTimeFormatOptions) => (
        new Intl.DateTimeFormat('zh-CN', options).format(new Date(value))
      ),
    }),
  }
})

import { AgentComposer } from './AgentComposer'

const conversation: ExternalConversationSummary = {
  id: 'thread-1',
  provider: 'openclaw',
  sourceId: 'source-1',
  title: '迁移会话',
  agentId: 'agent-1',
  externalSessionId: 'session-1',
  messageCount: 3,
  lastMessageAt: '2026-08-20T00:00:00.000Z',
  lastMessageExcerpt: '最后一条消息',
  available: true,
}

function renderComposer(overrides: Partial<React.ComponentProps<typeof AgentComposer>> = {}) {
  const props: React.ComponentProps<typeof AgentComposer> = {
    active: false,
    available: true,
    contextSummary: '首页',
    contextItems: [],
    hasSelectedText: false,
    loading: false,
    resetKey: 0,
    selectedExternalConversation: null,
    value: '',
    onChange: vi.fn(),
    onClearContext: vi.fn(),
    onRemoveContext: vi.fn(),
    onSelectExternalConversation: vi.fn(),
    onStop: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  }
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => { renderer = TestRenderer.create(<AgentComposer {...props} />) })
  return { props, renderer }
}

describe('AgentComposer external conversation command', () => {
  const conversations = vi.fn()

  beforeEach(() => {
    vi.useFakeTimers()
    conversations.mockResolvedValue({ items: [conversation], nextCursor: null })
    vi.stubGlobal('window', {
      nxcore: { migrations: { conversations } },
      requestAnimationFrame: (callback: FrameRequestCallback) => { callback(0); return 1 },
      setInterval,
      clearInterval,
      setTimeout,
      clearTimeout,
    })
    vi.stubGlobal('document', { activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the slash command draft on Escape and removes only its first line after selection', async () => {
    const onChange = vi.fn()
    const onSelectExternalConversation = vi.fn()
    const { renderer } = renderComposer({
      value: '/continue\n保留草稿',
      onChange,
      onSelectExternalConversation,
    })

    act(() => renderer.root.findByProps({ role: 'option' }).props.onClick())
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })
    expect(onChange).not.toHaveBeenCalled()

    act(() => {
      renderer.root.findByProps({ placeholder: '搜索之前的 Agent 会话' }).props.onKeyDown({
        key: 'Escape',
        preventDefault: vi.fn(),
        nativeEvent: {},
      })
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(renderer.root.findAllByProps({ className: 'agent-external-picker' })).toHaveLength(0)

    act(() => renderer.unmount())
    const { renderer: selectedRenderer } = renderComposer({
      value: '/continue\n保留草稿',
      onChange,
      onSelectExternalConversation,
    })
    act(() => selectedRenderer.root.findByProps({ role: 'option' }).props.onClick())
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })
    act(() => selectedRenderer.root.findByProps({ 'data-active': 'true' }).props.onClick())

    expect(onChange).toHaveBeenCalledWith('保留草稿')
    expect(onSelectExternalConversation).toHaveBeenCalledWith(conversation)
  })

  it('does not treat an IME confirmation Enter as a slash command selection', () => {
    const { renderer } = renderComposer({ value: '/' })
    const textarea = renderer.root.findByProps({ 'aria-label': '桌面 AI 工作台输入框' })
    const preventDefault = vi.fn()

    act(() => textarea.props.onCompositionStart())
    act(() => textarea.props.onKeyDown({
      key: 'Enter',
      shiftKey: false,
      preventDefault,
      nativeEvent: { isComposing: true, keyCode: 229 },
    }))

    expect(preventDefault).not.toHaveBeenCalled()
    expect(conversations).not.toHaveBeenCalled()
  })

  it('opens previous Agent chats from @ and keeps the reference as context', async () => {
    const onChange = vi.fn()
    const onSelectExternalConversation = vi.fn()
    const { renderer } = renderComposer({ value: '@claude', onChange, onSelectExternalConversation })

    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })
    expect(conversations).toHaveBeenCalledWith({ query: 'claude', cursor: undefined, limit: 20 })
    expect(renderer.root.findByProps({ 'aria-label': '引用 Agent 会话' })).toBeTruthy()

    act(() => renderer.root.findByProps({ 'data-active': 'true' }).props.onClick())
    expect(onChange).toHaveBeenCalledWith('')
    expect(onSelectExternalConversation).toHaveBeenCalledWith(conversation)
  })

  it('labels a selected chat as a reference instead of an active Agent', () => {
    const { renderer } = renderComposer({ selectedExternalConversation: conversation })

    expect(renderer.root.findAllByProps({ className: 'agent-current-agent' })).toHaveLength(0)
    expect(renderer.root.findByProps({ className: 'agent-external-selection' }).findAllByType('span')[0]?.children)
      .toContain('已引用会话')
  })

  it('renders command surfaces above the prompt without changing the prompt layout', () => {
    const { renderer } = renderComposer({ value: '/' })
    const popover = renderer.root.findByProps({ className: 'agent-composer-popover agent-command-picker' })
    const prompt = renderer.root.findByProps({ className: 'agent-prompt' })

    expect(popover.parent?.props.className).toBe('agent-composer-shell')
    expect(prompt.findAllByProps({ className: 'agent-command-picker' })).toHaveLength(0)
    expect(renderer.root.findByProps({ 'aria-label': '桌面 AI 工作台输入框' }).props['aria-expanded']).toBe(true)
  })

  it('does not render a voice input control', () => {
    const { renderer } = renderComposer()

    expect(renderer.root.findAllByProps({ 'aria-label': '语音输入' })).toHaveLength(0)
    expect(renderer.root.findAllByProps({ className: 'agent-prompt-voice' })).toHaveLength(0)
  })

  it('ignores stale search responses and never loads previews on hover', async () => {
    let resolveInitial!: (value: { items: ExternalConversationSummary[]; nextCursor: null }) => void
    const initial = new Promise<{ items: ExternalConversationSummary[]; nextCursor: null }>((resolve) => { resolveInitial = resolve })
    const newerConversation = { ...conversation, id: 'thread-2', title: '新的搜索结果' }
    conversations
      .mockReset()
      .mockReturnValueOnce(initial)
      .mockResolvedValueOnce({ items: [newerConversation], nextCursor: null })
    const { renderer } = renderComposer({ value: '/' })

    act(() => renderer.root.findByProps({ role: 'option' }).props.onClick())
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })
    const search = renderer.root.findByProps({ placeholder: '搜索之前的 Agent 会话' })
    act(() => search.props.onChange({ target: { value: '新' } }))
    await act(async () => {
      vi.advanceTimersByTime(180)
      await Promise.resolve()
    })
    await act(async () => {
      resolveInitial({ items: [conversation], nextCursor: null })
      await Promise.resolve()
    })

    const result = renderer.root.findByProps({ 'data-active': 'true' })
    expect(result.findByType('strong').children).toEqual(['新的搜索结果'])
    act(() => result.props.onMouseEnter())
    expect(window.nxcore?.migrations.preview).toBeUndefined()
  })

  it('shows a retry action when imported conversations cannot be loaded', async () => {
    conversations.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [conversation], nextCursor: null })
    const { renderer } = renderComposer({ value: '/' })

    act(() => renderer.root.findByProps({ role: 'option' }).props.onClick())
    await act(async () => {
      vi.runOnlyPendingTimers()
      await Promise.resolve()
    })
    expect(renderer.root.findAll((node) => node.children.includes('暂时无法读取已导入的会话'))).toHaveLength(1)

    await act(async () => {
      renderer.root.findAllByType('button').find((button) => button.children.includes('重试'))?.props.onClick()
      await Promise.resolve()
    })
    expect(renderer.root.findByProps({ 'data-active': 'true' })).toBeTruthy()
  })
})
