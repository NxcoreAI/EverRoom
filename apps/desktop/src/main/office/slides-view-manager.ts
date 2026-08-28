import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { GenOfficeSlidesRuntime } from './office-runtime'
import { OFFICE_WORKSPACE_BOUNDS_CHANNEL } from './office-view-manager'

function preparePresentation(fileId: string, hash: string, name: string, storagePath: string): string {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Presentation identity is invalid.')
  if (extname(name).toLowerCase() !== '.pptx') throw new Error(`Unsupported internal presentation: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Presentation is unavailable: ${source}`)
  // Object-store blobs are extensionless and content-addressed; the slides
  // runtime needs a .pptx path and must never write into the immutable CAS
  // blob, so open a stable per-version working copy instead.
  const dir = join(app.getPath('userData'), 'office-presentations', fileId, hash)
  const target = join(dir, basename(name))
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) copyFileSync(source, target)
  return target
}

export class SlidesViewManager {
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null
  private constructor(
    private readonly window: BrowserWindow,
    private readonly slides: GenOfficeSlidesRuntime,
    private readonly view: WebContentsView,
  ) {}

  static create(
    window: BrowserWindow,
    slides: GenOfficeSlidesRuntime,
    file: { id: string; contentHash: string; originalName: string; storagePath: string },
  ): SlidesViewManager {
    const path = preparePresentation(file.id, file.contentHash, file.originalName, file.storagePath)
    slides.setSlidesShellWindow(window)
    // createSlidesView queues the path for the renderer's mount-time
    // consumePendingOpen, registers slides IPC, and loads mode=tab.
    const view = slides.createSlidesView(path)
    slides.setActiveSlidesWebContents(view.webContents)
    view.setVisible(false)
    window.contentView.addChildView(view)
    const manager = new SlidesViewManager(window, slides, view)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    window.once('closed', manager.dispose)
    return manager
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (active && this.bounds) this.view.setBounds(this.bounds)
    this.view.setVisible(active && Boolean(this.bounds?.width && this.bounds.height))
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
    this.view.setBounds(bounds)
    this.view.setVisible(this.active && bounds.width > 0 && bounds.height > 0)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    this.slides.setActiveSlidesWebContents(null)
    this.slides.setSlidesShellWindow(null)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false })
  }
}
