import type { ContextRoomKind, ContextRoomRecord } from './types'

interface EmptyContextRoomInput {
  id: string
  title: string
  kind: ContextRoomKind
  background: string
  goal: string
  briefStatus: string
  origin?: 'user' | 'auto'
}

export function createEmptyContextRoom(input: EmptyContextRoomInput): ContextRoomRecord {
  return {
    id: input.id,
    title: input.title,
    kind: input.kind,
    icon: input.kind,
    tone: 'zinc',
    status: '进行中',
    starred: false,
    lastViewed: '刚刚',
    roomCode: input.id.toUpperCase(),
    ...(input.origin ? { origin: input.origin } : {}),
    brief: {
      background: input.background,
      goal: input.goal,
      status: input.briefStatus,
      risks: [],
      decisions: [],
    },
    stats: { docs: 0, mails: 0, meetings: 0, events: 0, memories: 0, tasks: 0 },
    riskCount: 0,
    pendingMemoryCount: 0,
    people: [],
    timeline: [],
    materials: [],
    actionItems: [],
    graphEdges: [],
    pendingMemoryItems: [],
    memoryItems: [],
    fileItems: [],
    nextReverseRecall: '暂无',
    cloudDoc: {
      workspaceId: 'local-placeholder',
      docId: `local-${input.id}`,
      title: input.title,
    },
  }
}
