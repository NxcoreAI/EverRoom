import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextRoomRecord } from '../src/renderer/src/components/context-room/ported/types'

const graphProps: Array<{ rooms: unknown[]; onSelectRoom: (roomId: string | null) => void }> = []

vi.mock('../src/renderer/src/components/context-room/ported/components/RoomGraphCanvas', async () => {
  const { forwardRef } = await import('react')
  return {
    RoomGraphCanvas: forwardRef(function MockRoomGraphCanvas(
      props: { rooms: unknown[]; onSelectRoom: (roomId: string | null) => void },
    ) {
      graphProps.push(props)
      return (
        <button type="button" onClick={() => props.onSelectRoom('room-b')}>
          select room-b
        </button>
      )
    }),
  }
})

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) => actual.translate('zh-CN', message, values),
    }),
  }
})

import { RelationsPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/RelationsPane'

function room(id: string, kind: '项目' | '主题', title: string): ContextRoomRecord {
  return {
    id,
    kind,
    title,
    icon: '',
    tone: 'sky',
    status: '',
    starred: false,
    lastViewed: '',
    roomCode: id,
    people: [],
    brief: { background: `${title} background`, goal: '', status: '', risks: [], decisions: [] },
    stats: { docs: 0, mails: 0, meetings: 0, events: 0, memories: 0, tasks: 0 },
    riskCount: 0,
    pendingMemoryCount: 0,
    timeline: [],
    materials: [],
    actionItems: [],
    graphEdges: [],
    pendingMemoryItems: [],
    memoryItems: [],
    fileItems: [],
    nextReverseRecall: '',
    cloudDoc: { workspaceId: '', docId: '' },
  }
}

describe('RelationsPane graph selection', () => {
  afterEach(() => {
    graphProps.length = 0
  })

  it('keeps the graph instance data stable while showing the selected Room details', async () => {
    const current = room('room-a', '项目', 'Current Room')
    const related = room('room-b', '项目', 'Related Room')
    let renderer: TestRenderer.ReactTestRenderer

    await act(async () => {
      renderer = TestRenderer.create(<RelationsPane room={current} rooms={[current, related]} onOpenRoom={vi.fn()} />)
    })

    expect(graphProps).toHaveLength(1)
    expect(renderer!.root.findByType('h3').children).toEqual(['Current Room'])

    await act(async () => {
      renderer!.root.findAllByType('button').find((button) => button.children.includes('select room-b'))!.props.onClick()
    })

    expect(graphProps).toHaveLength(2)
    expect(graphProps[1]!.rooms).toBe(graphProps[0]!.rooms)
    expect(renderer!.root.findByType('h3').children).toEqual(['Related Room'])
  })
})
