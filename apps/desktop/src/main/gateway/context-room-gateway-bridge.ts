import type {
  ContextRoomSnapshot,
  ContextRoomSnapshotItem,
  CreateContextRoomInput,
  CreateContextRoomResult,
  RoomDuplicateCandidate,
  RoomDuplicateCandidateStatus,
  RoomDuplicateCheckInput,
  RoomDuplicateCheckResult,
  RoomAppliedEntitiesResult,
  RoomOverviewProjection,
  RoomMergeOperation,
  RoomMergePreview,
  RoomMail,
  SaveContextRoomSnapshotInput,
  SubagentInvocation,
} from '@nxcore/agent-contract'

import type { GatewaySupervisor } from './gateway-supervisor'

export class ContextRoomGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  list(): Promise<ContextRoomSnapshot> {
    return this.request('/v1/context-rooms')
  }

  create(input: CreateContextRoomInput): Promise<CreateContextRoomResult> {
    return this.request('/v1/context-rooms', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  syncSnapshot(input: SaveContextRoomSnapshotInput): Promise<ContextRoomSnapshot> {
    return this.request('/v1/context-rooms/snapshot', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  }

  checkDuplicates(input: RoomDuplicateCheckInput): Promise<RoomDuplicateCheckResult> {
    return this.request('/v1/context-rooms/duplicate-check', { method: 'POST', body: JSON.stringify(input) })
  }

  listDuplicateCandidates(status?: RoomDuplicateCandidateStatus): Promise<{ items: RoomDuplicateCandidate[] }> {
    const query = status ? `?status=${encodeURIComponent(status)}` : ''
    return this.request(`/v1/context-rooms/duplicate-candidates${query}`)
  }

  updateDuplicateCandidate(id: string, status: 'related' | 'distinct'): Promise<RoomDuplicateCandidate> {
    return this.request(`/v1/context-rooms/duplicate-candidates/${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    })
  }

  previewMerge(sourceRoomId: string, targetRoomId: string): Promise<RoomMergePreview> {
    return this.request('/v1/context-rooms/merge-preview', {
      method: 'POST', body: JSON.stringify({ sourceRoomId, targetRoomId }),
    })
  }

  startMerge(input: { sourceRoomId: string; targetRoomId: string; previewHash: string; idempotencyKey: string }): Promise<RoomMergeOperation> {
    return this.request('/v1/context-rooms/merge-operations', { method: 'POST', body: JSON.stringify(input) })
  }

  getMergeOperation(id: string): Promise<RoomMergeOperation> {
    return this.request(`/v1/context-rooms/merge-operations/${encodeURIComponent(id)}`)
  }

  retryMerge(id: string): Promise<RoomMergeOperation> {
    return this.request(`/v1/context-rooms/merge-operations/${encodeURIComponent(id)}/retry`, { method: 'POST' })
  }

  cancelMerge(id: string): Promise<RoomMergeOperation> {
    return this.request(`/v1/context-rooms/merge-operations/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
  }

  /** 划词改写：dispatch context-room 子 Agent，立即返回 invocationId（不等待终态）。 */
  dispatchSelectionRewrite(input: {
    roomId?: string
    documentName?: string
    selectedText: string
    instruction?: string
    contextBefore?: string
    contextAfter?: string
    blockType?: string
    responseLanguage?: string
  }): Promise<{ invocationId: string }> {
    return this.request('/v1/context-rooms/selection-rewrite', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  getSubagentInvocation(invocationId: string): Promise<SubagentInvocation> {
    return this.request(`/v1/subagent-invocations/${encodeURIComponent(invocationId)}`)
  }

  cancelSubagentInvocation(invocationId: string): Promise<SubagentInvocation> {
    return this.request(`/v1/subagent-invocations/${encodeURIComponent(invocationId)}/cancel`, { method: 'POST' })
  }

  refreshBrief(roomId: string): Promise<ContextRoomSnapshotItem> {
    return this.request(`/v1/context-rooms/${encodeURIComponent(roomId)}/refresh-brief`, { method: 'POST' })
  }

  overview(roomId: string): Promise<RoomOverviewProjection> {
    return this.request(`/v1/context-rooms/${encodeURIComponent(roomId)}/overview`)
  }

  /** Room 邮箱面板的连接器邮件清单（sentAt 倒序，截 500）。 */
  listMails(roomId: string): Promise<{ items: RoomMail[] }> {
    return this.request(`/v1/context-rooms/${encodeURIComponent(roomId)}/mails`)
  }

  refreshOverview(roomId: string): Promise<RoomOverviewProjection> {
    return this.request(`/v1/context-rooms/${encodeURIComponent(roomId)}/overview/refresh`, { method: 'POST' })
  }

  /** Room 关联的应用实体（room_entity_mentions + entities 实时状态）。 */
  roomEntities(roomId: string): Promise<RoomAppliedEntitiesResult> {
    return this.request(`/v1/context-rooms/${encodeURIComponent(roomId)}/entities`)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${connection.token}`)
    if (init?.body !== undefined && init.body !== null) headers.set('Content-Type', 'application/json')
    const response = await fetch(`${connection.baseUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      const message = typeof body?.message === 'string'
        ? body.message
        : typeof body?.error === 'string'
          ? body.error
          : `Room 请求失败（${response.status}）`
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }
}
