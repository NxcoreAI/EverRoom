import type {
  AcknowledgeDocumentTransactionInput,
  DocumentEventFrame,
  ImportRoomDocumentInput,
  RoomDocument,
  SaveRoomDocumentInput,
} from '@nxcore/agent-contract'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import type { GatewaySupervisor } from './gateway-supervisor'

export const DOCUMENT_EVENT_CHANNEL = 'documents:event'

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

export class DocumentGatewayBridge {
  private readonly subscriptions = new Map<number, Map<string, Subscription>>()

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

  acknowledge(transactionId: string, input: AcknowledgeDocumentTransactionInput): Promise<void> {
    return this.request(`/v1/document-transactions/${encodeURIComponent(transactionId)}/ack`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  }

  subscribe(contents: WebContents, roomId: string): void {
    let subscriptions = this.subscriptions.get(contents.id)
    if (!subscriptions) {
      subscriptions = new Map()
      this.subscriptions.set(contents.id, subscriptions)
      contents.once('destroyed', () => this.unsubscribe(contents.id))
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
        if (isDocumentEventFrame(frame)) contents.send(DOCUMENT_EVENT_CHANNEL, frame)
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
      const body = await response.json().catch(() => null) as { message?: unknown } | null
      throw new Error(typeof body?.message === 'string' ? body.message : `文档请求失败（${response.status}）`)
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
