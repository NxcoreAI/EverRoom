import type { BrowserWindow } from 'electron'

import type { OfficeAgentFileEvent } from '../../shared/office'
import {
  OFFICE_TEST_INSTANCE_ID,
  officePreviewKindForFileName,
  type OfficePreviewKind,
} from '../../shared/sources'
import { onDocsSaved, wireDocsSavedHook } from './office-generation'
import {
  loadPreparedGenOfficeRuntime,
  preparedGenOfficeFixture,
  type PreparedGenOfficeRuntime,
} from './office-runtime'
import { OfficeViewManager, prepareOfficeDocument } from './office-view-manager'
import { PdfViewManager } from './pdf-view-manager'
import { SlidesViewManager } from './slides-view-manager'
import { SpreadsheetViewManager } from './spreadsheet-view-manager'

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
  /** docx 产物：true → 可编辑视图，保存后回填版本链（其余格式忽略）。 */
  editable?: boolean
  /** 版本链回填的 Room 投影归属（不传则按导入落点默认决策）。 */
  roomId?: string | null
}

/** The lifecycle surface the three view managers expose to the registry. */
interface OfficePreviewView {
  setActive(active: boolean): void
  /** false = 用户在脏关闭守卫里取消：实例原样保留。 */
  dispose(): Promise<boolean>
  /** docs 视图的 webContents id（保存事件订阅用）；其余形态缺省。 */
  readonly webContentsId?: number
}

interface OfficePreviewInstance {
  descriptor: OfficePreviewDescriptor
  view: OfficePreviewView
  editable: boolean
  documentPath: string | null
  unsubscribeSaved: (() => void) | null
}

/** 产物编辑回填的去抖合并窗口：连发保存（含关窗时的 Save）只落一次导入。 */
const EDIT_SYNC_DEBOUNCE_MS = 2_000

/** 保存回填的 per-file 状态：独立于视图存活（导入只需要磁盘工作副本）。 */
interface EditSyncState {
  filePath: string
  originalName: string
  roomId: string | null
  pending: boolean
  timer: NodeJS.Timeout | null
  runner: Promise<void> | null
}

/** 内嵌 Office 文件扩展名 → 预览运行时分流（shared 实现，渲染端入口与 files:open-original 共用同一白名单）。 */
export const officePreviewKindFor = officePreviewKindForFileName

/**
 * 顶栏 Office 预览标签的主进程侧：按 fileId 多开/复用 genoffice 视图实例，
 * 同一时刻只显示渲染端激活的那个（渲染端是焦点唯一事实源，open 不自动激活）。
 * docx 产物可编辑：保存事件去抖后按 fileEntryId 钉住条目重导入（版本链 +1）。
 */
export class OfficePreviewRegistry {
  private runtime: PreparedGenOfficeRuntime | null = null
  private window: BrowserWindow | null = null
  private readonly instances = new Map<string, OfficePreviewInstance>()
  private activeId: string | null = null
  private readonly editStates = new Map<string, EditSyncState>()
  private editSyncBindings: {
    importAgentFile: (input: {
      filePath: string
      originalName: string
      sourceKey: string
      fileEntryId?: string
      roomId?: string
    }) => Promise<unknown>
    broadcast: (event: OfficeAgentFileEvent) => void
  } | null = null

  /** 编辑回填依赖注入（index.ts 启动时接线；缺省则编辑视图保存不回填）。 */
  setEditSync(bindings: OfficePreviewRegistry['editSyncBindings']): void {
    this.editSyncBindings = bindings
  }

  /** 打开（或复用）一个预览实例；instanceId = fileId，contentHash 或 editable 变化时原地重建。 */
  async open(window: BrowserWindow, file: OfficePreviewFile): Promise<OfficePreviewDescriptor> {
    const kind = officePreviewKindFor(file.originalName)
    if (!kind) throw new Error(`Unsupported internal Office preview: ${file.originalName}`)
    this.bindWindow(window)
    const runtime = this.ensureRuntime(window)
    const editable = file.editable === true && kind === 'docx'
    const roomId = typeof file.roomId === 'string' && file.roomId ? file.roomId : null

    const existing = this.instances.get(file.id)
    if (existing && existing.descriptor.contentHash === file.contentHash && existing.editable === editable) {
      return existing.descriptor
    }
    if (existing) {
      // 旧实例可能带未保存编辑：脏关闭守卫里取消则保留旧实例不动。
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
      unsubscribeSaved: null,
    }
    if (editable && typeof view.webContentsId === 'number') {
      const fileId = file.id
      this.editStates.set(fileId, {
        filePath: documentPath!,
        originalName: file.originalName,
        roomId,
        pending: false,
        timer: null,
        runner: null,
      })
      instance.unsubscribeSaved = onDocsSaved(view.webContentsId, () => this.scheduleEditSync(fileId))
    }
    this.instances.set(file.id, instance)
    return descriptor
  }

  /** dev 测试页的 fixture 实例（固定 id，懒创建）。 */
  openTest(window: BrowserWindow): OfficePreviewDescriptor {
    if (this.instances.has(OFFICE_TEST_INSTANCE_ID)) {
      return this.instances.get(OFFICE_TEST_INSTANCE_ID)!.descriptor
    }
    this.bindWindow(window)
    const runtime = this.ensureRuntime(window)
    const view = OfficeViewManager.createWithRuntime(
      window,
      runtime.docs,
      preparedGenOfficeFixture(runtime.root),
    )
    const descriptor: OfficePreviewDescriptor = {
      id: OFFICE_TEST_INSTANCE_ID,
      kind: 'docx',
      title: 'DOCX test document',
      contentHash: 'test',
    }
    this.instances.set(OFFICE_TEST_INSTANCE_ID, {
      descriptor,
      view,
      editable: false,
      documentPath: null,
      unsubscribeSaved: null,
    })
    return descriptor
  }

  has(id: string): boolean {
    return this.instances.has(id)
  }

  /** 激活一个实例并隐藏其余；未知 id 返回 false。 */
  setActive(id: string | null): boolean {
    if (id === null) {
      for (const instance of this.instances.values()) instance.view.setActive(false)
      this.activeId = null
      return true
    }
    const instance = this.instances.get(id)
    if (!instance) return false
    for (const other of this.instances.values()) {
      if (other !== instance) other.view.setActive(false)
    }
    instance.view.setActive(true)
    this.activeId = id
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
    const input = {
      filePath: state.filePath,
      originalName: state.originalName,
      sourceKey: `agent:word:edit:${fileId}`,
      fileEntryId: fileId,
      ...(state.roomId ? { roomId: state.roomId } : {}),
    }
    const fail = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[office] edit sync failed', fileId, message)
      bindings.broadcast({
        type: 'error',
        format: 'docx',
        title: state.originalName,
        fileId,
        roomId: state.roomId,
        message: `文档保存已落盘，但版本回填失败：${message}。再次保存会自动重试。`,
      })
    }
    try {
      await bindings.importAgentFile(input)
    } catch (error) {
      // 连发保存会在导入读盘时再写工作副本：稍候重试一次。
      await new Promise((resolve) => setTimeout(resolve, 300))
      try {
        await bindings.importAgentFile(input)
      } catch (finalError) {
        fail(finalError)
        return
      }
    }
    bindings.broadcast({
      type: 'edited',
      format: 'docx',
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
    if (kind === 'docx') {
      const documentPath = await prepareOfficeDocument(file.id, file.contentHash, file.originalName, file.storagePath)
      const view = OfficeViewManager.createWithRuntime(window, runtime.docs, documentPath, { editable })
      return { view, documentPath }
    }
    if (kind === 'slides') {
      return { view: await SlidesViewManager.create(window, runtime.slides, file), documentPath: null }
    }
    if (kind === 'pdf') {
      return { view: await PdfViewManager.create(window, runtime.pdf, file), documentPath: null }
    }
    return { view: await SpreadsheetViewManager.create(window, runtime.sheets, file), documentPath: null }
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
    // docs 保存 hook（生成 + 编辑回填共享扇出）在首个使用者装一次。
    wireDocsSavedHook(this.runtime)
    // shell window 是三个运行时共享的对话框父窗口，换绑后需要重新指向。
    this.runtime.docs.setDocsShellWindow(window)
    this.runtime.sheets.setSheetsShellWindow(window)
    this.runtime.slides.setSlidesShellWindow(window)
    return this.runtime
  }

  /** 共享 runtime 的全局指针与 sidecar 只在最后一个相关实例关闭后清理。 */
  private teardownIfIdle(): void {
    const runtime = this.runtime
    if (!runtime) return
    if (this.instances.size > 0) {
      if (![...this.instances.values()].some((instance) => instance.descriptor.kind === 'spreadsheet')) {
        runtime.sheets.setActiveSheetsWebContents(null)
        runtime.sheets.stopSheetsSidecar()
      }
      return
    }
    runtime.docs.setActiveDocsResolver(null)
    runtime.docs.setDocsShellWindow(null)
    runtime.sheets.setActiveSheetsWebContents(null)
    runtime.sheets.setSheetsShellWindow(null)
    runtime.sheets.stopSheetsSidecar()
    runtime.slides.setActiveSlidesWebContents(null)
    runtime.slides.setSlidesShellWindow(null)
  }
}
