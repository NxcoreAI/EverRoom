import type { KnowledgeRoomContextDto } from '../../../../../shared/knowledge'

import type { ContextRoomActionItem, ContextRoomMaterial, ContextRoomRecord } from './types'

function stableId(prefix: string, value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`
}

function actionKey(item: Pick<ContextRoomActionItem, 'title' | 'source'>): string {
  return `${item.source?.name ?? ''}\u0000${item.title}`
}

export function applyGeneratedRoomContext(
  room: ContextRoomRecord,
  context: KnowledgeRoomContextDto,
): ContextRoomRecord {
  const manualActions = room.actionItems.filter((item) => !item.generated)
  const previousActions = new Map(
    room.actionItems.filter((item) => item.generated).map((item) => [actionKey(item), item]),
  )
  const generatedActions: ContextRoomActionItem[] = context.actionItems.map((item) => {
    const source = { type: '文档', name: item.sourceTitle }
    const previous = previousActions.get(actionKey({ title: item.title, source }))
    return {
      id: stableId('room-generated-task', `${item.sourceTitle}\u0000${item.title}`),
      title: item.title,
      status: previous?.status ?? '待处理',
      owner: previous?.owner ?? item.owner ?? '待确认',
      deadline: previous?.deadline ?? item.dueDate ?? '未设置',
      ...(previous?.completed !== undefined ? { completed: previous.completed } : {}),
      source,
      generated: true,
    }
  })
  const manualMaterials = room.materials.filter((item) => !item.generated)
  const generatedMeetings: ContextRoomMaterial[] = context.meetings.map((item) => ({
    id: stableId('room-generated-meeting', `${item.sourceTitle}\u0000${item.title}\u0000${item.when}`),
    type: '会议',
    title: item.title,
    time: item.when,
    summary: `来自《${item.sourceTitle}》`,
    attendees: item.participants,
    generated: true,
  }))
  const actionItems = [...manualActions, ...generatedActions]
  const materials = [...manualMaterials, ...generatedMeetings]
  return {
    ...room,
    generatedContext: context,
    actionItems,
    materials,
    stats: {
      ...room.stats,
      docs: context.sourceDocuments.length + room.fileItems.length,
      meetings: materials.filter((item) => item.type === '会议').length,
      tasks: actionItems.length,
    },
    updatedAt: context.generatedAt,
  }
}
