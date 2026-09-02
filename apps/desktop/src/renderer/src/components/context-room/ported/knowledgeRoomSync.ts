import type { KnowledgeRoomDto } from '../../../../../shared/knowledge'

import { createEmptyContextRoom } from './contextRoomFactory'
import { isDemoContextRoomId } from './demoContextRooms'
import type { ContextRoomKind, ContextRoomRecord } from './types'

const KNOWLEDGE_ROOM_KINDS = new Set<ContextRoomKind>([
  '人物',
  '项目',
  '主题',
  '长期目标',
  '议题',
  '事件',
])
function coerceKnowledgeKind(kind: string): ContextRoomKind {
  return KNOWLEDGE_ROOM_KINDS.has(kind as ContextRoomKind) ? kind as ContextRoomKind : '主题'
}

export function shouldSyncRoomToKnowledge(room: ContextRoomRecord): boolean {
  return room.origin !== 'auto' && room.origin !== 'source' && !isDemoContextRoomId(room.id)
}

export function shouldDeleteRoomFromKnowledge(room: ContextRoomRecord): boolean {
  return !isDemoContextRoomId(room.id)
}

/**
 * 网关知识 Room → 本地记录。晋升创建的 Room 出生即 user——确认晋升本来就是
 * 用户亲手点的，「认领」环节已废除（2026-09-02）；origin=auto 仅对迁移前的
 * 遗留行保留读取兼容，且不再附带「等待认领」占位文案。
 */
export function createKnowledgeContextRoom(dto: KnowledgeRoomDto): ContextRoomRecord {
  const id = dto.id
  return createEmptyContextRoom({
    id,
    title: dto.title,
    kind: coerceKnowledgeKind(dto.kind),
    origin: dto.origin === 'auto' ? 'auto' : 'user',
    background: dto.summary || '由知识推荐确认创建的 Room。',
    goal: '',
    briefStatus: '',
  })
}

export function mergeKnowledgeRooms(
  rooms: ContextRoomRecord[],
  deletedRooms: ContextRoomRecord[],
  incoming: KnowledgeRoomDto[],
): ContextRoomRecord[] {
  const knownIds = new Set([
    ...rooms.map((room) => room.id),
    ...deletedRooms.map((room) => room.id),
  ])
  const additions = incoming
    .filter((room) => !knownIds.has(room.id))
    .map(createKnowledgeContextRoom)
  return additions.length > 0 ? [...additions, ...rooms] : rooms
}
