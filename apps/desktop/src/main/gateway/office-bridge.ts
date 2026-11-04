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
  /** 会话所属工作区：产物入库归属（资料库/产物库按空间隔离）。 */
  workspaceId?: string | null
  fileName: string | null
  idempotencyKey: string
  /** pptx：true = 骨架入库阶段不广播 done，等全部页落定后由 /v1/office-complete 补发。 */
  deferDone?: boolean
}

/** 逐页落定后的真完成通知（gateway slides-layout-tail → /v1/office-complete）。 */
export interface OfficeCompleteRequest {
  fileId: string
  title: string
  originalName?: string
  roomId?: string | null
  completed: boolean
  appliedPages: number
  totalPages: number
  /** 失败/退化页 0 起页码。 */
  failedPages?: number[]
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

/** Agent 改写「用户正开着的那份」Word/Excel：字节 → 工作副本 → 版本链 → 重开视图。 */
export interface OfficeApplyBytesRequest {
  fileId: string
  bytesBase64: string
  expectedContentHash: string
}

/** Agent 驱动活 Word/Excel/PDF 的宿主执行器请求（gateway 工具 → /v1/office-agent-tools）。 */
export interface OfficeAgentToolsRequest {
  /** docx = Word 活文档；spreadsheet = Excel 活工作簿；pdf = PDF 文档。 */
  kind: 'docx' | 'spreadsheet' | 'pdf'
  /** read = describe（上下文+词汇表+指南）；apply = 执行工具调用。 */
  mode: 'read' | 'apply'
  fileId: string
  /** apply：docs/sheets/pdf AI 工具调用（id/name/input）。 */
  calls?: Array<{ id: string; name: string; input: Record<string, unknown> }>
  /** 后台 Word/Excel/PDF 会话回填版本链时的归属（跟当前 Run 的 Room/工作区走）。 */
  roomId?: string | null
  workspaceId?: string | null
}

/** 后台 Word/Excel/PDF 编辑会话可能返回的可诊断失败原因（不能一律折叠成 not_open）。 */
type OfficeAgentToolsFailureReason =
  | 'not_open'
  | 'not_editable'
  | 'unsaved'
  | 'not_found'
  | 'not_docx'
  | 'not_xlsx'
  | 'not_pdf'
  | 'too_large'
  | 'encrypted'
  | 'open_failed'
  | 'save_failed'
  | 'error'

function validAgentToolsBody(value: unknown): value is OfficeAgentToolsRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeAgentToolsRequest>
  if (input.kind !== 'docx' && input.kind !== 'spreadsheet' && input.kind !== 'pdf') return false
  if (input.mode !== 'read' && input.mode !== 'apply') return false
  if (typeof input.fileId !== 'string' || !input.fileId.trim()) return false
  if (input.roomId !== undefined && input.roomId !== null && typeof input.roomId !== 'string') return false
  if (input.workspaceId !== undefined && input.workspaceId !== null && typeof input.workspaceId !== 'string') return false
  if (input.calls !== undefined) {
    if (!Array.isArray(input.calls) || input.calls.length === 0 || input.calls.length > 50) return false
    if (!input.calls.every((call) => call && typeof call === 'object'
      && typeof (call as { id?: unknown }).id === 'string' && (call as { id?: unknown }).id
      && typeof (call as { name?: unknown }).name === 'string' && (call as { name?: unknown }).name
      && (call as { input?: unknown }).input !== undefined
      && typeof (call as { input?: unknown }).input === 'object')) return false
  }
  if (input.mode === 'apply' && !Array.isArray(input.calls)) return false
  return true
}

/**
 * Agent 导出 Word 为 PDF（gateway word_export_pdf → /v1/office-export-pdf）。
 * 桌面端用 LibreOffice 把 catalog 里的 docx 转成 PDF，再作为新文件入库。
 */
export interface OfficeExportPdfRequest {
  fileId: string
  /** 输出文件名（可选，默认取原文件名 .pdf）。 */
  fileName?: string | null
  roomId?: string | null
  workspaceId?: string | null
}

function validExportPdfBody(value: unknown): value is OfficeExportPdfRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeExportPdfRequest>
  if (typeof input.fileId !== 'string' || !input.fileId.trim()) return false
  if (input.fileName !== undefined && input.fileName !== null && typeof input.fileName !== 'string') return false
  if (input.roomId !== undefined && input.roomId !== null && typeof input.roomId !== 'string') return false
  if (input.workspaceId !== undefined && input.workspaceId !== null && typeof input.workspaceId !== 'string') return false
  return true
}

export interface OfficeExportPdfResult {
  ok: true
  fileId: string
  originalName: string
  contentHash?: string
}

/** 论文装订请求（gateway thesis-format → /v1/office-reformat）。 */
export interface OfficeReformatRequest {
  action: 'describe' | 'build'
  docxBase64: string
  /** 模版 docx 原文件（base64）：有则按「模板骨架」装订，模版元素原位置保留。 */
  templateBase64?: string
  formatCard?: ThesisFormatCardPayload
  bindingSpec?: ThesisBindingSpecPayload
  /** 产物入库归属（工作区）：排版结果与源文件落在同一空间（资料库按空间隔离）。 */
  workspaceId?: string
  sourceFileName?: string
  sourceFileEntryId?: string
  idempotencyKey?: string
  /** true = 本次勾选了「AI 补写」：产物文件名加 -ai补写版 后缀，便于和原稿区分。 */
  aiFill?: boolean
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

function validApplyBytesBody(value: unknown): value is OfficeApplyBytesRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeApplyBytesRequest>
  return typeof input.fileId === 'string' && input.fileId.trim().length > 0
    && typeof input.bytesBase64 === 'string' && input.bytesBase64.length > 0
    && typeof input.expectedContentHash === 'string' && /^[a-f0-9]{64}$/i.test(input.expectedContentHash)
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
    && (input.workspaceId == null || typeof input.workspaceId === 'string')
    && (input.fileName == null || typeof input.fileName === 'string')
    && typeof input.idempotencyKey === 'string' && input.idempotencyKey.length >= 8
    && (input.deferDone === undefined || typeof input.deferDone === 'boolean')
}

function validCompleteBody(value: unknown): value is OfficeCompleteRequest {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<OfficeCompleteRequest>
  if (!(typeof input.fileId === 'string' && input.fileId.trim().length > 0)) return false
  if (!(typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= 120)) return false
  if (input.originalName !== undefined && typeof input.originalName !== 'string') return false
  if (input.roomId !== undefined && input.roomId !== null && typeof input.roomId !== 'string') return false
  if (typeof input.completed !== 'boolean') return false
  const appliedPages = input.appliedPages
  if (typeof appliedPages !== 'number' || !Number.isInteger(appliedPages) || appliedPages < 0) return false
  const totalPages = input.totalPages
  if (typeof totalPages !== 'number' || !Number.isInteger(totalPages) || totalPages < 1) return false
  if (input.failedPages !== undefined) {
    if (!Array.isArray(input.failedPages)) return false
    if (!input.failedPages.every((page) => Number.isInteger(page) && page >= 0)) return false
  }
  return true
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
/** 排版产物落库后的通知（index.ts 注入：自动打开成品 + 刷新资料库）。 */
export interface ThesisProductReady {
  fileEntryId: string
  originalName: string
  workspaceId?: string
}

export class OfficeBridgeServer {
  private server: Server | null = null
  private readonly token = randomBytes(32).toString('base64url')
  /** 论文排版成品钩子：缺省只广播事件（旧行为）。 */
  private thesisProductHook: ((product: ThesisProductReady) => void | Promise<void>) | null = null
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
    /** 写回当前打开的 Word/Excel（registry.applyAgentFileBytes；未注入 = 工具不可用）。 */
    private readonly applyAgentBytes: () =>
      | ((fileId: string, bytes: Buffer, expectedContentHash: string) => Promise<
        | { ok: true; contentHash: string }
        | { ok: false; reason: 'not_open' | 'not_editable' | 'unsaved' | 'conflict' | 'error'; message?: string }
      >)
      | null = () => null,
    /** 活 Word/Excel 宿主执行器（registry 的 describe/apply 方法；未注入 = 工具不可用）。 */
    private readonly agentTools: () =>
      | ((req: OfficeAgentToolsRequest) => Promise<
        | { ok: true; data: Record<string, unknown> }
        | {
          ok: false
          reason: OfficeAgentToolsFailureReason
          message?: string
          open?: unknown[]
        }
      >)
      | null = () => null,
    /** Word → PDF 导出并入库（index.ts 注入；未注入 = 工具不可用）。 */
    private readonly exportPdfDoc: () =>
      | ((req: OfficeExportPdfRequest) => Promise<
        | OfficeExportPdfResult
        | { ok: false; message: string }
      >)
      | null = () => null,
  ) {}

  /** 排版成品落库后回调（index.ts 注入；晚于构造注入，故用 setter）。 */
  setThesisProductHook(hook: ((product: ThesisProductReady) => void | Promise<void>) | null): void {
    this.thesisProductHook = hook
  }

  private notifyThesisProduct(product: ThesisProductReady): void {
    const hook = this.thesisProductHook
    if (!hook) return
    try {
      void Promise.resolve(hook(product)).catch((error) => {
        console.warn('[office] 排版成品自动打开失败：', error instanceof Error ? error.message : String(error))
      })
    } catch (error) {
      console.warn('[office] 排版成品自动打开失败：', error instanceof Error ? error.message : String(error))
    }
  }

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
      || request.url === '/v1/office-complete'
      || request.url === '/v1/office-edit'
      || request.url === '/v1/office-render'
      || request.url === '/v1/office-render-page'
      || request.url === '/v1/office-reformat'
      || request.url === '/v1/office-apply-bytes'
      || request.url === '/v1/office-agent-tools'
      || request.url === '/v1/office-export-pdf'
    if (!known) {
      return { status: 404, body: { message: 'Not found' } }
    }
    if (!authorized(request, this.token)) return { status: 401, body: { message: 'Unauthorized' } }
    const read = await this.readJsonBody(
      request,
      request.url === '/v1/office-reformat' || request.url === '/v1/office-apply-bytes'
        ? 64 * 1024 * 1024
        // agent-tools may carry base64 images (insert_image_base64)
        : request.url === '/v1/office-agent-tools'
          ? 16 * 1024 * 1024
          : undefined,
    )
    if ('error' in read) return read.error
    if (request.url === '/v1/office-complete') {
      if (!validCompleteBody(read.parsed)) return { status: 422, body: { message: 'Invalid office complete request' } }
      return this.complete(read.parsed)
    }
    if (request.url === '/v1/office-apply-bytes') {
      if (!validApplyBytesBody(read.parsed)) return { status: 422, body: { message: 'Invalid office apply-bytes request' } }
      return this.applyBytes(read.parsed)
    }
    if (request.url === '/v1/office-agent-tools') {
      if (!validAgentToolsBody(read.parsed)) return { status: 422, body: { message: 'Invalid office agent-tools request' } }
      return this.agentToolsRoute(read.parsed)
    }
    if (request.url === '/v1/office-export-pdf') {
      if (!validExportPdfBody(read.parsed)) return { status: 422, body: { message: 'Invalid office export-pdf request' } }
      return this.exportPdfRoute(read.parsed)
    }
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
   * /v1/office-apply-bytes：Agent 改写当前打开的 Word/Excel。
   * 桌面端负责脏检查/基线校验/覆盖工作副本/版本回填/重开视图，网关只送字节。
   */
  /**
   * 活 Word/Excel 宿主执行器入口：read = describe（上下文+工具词汇表+指南），
   * apply = 执行 docs/sheets 渲染层工具调用（编辑实时重绘在打开的视图上，
   * 变更后静默保存触发版本链回填）。
   *
   * Word 与 Excel 都优先走后台隐藏会话（registry 拉起隐藏编辑器/工作簿，
   * 不弹页签）。下面的 not_open 自动打开重试只作为旧运行时的兜底：当运行时
   * 缺少 waitForAgentReady（老 genoffice 包）时 registry 会保留原 not_open，
   * 此时才请渲染端开一个可见实例再重试。
   */
  private async agentToolsRoute(req: OfficeAgentToolsRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const agentTools = this.agentTools()
    if (!agentTools) return { status: 503, body: { message: 'EverRoom Office 宿主执行器尚未就绪' } }
    let outcome = await agentTools(req)
    // 旧运行时兜底（Word/Excel 都已经是 headless 优先）：仅当 registry 无法
    // 拉起隐藏会话、仍返回 not_open 时，才按旧路径请渲染端自动打开页签重试。
    if (!outcome.ok && outcome.reason === 'not_open' && req.kind !== 'docx' && req.fileId !== 'active') {
      console.info('office-bridge: office-agent-tools 命中 not_open，尝试自动打开', { fileId: req.fileId })
      const opened = await this.requestRendererOpen(req.fileId)
      if (opened) {
        const deadline = Date.now() + 30_000
        do {
          outcome = await agentTools(req)
        } while (!outcome.ok && outcome.reason === 'not_open' && Date.now() < deadline)
      }
    }
    if (!outcome.ok) {
      const kindLabel = req.kind === 'docx' ? 'Word' : 'Excel'
      const openSummary = describeOpenInstances(outcome.open)
      const detail = outcome.message ? `（${outcome.message}）` : ''
      const message =
        outcome.reason === 'unsaved'
          ? `该${kindLabel}文件有未保存的修改，为避免覆盖用户输入已拒绝执行。请先让用户保存（或等自动保存完成）再重试。${openSummary}`
          : outcome.reason === 'not_editable'
            ? `该${kindLabel}文件当前不是以可编辑方式打开的，无法应用编辑。请在 Room 产物库中重新以可编辑方式打开后再试。${openSummary}`
            : outcome.reason === 'not_found'
              ? `文件不在文件库中（可能仍在导入或已被删除）。${detail}`
              : outcome.reason === 'encrypted'
                ? `${detail || '该文件有打开密码。'}请先在编辑器里打开并输入密码后再让 Agent 修改。`
                : outcome.reason === 'too_large'
                  ? `${detail || '文件过大，超出后台编辑上限。'}`
                  : outcome.reason === 'not_docx' || outcome.reason === 'not_xlsx' || outcome.reason === 'open_failed'
                    ? `无法在后台打开该${kindLabel}文件。${detail}`
                    : req.fileId === 'active'
                      ? `当前没有已打开的${kindLabel}文件。若知道目标文件的 fileEntryId，把它作为 fileId 传入即可后台编辑；不知道时可先用 file_search 按文件名查找。${openSummary}`
                      : `fileId 对应的${kindLabel}文件未能打开。请核对 fileEntryId 后重试。${openSummary}${detail}`
      return { status: 422, body: { code: outcome.reason, message, open: outcome.open ?? [] } }
    }
    return { status: 200, body: { data: outcome.data } }
  }

  /**
   * /v1/office-export-pdf：任意 Word → PDF 并作为新文件入库。
   * 桌面端做 LibreOffice 转换与文件库导入；网关只转发 fileId/归属。
   */
  private async exportPdfRoute(
    req: OfficeExportPdfRequest,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const exportPdf = this.exportPdfDoc()
    if (!exportPdf) return { status: 503, body: { message: 'EverRoom Word→PDF 导出尚未就绪' } }
    const outcome = await exportPdf({
      ...req,
      fileId: req.fileId.trim(),
      ...(typeof req.fileName === 'string' && req.fileName.trim() ? { fileName: req.fileName.trim() } : {}),
    })
    if (!outcome.ok) {
      return { status: 422, body: { code: 'export_failed', message: outcome.message } }
    }
    return { status: 200, body: { data: outcome } }
  }

  private async applyBytes(req: OfficeApplyBytesRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const apply = this.applyAgentBytes()
    if (!apply) return { status: 503, body: { message: 'EverRoom Office 预览会话尚未就绪' } }
    const bytes = Buffer.from(req.bytesBase64, 'base64')
    if (bytes.length === 0) return { status: 422, body: { message: 'bytesBase64 required' } }
    const result = await apply(req.fileId.trim(), bytes, req.expectedContentHash)
    if (!result.ok) {
      return {
        status: 409,
        body: {
          data: {
            reason: result.reason,
            ...(result.message ? { message: result.message } : {}),
          },
        },
      }
    }
    return { status: 200, body: { data: { ok: true, contentHash: result.contentHash } } }
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
          {
            sourceBytes,
            ...(req.templateBase64 ? { templateBytes: Buffer.from(req.templateBase64, 'base64') } : {}),
            formatCard: req.formatCard,
            bindingSpec: req.bindingSpec,
          },
          broadcastPhase,
        )
        const baseName = sourceFileName.replace(/\.(docx|doc)$/i, '').trim() || generated.title
        // 勾了 AI 补写时文件名带 -ai补写版：用户要能一眼分清「原稿排版」和「补写版」
        const suffix = req.aiFill === true ? '-ai补写版' : '-排版版'
        const originalName = `${baseName}${suffix}.docx`
        this.broadcast({ type: 'phase', title: baseName, phase: 'importing', format: 'docx' })
        let accepted: FileImportAcceptedDto
        try {
          accepted = await files.importAgentGeneratedFile({
            filePath: generated.filePath,
            originalName,
            sourceKey: `agent:docx-thesis:${req.sourceFileEntryId}:${req.idempotencyKey}`,
            ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
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
          ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
        })
        // 成品已入库：自动打开给用户看（否则「排版完成」只停在面板一行字，
        // 当前文档又不会变，用户会以为没出效果）。
        this.notifyThesisProduct({
          fileEntryId: accepted.fileEntryId,
          originalName,
          ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
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
              originalName,
              // 出稿自检/骨架回落提示：面板要能让用户看到「为什么这次排版不对」，
              // 否则只能看到成品、猜不到原因。
              ...(generated.warnings ? { warnings: generated.warnings } : {}),
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
      if (!outcome.ok && outcome.reason === 'not_open' && req.fileId !== 'active') {
        console.info('office-bridge: office-edit 命中 not_open，尝试请渲染端自动打开', { fileId: req.fileId })
        const opened = await this.requestRendererOpen(req.fileId)
        if (!opened) {
          // requestRendererOpen 内部已带具体跳过原因，这里补一条调用方视角的结论日志。
          console.warn('office-bridge: office-edit 自动打开未生效（requestRendererOpen 返回 false），保持 not_open 报错', {
            fileId: req.fileId,
          })
        } else {
          const startedAt = Date.now()
          const deadline = startedAt + 30_000
          let attempts = 0
          do {
            outcome = await slidesEdit(req.fileId, artifactReq)
            attempts += 1
          } while (!outcome.ok && outcome.reason === 'not_open' && Date.now() < deadline)
          console.warn('office-bridge: office-edit 自动打开重试结束', {
            fileId: req.fileId,
            ok: outcome.ok,
            elapsedMs: Date.now() - startedAt,
            attempts,
            lastReason: outcome.ok ? null : outcome.reason,
            openCount: outcome.ok ? 0 : outcome.open?.length ?? 0,
          })
        }
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
   *
   * 查询顺序：catalog 条目（agent 生成/导入的产物都在 file_entries）优先，
   * `get()`（只查 legacy uploaded_files）兜底。此前只用 `get()`，导致
   * agent 生成的 PPT 永远 file_not_found，「未打开自动打开」从未成功过。
   */
  private async requestRendererOpen(fileId: string): Promise<boolean> {
    const files = this.filesBridge()
    if (!files) {
      console.warn('office-bridge: open-edit 跳过（files bridge 未就绪）', { fileId })
      return false
    }
    try {
      let entry: { originalName?: unknown; displayName?: unknown } | null = null
      try {
        entry = await files.catalogEntry(fileId)
      } catch (catalogError) {
        // 旧版本上传的产物不在 catalog 里：退回 legacy 查询。
        try {
          entry = await files.get(fileId)
        } catch (error) {
          console.warn('office-bridge: open-edit 跳过（fileId 读取失败）', {
            fileId,
            error: error instanceof Error ? error.message : String(error),
            catalogError: catalogError instanceof Error ? catalogError.message : String(catalogError),
          })
          return false
        }
      }
      if (!entry) {
        console.warn('office-bridge: open-edit 跳过（fileId 读取为空）', { fileId })
        return false
      }
      // 防御：条目缺 originalName 时，直接传给 officePreviewKindForFileName 会抛
      // TypeError 并被下面的 catch 吞成「未打开」；displayName 作为兜底文件名。
      const rawEntry = entry as { originalName?: unknown; displayName?: unknown }
      const originalName =
        typeof rawEntry.originalName === 'string' && rawEntry.originalName.trim().length > 0
          ? rawEntry.originalName
          : typeof rawEntry.displayName === 'string' && rawEntry.displayName.trim().length > 0
            ? rawEntry.displayName
            : ''
      if (!originalName) {
        console.warn('office-bridge: open-edit 跳过（产物条目缺少 originalName/displayName）', { fileId })
        return false
      }
      const kind = officePreviewKindForFileName(originalName)
      const format: OfficeAgentFileFormat | null =
        kind === 'slides' ? 'pptx' : kind === 'spreadsheet' ? 'xlsx' : kind === 'docx' ? 'docx' : null
      if (!format) {
        console.warn(`office-bridge: open-edit 跳过（不是 Office 产物：${originalName}）`, { fileId, kind })
        return false
      }
      this.broadcast({
        type: 'open-edit',
        title: originalName,
        format,
        fileId,
        originalName,
      })
      console.info('office-bridge: open-edit 已广播', { fileId, originalName, format, kind })
      return true
    } catch (error) {
      console.warn('office-bridge: open-edit 跳过（未预期异常）', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      })
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

  /** /v1/office-complete：全部页落定后补发 done（真完成时机；deferDone 生成期不广播）。 */
  private async complete(req: OfficeCompleteRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    this.broadcast({
      type: 'done',
      title: req.title,
      format: 'pptx',
      fileId: req.fileId,
      ...(req.originalName ? { originalName: req.originalName } : {}),
      roomId: req.roomId ?? null,
      partial: !req.completed,
      appliedPages: req.appliedPages,
      totalPages: req.totalPages,
      ...(req.failedPages && req.failedPages.length > 0 ? { failedPages: req.failedPages } : {}),
    })
    return { status: 200, body: { data: { ok: true } } }
  }

  private async generate(parsed: OfficeGenerateRequest): Promise<{ status: number; body: Record<string, unknown> }> {
    const files = this.filesBridge()
    if (!files) return { status: 503, body: { message: 'EverRoom 文件服务尚未就绪' } }

    try {
      const format: OfficeGenerateFormat = parsed.format ?? 'docx'
      // pptx 骨架入库不等于完成：逐页落页由 gateway 收尾，done 后移到 /v1/office-complete。
      const deferDone = parsed.deferDone === true && format === 'pptx'
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
          ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
        })
      } catch (error) {
        // 入库失败保留临时文件供人工恢复（docx 在 defaultSaveDir，其余在系统 temp）。
        const kindLabel = format === 'docx' ? 'Word' : format === 'pptx' ? 'PPT' : 'Excel'
        throw new Error(
          `${kindLabel} 已生成（${generated.filePath}）但入库失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await rm(generated.filePath, { force: true }).catch(() => undefined)
      if (!deferDone) {
        this.broadcast({
          type: 'done',
          title: parsed.title,
          format,
          fileId: accepted.fileEntryId,
          originalName,
          roomId: parsed.roomId,
        })
      }
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
