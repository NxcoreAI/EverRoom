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

export function createAutoContextRoom(dto: KnowledgeRoomDto): ContextRoomRecord {
  const id = dto.id
  return createEmptyContextRoom({
    id,
    title: dto.title,
    kind: coerceKnowledgeKind(dto.kind),
    origin: 'auto',
    background: dto.summary || '资料归类时判定为新主题，自动创建的 Room。',
    goal: '确认归属并补充背景。',
    briefStatus: '自动创建，等待认领。',
  })
}

export function mergeAutoKnowledgeRooms(
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
    .map(createAutoContextRoom)
  return additions.length > 0 ? [...additions, ...rooms] : rooms
}
