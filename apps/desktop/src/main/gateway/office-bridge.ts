import { randomBytes, timingSafeEqual } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { FileImportAcceptedDto } from '../../shared/ingest'
import type { FilesGatewayBridge } from './files-gateway-bridge'
import { generateDocxFromHtml } from '../office/office-generation'

// HTML 正文远大于通知，放宽到 2MB；超过视为模型输出异常。
const MAX_BODY_BYTES = 2 * 1024 * 1024

export interface OfficeGenerateRequest {
  title: string
  html: string
  roomId: string | null
  fileName: string | null
  idempotencyKey: string
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validBody(value: unknown): value is OfficeGenerateRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeGenerateRequest>
  return typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 120
    && typeof input.html === 'string' && input.html.length > 0
    && (input.roomId == null || typeof input.roomId === 'string')
    && (input.fileName == null || typeof input.fileName === 'string')
    && typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= 8
}

/**
 * Gateway → 桌面主进程的 Office 生成桥（loopback HTTP + Bearer token，仿
 * AgentNotificationBridgeServer）。gateway 的 capability 工具经此驱动隐藏
 * GenOffice docs view 生成 docx 并走 file-imports 入库。
 */
export class OfficeBridgeServer {
  private server: Server | null = null
  private readonly token = randomBytes(32).toString('base64url')
  /** filesGatewayBridge 在 bridge 启动之后才创建：惰性取最新引用。 */
  constructor(private readonly filesBridge: () => FilesGatewayBridge | null) {}

  async start(): Promise<{ baseUrl: string; token: string }> {
    if (this.server) throw new Error('Office bridge is already running')
    const server = createServer((request, response) => {
      void this.handle(request).then(({ status, body }) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(body))
      }).catch((error) => {
        response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify({ message: error instanceof Error ? error.message : 'Office bridge failed' }))
      })
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Office bridge did not bind a TCP port')
    return { baseUrl: `http://127.0.0.1:${address.port}`, token: this.token }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    if (request.method !== 'POST' || request.url !== '/v1/office-generate') return { status: 404, body: { message: 'Not found' } }
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
    if (!validBody(parsed)) return { status: 422, body: { message: 'Invalid office generate request' } }
    const files = this.filesBridge()
    if (!files) return { status: 503, body: { message: 'EverRoom 文件服务尚未就绪' } }

    const generated = await generateDocxFromHtml({ title: parsed.title, html: parsed.html })
    const originalName = parsed.fileName?.trim() || `${generated.title}.docx`
    let accepted: FileImportAcceptedDto
    try {
      accepted = await files.importAgentGeneratedFile({
        filePath: generated.filePath,
        originalName,
        // 同 idempotencyKey 重试 → 同 sourceKey：同内容去重 / 新内容进版本链。
        sourceKey: `agent:word:${parsed.idempotencyKey}`,
        ...(parsed.roomId ? { roomId: parsed.roomId } : {}),
      })
    } catch (error) {
      // 入库失败保留临时文件（defaultSaveDir 下的 <title>.docx）供人工恢复。
      throw new Error(
        `Word 已生成（${generated.filePath}）但入库失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    await rm(generated.filePath, { force: true }).catch(() => undefined)
    return {
      status: 200,
      body: {
        data: {
          fileEntryId: accepted.fileEntryId,
          fileVersionId: accepted.fileVersionId,
          jobId: accepted.jobId,
          contentHash: accepted.contentHash,
          blobDeduped: accepted.blobDeduped,
          versionDeduped: accepted.versionDeduped,
          // Room 投影由路由决策异步完成（router 关闭时会降级不进 Room），
          // 此字段只表达「本次是否请求了 Room 路由」。
          roomRequested: Boolean(parsed.roomId),
          originalName,
        },
      },
    }
  }
}
