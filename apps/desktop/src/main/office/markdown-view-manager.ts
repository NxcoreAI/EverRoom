import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { GenOfficeMarkdownRuntime } from './office-runtime'
import { OFFICE_WORKSPACE_BOUNDS_CHANNEL } from './office-view-manager'
import { OfficeViewFirstFrameGate } from './office-view-first-frame'

async function prepareMarkdown(
  fileId: string,
  hash: string,
  name: string,
  storagePath: string,
): Promise<string> {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) {
    throw new Error('Markdown identity is invalid.')
  }
  const ext = extname(name).toLowerCase()
  if (ext !== '.md' && ext !== '.markdown') throw new Error(`Unsupported internal markdown: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Markdown is unavailable: ${source}`)
  }
  // Object-store blobs are extensionless and content-addressed; the markdown
  // runtime gets a stable per-version working copy and never touches the
  // immutable CAS blob. hash 变化即换目录，与 pdf runtime 同一套快照保证。
  // 评论侧车 <file>.md.comments.json 由 runtime 写在工作副本旁，不进 CAS。
  const dir = join(app.getPath('userData'), 'office-markdowns', fileId, hash)
  const target = join(dir, basename(name))
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) copyFileSync(source, target)
  return target
}

export class MarkdownViewManager {
  private disposed = false
  private readonly gate: OfficeViewFirstFrameGate
  private constructor(
    private readonly window: BrowserWindow,
    private readonly markdown: GenOfficeMarkdownRuntime,
    private readonly view: WebContentsView,
    private readonly editable: boolean,
    /** 工作副本路径：编辑回填（editStates.filePath）按它读盘。 */
    readonly documentPath: string,
  ) {
    this.gate = new OfficeViewFirstFrameGate(view, window)
  }

  static async create(
    window: BrowserWindow,
    markdown: GenOfficeMarkdownRuntime,
    file: { id: string; contentHash: string; originalName: string; storagePath: string },
    options?: { editable?: boolean },
  ): Promise<MarkdownViewManager> {
    const path = await prepareMarkdown(file.id, file.contentHash, file.originalName, file.storagePath)
    const editable = options?.editable === true
    // createMarkdownView queues the path for the renderer's mount-time
    // consumePending and loads it with hostMode=everroom (操作栏收起默认开，
    // 宿主提供 agent 面板)。host-readonly preview 走 readonly=1。
    markdown.registerMarkdownIpc()
    const view = markdown.createMarkdownView(path, {
      hostMode: 'everroom',
      readonly: !editable,
    })
    view.setVisible(false)
    window.contentView.addChildView(view)
    const manager = new MarkdownViewManager(window, markdown, view, editable, path)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    return manager
  }

  /** markdown webContents id：chrome-toggle 等 host IPC 按 wcId 键控。 */
  get webContentsId(): number {
    return this.view.webContents.id
  }

  /** 未保存修改：Agent 覆盖工作副本前必须为 false（脏关闭守卫同源）。 */
  async isDirty(): Promise<boolean> {
    if (this.disposed) return false
    return this.markdown.markdownIsDirty(this.view.webContents.id)
  }

  /** 操作栏收起两态（不传 = 切换）：宿主工具栏/菜单入口。 */
  setChromeHidden(hidden?: boolean): void {
    if (this.disposed || this.view.webContents.isDestroyed()) return
    this.markdown.setMarkdownChromeHidden(this.view.webContents, hidden)
  }

  /** 后台 agent 会话：等渲染层装载完目标工作副本（身份一致）。 */
  async waitForAgentReady(timeoutMs?: number): Promise<boolean> {
    if (!this.markdown.waitForMarkdownAgentReady) return false
    return this.markdown.waitForMarkdownAgentReady(this.view.webContents, this.documentPath, timeoutMs)
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    // 首次出帧闸门：空视图直接显示会让宿主占位界面透出来。
    this.gate.setActive(active)
  }

  private readonly handleBounds = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (this.disposed || event.sender !== this.window.webContents || !input || typeof input !== 'object') return
    const value = input as Partial<Rectangle>
    if (![value.x, value.y, value.width, value.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return
    const content = this.window.getContentBounds()
    const x = Math.max(0, Math.round(value.x!))
    const y = Math.max(0, Math.round(value.y!))
    const bounds = {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(value.width!), content.width - x)),
      height: Math.max(0, Math.min(Math.round(value.height!), content.height - y)),
    }
    this.gate.setBounds(bounds)
  }

  readonly dispose = async (): Promise<boolean> => {
    if (this.disposed) return true
    // 脏关闭守卫与 docs/sheets/slides 一致：未保存的编辑先问再关。
    if (this.editable && !this.view.webContents.isDestroyed() && !this.window.isDestroyed()) {
      const proceed = await this.markdown.requestMarkdownClose(this.view.webContents, this.window)
      if (!proceed) return false
    }
    this.disposed = true
    this.gate.dispose()
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) {
      this.markdown.teardownMarkdownRenderer(this.view.webContents)
      this.view.webContents.close({ waitForBeforeUnload: false })
    }
    return true
  }
}
