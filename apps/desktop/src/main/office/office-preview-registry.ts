import type { BrowserWindow } from 'electron'

import {
  OFFICE_TEST_INSTANCE_ID,
  officePreviewKindForFileName,
  type OfficePreviewKind,
} from '../../shared/sources'
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
}

/** The lifecycle surface the three view managers expose to the registry. */
interface OfficePreviewView {
  setActive(active: boolean): void
  dispose(): void
}

interface OfficePreviewInstance {
  descriptor: OfficePreviewDescriptor
  view: OfficePreviewView
}

/** 内嵌 Office 文件扩展名 → 预览运行时分流（shared 实现，渲染端入口与 files:open-original 共用同一白名单）。 */
export const officePreviewKindFor = officePreviewKindForFileName

/**
 * 顶栏 Office 预览标签的主进程侧：按 fileId 多开/复用 genoffice 视图实例，
 * 同一时刻只显示渲染端激活的那个（渲染端是焦点唯一事实源，open 不自动激活）。
 */
export class OfficePreviewRegistry {
  private runtime: PreparedGenOfficeRuntime | null = null
  private window: BrowserWindow | null = null
  private readonly instances = new Map<string, OfficePreviewInstance>()
  private activeId: string | null = null

  /** 打开（或复用）一个预览实例；instanceId = fileId，内容 hash 变化时原地重建。 */
  async open(window: BrowserWindow, file: OfficePreviewFile): Promise<OfficePreviewDescriptor> {
    const kind = officePreviewKindFor(file.originalName)
    if (!kind) throw new Error(`Unsupported internal Office preview: ${file.originalName}`)
    this.bindWindow(window)
    const runtime = this.ensureRuntime(window)

    const existing = this.instances.get(file.id)
    if (existing && existing.descriptor.contentHash === file.contentHash) return existing.descriptor
    if (existing) this.close(file.id)

    const descriptor: OfficePreviewDescriptor = {
      id: file.id,
      kind,
      title: file.originalName,
      contentHash: file.contentHash,
    }
    const view = await this.createView(window, runtime, kind, file)
    this.instances.set(file.id, { descriptor, view })
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
    this.instances.set(OFFICE_TEST_INSTANCE_ID, { descriptor, view })
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

  close(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return
    this.instances.delete(id)
    instance.view.dispose()
    if (this.activeId === id) this.activeId = null
    this.teardownIfIdle()
  }

  disposeAll(): void {
    for (const instance of this.instances.values()) instance.view.dispose()
    this.instances.clear()
    this.activeId = null
    this.teardownIfIdle()
  }

  private async createView(
    window: BrowserWindow,
    runtime: PreparedGenOfficeRuntime,
    kind: OfficePreviewKind,
    file: OfficePreviewFile,
  ): Promise<OfficePreviewView> {
    if (kind === 'docx') {
      const documentPath = await prepareOfficeDocument(file.id, file.contentHash, file.originalName, file.storagePath)
      return OfficeViewManager.createWithRuntime(window, runtime.docs, documentPath)
    }
    if (kind === 'slides') {
      return SlidesViewManager.create(window, runtime.slides, file)
    }
    if (kind === 'pdf') {
      return PdfViewManager.create(window, runtime.pdf, file)
    }
    return SpreadsheetViewManager.create(window, runtime.sheets, file)
  }

  private bindWindow(window: BrowserWindow): void {
    if (this.window === window) return
    // 旧窗口的视图已随窗口销毁；换绑前先清空注册表再做全局 runtime 清理。
    this.disposeAll()
    this.window = window
    window.once('closed', () => {
      if (this.window === window) this.disposeAll()
    })
  }

  private ensureRuntime(window: BrowserWindow): PreparedGenOfficeRuntime {
    if (!this.runtime) {
      this.runtime = loadPreparedGenOfficeRuntime()
    }
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
