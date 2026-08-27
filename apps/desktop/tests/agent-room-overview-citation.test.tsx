/** @vitest-environment happy-dom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RoomOverviewProjection } from '@nxcore/agent-contract'
import type { RoomOverviewCitation } from '../src/renderer/src/components/context-room/roomOverviewCitation'
import {
  ROOM_OVERVIEW_CHANGED_EVENT,
  type RoomOverviewChangedDetail,
} from '../src/renderer/src/components/context-room/roomOverviewChange'

let composerProps: Record<string, unknown> = {}
let session: Record<string, unknown>
const prepareActiveDocumentRun = vi.fn()

vi.mock('../src/renderer/src/components/agent/AgentComposer', async () => {
  const { forwardRef } = await import('react')
  return {
    AgentComposer: forwardRef<HTMLTextAreaElement, Record<string, unknown>>(function MockAgentComposer(props, ref) {
      composerProps = props
      return <textarea ref={ref} />
    }),
  }
})

vi.mock('../src/renderer/src/components/agent/AgentChatView', () => ({
  AgentChatView: ({ composer }: { composer: React.ReactNode }) => <div>{composer}</div>,
}))

vi.mock('../src/renderer/src/components/agent/AgentSessionSwitcher', () => ({
  AgentSessionSwitcher: () => null,
}))

vi.mock('../src/renderer/src/components/agent/AgentToolbar', () => ({
  AgentToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../src/renderer/src/components/agent/useAgentSession', () => ({
  useAgentSession: () => session,
}))

vi.mock('../src/renderer/src/components/context-room/ContextRoomStateProvider', () => ({
  useContextRoomState: () => ({ refreshFromBackend: vi.fn() }),
}))

vi.mock('../src/renderer/src/state/ActiveDocumentContext', () => ({
  useActiveDocument: () => ({ activeDocument: null, prepareActiveDocumentRun }),
}))

import { AgentPanel } from '../src/renderer/src/components/AgentPanel'

function panel(
  citations: RoomOverviewCitation[],
  onRemoveRoomCitation: (citationId: string) => void,
  onClearRoomCitations: () => void,
) {
  return (
    <AgentPanel
      pageId="rooms"
      pageLabel="Context Room"
      roomId="room-1"
      rooms={[{ id: 'room-1', title: '产品发布', kind: '项目' }]}
      roomBackendReady
      navigationRequest={null}
      sessionRouteRequest={null}
      onNavigate={() => undefined}
      onRestoreRoomTab={() => undefined}
      onNavigationConsumed={() => undefined}
      onOpenSessionLink={() => undefined}
      onOpenDocument={() => undefined}
      onSessionRouteConsumed={() => undefined}
      roomCitations={citations}
      onRemoveRoomCitation={onRemoveRoomCitation}
      onClearRoomCitations={onClearRoomCitations}
    />
  )
}

describe('Agent Room overview citation submission', () => {
  let container: HTMLDivElement
  let root: Root
  const sendPrompt = vi.fn()

  beforeEach(() => {
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    composerProps = {}
    prepareActiveDocumentRun.mockResolvedValue(undefined)
    sendPrompt.mockResolvedValue('run-1')
    session = {
      activeRunId: null,
      activityByRun: {},
      connected: true,
      currentSession: { id: 'session-1', title: 'Room 对话' },
      displayTitle: 'Room 对话',
      error: null,
      loading: false,
      messages: [],
      pendingApprovals: [],
      resolvingApprovalIds: [],
      runCompletedAtByRun: {},
      runStartedAtByRun: {},
      scopeReady: true,
      sendPrompt,
      sessionId: 'session-1',
      sessionLinks: [],
      sessions: [{ id: 'session-1', title: 'Room 对话' }],
      toolCallsByRun: {},
    }
    Object.defineProperty(window, 'nxcore', {
      configurable: true,
      value: { agent: {} },
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('sends the cited section and text, then clears the citation after success', async () => {
    const onRemoveRoomCitation = vi.fn()
    const onClearRoomCitations = vi.fn()
    const citations: RoomOverviewCitation[] = [{
      id: 'citation-1',
      roomId: 'room-1',
      roomTitle: '产品发布',
      section: 'next_steps',
      text: '本周五前完成发布清单',
      comment: '负责人需要更新',
    }, {
      id: 'citation-2',
      roomId: 'room-1',
      roomTitle: '产品发布',
      section: 'status',
      text: '当前仍在等待设计确认',
    }]
    await act(async () => root.render(panel(citations, onRemoveRoomCitation, onClearRoomCitations)))

    expect(composerProps.contextSummary).toContain('产品发布 · 已引用 2 段')
    expect(composerProps.contextItems).toEqual([
      expect.objectContaining({ id: 'citation-1', label: expect.stringContaining('本周五前完成发布清单') }),
      expect.objectContaining({ id: 'citation-2', label: expect.stringContaining('当前仍在等待设计确认') }),
    ])
    await act(async () => (composerProps.onRemoveContext as (id: string) => void)('citation-2'))
    expect(onRemoveRoomCitation).toHaveBeenCalledWith('citation-2')
    await act(async () => (composerProps.onChange as (value: string) => void)('负责人应改为王敏'))
    await act(async () => {
      (composerProps.onSubmit as (files: File[]) => void)([])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendPrompt).toHaveBeenCalledWith(
      '负责人应改为王敏',
      '引用 1\n区块：next_steps\n引用文本：本周五前完成发布清单\n用户评论：负责人需要更新\n\n引用 2\n区块：status\n引用文本：当前仍在等待设计确认',
      'room-1',
      undefined,
      undefined,
      undefined,
    )
    expect(onClearRoomCitations).toHaveBeenCalledTimes(1)
  })

  it('keeps fuzzy clarification available without a citation', async () => {
    await act(async () => root.render(panel([], () => undefined, () => undefined)))
    await act(async () => (composerProps.onChange as (value: string) => void)('最近状态不准确，请结合新文档调整'))
    await act(async () => {
      (composerProps.onSubmit as (files: File[]) => void)([])
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(sendPrompt).toHaveBeenCalledWith(
      '最近状态不准确，请结合新文档调整',
      '',
      'room-1',
      undefined,
      undefined,
      undefined,
    )
  })

  it('publishes the applied projection for an immediate Room overview update', async () => {
    const updated: RoomOverviewProjection = {
      roomId: 'room-1',
      revision: 6,
      generatedAt: '2026-08-27T12:00:00.000Z',
      stale: false,
      overview: [],
      status: [],
      nextSteps: [],
      timeline: [],
      entities: [],
      appliedCorrectionIds: ['correction-1'],
    }
    session.toolCallsByRun = {
      'run-apply': [{
        id: 'tool-apply',
        runId: 'run-apply',
        name: 'context_room_correction_apply',
        args: { proposalId: 'correction-1' },
        result: { details: { overview: updated } },
        status: 'completed',
        startedAt: '2026-08-27T12:00:00.000Z',
        completedAt: '2026-08-27T12:00:01.000Z',
      }],
    }
    const listener = vi.fn()
    window.addEventListener(ROOM_OVERVIEW_CHANGED_EVENT, listener)

    await act(async () => root.render(panel([], () => undefined, () => undefined)))

    expect((listener.mock.calls[0]?.[0] as CustomEvent<RoomOverviewChangedDetail>).detail)
      .toEqual({ roomId: 'room-1', projection: updated })
    window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, listener)
  })

  it('publishes a regenerated projection for an immediate Room overview update', async () => {
    const updated: RoomOverviewProjection = {
      roomId: 'room-1', revision: 7, generatedAt: '2026-08-27T12:05:00.000Z', stale: false,
      overview: [], status: [], nextSteps: [], timeline: [], entities: [], appliedCorrectionIds: [],
    }
    session.toolCallsByRun = {
      'run-regenerate': [{
        id: 'tool-regenerate',
        runId: 'run-regenerate',
        name: 'context_room_overview_regenerate',
        args: {},
        result: { details: { roomId: 'room-1', overview: updated } },
        status: 'completed',
        startedAt: '2026-08-27T12:05:00.000Z',
        completedAt: '2026-08-27T12:05:01.000Z',
      }],
    }
    const listener = vi.fn()
    window.addEventListener(ROOM_OVERVIEW_CHANGED_EVENT, listener)

    await act(async () => root.render(panel([], () => undefined, () => undefined)))

    expect((listener.mock.calls[0]?.[0] as CustomEvent<RoomOverviewChangedDetail>).detail)
      .toEqual({ roomId: 'room-1', projection: updated })
    window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, listener)
  })

  it('logs correction tool failures without forwarding the error content', async () => {
    const log = vi.fn()
    Object.defineProperty(window, 'nxcore', {
      configurable: true,
      value: { agent: {}, diagnostics: { log } },
    })
    session.toolCallsByRun = {
      'run-error': [{
        id: 'tool-error',
        runId: 'run-error',
        name: 'context_room_correction_apply',
        args: { proposalId: 'correction-secret' },
        error: 'sensitive correction content',
        status: 'error',
        startedAt: '2026-08-27T12:00:00.000Z',
        completedAt: '2026-08-27T12:00:01.000Z',
      }],
    }

    await act(async () => root.render(panel([], () => undefined, () => undefined)))

    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      module: 'context-room-overview',
      level: 'error',
      event: expect.objectContaining({
        event: 'correction.tool_failed',
        roomId: 'room-1',
        toolName: 'context_room_correction_apply',
        toolId: 'tool-error',
        runId: 'run-error',
        status: 'error',
        errorPresent: true,
      }),
    }))
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive correction content')
    expect(JSON.stringify(log.mock.calls)).not.toContain('correction-secret')
  })
})
