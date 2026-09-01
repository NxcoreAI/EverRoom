import { timingSafeEqual, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { AgentNotificationRequest } from '../../shared/notifications'
import type { SaasClient } from './saas-client'

const MAX_BODY_BYTES = 8 * 1024

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validBody(value: unknown): value is AgentNotificationRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<AgentNotificationRequest>
  return typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 80
    && typeof input.body === 'string' && input.body.trim().length > 0 && input.body.trim().length <= 120
    && Array.isArray(input.platforms) && input.platforms.length > 0
    && input.platforms.every((platform) => platform === 'ios' || platform === 'macos')
    && typeof input.sessionId === 'string' && input.sessionId.length > 0
    && typeof input.runId === 'string' && input.runId.length > 0
    && (input.roomId === null || typeof input.roomId === 'string')
    && typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= 8
    && (input.local === undefined || typeof input.local === 'boolean')
}

export interface LocalAgentNotification {
  title: string
  body: string
  notificationId: string
  sessionId: string
  runId: string
  roomId: string | null
}

export class AgentNotificationBridgeServer {
  private server: Server | null = null
  private readonly token = randomBytes(32).toString('base64url')
  constructor(
    private readonly client: () => SaasClient | null,
    private readonly showLocalNotification: (notification: LocalAgentNotification) => void = () => undefined,
  ) {}

  async start(): Promise<{ baseUrl: string; token: string }> {
    if (this.server) throw new Error('Agent notification bridge is already running')
    const server = createServer((request, response) => {
      void this.handle(request).then(({ status, body }) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(body))
      }).catch((error) => {
        response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Notification bridge failed' }))
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Notification bridge did not bind a TCP port')
    return { baseUrl: `http://127.0.0.1:${address.port}`, token: this.token }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    if (request.method !== 'POST' || request.url !== '/v1/agent-notifications') return { status: 404, body: { message: 'Not found' } }
    if (!authorized(request, this.token)) return { status: 401, body: { message: 'Unauthorized' } }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) return { status: 413, body: { message: 'Request body is too large' } }
      chunks.push(buffer)
    }
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return { status: 400, body: { message: 'Invalid JSON' } } }
    if (!validBody(parsed)) return { status: 422, body: { message: 'Invalid notification request' } }
    const client = this.client()
    if (!client) return { status: 503, body: { message: 'EverRoom account service is not ready' } }
    // `local` 是 Gateway→Bridge 的内部标志（本机兜底通知），不透传给 SaaS。
    const { local: showLocal, ...remoteRequest } = parsed
    const result = await client.createAgentNotification(remoteRequest) as { notificationId?: unknown }
    if (showLocal) {
      const notificationId = typeof result.notificationId === 'string' ? result.notificationId : ''
      if (notificationId) {
        this.showLocalNotification({
          title: parsed.title,
          body: parsed.body,
          notificationId,
          sessionId: parsed.sessionId,
          runId: parsed.runId,
          roomId: parsed.roomId,
        })
      }
    }
    return { status: 200, body: { data: result } }
  }
}
