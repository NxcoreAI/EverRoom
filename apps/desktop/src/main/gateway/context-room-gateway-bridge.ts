import type {
  ContextRoomSnapshot,
  SaveContextRoomSnapshotInput,
} from '@nxcore/agent-contract'

import type { GatewaySupervisor } from './gateway-supervisor'

export class ContextRoomGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  list(): Promise<ContextRoomSnapshot> {
    return this.request('/v1/context-rooms')
  }

  syncSnapshot(input: SaveContextRoomSnapshotInput): Promise<ContextRoomSnapshot> {
    return this.request('/v1/context-rooms/snapshot', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
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
