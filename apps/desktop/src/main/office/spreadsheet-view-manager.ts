import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import { ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'
import type { GenOfficeSheetsRuntime } from './office-runtime'
import { convertLegacyOfficeFile } from './legacy-convert'
import { ensureWorkingCopyWritable } from './working-copy'
import { OFFICE_WORKSPACE_BOUNDS_CHANNEL } from './office-view-manager'
import { OfficeViewFirstFrameGate } from './office-view-first-frame'

/**
 * 后台 Agent 会话的工作副本变体：文件名加 `agent-` 前缀，与用户可见视图的
 * 工作副本分开。
 *
 * 为什么不能共用：GenOffice Sheets 的崩溃恢复副本按「工作副本路径」哈希存放。
 * 用户在可见视图里改完未保存就退出，下一次后台会话如果用同一条路径打开，就会
 * 命中那份恢复副本并弹出「是否恢复」对话框——隐藏视图没有人能点它，工作簿
 * 永远打不开。独立路径也让后台编辑的静默保存不会清掉用户待恢复的副本。
 */
const AGENT_WORK_COPY_PREFIX = 'agent-'

/**
 * 把 catalog 里的表格准备成可编辑工作副本（按 fileId+contentHash 缓存，边界校验
 * 与 prepareOfficeDocument 对齐）。可见视图与后台隐藏 Agent 会话共用这一份逻辑，
 * 但用不同文件名（见 AGENT_WORK_COPY_PREFIX）。
 */
export async function prepareSpreadsheet(
  fileId: string,
  hash: string,
  name: string,
  storagePath: string,
  options: { agent?: boolean } = {},
): Promise<string> {
  if (!/^file-[a-z0-9-]+$/i.test(fileId) || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Spreadsheet identity is invalid.')
  if (!/\.(xlsx|xlsm|xls)$/i.test(name)) throw new Error(`Unsupported internal spreadsheet: ${name}`)
  const source = resolve(storagePath)
  if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`Spreadsheet is unavailable: ${source}`)
  const dir = join(app.getPath('userData'), 'office-spreadsheets', fileId, hash)
  // 旧版 .xls 先经 LibreOffice 转成 .xlsx，与 OOXML 一样按 (fileId, hash) 缓存工作副本。
  const legacyTarget = extname(name).toLowerCase() === '.xls' ? 'xlsx' as const : null
  const baseName = legacyTarget ? `${basename(name, extname(name))}.${legacyTarget}` : basename(name)
  const target = join(dir, options.agent === true ? `${AGENT_WORK_COPY_PREFIX}${baseName}` : baseName)
  mkdirSync(dir, { recursive: true })
  if (!existsSync(target)) {
    if (legacyTarget) await convertLegacyOfficeFile(source, name, dir, legacyTarget)
    else copyFileSync(source, target)
  }
  // 既有缓存也要修：老版本从只读原文件复制出来的工作副本一直是只读的。
  ensureWorkingCopyWritable(target)
  return target
}

export class SpreadsheetViewManager {
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null
  private readonly gate: OfficeViewFirstFrameGate
  private constructor(
    private readonly window: BrowserWindow,
    private readonly sheets: GenOfficeSheetsRuntime,
    private readonly view: WebContentsView,
    private readonly editable: boolean,
    readonly documentPath: string,
  ) {
    this.gate = new OfficeViewFirstFrameGate(view, window)
  }

  get webContentsId(): number {
    return this.view.webContents.id
  }

  /** 未保存修改（renderer 上报的 pending 编辑数 > 0）：Agent 写回前的闸门。 */
  async isDirty(): Promise<boolean> {
    if (this.view.webContents.isDestroyed()) return false
    return this.sheets.sheetsPendingEditCount(this.view.webContents.id) > 0
  }

  static async create(window: BrowserWindow, sheets: GenOfficeSheetsRuntime, file: { id: string; contentHash: string; originalName: string; storagePath: string }, options?: { editable?: boolean }): Promise<SpreadsheetViewManager> {
    const path = await prepareSpreadsheet(file.id, file.contentHash, file.originalName, file.storagePath)
    const editable = options?.editable === true
    sheets.setSheetsShellWindow(window)
    const view = sheets.createSheetsView({
      includeAiHandlers: false,
      readonly: !editable,
    })
    sheets.queueWorkbookForView(view.webContents, path)
    sheets.setActiveSheetsWebContents(view.webContents)
    view.setVisible(false)
    window.contentView.addChildView(view)
    const manager = new SpreadsheetViewManager(window, sheets, view, editable, path)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    return manager
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (active) {
      // 多实例并存时全局激活指针只有一个：每次激活都要重新指向本视图。
      this.sheets.setActiveSheetsWebContents(this.view.webContents)
    }
    // 首次出帧闸门：空视图直接显示会让宿主占位界面透出来。
    this.gate.setActive(active)
  }

  private readonly handleBounds = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (this.disposed || event.sender !== this.window.webContents || !input || typeof input !== 'object') return
    const value = input as Partial<Rectangle>
    if (![value.x, value.y, value.width, value.height].every((n) => typeof n === 'number' && Number.isFinite(n))) return
    const content = this.window.getContentBounds()
    const x = Math.max(0, Math.round(value.x!)); const y = Math.max(0, Math.round(value.y!))
    const bounds = { x, y, width: Math.max(0, Math.min(Math.round(value.width!), content.width - x)), height: Math.max(0, Math.min(Math.round(value.height!), content.height - y)) }
    this.bounds = bounds
    this.gate.setBounds(bounds)
  }

  readonly dispose = async (): Promise<boolean> => {
    if (this.disposed) return true
    if (this.editable && !this.view.webContents.isDestroyed() && !this.window.isDestroyed()) {
      const proceed = await this.sheets.requestSheetsClose(this.view.webContents, this.window)
      if (!proceed) return false
    }
    this.disposed = true
    this.gate.dispose()
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close({ waitForBeforeUnload: false })
    return true
  }
}
