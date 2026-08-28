import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import { ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { GenOfficeSheetsRuntime } from './office-runtime'
import { convertLegacyOfficeFile } from './legacy-convert'
import { OFFICE_WORKSPACE_BOUNDS_CHANNEL } from './office-view-manager'

async function prepareSpreadsheet(fileId: string, hash: string, name: string, storagePath: string): Promise<string> {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Spreadsheet identity is invalid.')
  if (!/\.(xlsx|xlsm|xls)$/i.test(name)) throw new Error(`Unsupported internal spreadsheet: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Spreadsheet is unavailable: ${source}`)
  const dir = join(app.getPath('userData'), 'office-spreadsheets', fileId, hash)
  // 旧版 .xls 先经 LibreOffice 转成 .xlsx，与 OOXML 一样按 (fileId, hash) 缓存工作副本。
  const legacyTarget = extname(name).toLowerCase() === '.xls' ? 'xlsx' as const : null
  const target = join(dir, legacyTarget ? `${basename(name, extname(name))}.${legacyTarget}` : basename(name))
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) {
    if (legacyTarget) await convertLegacyOfficeFile(source, name, dir, legacyTarget)
    else copyFileSync(source, target)
  }
  return target
}

export class SpreadsheetViewManager {
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null
  private constructor(private readonly window: BrowserWindow, private readonly sheets: GenOfficeSheetsRuntime, private readonly view: WebContentsView) {}

  static async create(window: BrowserWindow, sheets: GenOfficeSheetsRuntime, file: { id: string; contentHash: string; originalName: string; storagePath: string }): Promise<SpreadsheetViewManager> {
    const path = await prepareSpreadsheet(file.id, file.contentHash, file.originalName, file.storagePath)
    sheets.setSheetsShellWindow(window)
    const view = sheets.createSheetsView({ includeAiHandlers: false, readonly: true })
    sheets.queueWorkbookForView(view.webContents, path)
    sheets.setActiveSheetsWebContents(view.webContents)
    view.setVisible(false)
    window.contentView.addChildView(view)
    const manager = new SpreadsheetViewManager(window, sheets, view)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    return manager
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (active) {
      // 多实例并存时全局激活指针只有一个：每次激活都要重新指向本视图。
      this.sheets.setActiveSheetsWebContents(this.view.webContents)
      if (this.bounds) this.view.setBounds(this.bounds)
    }
    this.view.setVisible(active && Boolean(this.bounds?.width && this.bounds.height))
  }

  private readonly handleBounds = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (this.disposed || event.sender !== this.window.webContents || !input || typeof input !== 'object') return
    const value = input as Partial<Rectangle>
    if (![value.x, value.y, value.width, value.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return
    const content = this.window.getContentBounds()
    const x = Math.max(0, Math.round(value.x!)); const y = Math.max(0, Math.round(value.y!))
    const bounds = { x, y, width: Math.max(0, Math.min(Math.round(value.width!), content.width - x)), height: Math.max(0, Math.min(Math.round(value.height!), content.height - y)) }
    this.bounds = bounds; this.view.setBounds(bounds); this.view.setVisible(this.active && bounds.width > 0 && bounds.height > 0)
  }

  readonly dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false })
  }
}
