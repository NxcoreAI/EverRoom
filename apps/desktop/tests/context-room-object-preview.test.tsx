import TestRenderer from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { ObjectPreview } from '../src/renderer/src/components/context-room/ported/components/detail-panels/ObjectPreview'
import type {
  EntityFactGraphEntityNode,
  EntityFactGraphFactNode,
} from '../src/renderer/src/components/context-room/ported/components/entityFactGraphModel'
import { createContextRoomFixture } from './context-room-fixture'

function textNodes(renderer: TestRenderer.ReactTestRenderer, text: string) {
  return renderer.root.findAll((node) => (
    typeof node.children === 'string' || Array.isArray(node.children)
      ? node.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('').includes(text)
      : false
  ))
}

function entityNode(): EntityFactGraphEntityNode {
  return {
    id: 'applied:e-1',
    kind: 'entity',
    label: '林薇',
    entityType: '人物',
    description: '设计负责人',
    status: 'room',
    mentionCount: 2,
    lastMentionAt: '2026-08-25T08:00:00.000Z',
    sources: [{
      sourceKind: 'everroom-doc',
      sourceId: 'doc-1',
      sourceTitle: 'V1 项目结论',
      evidence: '林薇负责 V1 视觉设计',
      mentionedAt: '2026-08-25T08:00:00.000Z',
    }],
    linkedRoomId: 'room-linwei',
  }
}

describe('ObjectPreview graph-node detail', () => {
  it('renders the applied entity detail with status, mentions, sources, and a linked-room jump', async () => {
    const onOpenRoom = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <ObjectPreview
          room={createContextRoomFixture()}
          rooms={[]}
          selection={{ kind: 'graph-node', node: entityNode() }}
          onOpenRoom={onOpenRoom}
        />,
      )
    })

    expect(textNodes(renderer!, '实体详情')).toHaveLength(1)
    expect(renderer!.root.findByProps({ 'data-status': 'room' }).children.join('')).toContain('已建 Room')
    expect(textNodes(renderer!, '实体类型')).toHaveLength(1)
    expect(textNodes(renderer!, '2 个来源')).toHaveLength(1)
    expect(textNodes(renderer!, '设计负责人')).toHaveLength(1)
    expect(textNodes(renderer!, '林薇负责 V1 视觉设计')).toHaveLength(1)

    const jump = renderer!.root.findAllByType('button')
      .find((button) => button.children.flatMap((child) => (typeof child === 'string' ? [child] : [])).join('').includes('打开关联 Room'))
    expect(jump).toBeTruthy()
    await TestRenderer.act(async () => {
      jump!.props.onClick()
    })
    expect(onOpenRoom).toHaveBeenCalledWith('room-linwei')
  })

  it('renders the room root as an overview and a fact node with its sources', async () => {
    const room = createContextRoomFixture()
    const root: EntityFactGraphEntityNode = {
      id: 'entity:root',
      kind: 'entity',
      label: room.title,
      entityType: room.kind,
      description: room.brief.background,
    }
    let renderer: TestRenderer.ReactTestRenderer
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <ObjectPreview room={room} rooms={[]} selection={{ kind: 'graph-node', node: root }} onOpenRoom={() => undefined} />,
      )
    })
    expect(textNodes(renderer!, 'Room 概览')).toHaveLength(1)
    expect(renderer!.root.findAllByProps({ className: 'context-room-memory-entity-status' })).toHaveLength(0)

    const fact: EntityFactGraphFactNode = {
      id: 'fact:memory-1',
      kind: 'fact',
      label: '事实',
      description: '薇薇负责 V1 视觉设计',
      memory: {
        id: 'memory-1',
        content: '薇薇负责 V1 视觉设计',
        type: '事实',
        status: '已确认',
        sources: [{ type: '云文档', name: 'V1 项目结论' }],
      },
    }
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <ObjectPreview room={room} rooms={[]} selection={{ kind: 'graph-node', node: fact }} onOpenRoom={() => undefined} />,
      )
    })
    expect(textNodes(renderer!, '事实详情')).toHaveLength(1)
    expect(textNodes(renderer!, '薇薇负责 V1 视觉设计')).toHaveLength(1)
    expect(textNodes(renderer!, 'V1 项目结论')).toHaveLength(1)
  })

  it('renders an applied fact with related entities and sources, and entity related facts', async () => {
    const room = createContextRoomFixture()
    const appliedFactNode: EntityFactGraphFactNode = {
      id: 'applied-fact:f-1',
      kind: 'fact',
      label: '关系',
      description: '林薇负责 V1 视觉设计',
      fact: {
        factId: 'f-1',
        content: '林薇负责 V1 视觉设计',
        type: '关系',
        entityIds: ['e-1'],
        entityNames: ['林薇'],
        sourceCount: 2,
        lastMentionAt: '2026-08-25T08:00:00.000Z',
        sources: [{
          sourceKind: 'everroom-doc',
          sourceId: 'doc-1',
          sourceTitle: 'V1 项目结论',
          evidence: '林薇负责 V1 视觉设计',
          mentionedAt: '2026-08-25T08:00:00.000Z',
        }],
      },
    }
    let renderer: TestRenderer.ReactTestRenderer
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <ObjectPreview room={room} rooms={[]} selection={{ kind: 'graph-node', node: appliedFactNode }} onOpenRoom={() => undefined} />,
      )
    })
    expect(textNodes(renderer!, '事实详情')).toHaveLength(1)
    expect(textNodes(renderer!, '关系')).toHaveLength(1)
    expect(textNodes(renderer!, '关联实体')).toHaveLength(1)
    // 「林薇」两处：关联实体 dd + 事实内容「林薇负责 V1 视觉设计」的子串命中。
    expect(textNodes(renderer!, '林薇')).toHaveLength(2)
    expect(textNodes(renderer!, '林薇负责 V1 视觉设计')).toHaveLength(1)
    expect(textNodes(renderer!, 'V1 项目结论')).toHaveLength(1)

    const entityWithFacts: EntityFactGraphEntityNode = {
      ...entityNode(),
      relatedFacts: [appliedFactNode.fact!],
    }
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(
        <ObjectPreview room={room} rooms={[]} selection={{ kind: 'graph-node', node: entityWithFacts }} onOpenRoom={() => undefined} />,
      )
    })
    expect(textNodes(renderer!, '关联事实')).toHaveLength(1)
    // 内容两处命中：关联事实行 + 实体来源资料行的 evidence。
    expect(textNodes(renderer!, '林薇负责 V1 视觉设计')).toHaveLength(2)
  })
})
