import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { Rectangle, WebContentsView } from 'electron'

import { OfficeFixtureStore, type NativeFileSpec } from './office-files'
import { loadGenOfficeRuntime, type PreparedGenOfficeRuntime } from './runtime'

/**
 * 原型版 Office 视图桥：把 GenOffice 四个原生编辑器以 WebContentsView 形式
 * 叠在主窗口上（结构参照 EverRoom apps/desktop 的 OfficePreviewRegistry，去掉
 * 版本链/回填/Agent 桥，只保留 open/activate/close/bounds 四个动作）。
 * 渲染层是焦点唯一事实源：谁可见谁上报矩形，主进程把矩形应用到激活实例。
 */

const BOUNDS_CHANNEL = 'office:bounds'

type NativeKind = NativeFileSpec['kind']

interface NativeOpenRequest {
  fileId: string
  title: string
  spec: NativeFileSpec
}

interface OfficeInstance {
  fileId: string
  kind: NativeKind
  view: WebContentsView
  editable: boolean
  wcId: number
  active: boolean
  bounds: Rectangle | null
  /** false = 用户在脏关闭守卫里点了取消，实例保留。 */
  dispose: () => Promise<boolean>
}

function normalizeBounds(input: unknown, window: BrowserWindow): Rectangle | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<Rectangle>
  const nums = [value.x, value.y, value.width, value.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const content = window.getContentBounds()
  const x = Math.max(0, Math.round(value.x!))
  const y = Math.max(0, Math.round(value.y!))
  return {
    x,
    y,
    width: Math.max(0, Math.min(Math.round(value.width!), content.width - x)),
    height: Math.max(0, Math.min(Math.round(value.height!), content.height - y)),
  }
}

export class OfficeBridge {
  private runtime: PreparedGenOfficeRuntime | null = null
  private window: BrowserWindow | null = null
  private readonly instances = new Map<string, OfficeInstance>()
  private activeId: string | null = null
  private fixtures: OfficeFixtureStore

  constructor() {
    const sandbox = join(app.getPath('userData'), 'office-sandbox')
    mkdirSync(sandbox, { recursive: true })
    this.fixtures = new OfficeFixtureStore(sandbox)
    // GenOffice 的「新文件首次保存」默认落 ~/Documents/GenOffice；原型把它
    // 收进自己的 userData 沙箱，避免演示时污染用户文稿目录。
    const settingsPath = join(app.getPath('userData'), 'app-settings.json')
    let settings: Record<string, unknown> = {}
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      // 首次启动没有配置文件
    }
    settings.defaultSaveDir = sandbox
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    this.registerHostCompatIpc()
    this.registerIpc()
  }

  /**
   * GenOffice 编辑器期待 standalone shell 提供的杂项 IPC。embed 宿主给最小
   * 实现（固定亮色主题），避免渲染端 getTheme() 每次启动都报 No handler。
   */
  private registerHostCompatIpc(): void {
    ipcMain.removeHandler('app:get-theme')
    ipcMain.handle('app:get-theme', () => 'light')
  }

  /** 窗口关闭前的脏守卫：true = 可以关（Save 已执行或无改动）。 */
  async confirmCloseAll(): Promise<boolean> {
    for (const instance of [...this.instances.values()]) {
      const closed = await instance.dispose().catch(() => false)
      if (!closed) return false
      this.instances.delete(instance.fileId)
    }
    this.activeId = null
    this.teardownIfIdle()
    this.fixtures.cleanup()
    return true
  }

  /** IPC 的窗口从事件 sender 反查——bridge 构造时窗口可能还没建好。 */
  private windowFor(sender: Electron.WebContents): BrowserWindow | null {
    const win = BrowserWindow.fromWebContents(sender)
    return win && !win.isDestroyed() ? win : null
  }

  private registerIpc(): void {
    ipcMain.handle('office:open', async (event, request: NativeOpenRequest) => {
      const window = this.windowFor(event.sender)
      if (!window) return { ok: false, error: 'no window' }
      try {
        await this.open(window, request)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('office:activate', (event, fileId: string | null) => {
      const window = this.windowFor(event.sender)
      if (!window) return false
      return this.setActive(fileId)
    })

    ipcMain.handle('office:close', async (event, fileId: string) => {
      const window = this.windowFor(event.sender)
      if (!window) return false
      const closed = await this.close(fileId)
      if (closed) this.fixtures.cleanup()
      return closed
    })

    ipcMain.handle('office:dirty', (event, fileId: string) => {
      const window = this.windowFor(event.sender)
      if (!window || !this.runtime) return false
      const instance = this.instances.get(fileId)
      if (!instance) return false
      if (instance.kind === 'docx') {
        const wc = this.wcOf(instance)
        return wc ? this.runtime.docs.docsQueryDirty(wc) : false
      }
      if (instance.kind === 'pptx') return this.runtime.slides.slidesIsDirty(instance.wcId)
      return false
    })

    ipcMain.handle('office:pick-materials', async (event) => {
      const window = this.windowFor(event.sender)
      if (!window) return []
      const result = await dialog.showOpenDialog(window, {
        title: '添加材料',
        properties: ['openFile', 'multiSelections'],
      })
      if (result.canceled) return []
      const picked: Array<{ name: string; size: number }> = []
      for (const path of result.filePaths) {
        try {
          picked.push({ name: basename(path), size: statSync(path).size })
        } catch {
          // 不可读的文件跳过
        }
      }
      return picked
    })

    ipcMain.on(BOUNDS_CHANNEL, (event, input: unknown) => {
      const window = this.windowFor(event.sender)
      const active = this.activeId ? this.instances.get(this.activeId) : null
      if (!window || !active) return
      const bounds = normalizeBounds(input, window)
      if (!bounds) return
      active.bounds = bounds
      active.view.setBounds(bounds)
      active.view.setVisible(active.active && bounds.width > 0 && bounds.height > 0)
    })
  }

  private async open(window: BrowserWindow, request: NativeOpenRequest): Promise<void> {
    this.bindWindow(window)
    if (this.instances.has(request.fileId)) return
    const runtime = (this.runtime ??= loadGenOfficeRuntime())
    runtime.docs.registerDocsIpc()
    const path = await this.fixtures.materialize(request.fileId, request.title, request.spec)
    const instance = this.createInstance(window, runtime, request, path)
    this.instances.set(request.fileId, instance)
  }

  private createInstance(
    window: BrowserWindow,
    runtime: PreparedGenOfficeRuntime,
    request: NativeOpenRequest,
    path: string,
  ): OfficeInstance {
    const { spec } = request
    const editable = spec.kind !== 'pdf'
    // GenOffice 自带的对话区/侧栏已从 vendor 源码删除，停靠栏只由主窗口渲染层提供
    // （SideDock → AgentChatDock → 真实 window.nxcore 网关桥）。
    let view: WebContentsView
    if (spec.kind === 'docx') {
      view = runtime.docs.createDocsView(path, { hostMode: 'everroom', readonly: false })
    } else if (spec.kind === 'xlsx') {
      runtime.sheets.setSheetsShellWindow(window)
      view = runtime.sheets.createSheetsView({ includeAiHandlers: false, readonly: false })
      runtime.sheets.queueWorkbookForView(view.webContents, path)
    } else if (spec.kind === 'pptx') {
      runtime.slides.setSlidesShellWindow(window)
      view = runtime.slides.createSlidesView(path, { readonly: false })
    } else {
      view = runtime.pdf.createPdfView(path, { readonly: true })
    }
    view.setVisible(false)
    window.contentView.addChildView(view)
    const wcId = view.webContents.id
    const self = this

    const instance: OfficeInstance = {
      fileId: request.fileId,
      kind: spec.kind,
      view,
      editable,
      wcId,
      active: false,
      bounds: null,
      async dispose(): Promise<boolean> {
        const wc = self.wcOf(this)
        if (wc && editable && !window.isDestroyed()) {
          const proceed =
            this.kind === 'docx'
              ? await runtime.docs.requestDocsClose(wc, window)
              : this.kind === 'xlsx'
                ? await runtime.sheets.requestSheetsClose(wc, window)
                : this.kind === 'pptx'
                  ? await runtime.slides.requestSlidesClose(wc, window)
                  : true
          if (!proceed) return false
        }
        if (wc && this.kind === 'docx') runtime.docs.teardownDocsRenderer(wc)
        if (wc) wc.close({ waitForBeforeUnload: false })
        return true
      },
    }
    return instance
  }

  /** 激活一个实例并隐藏其余；null = 全部隐藏（主页）。 */
  private setActive(fileId: string | null): boolean {
    if (fileId === null) {
      for (const instance of this.instances.values()) {
        instance.active = false
        instance.view.setVisible(false)
      }
      this.activeId = null
      this.refreshRuntimePointers()
      return true
    }
    const target = this.instances.get(fileId)
    if (!target) return false
    for (const other of this.instances.values()) {
      if (other !== target) {
        other.active = false
        other.view.setVisible(false)
      }
    }
    target.active = true
    this.activeId = fileId
    if (target.bounds) target.view.setBounds(target.bounds)
    this.refreshRuntimePointers()
    return true
  }

  /** runtime 的全局激活指针一次只指向一个视图：每次激活都重新对准。 */
  private refreshRuntimePointers(): void {
    const runtime = this.runtime
    if (!runtime) return
    runtime.docs.setActiveDocsResolver(() => this.wcOfActive('docx'))
    runtime.sheets.setActiveSheetsWebContents(this.wcOfActive('xlsx') ?? this.firstWcOf('xlsx'))
    runtime.slides.setActiveSlidesWebContents(this.wcOfActive('pptx') ?? this.firstWcOf('pptx'))
  }

  private wcOfActive(kind: NativeKind): Electron.WebContents | null {
    const active = this.activeId ? this.instances.get(this.activeId) : null
    if (!active || active.kind !== kind) return null
    return this.wcOf(active)
  }

  private firstWcOf(kind: NativeKind): Electron.WebContents | null {
    for (const instance of this.instances.values()) {
      if (instance.kind !== kind) continue
      const wc = this.wcOf(instance)
      if (wc) return wc
    }
    return null
  }

  private wcOf(instance: OfficeInstance): Electron.WebContents | null {
    return instance.view.webContents.isDestroyed() ? null : instance.view.webContents
  }

  private async close(fileId: string): Promise<boolean> {
    const instance = this.instances.get(fileId)
    if (!instance) return true
    const closed = await instance.dispose()
    if (!closed) return false
    this.instances.delete(fileId)
    if (this.activeId === fileId) this.activeId = null
    this.teardownIfIdle()
    return true
  }

  private bindWindow(window: BrowserWindow): void {
    if (this.window === window) return
    void this.confirmCloseAll()
    this.window = window
    window.once('closed', () => {
      if (this.window === window) this.window = null
    })
  }

  /** 共享 runtime 的全局指针与 sidecar 只在最后一个实例关闭后清理。 */
  private teardownIfIdle(): void {
    const runtime = this.runtime
    if (!runtime) return
    if (this.instances.size > 0) {
      const hasSheets = [...this.instances.values()].some((i) => i.kind === 'xlsx')
      if (!hasSheets) {
        runtime.sheets.setActiveSheetsWebContents(null)
        runtime.sheets.stopSheetsSidecar()
      }
      this.refreshRuntimePointers()
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
