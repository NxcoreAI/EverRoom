import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { GenOfficeSlidesRuntime } from './office-runtime'
import { convertLegacyOfficeFile } from './legacy-convert'
import { ensureWorkingCopyWritable } from './working-copy'
import { OFFICE_WORKSPACE_BOUNDS_CHANNEL } from './office-view-manager'
import { OfficeViewFirstFrameGate } from './office-view-first-frame'

async function preparePresentation(fileId: string, hash: string, name: string, storagePath: string): Promise<string> {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Presentation identity is invalid.')
  const extension = extname(name).toLowerCase()
  if (extension !== '.pptx' && extension !== '.ppt') throw new Error(`Unsupported internal presentation: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Presentation is unavailable: ${source}`)
  // Object-store blobs are extensionless and content-addressed; the slides
  // runtime needs a .pptx path and must never write into the immutable CAS
  // blob, so open a stable per-version working copy instead. Legacy .ppt gets
  // a LibreOffice conversion cached next to that working copy.
  const dir = join(app.getPath('userData'), 'office-presentations', fileId, hash)
  const legacyTarget = extension === '.ppt' ? 'pptx' as const : null
  const target = join(dir, legacyTarget ? `${basename(name, extname(name))}.${legacyTarget}` : basename(name))
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) {
    if (legacyTarget) await convertLegacyOfficeFile(source, name, dir, legacyTarget)
    else copyFileSync(source, target)
  }
  // 既有缓存也要修：老版本从只读原文件复制出来的工作副本一直是只读的。
  ensureWorkingCopyWritable(target)
  return target
}

export class SlidesViewManager {
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null
  private readonly gate: OfficeViewFirstFrameGate
  private constructor(
    private readonly window: BrowserWindow,
    private readonly slides: GenOfficeSlidesRuntime,
    private readonly view: WebContentsView,
    private readonly editable: boolean,
    readonly documentPath: string,
  ) {
    this.gate = new OfficeViewFirstFrameGate(view, window)
  }

  get webContentsId(): number {
    return this.view.webContents.id
  }

  static async create(
    window: BrowserWindow,
    slides: GenOfficeSlidesRuntime,
    file: { id: string; contentHash: string; originalName: string; storagePath: string },
    options?: { editable?: boolean },
  ): Promise<SlidesViewManager> {
    const path = await preparePresentation(file.id, file.contentHash, file.originalName, file.storagePath)
    const editable = options?.editable === true
    slides.setSlidesShellWindow(window)
    // createSlidesView queues the path for the renderer's mount-time
    // consumePendingOpen, registers slides IPC, and loads mode=tab.
    const view = slides.createSlidesView(path, { readonly: !editable })
    slides.setActiveSlidesWebContents(view.webContents)
    view.setVisible(false)
    window.contentView.addChildView(view)
    const manager = new SlidesViewManager(window, slides, view, editable, path)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    return manager
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (active) {
      // 多实例并存时全局激活指针只有一个：每次激活都要重新指向本视图。
      this.slides.setActiveSlidesWebContents(this.view.webContents)
    }
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
    this.bounds = bounds
    this.gate.setBounds(bounds)
  }

  readonly dispose = async (): Promise<boolean> => {
    if (this.disposed) return true
    if (this.editable && !this.view.webContents.isDestroyed() && !this.window.isDestroyed()) {
      const proceed = await this.slides.requestSlidesClose(this.view.webContents, this.window)
      if (!proceed) return false
    }
    this.disposed = true
    this.gate.dispose()
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false })
    return true
  }
}
