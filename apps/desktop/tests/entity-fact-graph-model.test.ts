import type { RoomAppliedEntity } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import { createEntityFactGraphData } from '../src/renderer/src/components/context-room/ported/components/entityFactGraphModel'
import { createContextRoomFixture } from './context-room-fixture'

function appliedEntity(
  overrides: Partial<RoomAppliedEntity> & Pick<RoomAppliedEntity, 'entityId' | 'name'>,
): RoomAppliedEntity {
  return {
    kind: '项目',
    status: 'weak',
    summary: null,
    aliases: [],
    linkedRoomId: null,
    mentionCount: 1,
    sourceKinds: ['everroom-doc'],
    salience: 0.5,
    lastMentionAt: '2026-08-20T10:00:00.000Z',
    evidence: null,
    ...overrides,
  }
}

describe('createEntityFactGraphData', () => {
  it('builds applied entity nodes with live status and keeps the room root', () => {
    const room = createContextRoomFixture()
    const graph = createEntityFactGraphData(room, [
      appliedEntity({
        entityId: 'e-1',
        name: '林薇',
        kind: '人物',
        status: 'room',
        summary: '设计负责人',
        mentionCount: 3,
      }),
      appliedEntity({
        entityId: 'e-2',
        name: 'V1 发布',
        status: 'promoting',
        summary: null,
        evidence: '发布计划推进中',
      }),
    ])

    expect(graph.rootId).toBe('entity:root')
    const root = graph.nodes.find((node) => node.id === graph.rootId)
    expect(root).toMatchObject({ kind: 'entity', label: room.title, entityType: '项目' })

    const appliedNode = graph.nodes.find((node) => node.id === 'applied:e-1')
    expect(appliedNode).toMatchObject({
      kind: 'entity',
      label: '林薇',
      entityType: '人物',
      status: 'room',
      mentionCount: 3,
      description: '设计负责人',
    })
    const evidenceNode = graph.nodes.find((node) => node.id === 'applied:e-2')
    expect(evidenceNode).toMatchObject({ status: 'promoting', description: '发布计划推进中' })
  })

  it('merges static people and graph edges that applied entities do not cover', () => {
    const room = createContextRoomFixture()
    room.people = [{ name: '林薇', role: '设计负责人', avatar: '林' }]
    room.graphEdges = [
      { from: '林薇', to: '星港项目', relation: '负责人' },
      { from: '旧系统', to: '星港项目', relation: '依赖' },
    ]
    const graph = createEntityFactGraphData(room, [appliedEntity({ entityId: 'e-1', name: '林薇' })])

    const labels = graph.nodes.filter((node) => node.kind === 'entity').map((node) => node.label)
    expect(labels).toEqual([room.title, '林薇', '星港项目', '旧系统'])
    // 应用实体与静态人物同名时不重复建节点。
    expect(graph.nodes.find((node) => node.id === 'applied:e-1')).toBeTruthy()
    expect(graph.nodes.filter((node) => node.label === '林薇')).toHaveLength(1)

    const edge = graph.edges.find((item) => item.relation === '负责人')
    expect(edge).toMatchObject({ source: 'applied:e-1', target: expect.stringMatching(/^entity:/) })
  })

  it('falls back to static derivation when applied entities are unavailable', () => {
    const room = createContextRoomFixture()
    room.people = [{ name: '陆远', role: '知识管理实践者', avatar: '陆' }]
    room.graphEdges = [{ from: '陆远', to: '知识库', relation: '维护' }]
    const graph = createEntityFactGraphData(room, null)

    const person = graph.nodes.find((node) => node.label === '陆远')
    expect(person).toMatchObject({ kind: 'entity', entityType: '人物', description: '知识管理实践者' })
    const other = graph.nodes.find((node) => node.label === '知识库')
    expect(other).toMatchObject({ entityType: '关联对象' })
    expect(graph.nodes.find((node) => 'status' in node && node.status)).toBeUndefined()
  })

  it('links facts to applied entities by name or alias and falls back to the room root', () => {
    const room = createContextRoomFixture()
    room.memoryItems = [
      { id: 'memory-1', content: '薇薇负责 V1 视觉设计', type: '事实', status: '已确认' },
      { id: 'memory-2', content: '与本实体无关的内容', type: '事实', status: '已确认' },
    ]
    const graph = createEntityFactGraphData(room, [
      appliedEntity({ entityId: 'e-1', name: '林薇', aliases: ['薇薇'] }),
    ])

    const matched = graph.edges.find((edge) => edge.target === 'fact:memory-1')
    expect(matched).toMatchObject({ source: 'applied:e-1', relation: '内容命中' })
    const fallback = graph.edges.find((edge) => edge.target === 'fact:memory-2')
    expect(fallback).toMatchObject({ source: 'entity:root', relation: 'Room 记忆' })
  })

  it('caps entity and fact node counts at the raised limits', () => {
    const room = createContextRoomFixture()
    room.people = Array.from({ length: 40 }, (_, index) => ({
      name: `人物${String(index)}`,
      role: '角色',
      avatar: '人',
    }))
    room.memoryItems = Array.from({ length: 20 }, (_, index) => ({
      id: `memory-${String(index)}`,
      content: `事实 ${String(index)}`,
      type: '事实',
      status: '已确认',
    }))
    const graph = createEntityFactGraphData(room)

    expect(graph.nodes.filter((node) => node.kind === 'entity')).toHaveLength(24)
    expect(graph.nodes.filter((node) => node.kind === 'fact')).toHaveLength(12)
  })
})
