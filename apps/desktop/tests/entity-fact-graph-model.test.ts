import type { RoomAppliedEntity, RoomAppliedFact } from '@nxcore/agent-contract'
import { describe, expect, it } from 'vitest'

import type { RoomAppliedMemoryInput } from '../src/renderer/src/components/context-room/ported/components/entityFactGraphModel'
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

function appliedMemory(
  entities: RoomAppliedEntity[],
  facts: RoomAppliedFact[] = [],
): RoomAppliedMemoryInput {
  return { entities, facts }
}

describe('createEntityFactGraphData', () => {
  it('builds applied entity nodes with live status and keeps the room root', () => {
    const room = createContextRoomFixture()
    const graph = createEntityFactGraphData(room, appliedMemory([
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
    ]))

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

    // 来源明细原样透传到节点，供详情卡「来源资料」区块渲染。
    const withSources = createEntityFactGraphData(room, appliedMemory([
      appliedEntity({
        entityId: 'e-3',
        name: '星港项目',
        sources: [{
          sourceKind: 'everroom-doc',
          sourceId: 'doc-1',
          sourceTitle: 'V1 项目结论',
          evidence: '星港项目 V1 目标 7-30 交付',
          mentionedAt: '2026-08-25T08:00:00.000Z',
        }],
      }),
    ]))
    expect(withSources.nodes.find((node) => node.id === 'applied:e-3')?.sources).toEqual([{
      sourceKind: 'everroom-doc',
      sourceId: 'doc-1',
      sourceTitle: 'V1 项目结论',
      evidence: '星港项目 V1 目标 7-30 交付',
      mentionedAt: '2026-08-25T08:00:00.000Z',
    }])
  })

  it('merges static people and graph edges that applied entities do not cover', () => {
    const room = createContextRoomFixture()
    room.people = [{ name: '林薇', role: '设计负责人', avatar: '林' }]
    room.graphEdges = [
      { from: '林薇', to: '星港项目', relation: '负责人' },
      { from: '旧系统', to: '星港项目', relation: '依赖' },
    ]
    const graph = createEntityFactGraphData(room, appliedMemory([
      appliedEntity({ entityId: 'e-1', name: '林薇' }),
    ]))

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
    const graph = createEntityFactGraphData(room, appliedMemory([
      appliedEntity({ entityId: 'e-1', name: '林薇', aliases: ['薇薇'] }),
    ]))

    const matched = graph.edges.find((edge) => edge.target === 'fact:memory-1')
    expect(matched).toMatchObject({ source: 'applied:e-1', relation: '内容命中' })
    const fallback = graph.edges.find((edge) => edge.target === 'fact:memory-2')
    expect(fallback).toMatchObject({ source: 'entity:root', relation: 'Room 记忆' })
  })

  it('builds applied fact nodes linked by entity id and dedupes static memory items', () => {
    const room = createContextRoomFixture()
    room.memoryItems = [
      { id: 'memory-1', content: '林薇负责 V1 视觉设计', type: '事实', status: '已确认' },
      { id: 'memory-2', content: '静态独有事实', type: '事实', status: '已确认' },
    ]
    const graph = createEntityFactGraphData(room, appliedMemory(
      [appliedEntity({ entityId: 'e-1', name: '林薇' }), appliedEntity({ entityId: 'e-2', name: 'V1 视觉' })],
      [
        // 与静态 memoryItems 内容一致 → 静态侧去重
        appliedFact({ factId: 'f-1', content: '林薇负责 V1 视觉设计', entityIds: ['e-1', 'e-2'] }),
        // 解析不到图上实体 → 连根
        appliedFact({ factId: 'f-2', content: '外部供应商尚未签约', entityIds: ['e-missing'] }),
        appliedFact({ factId: 'f-3', content: 'V1 视觉由星港团队交付', type: '关系', entityIds: ['e-2'] }),
      ],
    ))

    const factIds = graph.nodes.filter((node) => node.kind === 'fact').map((node) => node.id)
    expect(factIds).toEqual(['applied-fact:f-1', 'applied-fact:f-2', 'applied-fact:f-3', 'fact:memory-2'])

    // 事实按已解析实体 id 连边；未命中实体的连根。
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'applied:e-1', target: 'applied-fact:f-1', relation: '关联事实' }),
        expect.objectContaining({ source: 'applied:e-2', target: 'applied-fact:f-1', relation: '关联事实' }),
        expect.objectContaining({ source: 'entity:root', target: 'applied-fact:f-2', relation: '关联事实' }),
        expect.objectContaining({ source: 'applied:e-2', target: 'applied-fact:f-3', relation: '关联事实' }),
      ]),
    )

    // 实体节点携带按 entityId 过滤的 relatedFacts，供详情区「关联事实」区块展示。
    const entityNode = graph.nodes.find((node) => node.id === 'applied:e-1')
    expect(entityNode && 'relatedFacts' in entityNode ? entityNode.relatedFacts?.map((fact) => fact.factId) : null)
      .toEqual(['f-1'])
  })

  it('connects applied entities to the room root and leaves no entity node isolated', () => {
    // 自动创建的 Room：静态快照全空，图上只有根 + 应用实体 → 全部连根，不能出现无连线节点。
    const room = createContextRoomFixture()
    room.memoryItems = []
    room.people = []
    room.graphEdges = []
    const graph = createEntityFactGraphData(room, appliedMemory([
      appliedEntity({ entityId: 'e-1', name: '林薇' }),
      appliedEntity({ entityId: 'e-2', name: 'V1 发布' }),
    ]))

    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'entity:root', target: 'applied:e-1', relation: '资料提及' }),
        expect.objectContaining({ source: 'entity:root', target: 'applied:e-2', relation: '资料提及' }),
      ]),
    )

    // 静态路径同样不留孤立点：只列 people、没有 graphEdges 的实体回落连根。
    const staticRoom = createContextRoomFixture()
    staticRoom.memoryItems = []
    staticRoom.graphEdges = []
    staticRoom.people = [{ name: '陆远', role: '知识管理实践者', avatar: '陆' }]
    const staticGraph = createEntityFactGraphData(staticRoom, null)
    const connectedIds = new Set(staticGraph.edges.flatMap((edge) => [edge.source, edge.target]))
    staticGraph.nodes
      .filter((node) => node.kind === 'entity' && node.id !== staticGraph.rootId)
      .forEach((node) => expect(connectedIds).toContain(node.id))
  })

  it('caps entity and fact node counts at the raised limits', () => {
    const room = createContextRoomFixture()
    room.people = Array.from({ length: 40 }, (_, index) => ({
      name: `人物${String(index)}`,
      role: '角色',
      avatar: '人',
    }))
    room.memoryItems = Array.from({ length: 30 }, (_, index) => ({
      id: `memory-${String(index)}`,
      content: `事实 ${String(index)}`,
      type: '事实',
      status: '已确认',
    }))
    const graph = createEntityFactGraphData(room)

    expect(graph.nodes.filter((node) => node.kind === 'entity')).toHaveLength(24)
    expect(graph.nodes.filter((node) => node.kind === 'fact')).toHaveLength(24)
  })
})
