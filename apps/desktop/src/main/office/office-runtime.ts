import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

export interface GenOfficeDocsRuntime {
  configureDocsRuntime(config: {
    preloadPath: string
    rendererFile: string
    rendererUrl?: string
  }): void
  createDocsView(
    openPath?: string,
    options?: { hostMode?: 'tab' | 'everroom'; readonly?: boolean },
  ): WebContentsView
  registerDocsIpc(): void
  setActiveDocsResolver(resolve: (() => WebContents | null) | null): void
  setDocsShellWindow(window: BrowserWindow | null): void
  teardownDocsRenderer(contents: WebContents): void
}
export interface GenOfficeSheetsRuntime {
  configureSheetsRuntime(config: { preloadPath: string; rendererFile: string; sidecarPath: string }): void
  createSheetsView(options?: { includeAiHandlers?: boolean; readonly?: boolean }): WebContentsView
  queueWorkbookForView(contents: WebContents, path: string): void
  registerSheetsIpc(): void
  setActiveSheetsWebContents(contents: WebContents | null): void
  setSheetsShellWindow(window: BrowserWindow | null): void
  stopSheetsSidecar(): void
}

export interface GenOfficeSlidesRuntime {
  configureSlidesRuntime(config: { preloadPath: string; rendererFilePath?: string }): void
  createSlidesView(openPath?: string | null, options?: { readonly?: boolean }): WebContentsView
  registerSlidesIpc(): void
  requestSlidesClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  setActiveSlidesWebContents(contents: WebContents | null): void
  setSlidesShellWindow(window: BrowserWindow | null): void
  slidesIsDirty(webContentsId: number): boolean
}

export interface GenOfficePdfRuntime {
  configurePdfRuntime(config: { preloadPath: string; rendererFile?: string }): void
  createPdfView(openPath?: string | null, options?: { readonly?: boolean }): WebContentsView
  requestPdfClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  pdfIsDirty(webContentsId: number): boolean
}

export interface PreparedGenOfficeRuntime {
  docs: GenOfficeDocsRuntime
  sheets: GenOfficeSheetsRuntime
  slides: GenOfficeSlidesRuntime
  pdf: GenOfficePdfRuntime
  root: string
}

export function preparedGenOfficeFixture(root: string): string {
  const fixture = join(root, 'fixtures', 'simple.docx')
  if (!existsSync(fixture)) throw new Error(`GenOffice test fixture is unavailable: ${fixture}`)
  return fixture
}

function runtimeRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'genoffice')
    : join(app.getAppPath(), 'build', 'genoffice-runtime')
}

export function loadPreparedGenOfficeRuntime(): PreparedGenOfficeRuntime {
  const root = runtimeRoot()
  const mainEntry = join(root, 'docs', 'main', 'embed.js')
  const preloadPath = join(root, 'docs', 'preload', 'index.js')
  const rendererFile = join(root, 'docs', 'renderer', 'index.html')
  const sheetsMainEntry = join(root, 'sheets', 'main', 'embed.js')
  const sheetsPreloadPath = join(root, 'sheets', 'preload', 'index.js')
  const sheetsRendererFile = join(root, 'sheets', 'renderer', 'index.html')
  const slidesMainEntry = join(root, 'slides', 'main', 'embed.js')
  const slidesPreloadPath = join(root, 'slides', 'preload', 'index.js')
  const slidesRendererFile = join(root, 'slides', 'renderer', 'index.html')
  const pdfMainEntry = join(root, 'pdf', 'main', 'embed.js')
  const pdfPreloadPath = join(root, 'pdf', 'preload', 'index.js')
  const pdfRendererFile = join(root, 'pdf', 'renderer', 'index.html')
  const sidecarPath = join(root, 'native', process.platform === 'win32' ? 'xlsx-sidecar.exe' : 'xlsx-sidecar')
  for (const path of [
    mainEntry,
    preloadPath,
    rendererFile,
    sheetsMainEntry,
    sheetsPreloadPath,
    sheetsRendererFile,
    slidesMainEntry,
    slidesPreloadPath,
    slidesRendererFile,
    pdfMainEntry,
    pdfPreloadPath,
    pdfRendererFile,
    sidecarPath,
  ]) {
    if (!existsSync(path)) {
      throw new Error(`GenOffice runtime is incomplete: ${path}`)
    }
  }

  // The runtime is built independently and copied through extraResources, so
  // it must stay outside EverRoom's electron-vite dependency graph.
  const requireRuntime = createRequire(mainEntry)
  const docs = requireRuntime(mainEntry) as GenOfficeDocsRuntime
  docs.configureDocsRuntime({ preloadPath, rendererFile })
  const sheetsRequire = createRequire(sheetsMainEntry)
  const sheets = sheetsRequire(sheetsMainEntry) as GenOfficeSheetsRuntime
  sheets.configureSheetsRuntime({ preloadPath: sheetsPreloadPath, rendererFile: sheetsRendererFile, sidecarPath })
  const slidesRequire = createRequire(slidesMainEntry)
  const slides = slidesRequire(slidesMainEntry) as GenOfficeSlidesRuntime
  slides.configureSlidesRuntime({ preloadPath: slidesPreloadPath, rendererFilePath: slidesRendererFile })
  const pdfRequire = createRequire(pdfMainEntry)
  const pdf = pdfRequire(pdfMainEntry) as GenOfficePdfRuntime
  pdf.configurePdfRuntime({ preloadPath: pdfPreloadPath, rendererFile: pdfRendererFile })
  return { docs, sheets, slides, pdf, root }
}
