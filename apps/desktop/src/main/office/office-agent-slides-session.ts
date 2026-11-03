import { open as openFile, stat } from 'node:fs/promises'

import type { BrowserWindow, WebContentsView } from 'electron'

import { logDesktop } from '../logging/desktop-logger'
import type { AgentDocFailureReason } from './office-agent-doc-session'
import type {
  AgentSlidesEditResult,
  GenOfficeMaterialResolver,
  GenOfficeSlidesRuntime,
} from './office-runtime'
import { preparePresentation } from './slides-view-manager'

/**
 * Agent 的后台 slides 编辑会话（结构与 office-agent-sheet-session.ts 同构，按落页
 * 链路裁剪）：用户没有打开这份 PPT 时，用一份隐藏的 GenOffice slides 视图跑与
 * 活会话**同一条** applyAgentDeckPage 事务管线（像素一致、undo、fileSaved 回填），
 * 让逐页落页不再依赖「用户恰好打开过这个文件」。
 *
 * 与 SlidesViewManager 的活视图刻意隔离：
 * - 不进 OfficePreviewRegistry.instances（不出现在页签清单/active 解析里）；
 * - 不调 setActiveSlidesWebContents / setSlidesShellWindow / 首帧闸门 / bounds IPC；
 * - dispose 绝不 requestSlidesClose（隐藏视图没人能回答脏关闭对话框）；
 * - 工作副本带 agent- 前缀，静默保存不会清掉用户的崩溃恢复副本。
 */

const failure = (reason: AgentSlidesFailureReason, message?: string) =>
  ({ ok: false as const, reason, ...(message ? { message } : {}) })

export type AgentSlidesFailureReason = AgentDocFailureReason

/** 单份文件的后台上限：deck 解包在渲染端做，超大的整册不适合后台跑。 */
const MAX_AGENT_SLIDE_BYTES = 100 * 1024 * 1024
/** 空闲回收：隐藏会话是一个完整 Chromium 渲染器（~100-250MB）；落页页间可能数分钟，给宽。 */
const SESSION_IDLE_MS = 5 * 60_000
/** 同时保留的隐藏会话数（按最近使用淘汰）。 */
const SESSION_MAX = 2
/** 等渲染端 mount + consumePendingOpen + openAndBuild 注册会话的上限。 */
const READY_TIMEOUT_MS = 20_000
/** 隐藏视图给真实尺寸（渲染层 deck 布局测量依赖非 0 视口）。 */
const HIDDEN_VIEW_BOUNDS = { x: 0, y: 0, width: 1280, height: 720 }
/** OOXML 加密文件是 CFB 容器：正常 .pptx 是 zip（PK..）。 */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export interface AgentSlidesFileMeta {
  fileId: string
  originalName: string
  storagePath: string
  contentHash: string
  roomId?: string | null
  workspaceId?: string | null
}

/** 会话回填端口：复用 Registry 既有的 editStates + 去抖导入链路（与 Word/Excel 同一套）。 */
export interface AgentSlidesEditSyncPort {
  register(input: {
    fileId: string
    webContentsId: number
    filePath: string
    originalName: string
    roomId: string | null
    workspaceId: string | null
  }): () => void
  drain(fileId: string): Promise<{ contentHash?: string; fileVersionId?: string } | null>
  release(fileId: string): Promise<void>
}

interface Session {
  fileId: string
  meta: AgentSlidesFileMeta
  view: WebContentsView
  workingCopyPath: string
  /** 建会话时的 catalog 版本指纹：catalog 变了（版本回填）就重建，别改旧副本。 */
  baseContentHash: string
  roomId: string | null
  workspaceId: string | null
  lastUsed: number
  idleTimer: NodeJS.Timeout | null
  unsubscribeSaved: (() => void) | null
  disposed: boolean
}

export class AgentSlidesSessionManager {
  private readonly sessions = new Map<string, Session>()
  private shuttingDown = false

  constructor(private readonly options: {
    slides: GenOfficeSlidesRuntime
    getWindow(): BrowserWindow | null
    resolveFile(fileId: string): Promise<AgentSlidesFileMeta | null>
    materialResolver(): GenOfficeMaterialResolver | null
    editSync: AgentSlidesEditSyncPort
  }) {}

  /** 逐页落页：ensure 会话 → applyAgentDeckPage（事务 + 广播 + 静默保存）→ 排空版本回填。 */
  async applyPage(
    fileId: string,
    page: { slideIndex: number; specJson: string },
  ): Promise<{ ok: true; result: AgentSlidesEditResult } | { ok: false; reason: AgentSlidesFailureReason; message?: string }> {
    const ensured = await this.ensure(fileId)
    if (!ensured.ok) return ensured
    const { session } = ensured
    const result = await this.options.slides.applyAgentDeckPage(
      session.view.webContents.id,
      page,
      this.options.materialResolver() ?? undefined,
    )
    this.touch(session)
    if (!result.ok) return { ok: false, reason: 'open_failed', message: result.error }
    // applyAgentDeckPage 内部已静默保存触发 fileSaved；排空去抖让版本链立即回填，
    // 后续页若触发 catalog hash 变化（ensure 重建判定）能看到最新版本。
    await this.options.editSync.drain(fileId).catch(() => null)
    return { ok: true, result }
  }

  async dispose(fileId: string): Promise<void> {
    const session = this.sessions.get(fileId)
    if (session) await this.disposeSession(session)
  }

  async disposeAll(): Promise<void> {
    this.shuttingDown = true
    await Promise.all([...this.sessions.keys()].map((fileId) => this.dispose(fileId)))
    this.shuttingDown = false
  }

  private async ensure(
    fileId: string,
  ): Promise<{ ok: true; session: Session } | { ok: false; reason: AgentSlidesFailureReason; message?: string }> {
    if (this.shuttingDown) return failure('not_open', '应用正在退出')
    const meta = await this.options.resolveFile(fileId).catch(() => null)
    if (!meta) return failure('not_found', `文件 ${fileId} 不在文件库中（可能已删除或仍在导入）`)
    if (!/\.pptx$/i.test(meta.originalName)) {
      return failure('open_failed', `《${meta.originalName}》不是 .pptx（后台落页只支持 .pptx）`)
    }
    const existing = this.sessions.get(fileId)
    if (existing && !existing.disposed && !existing.view.webContents.isDestroyed()) {
      if (existing.baseContentHash.toLowerCase() === meta.contentHash.toLowerCase()) {
        this.touch(existing)
        return { ok: true, session: existing }
      }
      // catalog 版本变了（例如上一轮落页已回填新版本）：旧会话开的是旧副本，重建。
      await this.disposeSession(existing)
    }
    if (existing) this.sessions.delete(fileId)

    const prepared = await this.prepareSession(meta)
    if (!prepared.ok) return prepared
    await this.evictOverflow(fileId)
    this.sessions.set(fileId, prepared.session)
    this.touch(prepared.session)
    return { ok: true, session: prepared.session }
  }

  private async prepareSession(
    meta: AgentSlidesFileMeta,
  ): Promise<{ ok: true; session: Session } | { ok: false; reason: AgentSlidesFailureReason; message?: string }> {
    const window = this.options.getWindow()
    if (!window || window.isDestroyed()) return failure('not_open', '主窗口不可用，无法启动后台编辑器')

    let bytes = 0
    try {
      bytes = (await stat(meta.storagePath)).size
    } catch {
      return failure('not_found', `《${meta.originalName}》的文件内容不可读`)
    }
    if (bytes > MAX_AGENT_SLIDE_BYTES) {
      return failure('too_large', `《${meta.originalName}》${(bytes / 1024 / 1024).toFixed(1)}MB，超过后台落页上限 ${MAX_AGENT_SLIDE_BYTES / 1024 / 1024}MB`)
    }
    if (await isCfbFile(meta.storagePath)) {
      return failure('encrypted', `《${meta.originalName}》有打开密码，请先在编辑器里打开并输入密码`)
    }

    let workingCopyPath: string
    try {
      workingCopyPath = await preparePresentation(meta.fileId, meta.contentHash, meta.originalName, meta.storagePath, { agent: true })
    } catch (error) {
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }

    const slides = this.options.slides
    slides.registerSlidesIpc()
    // createSlidesView 只建视图 + 排队路径 + 加载渲染器（不接管 active/shell 指针），
    // 渲染端 mount 后 consumePendingOpen → openAndBuild 注册 genoffice session。
    const view = slides.createSlidesView(workingCopyPath, { readonly: false })
    try {
      window.contentView.addChildView(view)
      view.setBounds(HIDDEN_VIEW_BOUNDS)
      view.setVisible(false)
    } catch (error) {
      await teardownView(window, view)
      return failure('open_failed', error instanceof Error ? error.message : String(error))
    }

    const wcId = view.webContents.id
    const deadline = Date.now() + READY_TIMEOUT_MS
    // 就绪探测：describeAgentDeck 返回非 null = genoffice session 已注册。
    while (this.options.slides.describeAgentDeck(wcId) === null) {
      if (view.webContents.isDestroyed()) {
        return failure('open_failed', `《${meta.originalName}》后台编辑器在就绪前被销毁`)
      }
      if (Date.now() > deadline) {
        await teardownView(window, view)
        return failure('open_failed', `《${meta.originalName}》后台编辑器未在 ${READY_TIMEOUT_MS / 1000}s 内就绪（文件可能损坏或格式不支持）`)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    const roomId = normalizedId(meta.roomId)
    const workspaceId = normalizedId(meta.workspaceId)
    const session: Session = {
      fileId: meta.fileId,
      meta,
      view,
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
      webContentsId: wcId,
      filePath: workingCopyPath,
      originalName: meta.originalName,
      roomId,
      workspaceId,
    })
    view.webContents.once('destroyed', () => {
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
      event: 'office.agent-slides.session-created',
      fileId: meta.fileId,
      originalName: meta.originalName,
      webContentsId: wcId,
      bytes,
    })
    return { ok: true, session }
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
        event: 'office.agent-slides.release-failed',
        fileId: session.fileId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    await teardownView(this.options.getWindow(), session.view)
    logDesktop('office', 'info', { event: 'office.agent-slides.session-disposed', fileId: session.fileId })
  }
}

function normalizedId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function isCfbFile(path: string): Promise<boolean> {
  const handle = await openFile(path, 'r').catch(() => null)
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

/** 拆视图：摘出窗口 → 关 webContents；不弹脏关闭对话框（slides 无 renderer teardown API）。 */
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
