import type { PendingAgentIntent, RoomDocument } from '@nxcore/agent-contract'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const document: RoomDocument = {
  id: 'document-1',
  roomId: 'room-1',
  title: '发布计划',
  contentJson: { type: 'doc', content: [] },
  contentSchemaVersion: 3,
  version: 2,
  status: 'active',
  activeTransactionId: null,
  deletedAt: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

vi.mock('../context-room/RoomDocumentsProvider', () => ({
  useRoomDocumentsState: () => ({ documentsByRoom: { 'room-1': [document] } }),
}))

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

function pendingIntent(targetCapability: 'document.edit' | 'document.continue'): PendingAgentIntent {
  return {
    id: `intent-${targetCapability}`,
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    originalPrompt: '更新发布计划',
    targetCapability,
    allowedRoomIds: ['room-1'],
    allowedDocumentIds: ['document-1'],
    expiresAt: '2026-08-20T01:00:00.000Z',
    consumedAt: null,
    createdAt: '2026-08-20T00:00:00.000Z',
  }
}

describe('Agent pending document intent UI', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      clearTimeout,
      matchMedia: () => ({ matches: true }),
      removeEventListener: vi.fn(),
      setTimeout,
    })
    vi.stubGlobal('document', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      visibilityState: 'visible',
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it.each(['document.edit', 'document.continue'] as const)(
    'selects an allowed document before submitting %s',
    async (targetCapability) => {
      const intent = pendingIntent(targetCapability)
      const onSelectRoom = vi.fn().mockResolvedValue(undefined)
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(<AgentChatView
          activeDocument={null}
          activeRunId={null}
          activityByRun={{}}
          availableRooms={[{ id: 'room-1', title: '产品 Room' }]}
          composer={null}
          currentSessionId="session-1"
          draftHasContent={false}
          error={null}
          loading={false}
          messages={[]}
          onOpenSessionLink={vi.fn()}
          onRejectDocumentIntent={vi.fn()}
          onRetryPrompt={vi.fn()}
          onSelectDocument={vi.fn()}
          onSelectPrompt={vi.fn()}
          onSelectRoom={onSelectRoom}
          pendingNavigationByRun={{}}
          runCompletedAtByRun={{}}
          runStartedAtByRun={{}}
          scopeReady
          sessionLinks={[]}
          submitting={false}
          toolCallsByRun={{
            'run-1': [{
              id: 'tool-1',
              runId: 'run-1',
              name: 'context_room_list',
              status: 'completed',
              args: {},
              result: {
                rooms: [{ id: 'room-1', title: '产品 Room' }],
                selectionRequired: true,
                pendingIntent: intent,
              },
              startedAt: '2026-08-20T00:00:00.000Z',
              completedAt: '2026-08-20T00:00:01.000Z',
            }],
          }}
        />)
      })

      act(() => renderer.root.findByProps({ title: '产品 Room' }).props.onClick())
      expect(onSelectRoom).not.toHaveBeenCalled()

      await act(async () => {
        renderer.root.findByProps({ title: '发布计划' }).props.onClick()
        await Promise.resolve()
      })
      expect(onSelectRoom).toHaveBeenCalledWith(
        { id: 'room-1', title: '产品 Room' },
        intent,
        expect.objectContaining({ documentId: 'document-1', roomId: 'room-1' }),
      )
    },
  )
})
