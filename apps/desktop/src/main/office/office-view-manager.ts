import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

import { app, ipcMain } from 'electron'
import type { BrowserWindow, Rectangle, WebContentsView } from 'electron'

import type { GenOfficeDocsRuntime } from './office-runtime'
import { convertLegacyOfficeFile } from './legacy-convert'
import { ensureWorkingCopyWritable } from './working-copy'
import { logOfficeDiag, logOfficeViewState, wireOfficeViewDiag } from './office-diag'
import { OfficeViewFirstFrameGate } from './office-view-first-frame'

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
  // 既有缓存也要修：老版本从只读原文件复制出来的工作副本一直是只读的。
  ensureWorkingCopyWritable(target)
  return target
}

export class OfficeViewManager {
  private readonly docs: GenOfficeDocsRuntime
  private readonly view: WebContentsView
  private readonly editable: boolean
  private readonly gate: OfficeViewFirstFrameGate
  private disposed = false
  private active = false
  private bounds: Rectangle | null = null

  private constructor(
    private readonly window: BrowserWindow,
    docs: GenOfficeDocsRuntime,
    view: WebContentsView,
    editable: boolean,
  ) {
    this.docs = docs
    this.view = view
    this.editable = editable
    this.gate = new OfficeViewFirstFrameGate(view, window)
  }

  /** docs webContents id：保存事件订阅（编辑回填）按它键控。 */
  get webContentsId(): number {
    return this.view.webContents.id
  }

  /** 未保存修改：Agent 覆盖工作副本前的闸门（脏 → 先把“保存后再改”告诉用户）。 */
  async isDirty(): Promise<boolean> {
    if (this.view.webContents.isDestroyed()) return false
    return this.docs.docsQueryDirty(this.view.webContents)
  }

  static createWithRuntime(
    window: BrowserWindow,
    docs: GenOfficeDocsRuntime,
    docxPath: string,
    options?: { editable?: boolean },
  ): OfficeViewManager {
    const filePath = validateDocxPath(docxPath)
    const editable = options?.editable === true
    docs.registerDocsIpc()
    docs.setDocsShellWindow(window)
    // GenOffice 自带的对话区/侧栏已删除，停靠栏统一由主窗口渲染层挂 SideDock
    // （见 office-preview-registry.ts）。
    const view = docs.createDocsView(filePath, {
      hostMode: 'everroom',
      readonly: !editable,
    })
    docs.setActiveDocsResolver(() => view.webContents.isDestroyed() ? null : view.webContents)
    view.setVisible(false)
    window.contentView.addChildView(view)

    const manager = new OfficeViewManager(window, docs, view, editable)
    ipcMain.on(OFFICE_WORKSPACE_BOUNDS_CHANNEL, manager.handleBounds)
    wireOfficeViewDiag(view, window)
    logOfficeViewState('office.diag.created', view, window, { filePath, editable })
    return manager
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    if (active) {
      // 多实例并存时全局激活指针只有一个：每次激活都要重新指向本视图。
      this.docs.setActiveDocsResolver(() => this.view.webContents.isDestroyed() ? null : this.view.webContents)
    }
    // 首次显示推迟到首帧提交后（见 OfficeViewFirstFrameGate）：空视图直接显示
    // 会让宿主 DOM 的占位界面透出来，正是「首次打开文档看不到文档」的现场。
    this.gate.setActive(active)
    logOfficeViewState('office.diag.set-active', this.view, this.window, {
      active,
      disposed: this.disposed,
      managerBounds: this.bounds,
    })
  }

  private readonly handleBounds = (event: Electron.IpcMainEvent, input: unknown): void => {
    if (this.disposed || event.sender !== this.window.webContents) return
    const bounds = normalizeBounds(input, this.window)
    if (!bounds) return
    this.bounds = bounds
    this.gate.setBounds(bounds)
  }

  /** false = 用户在脏关闭守卫里点了取消：实例与视图原样保留。 */
  readonly dispose = async (): Promise<boolean> => {
    if (this.disposed) return true
    if (
      this.editable &&
      !this.view.webContents.isDestroyed() &&
      !this.window.isDestroyed()
    ) {
      // Save 分支会跑渲染端完整保存流——保存事件照常进回填链，随后由调用方 flush。
      const proceed = await this.docs.requestDocsClose(this.view.webContents, this.window)
      if (!proceed) return false
    }
    this.disposed = true
    this.gate.dispose()
    ipcMain.removeListener(OFFICE_WORKSPACE_BOUNDS_CHANNEL, this.handleBounds)
    if (!this.view.webContents.isDestroyed()) {
      this.docs.teardownDocsRenderer(this.view.webContents)
      this.view.webContents.close({ waitForBeforeUnload: false })
    }
    return true
  }
}
