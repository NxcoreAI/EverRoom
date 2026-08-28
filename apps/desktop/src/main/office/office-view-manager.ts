import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { app, ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'

import type { GenOfficeDocsRuntime } from './office-runtime'
import { convertLegacyOfficeFile } from './legacy-convert'

export const OFFICE_WORKSPACE_BOUNDS_CHANNEL = 'office:workspace-bounds'

export interface OfficeWorkspaceBounds {
  x: number
  y: number
  width: number
  height: number
}

function validCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeBounds(input: unknown, window: BrowserWindow): Rectangle | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Partial<OfficeWorkspaceBounds>
  if (![value.x, value.y, value.width, value.height].every(validCoordinate)) return null
  const content = window.getContentBounds()
  const x = Math.max(0, Math.round(value.x!))
  const y = Math.max(0, Math.round(value.y!))
  const width = Math.max(0, Math.min(Math.round(value.width!), content.width - x))
  const height = Math.max(0, Math.min(Math.round(value.height!), content.height - y))
  return { x, y, width, height }
}

function validateDocxPath(input: string): string {
  const filePath = resolve(input)
  if (extname(filePath).toLowerCase() !== '.docx' || !existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`Office document must point to a readable .docx file: ${filePath}`)
  }
  return filePath
}

export async function prepareOfficeDocument(
  fileId: string,
  contentHash: string,
  originalName: string,
  storagePath: string,
): Promise<string> {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(contentHash)) {
    throw new Error('Office document identity is invalid.')
  }
  const extension = extname(originalName).toLowerCase()
  if (extension !== '.docx' && extension !== '.doc') {
    throw new Error(`Unsupported internal Office document: ${originalName}`)
  }
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Office document is unavailable: ${source}`)
  }

  // Object-store blobs are extensionless and content-addressed. GenOffice
  // requires a .docx path and must never write into the immutable CAS blob, so
  // open a stable per-version working copy instead. Legacy .doc files get a
  // LibreOffice conversion cached next to that working copy.
  const directory = join(app.getPath('userData'), 'office-documents', fileId, contentHash)
  const legacyTarget = extension === '.doc' ? 'docx' : null
  const target = join(
    directory,
    legacyTarget ? `${basename(originalName, extname(originalName))}.${legacyTarget}` : basename(originalName),
  )
  mkdirSync(directory, { recursive: true })
  if (!existsSync(target)) {
    if (legacyTarget) await convertLegacyOfficeFile(source, originalName, directory, legacyTarget)
    else copyFileSync(source, target)
  }
  return target
}

export class OfficeViewManager {
  private readonly docs: GenOfficeDocsRuntime
  private readonly view: WebContentsView
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null

  private constructor(
    private readonly window: BrowserWindow,
    docs: GenOfficeDocsRuntime,
    view: WebContentsView,
  ) {
    this.docs = docs
    this.view = view
  }

  static createWithRuntime(
    window: BrowserWindow,
    docs: GenOfficeDocsRuntime,
    docxPath: string,
  ): OfficeViewManager {
    const filePath = validateDocxPath(docxPath)
    docs.registerDocsIpc()
    docs.setDocsShellWindow(window)
    const view = docs.createDocsView(filePath, { hostMode: 'everroom', readonly: true })
    docs.setActiveDocsResolver(() => view.webContents.isDestroyed() ? null : view.webContents)
    view.setVisible(false)
    window.contentView.addChildView(view)

    const manager = new OfficeViewManager(window, docs, view)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    return manager
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (active) {
      // 多实例并存时全局激活指针只有一个：每次激活都要重新指向本视图。
      this.docs.setActiveDocsResolver(() => this.view.webContents.isDestroyed() ? null : this.view.webContents)
      if (this.bounds) this.view.setBounds(this.bounds)
    }
    this.view.setVisible(active && Boolean(this.bounds?.width && this.bounds.height))
  }

  private readonly handleBounds = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (this.disposed || event.sender !== this.window.webContents) return
    const bounds = normalizeBounds(input, this.window)
    if (!bounds) return
    this.bounds = bounds
    this.view.setBounds(bounds)
    this.view.setVisible(this.active && bounds.width > 0 && bounds.height > 0)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) {
      this.docs.teardownDocsRenderer(this.view.webContents)
      this.view.webContents.close({ waitForBeforeUnload: false })
    }
  }
}
