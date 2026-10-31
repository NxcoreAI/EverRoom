import { createHash } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { BrowserWindow, webContents } from 'electron'

import type { OfficeAgentFileEvent } from '../../shared/office'
import { describeThesisError } from '../../shared/thesis-error-message'
import { logDesktop } from '../logging/desktop-logger'
import {
  officePreviewKindForFileName,
  type OfficePreviewKind,
} from '../../shared/sources'
import { onOfficeFileSaved, wireOfficeSavedHooks, wireSlidesAgentAsk, type AgentAskForwardEvent } from './office-generation'
import type { GenOfficeMaterialResolver } from './office-runtime'
import {
  loadPreparedGenOfficeRuntime,
  type AgentSlidesDeckInfo,
  type AgentSlidesEditResult,
  type GenOfficeAgentDocDescription,
  type GenOfficeAgentToolCall,
  type GenOfficeAgentToolResult,
  type GenOfficeAgentWorkbookDescription,
  type PreparedGenOfficeRuntime,
} from './office-runtime'
import { OfficeViewManager, prepareOfficeDocument } from './office-view-manager'
import {
  AgentDocSessionManager,
  type AgentDocFileHints,
  type AgentDocFileMeta,
  type AgentDocFailureReason,
} from './office-agent-doc-session'
import {
  AgentSheetSessionManager,
  type AgentSheetFileHints,
  type AgentSheetFailureReason,
} from './office-agent-sheet-session'
import { writeBackEditedDocument } from './write-back'
import { PdfViewManager } from './pdf-view-manager'
import { SlidesViewManager } from './slides-view-manager'
import { SpreadsheetViewManager } from './spreadsheet-view-manager'
import { logOfficeDiag } from './office-diag'

/** 默认工作区 id（与网关 files/agent 的 default 工作区同名）：归属缺失时的兜底。 */
const DEFAULT_OFFICE_WORKSPACE_ID = 'default'

export interface OfficePreviewDescriptor {
  id: string
  kind: OfficePreviewKind
  title: string
  contentHash: string
}

export interface OfficePreviewFile {
  id: string
  contentHash: string
  originalName: string
  storagePath: string
  /** 产物（docx/pptx/xlsx）：true → 可编辑视图，保存后回填版本链（其余格式忽略）。 */
  editable?: boolean
  /** 版本链回填的 Room 投影归属（不传则按导入落点默认决策）。 */
  roomId?: string | null
  /** 条目归属工作区（资料库/产物库按空间隔离；保存回填重导入带上，避免归属被重置；
   *  论文排版面板据此取模版卡与产物落点）。 */
  workspaceId?: string | null
  /**
   * 从系统文件管理器直接打开的磁盘路径：保存后除回填版本链外，还把工作副本
   * 写回这份原文件，保证 Word/WPS 等外部程序能看到编辑结果。
   */
  writeBackPath?: string
}

/** The lifecycle surface the three view managers expose to the registry. */
interface OfficePreviewView {
  setActive(active: boolean): void
  /** false = 用户在脏关闭守卫里取消：实例原样保留。 */
  dispose(): Promise<boolean>
  /** Office 视图的 webContents id（保存事件订阅用）；pdf 缺省。 */
  readonly webContentsId?: number
  /** 未保存修改：Agent 覆盖工作副本前必须为 false（pdf/slides 缺省）。 */
  isDirty?(): Promise<boolean>
}

interface OfficePreviewInstance {
  descriptor: OfficePreviewDescriptor
  view: OfficePreviewView
  editable: boolean
  documentPath: string | null
  roomId: string | null
  /** 未解析到归属时按默认工作区处理（资料库/上传/排版都能用）。 */
  workspaceId: string
  unsubscribeSaved: (() => void) | null
}

/** 产物编辑回填的去抖合并窗口：连发保存（含关窗时的 Save）只落一次导入。 */
const EDIT_SYNC_DEBOUNCE_MS = 2_000

/** Agent 编辑已打开 slides 产物的请求（bridge /v1/office-edit 的载荷）。 */
export type SlidesEditArtifactRequest =
  | { mode: 'read' }
  | { mode: 'apply'; ops: unknown[]; dryRun?: boolean; isolation?: 'atomic' | 'per_op' }
  | { mode: 'apply'; page: { slideIndex: number; specJson: string } }

/** 当前打开的 Office 实例（引导报错随行，让 Agent 能告知用户现场）。 */
export interface OpenOfficeInstanceInfo {
  fileId: string
  title: string
  kind: OfficePreviewKind
  editable: boolean
  active: boolean
}

/**
 * Agent 后台 Word/Excel 失败原因：not_open/not_editable/unsaved 是“现场状态”，
 * 其余是后台打开/保存阶段的可诊断错误（任何一条都不能被谎报成成功）。
 * Excel 后台会话额外区分 not_xlsx（不是 OOXML 工作簿）。
 */
export type AgentArtifactFailureReason =
  | 'not_open'
  | 'not_editable'
  | 'unsaved'
  | Exclude<AgentDocFailureReason, 'not_open' | 'not_editable' | 'unsaved'>
  | Exclude<AgentSheetFailureReason, 'not_open' | 'not_editable' | 'unsaved'>

/** 活 Word/Excel 宿主执行器结果：apply 的错误随行（已应用但保存失败等）。 */
export type AgentArtifactToolsOutcome =
  | {
    ok: true
    results: GenOfficeAgentToolResult[]
    error?: string
    /** 后台会话在 apply 内完成版本回填后的新版本 id。 */
    version?: string
  }
  | {
    ok: false
    reason: AgentArtifactFailureReason
    message?: string
    open?: OpenOfficeInstanceInfo[]
  }

export type SlidesEditArtifactOutcome =
  | { ok: true; info?: AgentSlidesDeckInfo; result?: AgentSlidesEditResult }
  | { ok: false; reason: 'not_open' | 'not_editable'; open?: OpenOfficeInstanceInfo[] }

/** 保存回填的 per-file 状态：独立于视图存活（导入只需要磁盘工作副本）。 */
interface EditSyncState {
  filePath: string
  originalName: string
  /** sourceKey 前缀与广播 format 按形态派生（word/slides/sheets → docx/pptx/xlsx）。 */
  kind: 'docx' | 'slides' | 'spreadsheet'
  roomId: string | null
  /** 条目归属工作区：保存回填重导入时带上，避免归属被重置（资料库按空间隔离）。 */
  workspaceId: string | null
  /** 访达直接打开时的原文件路径：保存后写回它（库内版本照常 +1）。 */
  writeBackPath: string | null
  pending: boolean
  timer: NodeJS.Timeout | null
  runner: Promise<void> | null
  /** 最近一次版本回填结果（后台会话 apply 后回传版本号用）。 */
  lastImport?: { contentHash?: string; fileVersionId?: string } | null
}

/** AI 页签论文排版桥（index.ts 注入网关实现；按工作区隔离）。 */
export interface OfficeThesisPanelBridge {
  listCards(workspaceId: string): Promise<unknown[]>
  pickAndSet(
    workspaceId: string,
    options?: { wordOnly?: boolean; overwrite?: boolean },
  ): Promise<{ canceled: boolean; cardId: string; sourceName: string; factGaps?: string[]; duplicate?: boolean }>
  removeCard(workspaceId: string, cardId: string): Promise<void>
  /** 彻底删除模版（文件 + 格式卡）。 */
  deleteTemplate(
    workspaceId: string,
    cardId: string,
    options?: { keepCard?: boolean },
  ): Promise<{ fileDeleted: boolean; hadFile: boolean; cardKept: boolean }>
  reformat(
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: {
      keepLogo?: boolean
      keepHeaderFooter?: boolean
      headingMapping?: { chapter?: number; section?: number; subsection?: number }
      aiFill?: boolean
    },
  ): Promise<{ originalName: string; report?: Record<string, unknown> }>
  /** 任务化排版：立即返回 jobId（后台执行），用 reformatJobStatus 轮询进度。 */
  startReformatJob(
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: {
      keepLogo?: boolean
      keepHeaderFooter?: boolean
      headingMapping?: { chapter?: number; section?: number; subsection?: number }
    },
  ): Promise<{ jobId: string; phase: string }>
  /** 打开模板原文件的真预览：应用自带 Office 渲染器（多页滚动、表格/图片完整）。 */
  previewTemplate(workspaceId: string, cardId: string): Promise<{ opened: boolean; reason?: string }>
  reformatJobStatus(
    jobId: string,
  ): Promise<{
    id: string
    status: 'running' | 'completed' | 'failed'
    phase: string
    progress: number
    result?: unknown
    error?: string
  }>
}

/** 内嵌 Office 文件扩展名 → 预览运行时分流（shared 实现，渲染端入口与 files:open-original 共用同一白名单）。 */
export const officePreviewKindFor = officePreviewKindForFileName

/**
 * 顶栏 Office 预览标签的主进程侧：按 fileId 多开/复用 genoffice 视图实例，
 * 同一时刻只显示渲染端激活的那个（渲染端是焦点唯一事实源，open 不自动激活）。
 * docx/pptx/xlsx 产物可编辑：保存事件去抖后按 fileEntryId 钉住条目重导入（版本链 +1）。
 */
export class OfficePreviewRegistry {
  private runtime: PreparedGenOfficeRuntime | null = null
  private window: BrowserWindow | null = null
  private readonly instances = new Map<string, OfficePreviewInstance>()
  private activeId: string | null = null
  private readonly editStates = new Map<string, EditSyncState>()
  private agentAskForward: ((event: AgentAskForwardEvent) => void) | null = null
  private thesisBridge: OfficeThesisPanelBridge | null = null
  /** 未打开文件的后台 Word 编辑会话（独立于页签实例，不进 instances）。 */
  private agentDocs: AgentDocSessionManager | null = null
  /** 未打开文件的后台 Excel 编辑会话（同上；持有自己的 sidecar 会话）。 */
  private agentSheets: AgentSheetSessionManager | null = null
  /** Agent 后台编辑的文件解析端口（index.ts 注入文件库访问）。 */
  private agentFileResolver: ((fileId: string) => Promise<AgentDocFileMeta | null>) | null = null
  /** 后台会话的保存回填订阅（fileId → unsubscribe）。 */
  private readonly agentEditUnsubscribers = new Map<string, () => void>()

  /** 生成完成 → 渲染端自动打开的等待窗口；测试可传 0 关闭。 */
  constructor(
    private readonly autoOpenWaitMs = 8_000,
    /** everroom-material:// 素材回源器（惰性取——文件桥在网关启动后才就绪）。 */
    private readonly materialResolver: () => GenOfficeMaterialResolver | null = () => null,
  ) {}
  private editSyncBindings: {
    importAgentFile: (input: {
      filePath: string
      originalName: string
      sourceKey: string
      fileEntryId?: string
      roomId?: string
      workspaceId?: string
    }) => Promise<unknown>
    broadcast: (event: OfficeAgentFileEvent) => void
  } | null = null

  /** 编辑回填依赖注入（index.ts 启动时接线；缺省则编辑视图保存不回填）。 */
  setEditSync(bindings: OfficePreviewRegistry['editSyncBindings']): void {
    this.editSyncBindings = bindings
  }

  /** 「AI 修改」转发出口：slides 弹层提交 → wcId 反查 Room → 注入 Room 对话框。 */
  setAgentAskForward(forward: ((event: AgentAskForwardEvent) => void) | null): void {
    this.agentAskForward = forward
  }

  /**
   * 注入「按 fileId 解析工作副本」的端口：后台 Word/Excel 编辑会话用它把任意
   * file_entry 变成可编辑工作副本（名称/内容哈希/存储路径/归属）。
   */
  setAgentFileResolver(resolver: ((fileId: string) => Promise<AgentDocFileMeta | null>) | null): void {
    this.agentFileResolver = resolver
    this.agentDocs = null
    this.agentSheets = null
  }

  /** 是否有正在显示的 docs 页签（应用菜单接管闸门；后台会话不算）。 */
  hasActiveDocInstance(): boolean {
    if (!this.activeId) return false
    return this.instances.get(this.activeId)?.descriptor.kind === 'docx'
  }

  /**
   * EverRoom 宿主控制「干净画布」：隐藏/显示当前 Word 编辑器的操作区
   * （Ribbon/状态栏/标尺/导航）。hidden 省略 = 切换。返回是否命中可见实例；
   * 渲染层自带恢复胶囊与 ⌘⇧F，隐藏后用户始终能恢复。
   */
  setDocsChromeHidden(fileId: string | 'active', hidden?: boolean): boolean {
    const resolvedId = fileId === 'active' ? this.resolveActiveKind('docx') : fileId
    const instance = resolvedId === null ? undefined : this.instances.get(resolvedId)
    const wcId = instance?.view.webContentsId
    if (!instance || instance.descriptor.kind !== 'docx' || !this.runtime || typeof wcId !== 'number') {
      return false
    }
    const target = webContents.fromId(wcId)
    if (!target || target.isDestroyed()) return false
    this.runtime.docs.setDocsChromeHidden(target, hidden)
    return true
  }

  /** AI 页签论文排版桥：网关就绪后由 index.ts 注入（幂等，晚于首开也生效）。 */
  setThesisPanelBridge(bridge: OfficeThesisPanelBridge | null): void {
    this.thesisBridge = bridge
    if (this.runtime && bridge) this.wireDocsThesisHook(this.runtime)
  }

  /** 格式卡变更 → 通知打开中的 docs 视图（AI 页签面板刷新）。 */
  notifyThesisCardsChanged(): void {
    for (const instance of this.instances.values()) {
      const wcId = instance.view.webContentsId
      if (typeof wcId !== 'number' || instance.descriptor.kind !== 'docx') continue
      const wc = webContents.fromId(wcId)
      if (wc && !wc.isDestroyed()) wc.send('docs:thesis-changed')
    }
  }

  private wireDocsThesisHook(runtime: PreparedGenOfficeRuntime): void {
    const bridge = this.thesisBridge
    if (!bridge) return
    // 运行时能力守卫：论文排版桥是 genoffice 后加的导出，带着旧运行时启动时它是 undefined。
    // 缺了只跳过这个桥（AI 页签排版面板不可用），不能让 ensureRuntime 抛错——那会让
    // 整条 open() 失败，Room 里的 Office 产物全部退回「用系统默认应用打开」。
    if (typeof runtime.docs.setDocsThesisPanelHook !== 'function') {
      logDesktop('office', 'warn', {
        event: 'office.thesis-bridge-unavailable',
        message: 'genoffice runtime 缺少 setDocsThesisPanelHook，跳过论文排版桥',
      })
      return
    }
    runtime.docs.setDocsThesisPanelHook(async (wcId, action) => {
      const instance = this.findByWebContentsId(wcId)
      if (!instance) return { ok: false, reason: 'no_room' as const }
      // 论文排版按工作区隔离：模版卡、模版文件与排版产物都归当前文档所属空间。
      // 老库/访达直开的文件可能没有归属，按默认工作区兜底——面板始终可用。
      const workspaceId = instance.workspaceId
      try {
        switch (action.kind) {
          case 'list':
            return { ok: true as const, value: await bridge.listCards(workspaceId) }
          case 'pick':
            // overwrite：同名冲突后用户选「替换原文件」→ 复用上次选择的文件直接解析
            return { ok: true as const, value: await bridge.pickAndSet(workspaceId, { overwrite: action.overwrite === true }) }
          case 'remove':
            await bridge.removeCard(workspaceId, action.cardId)
            return { ok: true as const, value: null }
          case 'delete-template':
            // 彻底删除：模版文件（+ 可选格式卡）。文件删不掉也继续，不阻断。
            return {
              ok: true as const,
              value: await bridge.deleteTemplate(workspaceId, action.cardId, { keepCard: action.keepCard === true }),
            }
          case 'reformat':
            return { ok: true as const, value: await bridge.reformat(workspaceId, instance.fileId, action.cardId) }
          case 'reformat-job':
            // 后台作业：立即返回 jobId，面板轮询进度（不再挂长请求）
            return {
              ok: true as const,
              value: await bridge.startReformatJob(workspaceId, instance.fileId, action.cardId, action.options),
            }
          case 'reformat-job-status': {
            const snapshot = await bridge.reformatJobStatus(action.jobId)
            // 作业失败是「轮询成功、状态为 failed」，走不到下面的 catch——
            // 错误码（thesis_source_not_docx 等）必须在这里翻译，否则面板
            // 显示的就是一串机器码（那正是 describeThesisError 要消灭的东西）。
            return {
              ok: true as const,
              value: snapshot.status === 'failed' && snapshot.error
                ? { ...snapshot, error: describeThesisError(snapshot.error) }
                : snapshot,
            }
          }
          case 'preview-template':
            // 真预览：宿主用自带 Office 渲染器打开模版原文件（多页、表格、图片完整）
            return { ok: true as const, value: await bridge.previewTemplate(workspaceId, action.cardId) }
        }
      } catch (error) {
        // 面板只显示这一行文本：内部错误码（thesis_format_card_not_found）与上游
        // 原样报错（nginx 502 HTML）必须翻译成人话，否则用户只看到「没反应」。
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[thesis] 面板操作失败', { kind: action.kind, workspaceId, fileId: instance.fileId, error: message })
        return {
          ok: false as const,
          reason: 'error' as const,
          message: describeThesisError(message),
        }
      }
      return { ok: false as const, reason: 'error' as const, message: '未知的排版操作，请重启应用后重试。' }
    })
  }

  /** 打开（或复用）一个预览实例；instanceId = fileId，contentHash 或 editable 变化时原地重建。 */
  async open(window: BrowserWindow, file: OfficePreviewFile): Promise<OfficePreviewDescriptor> {
    const kind = officePreviewKindFor(file.originalName)
    if (!kind) throw new Error(`Unsupported internal Office preview: ${file.originalName}`)
    const startedAt = Date.now()
    logOfficeDiag('office.diag.open.start', {
      fileId: file.id,
      kind,
      editable: file.editable === true,
      hasWriteBackPath: Boolean(file.writeBackPath),
      activeId: this.activeId,
      openCount: this.instances.size,
    })
    this.bindWindow(window)
    const runtime = this.ensureRuntime(window)
    const editable = file.editable === true && kind !== 'pdf'
    const roomId = typeof file.roomId === 'string' && file.roomId ? file.roomId : null
    const requestedWorkspaceId = typeof file.workspaceId === 'string' && file.workspaceId.trim()
      ? file.workspaceId.trim()
      : null
    // 论文排版面板要求实例一定有归属：老库/访达直开的文件按默认工作区兜底；
    // 但「有没有解析到归属」仍单独保留（requestedWorkspaceId），复用时不能把
    // 已解析到的空间冲回默认。
    const workspaceId: string = requestedWorkspaceId ?? DEFAULT_OFFICE_WORKSPACE_ID
    const writeBackPath = editable && typeof file.writeBackPath === 'string' && file.writeBackPath
      ? file.writeBackPath
      : null

    // 同一文件存在后台 Agent 会话（Word 或 Excel）时先排空并关闭：可见视图与
    // 隐藏视图绝不共用同一份工作副本（否则就是双写者）。
    if (this.agentDocs?.has(file.id)) {
      await this.agentDocs.dispose(file.id)
    }
    if (this.agentSheets?.has(file.id)) {
      await this.agentSheets.dispose(file.id)
    }

    const existing = this.instances.get(file.id)
    if (existing && existing.descriptor.contentHash === file.contentHash && existing.editable === editable) {
      // 复用实例时刷新归属：同一个 fileId 可能先从「无归属」入口打开（访达），
      // 再从资料库打开；排版面板要用最新解析到的工作区。只有真的解析到归属才覆盖，
      // 免得从无归属入口重开时把已知空间冲回 default。
      if (requestedWorkspaceId) {
        existing.workspaceId = requestedWorkspaceId
        const state = this.editStates.get(file.id)
        if (state) state.workspaceId = requestedWorkspaceId
      }
      logOfficeDiag('office.diag.open.reuse', { fileId: file.id, elapsedMs: Date.now() - startedAt, activeId: this.activeId })
      return existing.descriptor
    }
    if (existing) {
      // 旧实例可能带未保存编辑：脏关闭守卫里取消则保留旧实例不动。
      logOfficeDiag('office.diag.open.recreate', {
        fileId: file.id,
        wasActive: this.activeId === file.id,
        hashChanged: existing.descriptor.contentHash !== file.contentHash,
        editableChanged: existing.editable !== editable,
      })
      const closed = await this.close(file.id)
      if (!closed) return this.instances.get(file.id)!.descriptor
    }

    const descriptor: OfficePreviewDescriptor = {
      id: file.id,
      kind,
      title: file.originalName,
      contentHash: file.contentHash,
    }
    const { view, documentPath } = await this.createView(window, runtime, kind, file, editable)
    const instance: OfficePreviewInstance = {
      descriptor,
      view,
      editable,
      documentPath,
      roomId,
      workspaceId,
      unsubscribeSaved: null,
    }
    if (editable && typeof view.webContentsId === 'number') {
      const fileId = file.id
      this.editStates.set(fileId, {
        filePath: documentPath!,
        originalName: file.originalName,
        kind,
        roomId,
        workspaceId,
        writeBackPath,
        pending: false,
        timer: null,
        runner: null,
      })
      instance.unsubscribeSaved = onOfficeFileSaved(view.webContentsId, () => this.scheduleEditSync(fileId))
    }
    this.instances.set(file.id, instance)
    logOfficeDiag('office.diag.open.done', {
      fileId: file.id,
      kind,
      elapsedMs: Date.now() - startedAt,
      webContentsId: view.webContentsId ?? null,
      activeId: this.activeId,
      openCount: this.instances.size,
    })
    return descriptor
  }

  has(id: string): boolean {
    return this.instances.has(id)
  }

  /**
   * Agent 编辑一个已打开的 slides 产物（活会话事务；编辑过程直接重绘在打开的视图上）。
   * fileId 'active' 解析为「当前打开的那个 PPT」：焦点 slides 实例优先，退化为唯一
   * 打开的 slides 实例；未打开/会话未就绪返回结构化原因并附当前打开的 Office 清单。
   * read 对只读实例也放行（“这个 PPT 有啥”）；apply 必须是可编辑实例。
   */
  async editSlidesArtifact(
    fileId: string,
    req: SlidesEditArtifactRequest,
  ): Promise<SlidesEditArtifactOutcome> {
    const resolvedId = fileId === 'active' ? this.resolveActiveSlides() : fileId
    let instance = resolvedId === null ? undefined : this.instances.get(resolvedId)
    // 生成完成 → 渲染端自动以可编辑方式打开有一条异步链路（刷新/挂载/开视图）；
    // 显式 fileId 的读/写在等待窗口内轮询，避免把「正在打开」误报成「未打开」。
    if (!instance && fileId !== 'active') {
      instance = await this.waitForInstance(fileId)
    }
    const wcId = instance?.view.webContentsId
    if (!instance || !this.runtime || typeof wcId !== 'number') {
      return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
    }
    if (instance.descriptor.kind !== 'slides') {
      return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
    }
    if (req.mode === 'read') {
      const info = this.runtime.slides.describeAgentDeck(wcId)
      return info
        ? { ok: true, info: { ...info, editable: instance.editable } }
        : { ok: false, reason: 'not_open', open: this.listOpenOffice() }
    }
    if (!instance.editable) {
      return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
    }
    return {
      ok: true,
      result: 'page' in req
        ? await this.runtime.slides.applyAgentDeckPage(wcId, req.page, this.materialResolver() ?? undefined)
        : await this.runtime.slides.applyAgentDeckOps(wcId, req.ops, {
          dryRun: req.dryRun,
          isolation: req.isolation,
        }),
    }
  }

  /**
   * 渲染一个已打开 slides 产物的指定页为 1x PNG（视觉复检用）。fileId 解析
   * 与 editSlidesArtifact 同规则（active/显式 id + 自动打开等待窗口）；只读
   * 实例同样可渲染（复检不改内容）。
   */
  async renderSlidesPagePng(
    fileId: string,
    slideIndex: number,
  ): Promise<{ ok: true; pngBase64: string } | { ok: false; error: string }> {
    const resolvedId = fileId === 'active' ? this.resolveActiveSlides() : fileId
    let instance = resolvedId === null ? undefined : this.instances.get(resolvedId)
    if (!instance && fileId !== 'active') {
      instance = await this.waitForInstance(fileId)
    }
    const wcId = instance?.view.webContentsId
    if (!instance || !this.runtime || typeof wcId !== 'number') {
      return { ok: false, error: 'no open slides instance for this fileId' }
    }
    if (instance.descriptor.kind !== 'slides') {
      return { ok: false, error: 'the open instance is not a slides deck' }
    }
    const rendered = await this.runtime.slides.renderAgentDeckPagePng(wcId, slideIndex)
    return 'pngBase64' in rendered
      ? { ok: true, pngBase64: rendered.pngBase64 }
      : { ok: false, error: rendered.error }
  }

  /** 'active' 的解析：焦点实例优先；无焦点时该 kind 唯一打开的实例兜底。 */
  private resolveActiveKind(kind: 'docx' | 'spreadsheet'): string | null {
    if (this.activeId) {
      const instance = this.instances.get(this.activeId)
      if (instance?.descriptor.kind === kind) return this.activeId
    }
    const ids = [...this.instances.entries()]
      .filter(([, instance]) => instance.descriptor.kind === kind)
      .map(([id]) => id)
    return ids.length === 1 ? ids[0]! : null
  }

  /** 定位目标实例（active/显式 id + 自动打开等待窗口），并校验 kind。 */
  private async resolveAgentInstance(
    fileId: string,
    kind: 'docx' | 'spreadsheet',
    options?: {
      /** 显式 fileId 未打开时是否等自动打开窗口（后台 Word 会话不需要等）。 */
      waitForOpen?: boolean
    },
  ): Promise<
    | { ok: true; instance: OfficePreviewInstance; wcId: number }
    | { ok: false; reason: 'not_open' | 'not_editable'; open: OpenOfficeInstanceInfo[] }
  > {
    const resolvedId = fileId === 'active' ? this.resolveActiveKind(kind) : fileId
    let instance = resolvedId === null ? undefined : this.instances.get(resolvedId)
    if (!instance && fileId !== 'active' && options?.waitForOpen !== false) {
      instance = await this.waitForInstance(fileId)
    }
    const wcId = instance?.view.webContentsId
    if (!instance || !this.runtime || typeof wcId !== 'number') {
      return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
    }
    if (instance.descriptor.kind !== kind) {
      return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
    }
    return { ok: true, instance, wcId }
  }

  /**
   * 未打开的 Word 的后台编辑会话（惰性创建）。运行时缺少就绪信号或没有
   * 主窗口/文件解析端口时返回 null，调用方保持原 not_open 路径。
   */
  private ensureAgentDocs(): AgentDocSessionManager | null {
    const resolver = this.agentFileResolver
    if (!resolver) return null
    if (this.agentDocs) return this.agentDocs
    const window = this.window && !this.window.isDestroyed()
      ? this.window
      : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null
    if (!window) return null
    this.bindWindow(window)
    const runtime = this.ensureRuntime(window)
    if (typeof runtime.docs.waitForAgentReady !== 'function') return null
    this.agentDocs = new AgentDocSessionManager({
      docs: runtime.docs,
      getWindow: () => (this.window && !this.window.isDestroyed() ? this.window : null),
      resolveFile: resolver,
      editSync: {
        register: (input) => this.registerAgentEditState({ ...input, kind: 'docx' }),
        drain: (fileId) => this.drainAgentEdits(fileId),
        flush: (fileId) => this.flushAgentEdit(fileId),
        release: (fileId) => this.releaseAgentEditState(fileId),
      },
    })
    return this.agentDocs
  }

  /**
   * 未打开的 Excel 的后台编辑会话（惰性创建）。运行时缺少 createSheetsView /
   * 就绪信号或没有主窗口/文件解析端口时返回 null，调用方保持原 not_open 路径
   * （office-bridge 只在此时才走旧版“请渲染端自动打开”兜底）。
   */
  private ensureAgentSheets(): AgentSheetSessionManager | null {
    const resolver = this.agentFileResolver
    if (!resolver) return null
    if (this.agentSheets) return this.agentSheets
    const window = this.window && !this.window.isDestroyed()
      ? this.window
      : BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null
    if (!window) return null
    this.bindWindow(window)
    const runtime = this.ensureRuntime(window)
    if (typeof runtime.sheets.createSheetsView !== 'function') return null
    if (typeof runtime.sheets.waitForAgentReady !== 'function') return null
    if (typeof runtime.sheets.teardownSheetsRenderer !== 'function') return null
    this.agentSheets = new AgentSheetSessionManager({
      sheets: runtime.sheets,
      getWindow: () => (this.window && !this.window.isDestroyed() ? this.window : null),
      resolveFile: resolver,
      editSync: {
        register: (input) => this.registerAgentEditState({ ...input, kind: 'spreadsheet' }),
        drain: (fileId) => this.drainAgentEdits(fileId),
        flush: (fileId) => this.flushAgentEdit(fileId),
        release: (fileId) => this.releaseAgentEditState(fileId),
      },
    })
    return this.agentSheets
  }

  /** 后台会话接入既有 editStates + fileSaved 回填链（与活实例编辑同一条导入路径）。 */
  private registerAgentEditState(input: {
    fileId: string
    webContentsId: number
    filePath: string
    originalName: string
    roomId: string | null
    workspaceId: string | null
    /** 回填导入与广播的形态：docx = Word，spreadsheet = Excel（xlsx）。 */
    kind: 'docx' | 'spreadsheet'
  }): () => void {
    this.editStates.set(input.fileId, {
      filePath: input.filePath,
      originalName: input.originalName,
      kind: input.kind,
      roomId: input.roomId,
      workspaceId: input.workspaceId,
      writeBackPath: null,
      pending: false,
      timer: null,
      runner: null,
      lastImport: null,
    })
    return onOfficeFileSaved(input.webContentsId, () => this.scheduleEditSync(input.fileId))
  }

  /** 立即排空去抖中的回填（保留 editStates：后台会话后续编辑继续走同一条链）。 */
  private async drainAgentEdits(
    fileId: string,
  ): Promise<{ contentHash?: string; fileVersionId?: string } | null> {
    const state = this.editStates.get(fileId)
    if (!state) return null
    // 只认本次 drain 期间发生的回填：上次编辑留下的 lastImport 不能拿来冒充
    // 本次保存成功（否则静默保存失败会被误报成成功）。
    state.lastImport = null
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.runner) await state.runner
    if (state.pending) await this.runEditSync(fileId)
    return state.lastImport ?? null
  }

  /** 按当前工作副本强制回填一次（同内容导入幂等）：去抖提前跑过/漏跑时兜底。 */
  private async flushAgentEdit(
    fileId: string,
  ): Promise<{ contentHash?: string; fileVersionId?: string } | null> {
    const state = this.editStates.get(fileId)
    if (!state) return null
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.runner) await state.runner
    state.pending = false
    state.lastImport = null
    await this.performEditImport(fileId, state)
    return state.lastImport ?? null
  }

  private async releaseAgentEditState(fileId: string): Promise<void> {
    await this.flushEditSync(fileId)
  }

  /** Agent 读 Word：已打开实例优先；未打开则拉起后台编辑器（不弹页签）。 */
  async describeDocArtifact(
    fileId: string,
    hints?: AgentDocFileHints,
  ): Promise<
    | { ok: true; describe: GenOfficeAgentDocDescription }
    | {
      ok: false
      reason: AgentArtifactFailureReason
      message?: string
      open?: OpenOfficeInstanceInfo[]
    }
  > {
    const resolved = await this.resolveAgentInstance(fileId, 'docx', { waitForOpen: false })
    if (resolved.ok) {
      const target = webContents.fromId(resolved.wcId)
      if (!target || target.isDestroyed()) {
        return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
      }
      const described = await this.runtime!.docs.describeAgentDoc(target)
      if ('error' in described) {
        return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
      }
      return { ok: true, describe: described }
    }
    if (resolved.reason === 'not_editable') return resolved
    const headless = fileId === 'active' ? null : this.ensureAgentDocs()
    if (!headless) return { ...resolved, open: this.listOpenOffice() }
    const outcome = await headless.describe(fileId, hints)
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.message ? { message: outcome.message } : {}),
        open: this.listOpenOffice(),
      }
    }
    return { ok: true, describe: outcome.describe }
  }

  /** Agent 编辑 Word：已打开可编辑实例优先；否则后台会话执行并回填版本链。 */
  async applyDocAgentTools(
    fileId: string,
    calls: GenOfficeAgentToolCall[],
    hints?: AgentDocFileHints,
  ): Promise<AgentArtifactToolsOutcome> {
    const resolved = await this.resolveAgentInstance(fileId, 'docx', { waitForOpen: false })
    if (resolved.ok) {
      if (!resolved.instance.editable) {
        return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
      }
      const target = webContents.fromId(resolved.wcId)
      if (!target || target.isDestroyed()) {
        return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
      }
      if (await this.runtime!.docs.docsQueryDirty(target)) {
        return { ok: false, reason: 'unsaved', open: this.listOpenOffice() }
      }
      const applied = await this.runtime!.docs.applyAgentDocTools(target, calls)
      if (!('results' in applied)) {
        return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
      }
      return 'error' in applied && typeof applied.error === 'string'
        ? { ok: true, results: applied.results, error: applied.error }
        : { ok: true, results: applied.results }
    }
    if (resolved.reason === 'not_editable') return resolved
    const headless = fileId === 'active' ? null : this.ensureAgentDocs()
    if (!headless) return { ...resolved, open: this.listOpenOffice() }
    const outcome = await headless.apply(fileId, calls, hints)
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.message ? { message: outcome.message } : {}),
        open: this.listOpenOffice(),
      }
    }
    return {
      ok: true,
      results: outcome.results,
      ...(outcome.version ? { version: outcome.version } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }
  }

  /**
   * Agent 读 Excel：已打开实例优先（读也走用户现场的会话，不拿隐藏工作簿顶替）；
   * 未打开（或 UI 没有页签）则拉起后台隐藏工作簿会话。可见但不是表格、或
   * fileId 'active' 解析不到可见实例时保持原 not_open/not_editable 语义。
   */
  async describeSpreadsheetArtifact(
    fileId: string,
    hints?: AgentSheetFileHints,
  ): Promise<
    | { ok: true; describe: GenOfficeAgentWorkbookDescription }
    | {
      ok: false
      reason: AgentArtifactFailureReason
      message?: string
      open?: OpenOfficeInstanceInfo[]
    }
  > {
    const resolved = await this.resolveAgentInstance(fileId, 'spreadsheet', { waitForOpen: false })
    if (resolved.ok) {
      const target = webContents.fromId(resolved.wcId)
      if (!target || target.isDestroyed()) {
        return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
      }
      const described = await this.runtime!.sheets.describeAgentWorkbook(target)
      if ('error' in described) {
        return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
      }
      return { ok: true, describe: described }
    }
    // 有可见实例但不是表格：不能拿隐藏工作簿顶替用户眼前的那份。
    if (resolved.reason === 'not_editable') return resolved
    const headless = fileId === 'active' ? null : this.ensureAgentSheets()
    if (!headless) return { ...resolved, open: this.listOpenOffice() }
    const outcome = await headless.describe(fileId, hints)
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.message ? { message: outcome.message } : {}),
        open: this.listOpenOffice(),
      }
    }
    return { ok: true, describe: outcome.describe }
  }

  /**
   * Agent 编辑 Excel：已打开可编辑实例优先（保留未保存修改闸门）；未打开则
   * 后台隐藏会话执行并回填版本链。已打开但只读的实例绝不绕过（not_editable）。
   */
  async applySpreadsheetAgentTools(
    fileId: string,
    calls: GenOfficeAgentToolCall[],
    hints?: AgentSheetFileHints,
  ): Promise<AgentArtifactToolsOutcome> {
    const resolved = await this.resolveAgentInstance(fileId, 'spreadsheet', { waitForOpen: false })
    if (resolved.ok) {
      if (!resolved.instance.editable) {
        return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
      }
      const target = webContents.fromId(resolved.wcId)
      if (!target || target.isDestroyed()) {
        return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
      }
      // 可编辑活实例仍是唯一写者：有未保存修改时一律拒绝覆盖用户输入。
      if (this.runtime!.sheets.sheetsPendingEditCount(resolved.wcId) > 0) {
        return { ok: false, reason: 'unsaved', open: this.listOpenOffice() }
      }
      const applied = await this.runtime!.sheets.applyAgentWorkbookTools(target, calls)
      if (!('results' in applied)) {
        return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
      }
      return 'error' in applied && typeof applied.error === 'string'
        ? { ok: true, results: applied.results, error: applied.error }
        : { ok: true, results: applied.results }
    }
    if (resolved.reason === 'not_editable') return resolved
    const headless = fileId === 'active' ? null : this.ensureAgentSheets()
    if (!headless) return { ...resolved, open: this.listOpenOffice() }
    const outcome = await headless.apply(fileId, calls, hints)
    if (!outcome.ok) {
      return {
        ok: false,
        reason: outcome.reason,
        ...(outcome.message ? { message: outcome.message } : {}),
        open: this.listOpenOffice(),
      }
    }
    return {
      ok: true,
      results: outcome.results,
      ...(outcome.version ? { version: outcome.version } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    }
  }

  private async waitForInstance(
    fileId: string,
    timeoutMs = this.autoOpenWaitMs,
    pollMs = 400,
  ): Promise<OfficePreviewInstance | undefined> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      const hit = this.instances.get(fileId)
      if (hit) return hit
    }
    return undefined
  }

  /** 当前打开的 Office 实例清单（焦点在前），供 Agent 引导用户。 */
  listOpenOffice(): OpenOfficeInstanceInfo[] {
    return [...this.instances.entries()]
      .map(([fileId, instance]) => ({
        fileId,
        title: instance.descriptor.title,
        kind: instance.descriptor.kind,
        editable: instance.editable,
        active: fileId === this.activeId,
      }))
      .sort((a, b) => Number(b.active) - Number(a.active))
  }

  /**
   * Agent 写回「用户正开着的那份」Word/Excel：覆盖工作副本 → 版本链回填
   * （复用保存链路，含访达原文件写回）→ 用新内容重开视图。
   *
   * 事先要求：实例存在且可编辑、没有未保存修改、工作副本仍是生成字节时的基线
   * （expectedContentHash）——任何一条不满足都拒绝，绝不拿旧基线覆盖新保存。
   */
  async applyAgentFileBytes(
    fileId: string,
    bytes: Buffer,
    expectedContentHash: string,
  ): Promise<
    | { ok: true; contentHash: string }
    | {
      ok: false
      reason: 'not_open' | 'not_editable' | 'unsaved' | 'conflict' | 'error'
      message?: string
      open?: OpenOfficeInstanceInfo[]
    }
  > {
    const instance = this.instances.get(fileId)
    if (!instance) {
      return { ok: false, reason: 'not_open', open: this.listOpenOffice() }
    }
    if (!instance.editable || !instance.documentPath) {
      return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
    }
    if (instance.descriptor.kind !== 'docx' && instance.descriptor.kind !== 'spreadsheet') {
      return { ok: false, reason: 'not_editable', open: this.listOpenOffice() }
    }
    if (instance.view.isDirty && await instance.view.isDirty()) {
      return { ok: false, reason: 'unsaved', message: '文档有未保存的修改' }
    }
    const window = this.window
    if (!window || window.isDestroyed()) return { ok: false, reason: 'error', message: '主窗口不可用' }
    const target = instance.documentPath
    if (bytes.length === 0) return { ok: false, reason: 'error', message: '写回内容为空' }
    let current: Buffer
    try {
      current = await readFile(target)
    } catch {
      return { ok: false, reason: 'error', message: '无法读取文档工作副本' }
    }
    const currentHash = createHash('sha256').update(current).digest('hex')
    if (expectedContentHash && currentHash !== expectedContentHash.toLowerCase()) {
      return { ok: false, reason: 'conflict', message: '文档在生成修改期间又被保存过' }
    }
    const editState = this.editStates.get(fileId)
    const writeBackPath = editState?.writeBackPath ?? null
    const wasActive = this.activeId === fileId
    const originalName = instance.descriptor.title
    const roomId = instance.roomId

    // 原子覆盖：同目录临时文件 + rename，避免编辑视图/外部程序读到半个文件。
    const tempPath = join(dirname(target), `.everroom-agent-${fileId}-${Date.now()}.tmp`)
    try {
      await writeFile(tempPath, bytes)
      await rename(tempPath, target)
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined)
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) }
    }

    // 走与人工保存同一条回填链路：库内版本 +1（含访达原文件写回）。
    if (editState) {
      if (editState.runner) await editState.runner
      editState.pending = true
      await this.runEditSync(fileId)
    }

    const nextHash = createHash('sha256').update(bytes).digest('hex')
    logOfficeDiag('office.diag.agent-apply', {
      fileId,
      kind: instance.descriptor.kind,
      bytes: bytes.byteLength,
      versioned: Boolean(editState),
    })
    await this.open(window, {
      id: fileId,
      contentHash: nextHash,
      originalName,
      storagePath: target,
      editable: true,
      ...(roomId ? { roomId } : {}),
      ...(writeBackPath ? { writeBackPath } : {}),
    })
    if (wasActive) this.setActive(fileId)
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('office:instance-reloaded', { id: fileId, kind: instance.descriptor.kind })
    }
    return { ok: true, contentHash: nextHash }
  }

  /**
   * 用户当前正在浏览的 Office 文件（页签）：Agent 运行上下文的 activeFile。
   * activeId 只在渲染端切到 office-document 且该实例可见时被设置，其它页面为 null。
   */
  activeOfficeFile(): {
    fileId: string
    title: string
    kind: OpenOfficeInstanceInfo['kind']
    editable: boolean
  } | null {
    if (!this.activeId) return null
    const instance = this.instances.get(this.activeId)
    if (!instance) return null
    return {
      fileId: this.activeId,
      // 与网关 route schema 的 title maxLength=300 对齐，超长文件名不至于让整轮 run 400。
      title: instance.descriptor.title.slice(0, 300),
      kind: instance.descriptor.kind,
      editable: instance.editable,
    }
  }

  /**
   * 工作区当前打开的全部 Office 页签（焦点在前，active = 当前可见项）：
   * Agent 运行上下文的 openFiles。只认识“当前这份”时，用户问“另一个文件”
   * 模型会失明，所以每次 run 都带上整份清单。
   */
  openOfficeFiles(): OpenOfficeInstanceInfo[] {
    return this.listOpenOffice().map((instance) => ({
      ...instance,
      title: instance.title.slice(0, 300),
    }))
  }

  /** 「AI 修改」转发用的 wcId 反查：定位视图所属文件与 Room（编辑回填态里的 roomId 兜底）。 */
  findByWebContentsId(wcId: number): {
    fileId: string
    title: string
    kind: string
    roomId: string | null
    workspaceId: string
  } | null {
    for (const [fileId, instance] of this.instances.entries()) {
      if (instance.view.webContentsId !== wcId) continue
      return {
        fileId,
        title: instance.descriptor.title,
        kind: instance.descriptor.kind,
        roomId: instance.roomId ?? this.editStates.get(fileId)?.roomId ?? null,
        workspaceId: instance.workspaceId,
      }
    }
    return null
  }

  /** 'active' 的解析：焦点 slides 实例优先；无焦点时唯一打开的 slides 实例兜底。 */
  private resolveActiveSlides(): string | null {
    if (this.activeId) {
      const instance = this.instances.get(this.activeId)
      if (instance?.descriptor.kind === 'slides') return this.activeId
    }
    const slidesIds = [...this.instances.entries()]
      .filter(([, instance]) => instance.descriptor.kind === 'slides')
      .map(([id]) => id)
    return slidesIds.length === 1 ? slidesIds[0]! : null
  }

  /** 激活一个实例并隐藏其余；未知 id 返回 false。 */
  setActive(id: string | null): boolean {
    if (id === null) {
      for (const instance of this.instances.values()) instance.view.setActive(false)
      this.activeId = null
      logOfficeDiag('office.diag.registry.set-active', { id: null, found: true, openCount: this.instances.size })
      return true
    }
    const instance = this.instances.get(id)
    if (!instance) {
      logOfficeDiag('office.diag.registry.set-active', {
        id,
        found: false,
        previousActiveId: this.activeId,
        openIds: [...this.instances.keys()],
      })
      return false
    }
    for (const other of this.instances.values()) {
      if (other !== instance) other.view.setActive(false)
    }
    instance.view.setActive(true)
    this.activeId = id
    logOfficeDiag('office.diag.registry.set-active', { id, found: true, openCount: this.instances.size })
    return true
  }

  /** 关闭实例；false = 用户在脏关闭守卫里取消（实例保留）。 */
  async close(id: string): Promise<boolean> {
    const instance = this.instances.get(id)
    if (!instance) return true
    const closed = await instance.view.dispose()
    if (!closed) return false
    this.instances.delete(id)
    instance.unsubscribeSaved?.()
    if (this.activeId === id) this.activeId = null
    await this.flushEditSync(id)
    this.teardownIfIdle()
    return true
  }

  async disposeAll(): Promise<void> {
    // 先同步清空再逐个异步关闭：后续 open() 不会与在途 dispose 抢实例表。
    const entries = [...this.instances]
    this.instances.clear()
    this.activeId = null
    // 后台 Agent 会话硬清理（不弹脏关闭框）：放在同步清表之后，避免
    // bindWindow 的 `void disposeAll()` 在 await 期间把新开的实例清掉。
    if (this.agentDocs) {
      await this.agentDocs.disposeAll().catch(() => undefined)
    }
    if (this.agentSheets) {
      await this.agentSheets.disposeAll().catch(() => undefined)
    }
    const closedIds: string[] = []
    for (const [id, instance] of entries) {
      const closed = await instance.view.dispose().catch(() => false)
      instance.unsubscribeSaved?.()
      if (closed) closedIds.push(id)
      else this.instances.set(id, instance)
    }
    for (const id of closedIds) await this.flushEditSync(id)
    this.teardownIfIdle()
  }

  private scheduleEditSync(fileId: string): void {
    const state = this.editStates.get(fileId)
    if (!state) return
    state.pending = true
    if (state.runner || state.timer) return
    state.timer = setTimeout(() => {
      state.timer = null
      void this.runEditSync(fileId)
    }, EDIT_SYNC_DEBOUNCE_MS)
  }

  private async runEditSync(fileId: string): Promise<void> {
    const state = this.editStates.get(fileId)
    if (!state) return
    if (state.runner) return state.runner
    state.runner = this.drainEditSync(fileId, state)
    try {
      await state.runner
    } finally {
      state.runner = null
    }
  }

  /** 排空 pending：导入期间的后续保存会重新置位 pending 并继续循环。 */
  private async drainEditSync(fileId: string, state: EditSyncState): Promise<void> {
    while (this.editStates.get(fileId) === state && state.pending) {
      state.pending = false
      await this.performEditImport(fileId, state)
    }
  }

  private async performEditImport(fileId: string, state: EditSyncState): Promise<void> {
    const bindings = this.editSyncBindings
    if (!bindings) return
    const kindPrefix = state.kind === 'docx' ? 'word' : state.kind === 'slides' ? 'slides' : 'sheets'
    const format = state.kind === 'docx' ? 'docx' : state.kind === 'slides' ? 'pptx' : 'xlsx'
    const input = {
      filePath: state.filePath,
      originalName: state.originalName,
      sourceKey: `agent:${kindPrefix}:edit:${fileId}`,
      fileEntryId: fileId,
      ...(state.roomId ? { roomId: state.roomId } : {}),
      ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
    }
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[office] edit sync failed', fileId, message)
      bindings.broadcast({
        type: 'error',
        format,
        title: state.originalName,
        fileId,
        roomId: state.roomId,
        message: `文档保存已落盘，但版本回填失败：${message}。再次保存会自动重试。`,
      })
    }
    let imported: unknown = null
    try {
      imported = await bindings.importAgentFile(input)
    } catch (error) {
      // 连发保存会在导入读盘时再写工作副本：稍候重试一次。
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        imported = await bindings.importAgentFile(input)
      } catch (finalError) {
        fail(finalError)
        return
      }
    }
    state.lastImport = normalizeImportResult(imported)
    // 访达直接打开的文件：库内版本已回填，再把工作副本写回磁盘原文件，
    // 否则外部程序（Word/WPS/Keynote）看到的还是编辑前的内容。
    if (state.writeBackPath) {
      try {
        await writeBackEditedDocument(state.filePath, state.writeBackPath)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[office] write-back failed', fileId, state.writeBackPath, message)
        bindings.broadcast({
          type: 'write-back-failed',
          format,
          title: state.originalName,
          fileId,
          roomId: state.roomId,
          message,
        })
      }
    }
    bindings.broadcast({
      type: 'edited',
      format,
      title: state.originalName,
      fileId,
      roomId: state.roomId,
    })
  }

  /** 关闭时立即落掉在途/去抖中的回填，然后丢弃状态。 */
  private async flushEditSync(fileId: string): Promise<void> {
    const state = this.editStates.get(fileId)
    if (!state) return
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    if (state.runner) await state.runner
    if (this.editStates.get(fileId) !== state) return
    if (state.pending) await this.runEditSync(fileId)
    this.editStates.delete(fileId)
  }

  private async createView(
    window: BrowserWindow,
    runtime: PreparedGenOfficeRuntime,
    kind: OfficePreviewKind,
    file: OfficePreviewFile,
    editable: boolean,
  ): Promise<{ view: OfficePreviewView; documentPath: string | null }> {
    // 停靠栏（Agent / 材料 / 历史记录）只由主窗口渲染层挂 SideDock；GenOffice
    // 自带的对话区/侧栏已从 vendor 源码删除，视图创建不再有 dock 选项。
    if (kind === 'docx') {
      const documentPath = await prepareOfficeDocument(file.id, file.contentHash, file.originalName, file.storagePath)
      const view = OfficeViewManager.createWithRuntime(window, runtime.docs, documentPath, { editable })
      return { view, documentPath }
    }
    if (kind === 'slides') {
      const view = await SlidesViewManager.create(window, runtime.slides, file, { editable })
      return { view, documentPath: view.documentPath }
    }
    if (kind === 'pdf') {
      return { view: await PdfViewManager.create(window, runtime.pdf, file), documentPath: null }
    }
    const view = await SpreadsheetViewManager.create(window, runtime.sheets, file, { editable })
    return { view, documentPath: view.documentPath }
  }

  private bindWindow(window: BrowserWindow): void {
    if (this.window === window) return
    // 旧窗口的视图已随窗口销毁；换绑前先清空注册表再做全局 runtime 清理。
    void this.disposeAll()
    this.window = window
    window.once('closed', () => {
      if (this.window === window) void this.disposeAll()
    })
  }

  private ensureRuntime(window: BrowserWindow): PreparedGenOfficeRuntime {
    if (!this.runtime) {
      this.runtime = loadPreparedGenOfficeRuntime()
    }
    // Office 保存 hook（生成 + 编辑回填共享扇出，docs/slides/sheets）在首个使用者装一次。
    wireOfficeSavedHooks(this.runtime)
    // 「AI 修改」弹层转发：slides 视图提交 → wcId 反查 Room → 广播渲染层注入（幂等）。
    if (this.agentAskForward) {
      wireSlidesAgentAsk(this.runtime, {
        resolveInstance: (wcId) => this.findByWebContentsId(wcId),
        forward: this.agentAskForward,
      })
    }
    // AI 页签论文排版桥（注入晚于首开也在此补挂，幂等）。
    this.wireDocsThesisHook(this.runtime)
    // shell window 是三个运行时共享的对话框父窗口，换绑后需要重新指向。
    this.runtime.docs.setDocsShellWindow(window)
    this.runtime.sheets.setSheetsShellWindow(window)
    this.runtime.slides.setSlidesShellWindow(window)
    // 后台保存会 pushRecent → buildDocsMenu；只有可见 docs 页签活跃时才允许
    // docs 接管应用菜单，否则关掉页签后的后台编辑会改掉整个应用的菜单。
    if (typeof this.runtime.docs.setDocsMenuGate === 'function') {
      this.runtime.docs.setDocsMenuGate(() => this.hasActiveDocInstance())
    }
    return this.runtime
  }

  /** 共享 runtime 的全局指针与 sidecar 只在最后一个相关实例关闭后清理。 */
  private teardownIfIdle(): void {
    const runtime = this.runtime
    if (!runtime) return
    // 隐藏工作簿会话持有自己的 sidecar 会话与渲染器（它不在 instances 里）：
    // 它活着时停 sidecar，下一次后台 apply 就会静默保存失败。
    const hiddenSheetsAlive = this.agentSheets?.hasAny() === true
    if (this.instances.size > 0) {
      if (!hiddenSheetsAlive
        && ![...this.instances.values()].some((instance) => instance.descriptor.kind === 'spreadsheet')) {
        runtime.sheets.setActiveSheetsWebContents(null)
        runtime.sheets.stopSheetsSidecar()
      }
      return
    }
    runtime.docs.setActiveDocsResolver(null)
    runtime.docs.setDocsShellWindow(null)
    if (!hiddenSheetsAlive) {
      runtime.sheets.setActiveSheetsWebContents(null)
      runtime.sheets.setSheetsShellWindow(null)
      runtime.sheets.stopSheetsSidecar()
    }
    runtime.slides.setActiveSlidesWebContents(null)
    runtime.slides.setSlidesShellWindow(null)
  }
}

/** importAgentGeneratedFile 的返回值 → 后台会话可回传的版本信息。 */
function normalizeImportResult(value: unknown): { contentHash?: string; fileVersionId?: string } | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { contentHash?: unknown; fileVersionId?: unknown }
  return {
    ...(typeof record.contentHash === 'string' ? { contentHash: record.contentHash } : {}),
    ...(typeof record.fileVersionId === 'string' ? { fileVersionId: record.fileVersionId } : {}),
  }
}
