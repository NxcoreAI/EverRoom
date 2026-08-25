import type {
  ContextRoomSnapshot,
  CreateContextRoomInput,
  CreateContextRoomResult,
  RoomDuplicateCandidate,
  RoomDuplicateCandidateStatus,
  RoomDuplicateCheckInput,
  RoomDuplicateCheckResult,
  RoomMergeOperation,
  RoomMergePreview,
  SaveContextRoomSnapshotInput,
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
