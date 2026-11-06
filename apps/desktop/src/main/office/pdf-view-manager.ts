import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { app, ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { GenOfficePdfRuntime } from './office-runtime'
import { OFFICE_WORKSPACE_BOUNDS_CHANNEL } from './office-view-manager'
import { OfficeViewFirstFrameGate } from './office-view-first-frame'

async function preparePdf(fileId: string, hash: string, name: string, storagePath: string): Promise<string> {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('PDF identity is invalid.')
  if (extname(name).toLowerCase() !== '.pdf') throw new Error(`Unsupported internal PDF: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`PDF is unavailable: ${source}`)
  // Object-store blobs are extensionless and content-addressed; the pdf runtime
  // gets a stable per-version working copy and must never touch the immutable
  // CAS blob. Readonly mode never writes — the copy is the same snapshot
  // guarantee (hash 变化即换目录) the other three runtimes rely on.
  const dir = join(app.getPath('userData'), 'office-pdfs', fileId, hash)
  const target = join(dir, basename(name))
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) copyFileSync(source, target)
  return target
}

export class PdfViewManager {
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null
  private readonly gate: OfficeViewFirstFrameGate
  private constructor(
    private readonly window: BrowserWindow,
    private readonly pdf: GenOfficePdfRuntime,
    private readonly view: WebContentsView,
    private readonly editable: boolean,
    /** 工作副本路径：编辑回填（editStates.filePath）按它读盘。 */
    readonly documentPath: string,
  ) {
    this.gate = new OfficeViewFirstFrameGate(view, window)
  }

  static async create(
    window: BrowserWindow,
    pdf: GenOfficePdfRuntime,
    file: { id: string; contentHash: string; originalName: string; storagePath: string },
    options?: { editable?: boolean },
  ): Promise<PdfViewManager> {
    const path = await preparePdf(file.id, file.contentHash, file.originalName, file.storagePath)
    const editable = options?.editable === true
    // createPdfView queues the path for the renderer's mount-time
    // consumePending and loads it with readonly=1 for host-readonly preview.
    // Editable opens (选区标注工具卡) keep the full markup surface on.
    const view = pdf.createPdfView(path, { readonly: !editable })
    view.setVisible(false)
    window.contentView.addChildView(view)
    const manager = new PdfViewManager(window, pdf, view, editable, path)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    return manager
  }

  /** pdf webContents id：wcId 反查（「注释」转发、批注锚点投递）按它键控。 */
  get webContentsId(): number {
    return this.view.webContents.id
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
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
    // 脏关闭守卫与其他三类视图一致：编辑打开的 PDF 有未保存标注时先问再关。
    if (this.editable && !this.view.webContents.isDestroyed() && !this.window.isDestroyed()) {
      const proceed = await this.pdf.requestPdfClose(this.view.webContents, this.window)
      if (!proceed) return false
    }
    this.disposed = true
    this.gate.dispose()
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false })
    return true
  }
}
