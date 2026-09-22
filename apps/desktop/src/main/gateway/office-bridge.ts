import { randomBytes, timingSafeEqual } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { FileImportAcceptedDto } from '../../shared/ingest'
import type { OfficeAgentFileEvent, OfficeAgentFileFormat } from '../../shared/office'
import type { FilesGatewayBridge } from './files-gateway-bridge'
import type {
  SlidesEditArtifactOutcome,
  SlidesEditArtifactRequest,
} from '../office/office-preview-registry'
import { generateDocxFromHtml, generatePptxFromPageSpecs, generateXlsxFromSheets, type DocxGenerationPhase } from '../office/office-generation'
import type { AgentSheetInput } from '../office/xlsx-generation'

// HTML 正文 / 页 spec / 表格 JSON 远大于通知，放宽到 2MB；超过视为模型输出异常。
const MAX_BODY_BYTES = 2 * 1024 * 1024

export type OfficeGenerateFormat = 'docx' | 'pptx' | 'xlsx'

export interface OfficeGenerateRequest {
  title: string
  /** 缺省 docx（与旧客户端兼容）。 */
  format?: OfficeGenerateFormat
  /** docx 正文。 */
  html?: string | null
  /** pptx：每页一个 PageSpec JSON 字符串（1280×720 画布）。 */
  pages?: string[] | null
  /** xlsx：sheets→rows 结构。 */
  sheets?: AgentSheetInput[] | null
  roomId: string | null
  fileName: string | null
  idempotencyKey: string
}

/** Agent 编辑已打开 slides 产物的请求（gateway 工具 → /v1/office-edit）。 */
export interface OfficeEditRequest {
  mode: 'read' | 'apply'
  fileId: string
  ops?: unknown[]
  dryRun?: boolean
  isolation?: 'atomic' | 'per_op'
}

const FORMAT_EXT: Record<OfficeGenerateFormat, string> = { docx: '.docx', pptx: '.pptx', xlsx: '.xlsx' }
const FORMAT_SOURCE: Record<OfficeGenerateFormat, string> = { docx: 'word', pptx: 'pptx', xlsx: 'xlsx' }

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const left = Buffer.from(supplied)
  const right = Buffer.from(token)
  return left.length === right.length && timingSafeEqual(left, right)
}

function validBody(value: unknown): value is OfficeGenerateRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeGenerateRequest>
  if (!(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 120)) return false
  const format: OfficeGenerateFormat = input.format ?? 'docx'
  if (format !== 'docx' && format !== 'pptx' && format !== 'xlsx') return false
  if (format === 'docx' && !(typeof input.html === 'string' && input.html.length > 0)) return false
  if (format === 'pptx') {
    if (!Array.isArray(input.pages) || input.pages.length === 0) return false
    if (!input.pages.every((page) => typeof page === 'string' && page.length > 0)) return false
  }
  if (format === 'xlsx') {
    if (!Array.isArray(input.sheets) || input.sheets.length === 0) return false
    if (!input.sheets.every((sheet) => sheet && typeof sheet === 'object' && Array.isArray(sheet.rows))) return false
  }
  return (input.roomId == null || typeof input.roomId === 'string')
    && (input.fileName == null || typeof input.fileName === 'string')
    && typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= 8
}

function validEditBody(value: unknown): value is OfficeEditRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeEditRequest>
  if (typeof input.fileId !== 'string' || !input.fileId) return false
  if (input.mode !== 'read' && input.mode !== 'apply') return false
  if (input.mode === 'apply' && !Array.isArray(input.ops)) return false
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') return false
  if (input.isolation !== undefined && input.isolation !== 'atomic' && input.isolation !== 'per_op') return false
  return true
}

/**
 * Gateway → 桌面主进程的 Office 生成桥（loopback HTTP + Bearer token，仿
 * AgentNotificationBridgeServer）。gateway 的 capability 工具经此生成
 * Word（隐藏 docs view）/ PPT（主进程本地拼装）/ Excel（jszip 拼 OOXML）
 * 并走 file-imports 入库；/v1/office-edit 把 Agent 的编辑事务送进已打开
 * 的 slides 活会话（编辑过程实时重绘在打开的视图上）。
 */
export class OfficeBridgeServer {
  private server: Server | null = null
  private readonly token = randomBytes(32).toString('base64url')
  /** filesGatewayBridge / slidesEdit 在 bridge 启动之后才创建：惰性取最新引用。 */
  constructor(
    private readonly filesBridge: () => FilesGatewayBridge | null,
    private readonly broadcast: (event: OfficeAgentFileEvent) => void = () => undefined,
    private readonly slidesEdit: () =>
      | ((fileId: string, req: SlidesEditArtifactRequest) => Promise<SlidesEditArtifactOutcome>)
      | null = () => null,
  ) {}

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
    if (request.method !== 'POST') return { status: 404, body: { message: 'Not found' } }
    if (request.url !== '/v1/office-generate' && request.url !== '/v1/office-edit') {
      return { status: 404, body: { message: 'Not found' } }
    }
    if (!authorized(request, this.token)) return { status: 401, body: { message: 'Unauthorized' } }
    const read = await this.readJsonBody(request)
    if ('error' in read) return read.error
    if (request.url === '/v1/office-edit') {
      if (!validEditBody(read.parsed)) return { status: 422, body: { message: 'Invalid office edit request' } }
      return this.edit(read.parsed)
    }
    if (!validBody(read.parsed)) return { status: 422, body: { message: 'Invalid office generate request' } }
    return this.generate(read.parsed)
  }

  private async readJsonBody(
    request: IncomingMessage,
  ): Promise<{ parsed: unknown } | { error: { status: number; body: Record<string, unknown> } }> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) return { error: { status: 413, body: { message: 'Request body is too large' } } }
      chunks.push(buffer)
    }
    try {
      return { parsed: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    } catch {
      return { error: { status: 400, body: { message: 'Invalid JSON' } } }
    }
  }

  private async edit(req: OfficeEditRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const slidesEdit = this.slidesEdit()
    if (!slidesEdit) return { status: 503, body: { message: 'EverRoom Office 编辑会话尚未就绪' } }
    const artifactReq: SlidesEditArtifactRequest =
      req.mode === 'read'
        ? { mode: 'read' }
        : { mode: 'apply', ops: req.ops ?? [], dryRun: req.dryRun, isolation: req.isolation }
    let outcome: SlidesEditArtifactOutcome
    try {
      outcome = await slidesEdit(req.fileId, artifactReq)
    } catch (error) {
      return { status: 502, body: { message: error instanceof Error ? error.message : 'Office edit failed' } }
    }
    if (!outcome.ok) {
      const message =
        outcome.reason === 'not_editable'
          ? '该 PPT 当前不是以可编辑的 PPT 产物打开的。请在 Room 产物库中重新打开后再编辑。'
          : 'PPT 未在 Room 中打开。请先在产物库中打开该文件（Agent 的编辑会实时显示在打开的视图上），然后再试。'
      return { status: 422, body: { code: outcome.reason, message } }
    }
    return { status: 200, body: { data: outcome.info ?? outcome.result ?? {} } }
  }

  private async generate(parsed: OfficeGenerateRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const files = this.filesBridge()
    if (!files) return { status: 503, body: { message: 'EverRoom 文件服务尚未就绪' } }

    try {
      const format: OfficeGenerateFormat = parsed.format ?? 'docx'
      const broadcastPhase = (phase: DocxGenerationPhase) => {
        this.broadcast({ type: 'phase', title: parsed.title, phase, format })
      }
      const generated =
        format === 'docx'
          ? await generateDocxFromHtml({ title: parsed.title, html: parsed.html! }, broadcastPhase)
          : format === 'pptx'
            ? await generatePptxFromPageSpecs({ title: parsed.title, pages: parsed.pages! }, broadcastPhase)
            : await generateXlsxFromSheets({ title: parsed.title, sheets: parsed.sheets! }, broadcastPhase)
      const originalName = parsed.fileName?.trim() || `${generated.title}${FORMAT_EXT[format]}`
      this.broadcast({ type: 'phase', title: parsed.title, phase: 'importing', format })
      let accepted: FileImportAcceptedDto
      try {
        accepted = await files.importAgentGeneratedFile({
          filePath: generated.filePath,
          originalName,
          // 同 idempotencyKey 重试 → 同 sourceKey：同内容去重 / 新内容进版本链。
          sourceKey: `agent:${FORMAT_SOURCE[format]}:${parsed.idempotencyKey}`,
          ...(parsed.roomId ? { roomId: parsed.roomId } : {}),
        })
      } catch (error) {
        // 入库失败保留临时文件供人工恢复（docx 在 defaultSaveDir，其余在系统 temp）。
        const kindLabel = format === 'docx' ? 'Word' : format === 'pptx' ? 'PPT' : 'Excel'
        throw new Error(
          `${kindLabel} 已生成（${generated.filePath}）但入库失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await rm(generated.filePath, { force: true }).catch(() => undefined)
      this.broadcast({
        type: 'done',
        title: parsed.title,
        format,
        fileId: accepted.fileEntryId,
        originalName,
        roomId: parsed.roomId,
      })
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
    } catch (error) {
      this.broadcast({
        type: 'error',
        title: parsed.title,
        format: parsed.format ?? 'docx',
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
}
