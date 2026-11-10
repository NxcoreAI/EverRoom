import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

import { logDesktop } from '../logging/desktop-logger'
import type {
  GenOfficeAgentPdfDescription,
  GenOfficeAgentToolCall,
  GenOfficeAgentToolResult,
  GenOfficePdfRuntime,
} from './office-runtime'

/**
 * Agent 的后台 PDF 编辑会话：在用户没有打开（或 UI 已隐藏）的 .pdf 上，
 * 用一份隐藏的 GenOffice pdf 视图跑与活会话相同的渲染层 AI 工具链
 * （read_pages / edit_text / markup_text / insert_text / 表单填写 / 图片 /
 * 页面旋转删除等），编辑后静默保存，再走 fileSaved → 版本链回填。
 *
 * 与 docs/sheets 的隐藏会话同构：不进 OfficePreviewRegistry.instances、
 * 不弹脏关闭对话框、空闲回收。pdf 视图不依赖真实布局测量（无分页重排），
 * 但仍给真实尺寸避免 0×0 孤儿视图的渲染退化。
 */

/** 单份文件的后台编辑上限：pdf.js 全文解析在渲染器内存里。 */
const MAX_AGENT_PDF_BYTES = 100 * 1024 * 1024
/** 空闲回收：隐藏会话是一个完整 Chromium 渲染器。 */
const SESSION_IDLE_MS = 3 * 60_000
/** 同时保留的隐藏会话数（按最近使用淘汰）。 */
const SESSION_MAX = 2
/** 等渲染层报告「目标工作副本已装载」的上限。 */
const READY_TIMEOUT_MS = 15_000
/** 隐藏视图给 pdf.js 渲染用的真实布局尺寸。 */
const HIDDEN_VIEW_BOUNDS = { x: 0, y: 0, width: 1100, height: 1400 }
/** PDF 魔数（%PDF-）：空文件/损坏文件在渲染层就绪前就会被挡在这里。 */
const PDF_MAGIC = Buffer.from('%PDF-')

export interface AgentPdfFileMeta {
  fileId: string
  originalName: string
  storagePath: string
  contentHash: string
  roomId?: string | null
  workspaceId?: string | null
}

/** 会话回填端口：复用 Registry 既有的 editStates + 去抖导入链路。 */
export interface AgentPdfEditSyncPort {
  register(input: {
    fileId: string
    webContentsId: number
    filePath: string
    originalName: string
    roomId: string | null
    workspaceId: string | null
  }): () => void
  /** 立即排空去抖中的版本回填（保留 editStates，供后续编辑继续用）。 */
  drain(fileId: string): Promise<{ contentHash?: string; fileVersionId?: string } | null>
  /** 强制按当前工作副本回填一次（去抖已提前跑过/漏跑时兜底；同内容幂等）。 */
  flush(fileId: string): Promise<{ contentHash?: string; fileVersionId?: string } | null>
  /** 排空并移除回填状态（会话销毁时）。 */
  release(fileId: string): Promise<void>
}

export interface AgentPdfFileHints {
  roomId?: string | null
  workspaceId?: string | null
}

export type AgentPdfFailureReason =
  | 'not_found'
  | 'not_pdf'
  | 'too_large'
  | 'encrypted'
  | 'open_failed'
  | 'not_open'
  | 'not_editable'
  | 'unsaved'
  | 'save_failed'
  | 'error'

export type AgentPdfFailure = {
  ok: false
  reason: AgentPdfFailureReason
  message?: string
}

export type AgentPdfDescribeOutcome =
  | { ok: true; describe: GenOfficeAgentPdfDescription }
  | AgentPdfFailure

export type AgentPdfApplyOutcome =
  | {
    ok: true
    results: GenOfficeAgentToolResult[]
    /** 版本回填成功后返回新版本 id。 */
    version?: string
    /** 已应用但静默保存失败等：调用方仍需如实告诉用户。 */
    error?: string
  }
  | AgentPdfFailure

interface Session {
  fileId: string
  meta: AgentPdfFileMeta
  view: WebContentsView
  contents: WebContents
  workingCopyPath: string
  /** 当前工作副本对应的 catalog 内容指纹：catalog 变了就重建会话。 */
  baseContentHash: string
  roomId: string | null
  workspaceId: string | null
  lastUsed: number
  idleTimer: NodeJS.Timeout | null
  unsubscribeSaved: (() => void) | null
  disposed: boolean
}

const failure = (reason: AgentPdfFailureReason, message?: string): AgentPdfFailure =>
  message ? { ok: false, reason, message } : { ok: false, reason }

/** PDF 工作副本：CAS blob → userData 下按 (fileId, hash) 分桶的稳定副本。 */
function preparePdfWorkingCopy(
  fileId: string,
  hash: string,
  name: string,
  storagePath: string,
): string {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error('PDF identity is invalid.')
  }
  if (extname(name).toLowerCase() !== '.pdf') throw new Error(`Unsupported internal PDF: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`PDF is unavailable: ${source}`)
  // Object-store blobs are extensionless and content-addressed; the pdf runtime
  // gets a stable per-version working copy and must never touch the immutable
  // CAS blob. hash 变化即换目录，同一版本幂等复用。
  const dir = join(app.getPath('userData'), 'office-pdfs', fileId, hash)
  const target = join(dir, basename(name))
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) copyFileSync(source, target)
  return target
}

/** 一个文件一条串行链：隐藏会话的创建、describe、apply、销毁互斥。 */
export class AgentPdfSessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private shuttingDown = false

  constructor(
    private readonly options: {
      pdf: GenOfficePdfRuntime
      getWindow: () => BrowserWindow | null
      resolveFile: (fileId: string) => Promise<AgentPdfFileMeta | null>
      editSync: AgentPdfEditSyncPort
    },
  ) {}

  has(fileId: string): boolean {
    return this.sessions.has(fileId)
  }

  hasAny(): boolean {
    return this.sessions.size > 0
  }

  /** 只读描述；没有会话则按需拉起隐藏编辑器。 */
  async describe(fileId: string, hints?: AgentPdfFileHints): Promise<AgentPdfDescribeOutcome> {
    return this.runExclusive(fileId, async () => {
      const ensured = await this.ensure(fileId, hints)
      if (!ensured.ok) return ensured
      const { session } = ensured
      const described = await this.options.pdf.describeAgentPdf!(session.contents)
      if ('error' in described) {
        return failure('open_failed', described.error)
      }
      return { ok: true as const, describe: described }
    })
  }

  /** 执行一批 pdf AI 工具调用；返回前把去抖中的版本回填排空。 */
  async apply(
    fileId: string,
    calls: GenOfficeAgentToolCall[],
    hints?: AgentPdfFileHints,
  ): Promise<AgentPdfApplyOutcome> {
    return this.runExclusive(fileId, async () => {
      const ensured = await this.ensure(fileId, hints)
      if (!ensured.ok) return ensured
      const { session } = ensured
      let applied: Awaited<ReturnType<NonNullable<GenOfficePdfRuntime['applyAgentPdfTools']>>>
      try {
        applied = await this.options.pdf.applyAgentPdfTools!(session.contents, calls)
      } catch (error) {
        return failure('error', error instanceof Error ? error.message : String(error))
      }
      if (!('results' in applied)) {
        return failure('not_editable', applied.error)
      }
      // 渲染层 apply 成功但静默保存失败时会带 error（此时内存已改、磁盘未落）。
      let imported: { contentHash?: string; fileVersionId?: string } | null = null
      try {
        imported = await this.options.editSync.drain(fileId)
      } catch (error) {
        logDesktop('office', 'warn', {
          event: 'office.agent-pdf.version-backfill-failed',
          fileId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      const mutatedAny = applied.results.some((row) => row.mutated === true)
      if (mutatedAny && !imported) {
        try {
          imported = await this.options.editSync.flush(fileId)
        } catch (error) {
          logDesktop('office', 'warn', {
            event: 'office.agent-pdf.forced-backfill-failed',
            fileId,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      // 静默保存失败的唯一可靠证据是工作副本字节没有变化（与 docs 同口径）。
      let newHash: string | null = null
      try {
        newHash = (await hashFile(session.workingCopyPath)).toLowerCase()
      } catch {
        newHash = null
      }
      if (mutatedAny) {
        if (!newHash || newHash === session.baseContentHash.toLowerCase()) {
          return failure(
            'save_failed',
            '修改已在后台编辑器里应用，但没有落盘（文档可能被外部修改过，静默保存被拒绝）。请重新读取文档后再试。',
          )
        }
        if (!imported) {
          return {
            ok: true as const,
            results: applied.results,
            error: '修改已落盘，但版本回填失败；请重试保存（再次编辑会重新触发静默保存与回填）',
          }
        }
        session.baseContentHash = (imported.contentHash ?? newHash).toLowerCase()
      } else if (newHash && newHash !== session.baseContentHash.toLowerCase()) {
        session.baseContentHash = newHash
      }
      return {
        ok: true as const,
        results: applied.results,
        ...(imported?.fileVersionId ? { version: imported.fileVersionId } : {}),
        ...('error' in applied && typeof applied.error === 'string' ? { error: applied.error } : {}),
      }
    })
  }

  async dispose(fileId: string): Promise<void> {
    await this.runExclusive(fileId, async () => {
      const session = this.sessions.get(fileId)
      if (session) await this.disposeSession(session)
    })
  }

  async disposeAll(): Promise<void> {
    this.shuttingDown = true
    await Promise.all([...this.sessions.keys()].map((fileId) => this.dispose(fileId)))
    this.shuttingDown = false
  }

  private runExclusive<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(fileId) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    const guard = next.then(() => undefined, () => undefined)
    this.locks.set(fileId, guard)
    void guard.then(() => {
      if (this.locks.get(fileId) === guard) this.locks.delete(fileId)
    })
    return next
  }

  private async ensure(
    fileId: string,
    hints?: AgentPdfFileHints,
  ): Promise<{ ok: true; session: Session } | AgentPdfFailure> {
    if (this.shuttingDown) return failure('not_open', '应用正在退出')
    const meta = await this.options.resolveFile(fileId).catch(() => null)
    if (!meta) return failure('not_found', `文件 ${fileId} 不在文件库中（可能已删除或仍在导入）`)
    if (!/\.pdf$/i.test(meta.originalName)) {
      return failure('not_pdf', `《${meta.originalName}》不是 PDF 文档`)
    }

    const existing = this.sessions.get(fileId)
    if (existing && !existing.disposed && !existing.contents.isDestroyed()) {
      if (existing.baseContentHash.toLowerCase() === meta.contentHash.toLowerCase()) {
        this.applyHints(existing, hints)
        this.touch(existing)
        return { ok: true, session: existing }
      }
      // catalog 版本变了：旧会话打开的是旧工作副本，重建后再改。
      await this.disposeSession(existing)
    }
    if (existing) this.sessions.delete(fileId)

    const prepared = await this.prepareSession(meta, hints)
    if (!prepared.ok) return prepared
    await this.evictOverflow(fileId)
    this.sessions.set(fileId, prepared.session)
    this.touch(prepared.session)
    return { ok: true, session: prepared.session }
  }

  private async prepareSession(
    meta: AgentPdfFileMeta,
    hints?: AgentPdfFileHints,
  ): Promise<{ ok: true; session: Session } | AgentPdfFailure> {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return failure('not_open', '主窗口不可用，无法启动后台编辑器')

    let bytes = 0
    try {
      const info = statSync(meta.storagePath)
      bytes = info.size
    } catch {
      return failure('not_found', `《${meta.originalName}》的文件内容不可读`)
    }
    if (bytes > MAX_AGENT_PDF_BYTES) {
      return failure(
        'too_large',
        `《${meta.originalName}》${(bytes / 1024 / 1024).toFixed(1)}MB，超过后台编辑上限 ${MAX_AGENT_PDF_BYTES / 1024 / 1024}MB`,
      )
    }
    // pdf-lib 无法写回加密文件（含免密打开的 owner 加密）：开后台会话前先挡掉。
    if (await isEncryptedPdf(meta.storagePath)) {
      return failure('encrypted', `《${meta.originalName}》是加密 PDF，无法后台编辑（pdf-lib 不能写回加密文件）`)
    }

    let workingCopyPath: string
    try {
      workingCopyPath = preparePdfWorkingCopy(
        meta.fileId,
        meta.contentHash,
        meta.originalName,
        meta.storagePath,
      )
    } catch (error) {
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }

    const pdf = this.options.pdf
    // 可编辑会话：不带 readonly=1，渲染层编辑面全开。
    let view: WebContentsView
    try {
      view = pdf.createPdfView(workingCopyPath, { readonly: false })
    } catch (error) {
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }
    const contents = view.webContents
    try {
      window.contentView.addChildView(view)
      view.setBounds(HIDDEN_VIEW_BOUNDS)
      view.setVisible(false)
    } catch (error) {
      await teardownView(window, view)
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }

    const ready = typeof pdf.waitForAgentReady === 'function'
      ? await pdf.waitForAgentReady(contents, workingCopyPath, READY_TIMEOUT_MS)
      : false
    if (!ready) {
      await teardownView(window, view)
      return failure(
        'open_failed',
        typeof pdf.waitForAgentReady === 'function'
          ? `《${meta.originalName}》后台编辑器未在 ${READY_TIMEOUT_MS / 1000}s 内就绪（文件可能损坏或格式不支持）`
          : 'GenOffice 运行时缺少 waitForAgentReady，请重建运行时（pnpm prepare:genoffice）',
      )
    }

    const roomId = normalizedId(hints?.roomId) ?? normalizedId(meta.roomId)
    const workspaceId = normalizedId(hints?.workspaceId) ?? normalizedId(meta.workspaceId)
    const session: Session = {
      fileId: meta.fileId,
      meta,
      view,
      contents,
      workingCopyPath,
      baseContentHash: meta.contentHash.toLowerCase(),
      roomId,
      workspaceId,
      lastUsed: Date.now(),
      idleTimer: null,
      unsubscribeSaved: null,
      disposed: false,
    }
    session.unsubscribeSaved = this.options.editSync.register({
      fileId: meta.fileId,
      webContentsId: contents.id,
      filePath: workingCopyPath,
      originalName: meta.originalName,
      roomId,
      workspaceId,
    })
    contents.once('destroyed', () => {
      if (session.disposed) return
      session.disposed = true
      if (session.idleTimer) clearTimeout(session.idleTimer)
      session.idleTimer = null
      session.unsubscribeSaved?.()
      session.unsubscribeSaved = null
      if (this.sessions.get(session.fileId) === session) this.sessions.delete(session.fileId)
      void this.options.editSync.release(session.fileId).catch(() => undefined)
    })
    logDesktop('office', 'info', {
      event: 'office.agent-pdf.session-created',
      fileId: meta.fileId,
      originalName: meta.originalName,
      webContentsId: contents.id,
      bytes,
    })
    return { ok: true, session }
  }

  private applyHints(session: Session, hints?: AgentPdfFileHints): void {
    const roomId = normalizedId(hints?.roomId)
    const workspaceId = normalizedId(hints?.workspaceId)
    if (roomId) session.roomId = roomId
    if (workspaceId) session.workspaceId = workspaceId
  }

  private touch(session: Session): void {
    session.lastUsed = Date.now()
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null
      void this.dispose(session.fileId)
    }, SESSION_IDLE_MS)
    session.idleTimer.unref?.()
  }

  private async evictOverflow(keepFileId: string): Promise<void> {
    while (this.sessions.size >= SESSION_MAX) {
      const victim = [...this.sessions.values()]
        .filter((session) => session.fileId !== keepFileId && !session.disposed)
        .sort((left, right) => left.lastUsed - right.lastUsed)[0]
      if (!victim) return
      await this.disposeSession(victim)
      if (this.sessions.get(victim.fileId) === victim) this.sessions.delete(victim.fileId)
    }
  }

  private async disposeSession(session: Session): Promise<void> {
    if (session.disposed) return
    session.disposed = true
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = null
    session.unsubscribeSaved?.()
    session.unsubscribeSaved = null
    if (this.sessions.get(session.fileId) === session) this.sessions.delete(session.fileId)
    try {
      await this.options.editSync.release(session.fileId)
    } catch (error) {
      logDesktop('office', 'warn', {
        event: 'office.agent-pdf.release-failed',
        fileId: session.fileId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const window = this.options.getWindow()
    await teardownView(window, session.view)
    logDesktop('office', 'info', {
      event: 'office.agent-pdf.session-disposed',
      fileId: session.fileId,
    })
  }
}

function normalizedId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * 加密检测：/Encrypt 出现在头部长度窗口内（对象表散布全文，这里只做保守
 * 的头部启发式——头部没有 /Encrypt 的普通文件一定能后台编辑；头部的
 * /Encrypt 命中可能误伤极少数把加密字典引用写在开头的未加密文件，这类
 * 文件本来也无法保证 pdf-lib 兼容，退回前台打开即可）。
 */
async function isEncryptedPdf(path: string): Promise<boolean> {
  const handle = await readFile(path, { flag: 'r' }).then(
    (buf) => buf.subarray(0, 4096),
    () => null,
  )
  if (!handle || handle.length < PDF_MAGIC.length || !handle.subarray(0, 5).equals(PDF_MAGIC)) {
    return false
  }
  return handle.includes(Buffer.from('/Encrypt'))
}

/** 拆视图：摘视图 → 关 webContents；不弹对话框（pdf embed 无 teardown 通道）。 */
async function teardownView(window: BrowserWindow | null, view: WebContentsView): Promise<void> {
  const contents = view.webContents
  if (window && !window.isDestroyed()) {
    try {
      window.contentView.removeChildView(view)
    } catch {
      /* window/view tree already gone */
    }
  }
  if (!contents.isDestroyed()) {
    try {
      contents.close({ waitForBeforeUnload: false })
    } catch {
      /* already closed */
    }
  }
}
