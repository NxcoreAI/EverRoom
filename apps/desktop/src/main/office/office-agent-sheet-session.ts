import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'

import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

import { logDesktop } from '../logging/desktop-logger'
import type {
  GenOfficeAgentToolCall,
  GenOfficeAgentToolResult,
  GenOfficeAgentWorkbookDescription,
  GenOfficeSheetsRuntime,
} from './office-runtime'
import type { AgentDocFailureReason } from './office-agent-doc-session'
import { prepareSpreadsheet } from './spreadsheet-view-manager'

/**
 * Agent 的后台 Excel 编辑会话：在用户没有打开（UI 隐藏/根本没有页签）的 .xlsx 上，
 * 用一份隐藏的 GenOffice sheets 视图跑与活会话完全相同的渲染层 workbook AI 工具链，
 * 编辑后静默保存，再走 fileSaved → 版本链回填。
 *
 * 与 SpreadsheetViewManager 的活视图刻意隔离：
 * - 不进 OfficePreviewRegistry.instances（不出现在页签清单/active 解析里）；
 * - 不调用 setActiveSheetsWebContents / setSheetsShellWindow / 首帧闸门 / 窗口 bounds IPC；
 * - dispose 不弹脏关闭对话框（只 teardown + close），绝不 requestSheetsClose。
 *
 * 视图必须挂到主窗口并给真实尺寸（1100×1400）再从视觉上隐藏：隐藏会话同样
 * 依赖渲染层布局测量（选区/滚动/图表锚点），0×0 的孤儿视图会保存出错误的结果。
 *
 * 结构 1:1 对应 office-agent-doc-session.ts（同样的 per-file 串行链、LRU/空闲回收、
 * 100MB 上限、CFB 密码检测、保存字节 sha256 校验）。差异只在运行时类型与
 * 「准备/加载工作簿」的方法名（prepareSpreadsheet / queueWorkbookForView）。
 */

/** 单份文件的后台编辑上限：超过就不适合在渲染器里整表解析。 */
const MAX_AGENT_SHEET_BYTES = 100 * 1024 * 1024
/** 空闲回收：隐藏会话是一个完整 Chromium 渲染器（~100-250MB）。 */
const SESSION_IDLE_MS = 3 * 60_000
/** 同时保留的隐藏会话数（按最近使用淘汰）。 */
const SESSION_MAX = 2
/** 等渲染层报告「目标工作副本已装载」的上限。 */
const READY_TIMEOUT_MS = 15_000
/** 隐藏视图给布局测量用的真实尺寸。 */
const HIDDEN_VIEW_BOUNDS = { x: 0, y: 0, width: 1100, height: 1400 }
/** OOXML 加密文件（password-protected xlsx/xlsm）是 CFB 容器：正常 .xlsx 是 zip（PK..）。 */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export interface AgentSheetFileMeta {
  fileId: string
  originalName: string
  storagePath: string
  contentHash: string
  roomId?: string | null
  workspaceId?: string | null
}

/** 会话回填端口：复用 Registry 既有的 editStates + 去抖导入链路（与 Word 同一套）。 */
export interface AgentSheetEditSyncPort {
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

export interface AgentSheetFileHints {
  roomId?: string | null
  workspaceId?: string | null
}

/** Excel 后台会话失败原因：比 Word 多 not_xlsx，其余语义一致（含未打开/未编辑）。 */
export type AgentSheetFailureReason =
  | Exclude<AgentDocFailureReason, 'not_docx'>
  | 'not_xlsx'

export type AgentSheetFailure = {
  ok: false
  reason: AgentSheetFailureReason
  message?: string
}

export type AgentSheetDescribeOutcome =
  | { ok: true; describe: GenOfficeAgentWorkbookDescription }
  | AgentSheetFailure

export type AgentSheetApplyOutcome =
  | {
    ok: true
    results: GenOfficeAgentToolResult[]
    /** 版本回填成功后返回新版本 id。 */
    version?: string
    /** 已应用但静默保存失败等：调用方仍需如实告诉用户。 */
    error?: string
  }
  | AgentSheetFailure

interface Session {
  fileId: string
  meta: AgentSheetFileMeta
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

const failure = (reason: AgentSheetFailureReason, message?: string): AgentSheetFailure =>
  message ? { ok: false, reason, message } : { ok: false, reason }

/** 一个文件一条串行链：隐藏会话的创建、describe、apply、销毁互斥。 */
export class AgentSheetSessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private shuttingDown = false

  constructor(
    private readonly options: {
      sheets: GenOfficeSheetsRuntime
      getWindow: () => BrowserWindow | null
      resolveFile: (fileId: string) => Promise<AgentSheetFileMeta | null>
      editSync: AgentSheetEditSyncPort
    },
  ) {}

  has(fileId: string): boolean {
    return this.sessions.has(fileId)
  }

  /** 是否有任何隐藏工作簿会话：Registry 空闲清理必须据此保留 sidecar。 */
  hasAny(): boolean {
    return this.sessions.size > 0
  }

  /** 只读描述；没有会话则按需拉起隐藏编辑器。 */
  async describe(
    fileId: string,
    hints?: AgentSheetFileHints,
  ): Promise<AgentSheetDescribeOutcome> {
    return this.runExclusive(fileId, async () => {
      const ensured = await this.ensure(fileId, hints)
      if (!ensured.ok) return ensured
      const { session } = ensured
      const described = await this.options.sheets.describeAgentWorkbook(session.contents)
      if ('error' in described) {
        return failure('open_failed', described.error)
      }
      return { ok: true as const, describe: described }
    })
  }

  /** 执行一批 sheets AI 工具调用；返回前把去抖中的版本回填排空。 */
  async apply(
    fileId: string,
    calls: GenOfficeAgentToolCall[],
    hints?: AgentSheetFileHints,
  ): Promise<AgentSheetApplyOutcome> {
    return this.runExclusive(fileId, async () => {
      const ensured = await this.ensure(fileId, hints)
      if (!ensured.ok) return ensured
      const { session } = ensured
      let applied: Awaited<ReturnType<GenOfficeSheetsRuntime['applyAgentWorkbookTools']>>
      try {
        applied = await this.options.sheets.applyAgentWorkbookTools(session.contents, calls)
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
          event: 'office.agent-sheet.version-backfill-failed',
          fileId,
          message: error instanceof Error ? error.message : String(error),
        })
      }
      // 2s 去抖可能已提前把这次保存导入掉（drain 看不到新事件）：有变更但
      // drain 没拿到回执时，按当前工作副本强制回填一次（同内容导入是幂等的）。
      const mutatedAny = applied.results.some((row) => row.mutated === true)
      if (mutatedAny && !imported) {
        try {
          imported = await this.options.editSync.flush(fileId)
        } catch (error) {
          logDesktop('office', 'warn', {
            event: 'office.agent-sheet.forced-backfill-failed',
            fileId,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      // 静默保存可能被“外部已修改”静默拒绝：渲染层对 auto-save 的失败返回值
      // 不敏感，唯一可靠的证据是工作副本字节有没有变化。只读批（mutated=false）
      // 不要求落盘；有变更但字节没变/没有新版本回填都必须如实报错，不能谎报成功。
      const mutated = applied.results.some((row) => row.mutated === true)
      let newHash: string | null = null
      try {
        newHash = (await hashFile(session.workingCopyPath)).toLowerCase()
      } catch {
        newHash = null
      }
      if (mutated) {
        if (!newHash || newHash === session.baseContentHash.toLowerCase()) {
          return failure(
            'save_failed',
            '修改已在后台编辑器里应用，但没有落盘（工作簿可能被外部修改过，静默保存被拒绝）。请重新读取工作簿后再试。',
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
    hints?: AgentSheetFileHints,
  ): Promise<{ ok: true; session: Session } | AgentSheetFailure> {
    if (this.shuttingDown) return failure('not_open', '应用正在退出')
    const meta = await this.options.resolveFile(fileId).catch(() => null)
    if (!meta) return failure('not_found', `文件 ${fileId} 不在文件库中（可能已删除或仍在导入）`)
    // 后台只有 OOXML 工作簿可用：旧版二进制 .xls 是 CFB 容器（与加密 xlsx 同魔数，
    // 无法用魔数区分），且网关的 sheets_agent_* 也只接受 .xlsx。
    if (!/\.(xlsx|xlsm)$/i.test(meta.originalName)) {
      return failure(
        'not_xlsx',
        `《${meta.originalName}》不是 Excel 工作簿（后台编辑只支持 .xlsx/.xlsm；旧版 .xls 请先另存为 .xlsx）`,
      )
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
    meta: AgentSheetFileMeta,
    hints?: AgentSheetFileHints,
  ): Promise<{ ok: true; session: Session } | AgentSheetFailure> {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return failure('not_open', '主窗口不可用，无法启动后台编辑器')

    let bytes = 0
    try {
      const info = await stat(meta.storagePath)
      bytes = info.size
    } catch {
      return failure('not_found', `《${meta.originalName}》的文件内容不可读`)
    }
    if (bytes > MAX_AGENT_SHEET_BYTES) {
      return failure(
        'too_large',
        `《${meta.originalName}》${(bytes / 1024 / 1024).toFixed(1)}MB，超过后台编辑上限 ${MAX_AGENT_SHEET_BYTES / 1024 / 1024}MB`,
      )
    }
    if (await isCfbFile(meta.storagePath)) {
      return failure('encrypted', `《${meta.originalName}》有打开密码，请先在编辑器里打开并输入密码`)
    }

    let workingCopyPath: string
    try {
      // agent 专用文件名：不能命中用户可见视图的崩溃恢复副本（隐藏视图没人能
      // 回答「是否恢复」对话框），也不能让后台静默保存清掉用户的待恢复副本。
      workingCopyPath = await prepareSpreadsheet(
        meta.fileId,
        meta.contentHash,
        meta.originalName,
        meta.storagePath,
        { agent: true },
      )
    } catch (error) {
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }

    const sheets = this.options.sheets
    sheets.registerSheetsIpc()
    let view: WebContentsView
    try {
      // 隐藏会话不是用户的页签：不接管全局 active 指针、不装 AI 聊天面板处理器。
      view = sheets.createSheetsView({
        includeAiHandlers: false,
        readonly: false,
        claimActive: false,
      })
    } catch (error) {
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }
    const contents = view.webContents
    try {
      window.contentView.addChildView(view)
      view.setBounds(HIDDEN_VIEW_BOUNDS)
      view.setVisible(false)
    } catch (error) {
      await teardownView(sheets, window, view)
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }

    // 先排队目标工作簿，再等渲染层确认「装载的就是这份路径」——顺序反了会
    // 在空白工作簿上跑工具调用。
    sheets.queueWorkbookForView(contents, workingCopyPath)
    const ready = typeof sheets.waitForAgentReady === 'function'
      ? await sheets.waitForAgentReady(contents, workingCopyPath, READY_TIMEOUT_MS)
      : false
    if (!ready) {
      await teardownView(sheets, window, view)
      return failure(
        'open_failed',
        typeof sheets.waitForAgentReady === 'function'
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
      event: 'office.agent-sheet.session-created',
      fileId: meta.fileId,
      originalName: meta.originalName,
      webContentsId: contents.id,
      bytes,
    })
    return { ok: true, session }
  }

  private applyHints(session: Session, hints?: AgentSheetFileHints): void {
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
        event: 'office.agent-sheet.release-failed',
        fileId: session.fileId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const window = this.options.getWindow()
    await teardownView(this.options.sheets, window, session.view)
    logDesktop('office', 'info', {
      event: 'office.agent-sheet.session-disposed',
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

async function isCfbFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return false
  try {
    const head = Buffer.alloc(CFB_MAGIC.length)
    const { bytesRead } = await handle.read(head, 0, CFB_MAGIC.length, 0)
    return bytesRead === CFB_MAGIC.length && head.equals(CFB_MAGIC)
  } catch {
    return false
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** 拆视图：teardown 渲染端（清恢复副本/撤销写授权）→ 摘视图 → 关 webContents；不弹对话框。 */
async function teardownView(
  sheets: GenOfficeSheetsRuntime,
  window: BrowserWindow | null,
  view: WebContentsView,
): Promise<void> {
  const contents = view.webContents
  try {
    if (!contents.isDestroyed()) sheets.teardownSheetsRenderer(contents)
  } catch {
    /* already torn down */
  }
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