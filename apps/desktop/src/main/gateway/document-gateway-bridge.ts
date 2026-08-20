import type {
  DocumentBlockList,
  DocumentBlockBacklinkList,
  DocumentEventFrame,
  DocumentOperation,
  DocumentOperationCommandInput,
  DocumentOperationCommandResult,
  DocumentOperationList,
  DocumentOperationStatus,
  DocumentOperationSummary,
  DocumentVersionSummary,
  ImportRoomDocumentInput,
  RoomDocument,
  ResolveDocumentBlockReferencesInput,
  ResolveDocumentBlockReferencesResult,
  SaveRoomDocumentInput,
  StartDocumentOperationInput,
} from '@nxcore/agent-contract'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import type { GatewaySupervisor } from './gateway-supervisor'
import { WebContentsLifecycle } from './web-contents-lifecycle'

export const DOCUMENT_EVENT_CHANNEL = 'documents:event'
export const DOCUMENT_OPERATION_EVENT_CHANNEL = 'documents:operation-changed'

interface Subscription {
  roomId: string
  socket: WebSocket
  closed: boolean
  reconnectTimer: NodeJS.Timeout | null
}

const SAVE_RETRY_DELAYS_MS = [250, 500, 1_000, 1_500] as const

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isConnectionRefused(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  return Boolean(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ECONNREFUSED')
}

function isDocumentEventFrame(value: unknown): value is DocumentEventFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as Partial<DocumentEventFrame>
  return frame.type === 'document.event' && frame.protocol === 1 && Boolean(frame.event)
}

export function operationIdFromDocumentEvent(frame: DocumentEventFrame): string | null {
  if (frame.event.type !== 'document.operation.changed') return null
  const payload = frame.event.payload
  if (!payload || typeof payload !== 'object') return null
  const value = payload as Record<string, unknown>
  const operation = value.operation && typeof value.operation === 'object'
    ? value.operation as Record<string, unknown>
    : null
  const id = typeof operation?.id === 'string'
    ? operation.id
    : typeof value.operationId === 'string' ? value.operationId : ''
  return id.trim() || null
}

export function documentOperationListResult(
  result: DocumentOperationList,
): DocumentOperationSummary[] {
  return result.operations
}

export class DocumentGatewayBridge {
  private readonly subscriptions = new Map<number, Map<string, Subscription>>()
  private readonly contentsLifecycle = new WebContentsLifecycle()

  constructor(private readonly supervisor: GatewaySupervisor) {}

  list(roomId: string): Promise<RoomDocument[]> {
    return this.request(`/v1/documents?${new URLSearchParams({ roomId })}`)
  }

  listTrash(roomId: string): Promise<RoomDocument[]> {
    return this.request(`/v1/documents?${new URLSearchParams({ roomId, trashed: 'true' })}`)
  }

  get(documentId: string): Promise<RoomDocument> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`)
  }

  listBlocks(documentId: string): Promise<DocumentBlockList> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/blocks`)
  }

  listBlockBacklinks(documentId: string, blockId?: string): Promise<DocumentBlockBacklinkList> {
    const query = blockId ? `?${new URLSearchParams({ blockId })}` : ''
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/backlinks${query}`)
  }

  listVersions(documentId: string): Promise<DocumentVersionSummary[]> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/versions`)
  }

  restoreVersion(documentId: string, version: number, baseVersion: number): Promise<RoomDocument> {
    return this.request(
      `/v1/documents/${encodeURIComponent(documentId)}/versions/${String(version)}/restore`,
      { method: 'POST', body: JSON.stringify({ baseVersion }) },
      true,
    )
  }

  resolveBlockReferences(input: ResolveDocumentBlockReferencesInput): Promise<ResolveDocumentBlockReferencesResult> {
    return this.request('/v1/document-blocks/resolve', { method: 'POST', body: JSON.stringify(input) })
  }

  async listOperations(filters: {
    roomId?: string
    documentId?: string
    sessionId?: string
    status?: DocumentOperationStatus
  } = {}): Promise<DocumentOperationSummary[]> {
    const query = new URLSearchParams()
    if (filters.roomId) query.set('roomId', filters.roomId)
    if (filters.documentId) query.set('documentId', filters.documentId)
    if (filters.sessionId) query.set('sessionId', filters.sessionId)
    if (filters.status) query.set('status', filters.status)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const result = await this.request<DocumentOperationList>(
      `/v1/document-operations${suffix}`,
    )
    return documentOperationListResult(result)
  }

  startOperation(input: StartDocumentOperationInput): Promise<DocumentOperation> {
    return this.request('/v1/document-operations', {
      method: 'POST',
      body: JSON.stringify(input),
    }, true)
  }

  getOperation(operationId: string): Promise<DocumentOperation> {
    return this.request(`/v1/document-operations/${encodeURIComponent(operationId)}`)
  }

  executeOperationCommand(
    operationId: string,
    input: DocumentOperationCommandInput,
  ): Promise<DocumentOperationCommandResult> {
    return this.request(`/v1/document-operations/${encodeURIComponent(operationId)}/commands`, {
      method: 'POST',
      body: JSON.stringify(input),
    }, true)
  }

  import(input: ImportRoomDocumentInput): Promise<RoomDocument> {
    return this.request('/v1/documents/import', { method: 'POST', body: JSON.stringify(input) })
  }

  save(documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }, true)
  }

  delete(documentId: string): Promise<void> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' })
  }

  restore(documentId: string): Promise<RoomDocument> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/restore`, { method: 'POST' })
  }

  deletePermanently(documentId: string): Promise<void> {
    return this.request(`/v1/documents/${encodeURIComponent(documentId)}/permanent`, { method: 'DELETE' })
  }

  emptyTrash(roomId: string): Promise<void> {
    return this.request(`/v1/documents/trash?${new URLSearchParams({ roomId })}`, { method: 'DELETE' })
  }

  subscribe(contents: WebContents, roomId: string): void {
    let subscriptions = this.subscriptions.get(contents.id)
    if (!subscriptions) {
      subscriptions = new Map()
      this.subscriptions.set(contents.id, subscriptions)
      this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id))
    }
    if (subscriptions.has(roomId)) return
    const subscription: Subscription = {
      roomId,
      socket: this.openSocket(contents, roomId),
      closed: false,
      reconnectTimer: null,
    }
    subscriptions.set(roomId, subscription)
  }

  unsubscribe(contentsId: number, roomId?: string): void {
    const subscriptions = this.subscriptions.get(contentsId)
    if (!subscriptions) return
    const targets = roomId ? [subscriptions.get(roomId)].filter(Boolean) as Subscription[] : [...subscriptions.values()]
    for (const subscription of targets) {
      subscription.closed = true
      if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer)
      subscription.socket.close()
      subscriptions.delete(subscription.roomId)
    }
    if (subscriptions.size === 0) this.subscriptions.delete(contentsId)
  }

  dispose(): void {
    for (const contentsId of [...this.subscriptions.keys()]) this.unsubscribe(contentsId)
  }

  private openSocket(contents: WebContents, roomId: string): WebSocket {
    const connection = this.supervisor.getConnection()
    const url = new URL(connection.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `/v1/documents/rooms/${encodeURIComponent(roomId)}/stream`
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    socket.on('message', (data) => {
      if (contents.isDestroyed()) return
      try {
        const frame: unknown = JSON.parse(data.toString())
        if (isDocumentEventFrame(frame)) {
          contents.send(DOCUMENT_EVENT_CHANNEL, frame)
          const operationId = operationIdFromDocumentEvent(frame)
          if (operationId) contents.send(DOCUMENT_OPERATION_EVENT_CHANNEL, operationId)
        }
      } catch {
        // A reconnect refreshes the authoritative document list.
      }
    })
    socket.on('close', () => {
      const subscription = this.subscriptions.get(contents.id)?.get(roomId)
      if (!subscription || subscription.closed || contents.isDestroyed()) return
      subscription.reconnectTimer = setTimeout(() => {
        const current = this.subscriptions.get(contents.id)?.get(roomId)
        if (!current || current.closed || contents.isDestroyed()) return
        current.socket = this.openSocket(contents, roomId)
      }, 750)
    })
    socket.on('error', () => undefined)
    return socket
  }

  private async request<T>(path: string, init?: RequestInit, retryWhenUnavailable = false): Promise<T> {
    const connection = this.supervisor.getConnection()
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${connection.token}`)
    if (init?.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    let response: Response | null = null
    for (let attempt = 0; response === null; attempt += 1) {
      try {
        response = await fetch(`${connection.baseUrl}${path}`, {
          ...init,
          headers,
        })
      } catch (error) {
        const retryDelay = SAVE_RETRY_DELAYS_MS[attempt]
        if (!retryWhenUnavailable || !isConnectionRefused(error) || retryDelay === undefined) throw error
        await delay(retryDelay)
      }
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      const message = typeof body?.message === 'string' ? body.message : `文档请求失败（${response.status}）`
      throw new Error(typeof body?.error === 'string' ? `${body.error}: ${message}` : message)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
