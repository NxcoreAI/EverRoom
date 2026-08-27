import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RoomAppliedEntity } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'

let appliedResult: RoomAppliedEntity[] | null = null

vi.mock('../src/renderer/src/components/context-room/ported/useRoomAppliedEntities', () => ({
  useRoomAppliedEntities: () => appliedResult,
}))

vi.mock('../src/renderer/src/components/context-room/ported/components/EntityFactGraphCanvas', () => ({
  EntityFactGraphCanvas: function MockEntityFactGraphCanvas(props: {
    data: { nodes: Array<{ id: string; label: string }> }
    onSelect: (id: string | null) => void
  }) {
    return (
      <div>
        {props.data.nodes.map((node) => (
          <button key={node.id} type="button" onClick={() => props.onSelect(node.id)}>
            select {node.label}
          </button>
        ))}
      </div>
    )
  },
}))

vi.mock('../src/renderer/src/i18n/LocaleContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/renderer/src/i18n/LocaleContext')>()
  return {
    ...actual,
    useLocale: () => ({
      t: (message: string, values?: Record<string, string | number>) =>
        actual.translate('zh-CN', message, values),
      locale: 'zh-CN',
    }),
  }
})

import { MemoryPane } from '../src/renderer/src/components/context-room/ported/components/detail-panels/MemoryPane'

function appliedEntity(
  overrides: Partial<RoomAppliedEntity> & Pick<RoomAppliedEntity, 'entityId' | 'name'>,
): RoomAppliedEntity {
  return {
    kind: '人物',
    status: 'room',
    summary: '设计负责人',
    aliases: [],
    linkedRoomId: null,
    mentionCount: 2,
    sourceKinds: ['everroom-doc', 'mail'],
    salience: 0.6,
    lastMentionAt: '2026-08-25T08:00:00.000Z',
    evidence: null,
    ...overrides,
  }
}

function roomWithPeople() {
  const room = createContextRoomFixture()
  room.people = [{ name: '陆远', role: '知识管理实践者', avatar: '陆' }]
  return room
}

function textNodes(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAll((node) => (
    typeof node.children === 'string' || Array.isArray(node.children)
      ? flattenChildren(node).includes(text)
      : false
  ))
}

function flattenChildren(node: TestRenderer.ReactTestInstance): string {
  return node.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('')
}

describe('MemoryPane applied entities', () => {
  it('shows the live entity status badge, mention count, and last mention time', async () => {
    appliedResult = [appliedEntity({ entityId: 'e-1', name: '林薇' })]
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={roomWithPeople()} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} />,
      )
    })

    await act(async () => {
      renderer!.root.findAllByType('button')
        .find((button) => flattenChildren(button) === 'select 林薇')!.props.onClick()
    })

    const badge = renderer!.root.findByProps({ className: 'context-room-memory-entity-status' })
    expect(flattenChildren(badge)).toBe('已建 Room')
    expect(textNodes(renderer!, '人物 · 2 个来源提及')).toHaveLength(1)
    expect(textNodes(renderer!, '最近提及')).toHaveLength(1)
  })

  it('falls back to static entity derivation without a status badge', async () => {
    appliedResult = null
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={roomWithPeople()} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} />,
      )
    })

    await act(async () => {
      renderer!.root.findAllByType('button')
        .find((button) => flattenChildren(button) === 'select 陆远')!.props.onClick()
    })

    expect(renderer!.root.findAllByProps({ className: 'context-room-memory-entity-status' })).toHaveLength(0)
    expect(textNodes(renderer!, '人物 · 实体')).toHaveLength(1)
  })
})
