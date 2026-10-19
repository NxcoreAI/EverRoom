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
  markDocsNewBlank(wcId: number): void
  queueDocsAiContent(wcId: number, content: { title: string; html: string }): void
  registerDocsIpc(): void
  /** 脏关闭守卫：true = 可以关闭（Save 已执行/无改动）；Cancel = false。 */
  requestDocsClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  docsQueryDirty(contents: WebContents): Promise<boolean>
  setActiveDocsResolver(resolve: (() => WebContents | null) | null): void
  setDocsFileSavedHook(hook: (contents: WebContents, filePath: string) => void): void
  /** AI 页签论文排版面板：embed 宿主接管（wcId 反查 Room 与文件；payload 不带 id）。 */
  setDocsThesisPanelHook(
    hook:
      | ((
          wcId: number,
          action:
            | { kind: 'list' }
            | { kind: 'pick' }
            | { kind: 'remove'; cardId: string }
            | { kind: 'reformat'; cardId?: string },
        ) => Promise<
          { ok: true; value: unknown } | { ok: false; reason: 'no_room' | 'error'; message?: string }
        >)
      | null,
  ): void
  setDocsShellWindow(window: BrowserWindow | null): void
  teardownDocsRenderer(contents: WebContents): void
  /** 论文装订：源 docx + 格式卡 + 装订规格 → 装订版 docx 字节（主进程纯函数）。 */
  buildThesisDocx(
    sourceBytes: Uint8Array,
    formatCard: ThesisFormatCardPayload,
    bindingSpec: ThesisBindingSpecPayload,
  ): Promise<Uint8Array>
  /** 源论文 docx → 块大纲（装订映射的区间事实源，索引与 buildThesisDocx 对齐）。 */
  describeThesisBlocks(bytes: Uint8Array): Promise<ThesisOutlineBlock[]>
}

export interface ThesisOutlineBlock {
  index: number
  kind: 'heading' | 'paragraph' | 'table' | 'image' | 'list'
  level?: number
  text: string
}

/** 装订引擎侧格式卡载荷（与 genoffice docx-engine ThesisFormatCardInput 同构）。 */
export interface ThesisFormatCardPayload {
  page: Record<string, number | string>
  base: Record<string, unknown>
  header: Record<string, unknown>
  footer: Record<string, unknown>
  headings: Array<Record<string, unknown>>
  abstract: Record<string, unknown>
  toc: Record<string, unknown>
  references: Record<string, unknown>
  cover: Record<string, unknown>
  fixedTexts: Record<string, unknown>
  [key: string]: unknown
}

export interface ThesisBindingSpecPayload {
  title: string
  coverFields: Record<string, string>
  abstractZh: string
  keywordsZh: string[]
  abstractEn: string
  keywordsEn: string[]
  chapters: Array<{ level: number; headingText: string; blockStart: number; blockEnd: number }>
  references: string[]
  appendixBlocks: { start: number; end: number } | null
  acknowledgementParagraphs: string[]
  achievements: string[]
}
export interface GenOfficeSheetsRuntime {
  configureSheetsRuntime(config: { preloadPath: string; rendererFile: string; sidecarPath: string }): void
  createSheetsView(options?: { includeAiHandlers?: boolean; readonly?: boolean }): WebContentsView
  queueWorkbookForView(contents: WebContents, path: string): void
  registerSheetsIpc(): void
  /** 脏关闭守卫：true = 可以关闭（Save 已执行/无改动）；Cancel = false。 */
  requestSheetsClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  setActiveSheetsWebContents(contents: WebContents | null): void
  setSheetsFileSavedHook(hook: (contents: WebContents, filePath: string) => void): void
  setSheetsShellWindow(window: BrowserWindow | null): void
  stopSheetsSidecar(): void
}

export interface GenOfficeAgentDeckResult {
  bytes: Uint8Array
  warnings: { page: number; messages: string[] }[]
  imageFailures: { page: number; url: string }[]
}

/** everroom-material:// 素材引用回源器（桌面端注入，从本地素材库取字节）。 */
export interface GenOfficeMaterialResolver {
  resolveMaterial(url: string): Promise<{ bytes: Uint8Array; ext: string } | null>
}

export interface AgentSlidesDeckInfo {
  outline: string
  opVocabulary: string
  /** 宿主补充：实例是否可编辑（只读打开也能读大纲，编辑需重新以可编辑方式打开）。 */
  editable?: boolean
}

export interface AgentSlidesEditResult {
  ok: boolean
  /** 宿主级错误（无会话/无路径/非法请求）；per-op 失败走 failures。 */
  error?: string
  applied?: boolean
  dryRun?: boolean
  plan?: string[]
  records?: Array<{ op: string; target?: string; created?: string[] }>
  failures?: Array<{ index: number; error: string }>
  /** 静默保存结果；saveError = 已改内存但未落盘（版本链未回填）。 */
  saved?: boolean
  saveError?: string
  outline?: string
  /** PageSpec 解析告警（逐页填充路径）：页面已渲染，但建议关注。 */
  warnings?: Array<{ page: number; messages: string[] }>
}

export interface GenOfficeSlidesRuntime {
  configureSlidesRuntime(config: { preloadPath: string; rendererFilePath?: string }): void
  createSlidesView(openPath?: string | null, options?: { readonly?: boolean }): WebContentsView
  registerSlidesIpc(): void
  requestSlidesClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  setActiveSlidesWebContents(contents: WebContents | null): void
  setSlidesFileSavedHook(hook: (contents: WebContents, filePath: string) => void): void
  /** 「AI 修改」弹层转发（embed 宿主接管；id 空间 = 大纲/编辑 op 的 durable id）。 */
  setSlidesAgentAskHook(
    hook:
      | ((
          wcId: number,
          op: {
            instruction: string
            slideIndex: number
            targets: Array<{
              id: string
              desc: { type: string; text?: string; rows?: number; cols?: number }
            }>
          },
        ) => Promise<{ ok: true } | { ok: false; error: string }>)
      | null,
  ): void
  setSlidesShellWindow(window: BrowserWindow | null): void
  slidesIsDirty(webContentsId: number): boolean
  /** Agent 幻灯片生成：页 spec JSON 数组 → 单文件 .pptx 字节（无渲染端参与）。 */
  buildAgentDeckPptx(
    pageSpecJsons: string[],
    imageResolver?: GenOfficeMaterialResolver,
  ): Promise<{ ok: true; deck: GenOfficeAgentDeckResult } | { ok: false; error: string }>
  /** Agent 读取活会话：大纲 + op 词汇表（该视图无会话返回 null）。 */
  describeAgentDeck(webContentsId: number): AgentSlidesDeckInfo | null
  /** Agent 编辑活会话：事务应用 + 逐视图重绘广播 + 静默保存（fileSaved hook 回填版本链）。 */
  applyAgentDeckOps(
    webContentsId: number,
    ops: unknown[],
    opts?: { dryRun?: boolean; isolation?: 'atomic' | 'per_op' },
  ): Promise<AgentSlidesEditResult>
  /** Agent 逐页填充活会话：PageSpec 经与整册生成同一条 builder/merge 管线原地替换一页。 */
  applyAgentDeckPage(
    webContentsId: number,
    req: { slideIndex: number; specJson: string },
    imageResolver?: GenOfficeMaterialResolver,
  ): Promise<AgentSlidesEditResult>
  /** 视觉复检：活会话渲染层离屏栅格化一页为 1x PNG（base64，不带 data: 前缀）。 */
  renderAgentDeckPagePng(
    webContentsId: number,
    slideIndex: number,
  ): Promise<{ pngBase64: string } | { error: string }>
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
