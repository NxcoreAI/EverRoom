import {
  isRealitySocketFrame,
  type ApplyRealityAsrInput,
  type CreateRealityEventInput,
  type FinishRealityCaptureInput,
  type ImportRealityEventInput,
  type MarkRealityEventInput,
  type RealityEvent,
  type RealityEventStatus,
  type UpdateRealityTranscriptInput,
} from '@nxcore/reality-contract'
import type { AxiosRequestConfig } from 'axios'
import { isAxiosError } from 'axios'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import type { AsrJob } from '../../shared/sources'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'
import { WebContentsLifecycle } from './web-contents-lifecycle'

const REALITY_EVENT_CHANNEL = 'reality:event'
const http = createLoggedHttpClient('gateway-reality')
const RECOVERABLE_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
])

function isRecoverableConnectionError(error: unknown): boolean {
  if (!isAxiosError(error)) return false
  if (error.code && RECOVERABLE_CONNECTION_ERROR_CODES.has(error.code)) return true
  return typeof error.message === 'string' && /socket hang up/i.test(error.message)
}

interface Subscription {
  socket: WebSocket
  closed: boolean
  reconnectTimer: NodeJS.Timeout | null
}

export class RealityGatewayBridge {
  private readonly subscriptions = new Map<number, Subscription>()
  private readonly contentsLifecycle = new WebContentsLifecycle()

  constructor(private readonly supervisor: GatewaySupervisor) {}

  listEvents(filters: { status?: RealityEventStatus; search?: string } = {}): Promise<RealityEvent[]> {
    return this.request('/v1/reality/events', { params: filters })
  }

  getEvent(id: string): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}`)
  }

  createEvent(input: CreateRealityEventInput): Promise<RealityEvent> {
    return this.request('/v1/reality/events', { method: 'POST', data: input })
  }

  finishCapture(id: string, input: FinishRealityCaptureInput): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/capture-finished`, {
      method: 'POST',
      data: input,
    })
  }

  importEvent(input: ImportRealityEventInput): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(input.id)}/import`, {
      method: 'PUT',
      data: input,
    })
  }

  applyAsr(id: string, job: AsrJob): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/asr`, {
      method: 'POST',
      data: this.asrInput(job),
    })
  }

  applyAsrByJob(job: AsrJob): Promise<RealityEvent> {
    return this.request(`/v1/reality/asr-jobs/${encodeURIComponent(job.id)}`, {
      method: 'POST',
      data: this.asrInput(job),
    })
  }

  updateTranscript(id: string, input: UpdateRealityTranscriptInput): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/transcript`, {
      method: 'PATCH',
      data: input,
    })
  }

  addMarker(id: string, input: MarkRealityEventInput): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/markers`, {
      method: 'POST',
      data: input,
    })
  }

  setImportant(id: string, important: boolean): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/important`, {
      method: 'PATCH',
      data: { important },
    })
  }

  confirm(id: string): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/confirm`, { method: 'POST', data: {} })
  }

  async discard(id: string): Promise<void> {
    await this.request(`/v1/reality/events/${this.id(id)}`, { method: 'DELETE' })
  }

  fail(id: string, error: string): Promise<RealityEvent> {
    return this.request(`/v1/reality/events/${this.id(id)}/fail`, {
      method: 'POST',
      data: { error },
    })
  }

  async readAudio(id: string): Promise<Uint8Array> {
    const response = await this.rawRequest<ArrayBuffer>(`/v1/reality/events/${this.id(id)}/audio`, {
      responseType: 'arraybuffer',
    })
    return new Uint8Array(response)
  }

  subscribe(contents: WebContents): void {
    this.unsubscribe(contents.id)
    const subscription: Subscription = {
      socket: this.openSocket(contents),
      closed: false,
      reconnectTimer: null,
    }
    this.subscriptions.set(contents.id, subscription)
    this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id))
  }

  unsubscribe(contentsId: number): void {
    const subscription = this.subscriptions.get(contentsId)
    if (!subscription) return
    subscription.closed = true
    if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer)
    subscription.socket.close()
    this.subscriptions.delete(contentsId)
  }

  dispose(): void {
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id)
  }

  private openSocket(contents: WebContents): WebSocket {
    const connection = this.supervisor.getConnection()
    const url = new URL(connection.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/v1/reality/stream'
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    socket.on('message', (data) => {
      if (contents.isDestroyed()) return
      try {
        const frame: unknown = JSON.parse(data.toString())
        if (isRealitySocketFrame(frame)) contents.send(REALITY_EVENT_CHANNEL, frame)
      } catch {
        // Invalid frames are ignored; the REST snapshot remains authoritative.
      }
    })
    socket.on('close', () => {
      const subscription = this.subscriptions.get(contents.id)
      if (!subscription || subscription.closed || contents.isDestroyed()) return
      subscription.reconnectTimer = setTimeout(() => {
        const current = this.subscriptions.get(contents.id)
        if (!current || current.closed || contents.isDestroyed()) return
        current.socket = this.openSocket(contents)
      }, 1_000)
    })
    socket.on('error', () => undefined)
    return socket
  }

  private asrInput(job: AsrJob): ApplyRealityAsrInput {
    return {
      jobId: job.id,
      source: job.source,
      status: job.status,
      result: job.result,
      error: job.error,
      resultVersion: Math.max(1, Date.parse(job.updatedAt)),
    }
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    return this.rawRequest<T>(path, config)
  }

  private async rawRequest<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = this.supervisor.getConnection()
    try {
      return await this.rawRequestWithConnection<T>(connection, path, config)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error
      const recoveredConnection = await this.supervisor.recoverConnection(connection)
      return this.rawRequestWithConnection<T>(recoveredConnection, path, config)
    }
  }

  private async rawRequestWithConnection<T>(
    connection: ReturnType<GatewaySupervisor['getConnection']>,
    path: string,
    config: AxiosRequestConfig,
  ): Promise<T> {
    const response = await http.request<T & { message?: unknown }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      throw new Error(
        typeof response.data?.message === 'string'
          ? response.data.message
          : `现实感知请求失败（${response.status}）`,
      )
    }
    return response.data
  }

  private id(value: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error('无效的现实感知事件标识。')
    return encodeURIComponent(value)
  }
}
