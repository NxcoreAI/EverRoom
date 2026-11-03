import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'

export interface GenOfficeAgentToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface GenOfficeAgentToolResult {
  id: string
  name: string
  output: string
  isError?: boolean
  mutated?: boolean
  summary?: string
}

export interface GenOfficeAgentDocDescription {
  context: string
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }
  /** 当前文字水印；null = 无 */
  watermark?: string | null
  /** 当前页面设置（orientation/paper/margins/columns/pageColor/sectionCount） */
  pageSetup?: Record<string, unknown>
  commandsGuide?: string
  htmlRules?: string
  /** 结构化操作词汇（apply_operations / word_agent_ops）：按域分组的 op 指南。 */
  operationsGuide?: string
  /** 文档现场状态：分节/页眉页脚/脚注尾注/书签/来源/保护/域/表格/修订/批注。 */
  documentState?: Record<string, unknown>
}

export interface GenOfficeAgentWorkbookDescription {
  context: string
  tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[]
  guides?: Record<string, string>
}

export interface GenOfficeDocsRuntime {
  configureDocsRuntime(config: {
    preloadPath: string
    rendererFile: string
    rendererUrl?: string
  }): void
  createDocsView(
    openPath?: string,
    options?: {
      hostMode?: 'tab' | 'everroom'
      readonly?: boolean
    },
  ): WebContentsView
  markDocsNewBlank(wcId: number): void
  queueDocsAiContent(wcId: number, content: { title: string; html: string }): void
  registerDocsIpc(): void
  /** 脏关闭守卫：true = 可以关闭（Save 已执行/无改动）；Cancel = false。 */
  requestDocsClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  docsQueryDirty(contents: WebContents): Promise<boolean>
  /**
   * 文档就绪信号：渲染层在 doc/editor 装载完成后上报 filePath；true = 目标
   * 工作副本已在编辑器里打开（身份一致），false = 超时/视图销毁/身份不符。
   * 后台 Agent 会话必须等它才能安全 describe/apply（避免写进空白文档）。
   */
  waitForAgentReady(contents: WebContents, expectedPath: string, timeoutMs?: number): Promise<boolean>
  /** 应用菜单接管闸门：仅当可见 docs 实例活跃时才允许 docs 菜单覆盖应用菜单。 */
  setDocsMenuGate(gate: (() => boolean) | null): void
  /**
   * 干净画布（EverRoom）：隐藏/显示编辑器操作区（Ribbon/状态栏/标尺/导航）。
   * hidden 省略 = 切换；渲染层自带恢复胶囊与 ⌘⇧F，隐藏后始终可恢复。
   */
  setDocsChromeHidden(contents: WebContents, hidden?: boolean): void
  /**
   * 选区「AI 修改」浮层（EverRoom embed）：宿主接管——按 wcId 反查文件与工作空间，
   * 载荷只描述选区（顶层块索引区间 + 类型 + 文本摘要），不带任何 id。
   */
  setDocsAgentAskHook(
    hook:
      | ((
          wcId: number,
          op: {
            instruction: string
            fromBlockIndex: number
            toBlockIndex: number
            kind: 'text' | 'image' | 'chart' | 'table'
            excerpt?: string
            blockType?: string
            /** 'queue' = 攒成批注一起发；缺省立即发送。 */
            mode?: 'now' | 'queue'
          },
        ) => Promise<{ ok: true } | { ok: false; error: string }>)
      | null,
  ): void
  setActiveDocsResolver(resolve: (() => WebContents | null) | null): void
  setDocsFileSavedHook(hook: (contents: WebContents, filePath: string) => void): void
  /** AI 页签论文排版面板：embed 宿主接管（wcId 反查 Room 与文件；payload 不带 id）。 */
  setDocsThesisPanelHook(
    hook:
      | ((
          wcId: number,
          action:
            | { kind: 'list' }
            | { kind: 'pick'; overwrite?: boolean }
            | { kind: 'remove'; cardId: string }
            /** 彻底删除模版（文件 + 格式卡）。 */
            | { kind: 'delete-template'; cardId: string; keepCard?: boolean }
            | { kind: 'reformat'; cardId?: string }
            | {
                kind: 'reformat-job'
                cardId?: string
                options?: {
                  keepLogo?: boolean
                  keepHeaderFooter?: boolean
                  headingMapping?: { chapter?: number; section?: number; subsection?: number }
                  aiFill?: boolean
                }
              }
            | { kind: 'reformat-job-status'; jobId: string }
            | { kind: 'preview-template'; cardId: string }
        ) => Promise<
          { ok: true; value: unknown } | { ok: false; reason: 'no_room' | 'error'; message?: string }
        >)
      | null,
  ): void
  setDocsShellWindow(window: BrowserWindow | null): void
  teardownDocsRenderer(contents: WebContents): void
  /** Agent 读取活文档：块列表上下文 + 工具词汇表 + 命令/HTML 指南（无会话返回 error）。 */
  describeAgentDoc(
    contents: WebContents,
  ): Promise<GenOfficeAgentDocDescription | { error: string }>
  /** Agent 编辑活文档：渲染层执行 docs AI 工具调用，变更后静默保存（fileSaved hook 回填版本链）。 */
  applyAgentDocTools(
    contents: WebContents,
    calls: GenOfficeAgentToolCall[],
  ): Promise<{ results: GenOfficeAgentToolResult[] } | { error: string }>
  /** 论文装订：源 docx + 格式卡 + 装订规格 → 装订版 docx 字节（主进程纯函数）。 */
  buildThesisDocx(
    sourceBytes: Uint8Array,
    formatCard: ThesisFormatCardPayload,
    bindingSpec: ThesisBindingSpecPayload,
  ): Promise<Uint8Array>
  /**
   * 论文装订（v3 模板骨架版）：以模版 docx 为底，只替换内容槽位。
   * 封面/核心信息区/表格/教师评价表/目录按模版原位置原样保留。
   *
   * 签名必须与引擎一致：**一个对象**（`{ templateBytes, sourceBytes, card, spec }`）。
   * 曾经这里写成 4 个位置参数，`requireRuntime(...) as GenOfficeDocsRuntime` 又拦不住，
   * 引擎拿到的是个裸 Uint8Array、第一行就抛错 → 每次排版静默回落 v2，
   * 「表格跑位」反复查不出原因就是这个签名漂移。
   */
  buildThesisDocxOnTemplate(input: {
    templateBytes: Uint8Array
    sourceBytes: Uint8Array
    card: ThesisFormatCardPayload
    spec: ThesisBindingSpecPayload
  }): Promise<{ bytes: Uint8Array; diagnostics: ThesisTemplateDiagnostics }>
  /** 源论文 docx → 块大纲（装订映射的区间事实源，索引与 buildThesisDocx 对齐）。 */
  describeThesisBlocks(bytes: Uint8Array): Promise<ThesisOutlineBlock[]>
}

/**
 * 模板骨架装订诊断：面板据此告诉用户「这次是按模板排的」还是「正文只能堆到文末」。
 * slots=0 表示模板章节骨架没解析出来（模版用普通段落排标题、且卡片是旧版本解析的）。
 */
export interface ThesisTemplateDiagnostics {
  slots: number
  blocks: number
  anchors: number
  bodyStart: number
  chapters: number
  appendedOnly: boolean
  /** true = 模版正文认出的章节锚点太少（如「只有目录」的模版），骨架排版降级为内容重建。 */
  templateFirstDowngraded?: boolean
}

export interface ThesisOutlineBlock {
  index: number
  kind: 'heading' | 'paragraph' | 'table' | 'image' | 'list'
  level?: number
  text: string
}

/** 装订引擎侧格式卡载荷（与 genoffice docx-engine ThesisFormatCardInput 同构）。 */
export interface ThesisFormatCardPayload {
  /** v2 模板编号方案（cn-upper/decimal-tree/…）；缺省走 headings[].numbering 老语义。 */
  numbering?: { scheme: string; levels?: Array<{ level: number; numFmt?: string; lvlText?: string; start?: number }> }
  page: Record<string, number | string>
  base: Record<string, unknown>
  header: Record<string, unknown> & { images?: Array<Record<string, unknown>> }
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
  chapters: Array<{
    level: number
    headingText: string
    blockStart: number
    blockEnd: number
    /** v3 模板骨架装订：该章节要落回的模版槽位 id（缺省时按槽位顺序对齐）。 */
    slotId?: string
  }>
  references: string[]
  appendixBlocks: { start: number; end: number } | null
  acknowledgementParagraphs: string[]
  achievements: string[]
  /** v2 未归类内容区间：渲染为正文末尾独立小节并高亮标记（不丢内容）。 */
  unmatchedBlocks?: Array<{ start: number; end: number; label?: string }>
}
export interface GenOfficeSheetsRuntime {
  configureSheetsRuntime(config: { preloadPath: string; rendererFile: string; sidecarPath: string }): void
  /**
   * tab 模式建视图。claimActive=false 时不得改写全局 active 指针（后台 Agent
   * 隐藏会话不是用户的页签）；includeAiHandlers=false 关掉自带的 AI 聊天面板 IPC。
   */
  createSheetsView(options?: {
    includeAiHandlers?: boolean
    readonly?: boolean
    claimActive?: boolean
  }): WebContentsView
  queueWorkbookForView(contents: WebContents, path: string): void
  registerSheetsIpc(): void
  /**
   * 工作簿就绪信号：渲染层在目标工作副本装载完成后上报 filePath；true = 目标
   * 工作副本已在编辑器里打开（身份一致），false = 超时/视图销毁/身份不符。
   * 后台 Agent 会话必须等它才能安全 describe/apply（避免读写成空白工作簿）。
   */
  waitForAgentReady(contents: WebContents, expectedPath: string, timeoutMs?: number): Promise<boolean>
  /** 拆除渲染端（清恢复副本/撤销写授权/让孤儿渲染器失效）；不弹对话框。 */
  teardownSheetsRenderer(contents: WebContents): void
  /** 脏关闭守卫：true = 可以关闭（Save 已执行/无改动）；Cancel = false。 */
  requestSheetsClose(contents: WebContents, parent?: BrowserWindow | null): Promise<boolean>
  setActiveSheetsWebContents(contents: WebContents | null): void
  /** 未保存编辑条数（>0 = 脏）：Agent 写回工作副本前的闸门。 */
  sheetsPendingEditCount(webContentsId: number): number
  /**
   * 选区「AI 修改」浮层（EverRoom embed）：宿主接管——按 wcId 反查文件与工作空间，
   * 载荷带工作表 id（sheets 工具按 sheetId 定位）+ A1 区域 + 指令。
   */
  setSheetsAgentAskHook(
    hook:
      | ((
          wcId: number,
          op: {
            instruction: string
            sheetId?: string
            sheetName?: string
            range?: string
            mode?: 'now' | 'queue'
          },
        ) => Promise<{ ok: true } | { ok: false; error: string }>)
      | null,
  ): void
  setSheetsFileSavedHook(hook: (contents: WebContents, filePath: string) => void): void
  setSheetsShellWindow(window: BrowserWindow | null): void
  stopSheetsSidecar(): void
  /** Agent 读取活工作簿：工作簿上下文 + 工具词汇表 + 操作指南（无会话返回 error）。 */
  describeAgentWorkbook(
    contents: WebContents,
  ): Promise<GenOfficeAgentWorkbookDescription | { error: string }>
  /** Agent 编辑活工作簿：渲染层执行 workbook AI 工具调用（含 propose_operations），变更后静默保存。 */
  applyAgentWorkbookTools(
    contents: WebContents,
    calls: GenOfficeAgentToolCall[],
  ): Promise<{ results: GenOfficeAgentToolResult[] } | { error: string }>
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
  createSlidesView(
    openPath?: string | null,
    options?: { readonly?: boolean },
  ): WebContentsView
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
  createPdfView(
    openPath?: string | null,
    options?: { readonly?: boolean },
  ): WebContentsView
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
