import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RoomAppliedEntity, RoomAppliedFact } from '@nxcore/agent-contract'

import { createContextRoomFixture } from './context-room-fixture'

let appliedResult: { entities: RoomAppliedEntity[]; facts: RoomAppliedFact[] } | null = null

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
    sources: [],
    ...overrides,
  }
}

function appliedFact(
  overrides: Partial<RoomAppliedFact> & Pick<RoomAppliedFact, 'factId' | 'content'>,
): RoomAppliedFact {
  return {
    type: '属性',
    entityIds: [],
    entityNames: [],
    sourceCount: 1,
    lastMentionAt: '2026-08-25T08:00:00.000Z',
    sources: [],
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

async function clickNode(renderer: TestRenderer.ReactTestRenderer, label: string) {
  await act(async () => {
    renderer.root.findAllByType('button')
      .find((button) => flattenChildren(button) === `select ${label}`)!.props.onClick()
  })
}

describe('MemoryPane applied entities', () => {
  it('shows the live entity status badge, mention count, and last mention time', async () => {
    appliedResult = { entities: [appliedEntity({ entityId: 'e-1', name: '林薇' })], facts: [] }
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={roomWithPeople()} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} onOpenRoom={() => undefined} />,
      )
    })

    await clickNode(renderer!, '林薇')

    const badge = renderer!.root.findByProps({ className: 'context-room-memory-entity-status' })
    expect(flattenChildren(badge)).toBe('已建 Room')
    expect(textNodes(renderer!, '人物 · 2 个来源提及')).toHaveLength(1)
    expect(textNodes(renderer!, '最近提及')).toHaveLength(1)
  })

  it('lists source materials with attribution for the selected applied entity', async () => {
    appliedResult = { entities: [appliedEntity({
      entityId: 'e-1',
      name: '林薇',
      sources: [{
        sourceKind: 'everroom-doc',
        sourceId: 'doc-1',
        sourceTitle: 'V1 项目结论',
        evidence: '林薇负责 V1 视觉设计',
        mentionedAt: '2026-08-25T08:00:00.000Z',
      }],
    })], facts: [] }
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={roomWithPeople()} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} onOpenRoom={() => undefined} />,
      )
    })

    await clickNode(renderer!, '林薇')

    expect(textNodes(renderer!, '来源资料')).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ className: 'context-room-memory-source-row' })).toHaveLength(1)
    expect(textNodes(renderer!, '林薇负责 V1 视觉设计')).toHaveLength(1)
    // 来源归属：标题 + 来源类型（相对时间随当前时间变化，不做精确断言）。
    expect(textNodes(renderer!, 'V1 项目结论 · EverRoom 文档')).toHaveLength(1)
  })

  it('fires onOpenSource when a source-material row is clicked', async () => {
    const source = {
      sourceKind: 'everroom-doc',
      sourceId: 'doc-1',
      sourceTitle: 'V1 项目结论',
      evidence: '林薇负责 V1 视觉设计',
      mentionedAt: '2026-08-25T08:00:00.000Z',
    }
    appliedResult = { entities: [appliedEntity({ entityId: 'e-1', name: '林薇', sources: [source] })], facts: [] }
    const onOpenSource = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane
          room={roomWithPeople()}
          onOpenMemory={() => undefined}
          onUpdateRoom={() => undefined}
          onOpenRoom={() => undefined}
          onOpenSource={onOpenSource}
        />,
      )
    })

    await clickNode(renderer!, '林薇')
    const row = renderer!.root.findAllByProps({ className: 'context-room-memory-source-row' })[0]
    expect(row).toBeTruthy()
    await act(async () => {
      row!.props.onClick()
    })
    expect(onOpenSource).toHaveBeenCalledWith(source)
  })

  it('renders the graph from live entities even when static room content is empty', async () => {
    // 自动创建的 Room 静态快照字段全空，数据只存在于结构化实体表：
    // 图谱门槛必须认实时实体，否则永远显示空态。
    appliedResult = { entities: [appliedEntity({ entityId: 'e-1', name: '林薇' })], facts: [] }
    const room = createContextRoomFixture()
    room.memoryItems = []
    room.people = []
    room.graphEdges = []
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={room} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} />,
      )
    })

    expect(
      renderer!.root.findAllByType('button')
        .some((button) => flattenChildren(button) === 'select 林薇'),
    ).toBe(true)
    expect(textNodes(renderer!, '还没有实体与事实')).toHaveLength(0)
    expect(textNodes(renderer!, '完整图谱')).toHaveLength(1)
  })

  it('lists related facts on the selected applied entity and shows fact sources when selected', async () => {
    appliedResult = {
      entities: [appliedEntity({ entityId: 'e-1', name: '林薇' })],
      facts: [
        appliedFact({
          factId: 'f-1',
          content: '林薇负责 V1 视觉设计',
          entityIds: ['e-1'],
          entityNames: ['林薇'],
          type: '关系',
          sourceCount: 2,
          sources: [{
            sourceKind: 'everroom-doc',
            sourceId: 'doc-1',
            sourceTitle: 'V1 项目结论',
            evidence: null,
            mentionedAt: '2026-08-25T08:00:00.000Z',
          }],
        }),
      ],
    }
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={roomWithPeople()} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} onOpenRoom={() => undefined} />,
      )
    })

    // 实体详情：关联事实区块列出按 entityId 命中的事实（应用事实节点 label = type）。
    await clickNode(renderer!, '林薇')
    expect(textNodes(renderer!, '关联事实')).toHaveLength(1)
    expect(textNodes(renderer!, '林薇负责 V1 视觉设计')).toHaveLength(1)

    // 选中应用事实节点：内容 + 来源；应用事实只读，不出现「禁用」入口。
    // （meta「2 个来源陈述」与区块头「来源」都含“来源”，不按该词计数。）
    await clickNode(renderer!, '关系')
    expect(textNodes(renderer!, 'V1 项目结论')).toHaveLength(1)
    expect(textNodes(renderer!, '林薇负责 V1 视觉设计')).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ className: 'context-room-ghost' })).toHaveLength(0)
  })

  it('jumps to the linked Room from the inline detail card instead of pushing the right pane', async () => {
    // 详情只在本面板的内联卡展示；右区常驻文档，节点点击不再推送右侧内容区。
    appliedResult = {
      entities: [appliedEntity({ entityId: 'e-1', name: '林薇', linkedRoomId: 'room-linwei' })],
      facts: [],
    }
    const onOpenRoom = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane
          room={roomWithPeople()}
          onOpenMemory={() => undefined}
          onUpdateRoom={() => undefined}
          onOpenRoom={onOpenRoom}
        />,
      )
    })

    await clickNode(renderer!, '林薇')

    const jump = renderer!.root.findAllByType('button')
      .find((button) => flattenChildren(button).includes('打开关联 Room'))
    expect(jump).toBeTruthy()
    await act(async () => {
      jump!.props.onClick()
    })
    expect(onOpenRoom).toHaveBeenCalledWith('room-linwei')
  })

  it('falls back to static entity derivation without a status badge', async () => {
    appliedResult = null
    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        <MemoryPane room={roomWithPeople()} onOpenMemory={() => undefined} onUpdateRoom={() => undefined} onOpenRoom={() => undefined} />,
      )
    })

    await clickNode(renderer!, '陆远')

    expect(renderer!.root.findAllByProps({ className: 'context-room-memory-entity-status' })).toHaveLength(0)
    expect(textNodes(renderer!, '人物 · 实体')).toHaveLength(1)
  })
})
