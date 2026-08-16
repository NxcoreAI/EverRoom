import type { ContextRoomRecord } from '../src/renderer/src/components/context-room/ported/types'

export function createContextRoomFixture(
  id = 'room-test',
  title = '测试 Room',
): ContextRoomRecord {
  return {
    id,
    title,
    kind: '项目',
    icon: '项目',
    tone: 'zinc',
    status: '进行中',
    starred: false,
    lastViewed: '刚刚',
    roomCode: id.toUpperCase(),
    brief: {
      background: '',
      goal: '',
      status: '',
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
    cloudDoc: { workspaceId: 'gateway', docId: `${id}-document`, title },
  }
}
