import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'

import type { FileImportAcceptedDto } from '../../shared/ingest'
import type { OfficeAgentFileEvent, OfficeAgentFileFormat } from '../../shared/office'
import { officePreviewKindForFileName } from '../../shared/sources'
import type { FilesGatewayBridge } from './files-gateway-bridge'
import type {
  SlidesEditArtifactOutcome,
  SlidesEditArtifactRequest,
} from '../office/office-preview-registry'
import { generateDocxFromHtml, generatePptxFromPageSpecs, generateThesisDocx, generateXlsxFromSheets, describeThesisDocxBlocks, type DocxGenerationPhase } from '../office/office-generation'
import type { ThesisBindingSpecPayload, ThesisFormatCardPayload } from '../office/office-runtime'
import { createEverroomMaterialResolver } from '../office/office-material-resolver'
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
  /** 逐页填充：PageSpec 原地替换一页（与 ops 二选一）。 */
  page?: { slideIndex: number; specJson: string }
  dryRun?: boolean
  isolation?: 'atomic' | 'per_op'
}

/** 论文装订请求（gateway thesis-format → /v1/office-reformat）。 */
export interface OfficeReformatRequest {
  action: 'describe' | 'build'
  docxBase64: string
  formatCard?: ThesisFormatCardPayload
  bindingSpec?: ThesisBindingSpecPayload
  roomId?: string
  sourceFileName?: string
  sourceFileEntryId?: string
  idempotencyKey?: string
}

/** 只渲染不入库的请求（风格演示页自校用：PageSpec → pptx 字节）。 */
export interface OfficeRenderRequest {
  title: string
  pages: string[]
}

/** 视觉复检：把已打开 slides 产物的某一页渲染成 1x PNG（gateway slides 复检 → /v1/office-render-page）。 */
export interface OfficeRenderPageRequest {
  fileId: string
  slideIndex: number
}

function validRenderPageBody(value: unknown): value is OfficeRenderPageRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeRenderPageRequest>
  return typeof input.fileId === 'string' && input.fileId.trim().length > 0
    && Number.isInteger(input.slideIndex) && (input.slideIndex as number) >= 0
}

function validRenderBody(value: unknown): value is OfficeRenderRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeRenderRequest>
  if (!(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 120)) return false
  if (!Array.isArray(input.pages) || input.pages.length === 0 || input.pages.length > 4) return false
  return input.pages.every((page) => typeof page === 'string' && page.length > 0)
}

const FORMAT_EXT: Record<OfficeGenerateFormat, string> = { docx: '.docx', pptx: '.pptx', xlsx: '.xlsx' }
const FORMAT_SOURCE: Record<OfficeGenerateFormat, string> = { docx: 'word', pptx: 'pptx', xlsx: 'xlsx' }

const KIND_LABEL: Record<string, string> = { docx: 'Word', slides: 'PPT', spreadsheet: 'Excel', pdf: 'PDF' }

/** 报错随行的打开清单摘要：让 Agent（和用户）知道现场有哪些 Office 文件打开着。 */
function describeOpenInstances(open: unknown): string {
  if (!Array.isArray(open) || open.length === 0) return '当前没有打开任何 Office 文件。'
  const items = open.map((entry) => {
    const info = entry as { title?: unknown; kind?: unknown; editable?: unknown; active?: unknown }
    const label = KIND_LABEL[String(info.kind)] ?? String(info.kind)
    const suffix = [
      info.editable ? '可编辑' : '只读',
      info.active ? '当前焦点' : null,
    ].filter(Boolean).join('，')
    return `${String(info.title)}（${label}，${suffix}）`
  })
  return `当前打开的 Office 文件：${items.join('；')}。`
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
  const page = input.page
  if (page !== undefined && (
    !page || typeof page !== 'object'
    || !Number.isInteger(page.slideIndex) || page.slideIndex < 0
    || typeof page.specJson !== 'string' || page.specJson.length === 0
  )) return false
  if (input.mode === 'apply' && !page && !Array.isArray(input.ops)) return false
  if (input.mode === 'apply' && page && Array.isArray(input.ops)) return false
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
    private readonly slidesRenderPage: () =>
      | ((fileId: string, slideIndex: number) => Promise<{ ok: true; pngBase64: string } | { ok: false; error: string }>)
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
    const known = request.url === '/v1/office-generate'
      || request.url === '/v1/office-edit'
      || request.url === '/v1/office-render'
      || request.url === '/v1/office-render-page'
      || request.url === '/v1/office-reformat'
    if (!known) {
      return { status: 404, body: { message: 'Not found' } }
    }
    if (!authorized(request, this.token)) return { status: 401, body: { message: 'Unauthorized' } }
    const read = await this.readJsonBody(request, request.url === '/v1/office-reformat' ? 60 * 1024 * 1024 : undefined)
    if ('error' in read) return read.error
    if (request.url === '/v1/office-edit') {
      if (!validEditBody(read.parsed)) return { status: 422, body: { message: 'Invalid office edit request' } }
      return this.edit(read.parsed)
    }
    if (request.url === '/v1/office-render-page') {
      if (!validRenderPageBody(read.parsed)) return { status: 422, body: { message: 'Invalid office render-page request' } }
      return this.renderPage(read.parsed)
    }
    if (request.url === '/v1/office-render') {
      if (!validRenderBody(read.parsed)) return { status: 422, body: { message: 'Invalid office render request' } }
      return this.render(read.parsed)
    }
    if (request.url === '/v1/office-reformat') {
      return this.reformat(read.parsed as OfficeReformatRequest)
    }
    if (!validBody(read.parsed)) return { status: 422, body: { message: 'Invalid office generate request' } }
    return this.generate(read.parsed)
  }

  /**
   * /v1/office-reformat：论文装订。describe = 源 docx → 块大纲（装订映射的
   * 区间事实源）；build = 源 docx + 格式卡 + 装订规格 → 装订版 docx，走
   * file-imports 入库（版本链幂等）并广播 done（渲染层 toast + 产物库刷新）。
   */
  private async reformat(req: OfficeReformatRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    try {
      if (req.action === 'describe') {
        const sourceBytes = Buffer.from(req.docxBase64, 'base64')
        if (sourceBytes.length === 0) return { status: 422, body: { message: 'docxBase64 required' } }
        const outline = await describeThesisDocxBlocks(sourceBytes)
        return { status: 200, body: { data: { blockCount: outline.length, outline } } }
      }
      if (req.action === 'build') {
        const files = this.filesBridge()
        if (!files) return { status: 503, body: { message: 'EverRoom 文件服务尚未就绪' } }
        if (!req.docxBase64 || !req.formatCard || !req.bindingSpec || !req.sourceFileName) {
          return { status: 422, body: { message: 'docxBase64/formatCard/bindingSpec/sourceFileName required' } }
        }
        const sourceBytes = Buffer.from(req.docxBase64, 'base64')
        if (sourceBytes.length === 0) return { status: 422, body: { message: 'docxBase64 required' } }
        const sourceFileName = req.sourceFileName
        const broadcastPhase = (phase: DocxGenerationPhase) => {
          this.broadcast({ type: 'phase', title: sourceFileName, phase, format: 'docx' })
        }
        const generated = await generateThesisDocx(
          { sourceBytes, formatCard: req.formatCard, bindingSpec: req.bindingSpec },
          broadcastPhase,
        )
        const baseName = sourceFileName.replace(/\.(docx|doc)$/i, '').trim() || generated.title
        const originalName = `${baseName}-排版版.docx`
        this.broadcast({ type: 'phase', title: baseName, phase: 'importing', format: 'docx' })
        let accepted: FileImportAcceptedDto
        try {
          accepted = await files.importAgentGeneratedFile({
            filePath: generated.filePath,
            originalName,
            sourceKey: `agent:docx-thesis:${req.sourceFileEntryId}:${req.idempotencyKey}`,
            ...(req.roomId ? { roomId: req.roomId } : {}),
          })
        } catch (error) {
          throw new Error(
            `论文已装订（${generated.filePath}）但入库失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
        await rm(generated.filePath, { force: true }).catch(() => undefined)
        this.broadcast({
          type: 'done',
          title: baseName,
          format: 'docx',
          fileId: accepted.fileEntryId,
          originalName,
          roomId: req.roomId,
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
              roomRequested: Boolean(req.roomId),
              originalName,
            },
          },
        }
      }
      return { status: 422, body: { message: 'action must be describe or build' } }
    } catch (error) {
      return { status: 502, body: { message: error instanceof Error ? error.message : 'Office reformat failed' } }
    }
  }

  private async readJsonBody(
    request: IncomingMessage,
    maxBytes: number = MAX_BODY_BYTES,
  ): Promise<{ parsed: unknown } | { error: { status: number; body: Record<string, unknown> } }> {
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) return { error: { status: 413, body: { message: 'Request body is too large' } } }
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
        : req.page
          ? { mode: 'apply', page: req.page }
          : { mode: 'apply', ops: req.ops ?? [], dryRun: req.dryRun, isolation: req.isolation }
    let outcome: SlidesEditArtifactOutcome
    try {
      outcome = await slidesEdit(req.fileId, artifactReq)
      // 重启后产物未打开：显式 fileEntryId 先请渲染端以可编辑方式打开再重试
      //（每次调用自带 8s 等待窗口，外层再兜到 30s 覆盖 genoffice 冷启动 + 大文件解包）。
      if (!outcome.ok && outcome.reason === 'not_open' && req.fileId !== 'active'
        && await this.requestRendererOpen(req.fileId)) {
        const deadline = Date.now() + 30_000
        do {
          outcome = await slidesEdit(req.fileId, artifactReq)
        } while (!outcome.ok && outcome.reason === 'not_open' && Date.now() < deadline)
      }
    } catch (error) {
      return { status: 502, body: { message: error instanceof Error ? error.message : 'Office edit failed' } }
    }
    if (!outcome.ok) {
      const openSummary = describeOpenInstances(outcome.open)
      const message =
        outcome.reason === 'not_editable'
          ? `该 PPT 当前不是以可编辑的 PPT 产物打开的，无法应用编辑。请在 Room 产物库中重新以可编辑方式打开后再试。${openSummary}`
          : req.fileId === 'active'
            ? `当前没有已打开的 PPT。若知道目标 PPT 的 fileEntryId（此前生成/编辑结果里返回过），把它作为 fileId 传入即可自动打开并编辑；不知道时请用户先在产物库打开该文件。${openSummary}`
            : `fileId 对应的 PPT 未能打开（文件可能不存在或不是 Office 产物）。请核对 fileEntryId 后重试，或请用户先在产物库打开该文件。${openSummary}`
      return { status: 422, body: { code: outcome.reason, message, open: outcome.open ?? [] } }
    }
    return { status: 200, body: { data: outcome.info ?? outcome.result ?? {} } }
  }

  /**
   * 显式 fileEntryId 未打开时的自动打开：核实产物库条目是 Office 产物后，
   * 广播 open-edit 让渲染端以可编辑方式打开（顶栏出标签，编辑实时可见）。
   * 渲染层打开失败/文件不存在时返回 false，保持原 not_open 报错路径。
   */
  private async requestRendererOpen(fileId: string): Promise<boolean> {
    const files = this.filesBridge()
    if (!files) return false
    try {
      const entry = await files.get(fileId)
      const kind = officePreviewKindForFileName(entry.originalName)
      const format: OfficeAgentFileFormat | null =
        kind === 'slides' ? 'pptx' : kind === 'spreadsheet' ? 'xlsx' : kind === 'docx' ? 'docx' : null
      if (!format) return false
      this.broadcast({
        type: 'open-edit',
        title: entry.originalName,
        format,
        fileId,
        originalName: entry.originalName,
      })
      return true
    } catch {
      return false
    }
  }

  /** /v1/office-render-page：视觉复检——已打开 slides 产物的一页 → 1x PNG base64。 */
  private async renderPage(req: OfficeRenderPageRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const render = this.slidesRenderPage()
    if (!render) return { status: 503, body: { message: 'EverRoom Office 预览会话尚未就绪' } }
    const outcome = await render(req.fileId.trim(), req.slideIndex)
    if (!outcome.ok) return { status: 422, body: { message: outcome.error } }
    return { status: 200, body: { data: { pngBase64: outcome.pngBase64 } } }
  }

  /** /v1/office-render：只走生成管线出 pptx 字节，不 file-imports、不广播——风格演示页自校专用。 */
  private async render(req: OfficeRenderRequest): Promise<{ status: number; body: Record<string, unknown> }> {    try {
      const imageResolver = createEverroomMaterialResolver(this.filesBridge)
      const generated = await generatePptxFromPageSpecs(
        { title: req.title.trim(), pages: req.pages },
        () => undefined,
        imageResolver,
      )
      const bytes = await readFile(generated.filePath)
      await rm(generated.filePath, { force: true }).catch(() => undefined)
      return { status: 200, body: { data: { pptxBase64: bytes.toString('base64') } } }
    } catch (error) {
      return { status: 502, body: { message: error instanceof Error ? error.message : 'Office render failed' } }
    }
  }

  private async generate(parsed: OfficeGenerateRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const files = this.filesBridge()
    if (!files) return { status: 503, body: { message: 'EverRoom 文件服务尚未就绪' } }

    try {
      const format: OfficeGenerateFormat = parsed.format ?? 'docx'
      const broadcastPhase = (phase: DocxGenerationPhase) => {
        this.broadcast({ type: 'phase', title: parsed.title, phase, format })
      }
      // everroom-material:// 素材回源器：桥接本地网关素材库（无桥时引用按失败跳过）。
      const imageResolver = createEverroomMaterialResolver(this.filesBridge)
      const generated =
        format === 'docx'
          ? await generateDocxFromHtml({ title: parsed.title, html: parsed.html! }, broadcastPhase)
          : format === 'pptx'
            ? await generatePptxFromPageSpecs({ title: parsed.title, pages: parsed.pages! }, broadcastPhase, imageResolver)
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
