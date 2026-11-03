import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'
import type { WebContents, WebContentsView } from 'electron'

import { loadPreparedGenOfficeRuntime, type GenOfficeMaterialResolver, type PreparedGenOfficeRuntime, type ThesisBindingSpecPayload, type ThesisFormatCardPayload } from './office-runtime'
import { backfillThesisCoverLogo, backfillThesisHeaderLogos } from './thesis-logo-backfill'
import { selfCheckThesisDocx } from './thesis-selfcheck'
import { buildAgentXlsxBytes, type AgentSheetInput } from './xlsx-generation'
import type { OfficeAgentAskEvent } from '../../shared/office'

/** 生成卡死兜底：渲染端 boot → 填充 → 静默保存正常在秒级完成。 */
const GENERATION_TIMEOUT_MS = 3 * 60_000

let runtime: PreparedGenOfficeRuntime | null = null
let hookWired = false

// 三个 app 的 fileSaved hook 都是全局单槽位：按 webContents id 扇出给并发生成请求。
const pendingSaves = new Map<number, (filePath: string) => void>()
// 同一槽位的第二路扇出：预览编辑回填订阅（生成流程不受影响）。
const savedListeners = new Map<number, Set<(filePath: string) => void>>()

/** 订阅某 Office webContents 的保存事件（任意保存形态：save/save-as/save-new）。 */
export function onOfficeFileSaved(wcId: number, listener: (filePath: string) => void): () => void {
  const set = savedListeners.get(wcId) ?? new Set()
  set.add(listener)
  savedListeners.set(wcId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) savedListeners.delete(wcId)
  }
}

/** 生成阶段（渲染层做进度提示用）：视图就绪 → 落盘。 */
export type DocxGenerationPhase = 'rendering' | 'saved'

/** Office 保存 hook 全局只装一次（幂等）：生成 pendingSaves 与编辑回填监听共享扇出。 */
function ensureRuntime(): PreparedGenOfficeRuntime {
  runtime ??= loadPreparedGenOfficeRuntime()
  if (!hookWired) {
    wireOfficeSavedHooks(runtime)
  }
  return runtime
}

export function wireOfficeSavedHooks(target: PreparedGenOfficeRuntime): void {
  if (hookWired) return
  // 注册 IPC 自带进程级幂等守卫，与 Office 预览共存安全。
  target.docs.registerDocsIpc()
  const fanOut = (contents: WebContents, filePath: string): void => {
    const resolve = pendingSaves.get(contents.id)
    if (resolve) {
      pendingSaves.delete(contents.id)
      resolve(filePath)
    }
    for (const listener of savedListeners.get(contents.id) ?? []) listener(filePath)
  }
  target.docs.setDocsFileSavedHook(fanOut)
  target.slides.setSlidesFileSavedHook(fanOut)
  target.sheets.setSheetsFileSavedHook(fanOut)
  hookWired = true
}

// ── 「AI 修改」转发：slides 视图里的弹层提交 → Room 对话框 ──

/** fork slides:agent-ask 校验后透传的载荷（元素 id = 大纲/编辑 op 的 durable id）。 */
export interface SlidesAgentAskPayload {
  instruction: string
  slideIndex: number
  targets: Array<{
    id: string
    desc: { type: string; text?: string; rows?: number; cols?: number }
  }>
}

/** fork NodeDescriptor.type（RenderNodeType）→ 中文类型名。 */
const ASK_TYPE_LABEL: Record<string, string> = {
  text: '文本框',
  shape: '形状',
  picture: '图片',
  table: '表格',
  chart: '图表',
  group: '组合',
  'placeholder-chip': '形状',
}

function describeAskTarget(target: SlidesAgentAskPayload['targets'][number]): string {
  const label = ASK_TYPE_LABEL[target.desc.type] ?? target.desc.type
  const text = target.desc.text?.trim().split('\n')[0]
  if (!text) return `${target.id}（${label}）`
  const brief = text.length > 24 ? `${text.slice(0, 24)}…` : text
  return `${target.id}（${label}「${brief}」）`
}

/** 注入 Room 对话的用户消息：用户口吻的修改指令 + 给 Agent 的工具定位提示。 */
export function buildAgentAskMessage(title: string, op: SlidesAgentAskPayload): string {
  const targets = op.targets.map(describeAskTarget).join('、')
  return (
    `请修改 PPT《${title}》第 ${op.slideIndex + 1} 页选中的元素（${targets}）：${op.instruction}。`
    + '用 slides_draft(task=edit, fileId="active") 调度 slides-builder 子代理，把上述元素 id 与修改要求写进 instruction，'
    + '只改列出的元素，其他内容保持不动。'
  )
}

/** 同一请求的用户可见文案：只留页码与修改意图，元素 id / fileId / 子代理名不出现在社交层。 */
export function buildAgentAskDisplayMessage(title: string, op: SlidesAgentAskPayload): string {
  const instruction = op.instruction.trim().replace(/[。.!！]+$/, '')
  return `把 PPT《${title}》第 ${op.slideIndex + 1} 页选中的内容改一下：${instruction}。`
}

/** 渲染层注入事件：room 确定后由主进程广播（channel office:agent-ask）。 */
export type AgentAskForwardEvent = OfficeAgentAskEvent

let agentAskWired = false

/** 全局只装一次（幂等）：slides 弹层转发 → 反查 Room → 广播给渲染层注入对话框。 */
export function wireSlidesAgentAsk(
  target: PreparedGenOfficeRuntime,
  deps: {
    resolveInstance(wcId: number): {
      fileId: string
      title: string
      kind: string
      roomId: string | null
      workspaceId?: string | null
    } | null
    forward(event: AgentAskForwardEvent): void
  },
): void {
  if (agentAskWired) return
  target.slides.registerSlidesIpc()
  target.slides.setSlidesAgentAskHook(async (wcId, op) => {
    const instance = deps.resolveInstance(wcId)
    if (!instance) return { ok: false, error: '未找到该 PPT 对应的打开实例' }
    if (!instance.roomId) {
      return { ok: false, error: '该文件未在 Room 中打开，无法转发给 Agent（请在 Room 产物库打开后再试）' }
    }
    deps.forward({
      roomId: instance.roomId,
      ...(instance.workspaceId ? { workspaceId: instance.workspaceId } : {}),
      message: buildAgentAskMessage(instance.title, op),
      displayMessage: buildAgentAskDisplayMessage(instance.title, op),
    })
    return { ok: true }
  })
  agentAskWired = true
}

// ── 「AI 修改」转发：docs 视图里的选区浮层提交 → 工作空间对话 ──

/**
 * docs 选区浮层的载荷：宿主 word 工具按**顶层块索引**定位，不认页码/行号，
 * 所以这里只带块索引区间 + 选区类型 + 文本摘要（编辑后索引会漂移，摘要供
 * Agent 重新 read 后交叉校验）。
 */
export interface DocsAgentAskPayload {
  instruction: string
  fromBlockIndex: number
  toBlockIndex: number
  kind: 'text' | 'image' | 'chart' | 'table'
  excerpt?: string
  blockType?: string
  /** 'queue' = 攒成批注一起发；缺省立即发送。 */
  mode?: 'now' | 'queue'
}

const DOCS_ASK_KIND_LABEL: Record<DocsAgentAskPayload['kind'], string> = {
  text: '正文',
  image: '图片',
  chart: '图表',
  table: '表格',
}

function clipAskText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function describeDocsAskScope(op: DocsAgentAskPayload): string {
  const range = op.fromBlockIndex === op.toBlockIndex
    ? `第 ${op.fromBlockIndex} 块`
    : `第 ${op.fromBlockIndex}–${op.toBlockIndex} 块`
  const label = DOCS_ASK_KIND_LABEL[op.kind] ?? op.kind
  const excerpt = op.excerpt ? `「${clipAskText(op.excerpt, 40)}」` : ''
  return `${range}（${label}${excerpt}）`
}

/** 注入对话的用户消息：用户口吻的修改指令 + 给 Agent 的工具定位提示。 */
export function buildDocsAgentAskMessage(title: string, op: DocsAgentAskPayload): string {
  return (
    `请修改 Word《${title}》${describeDocsAskScope(op)}选中的内容：${op.instruction.trim()}。`
    + '先用 word_agent_read 读一次最新块索引确认目标（选中的块索引可能已因前序编辑漂移），'
    + '再用 word_agent_edit 或 word_agent_ops 只改这几块，其他内容保持不动。'
  )
}

/** 同一请求的用户可见文案：只留位置与修改意图，块索引/工具名不出现在社交层。 */
export function buildDocsAgentAskDisplayMessage(title: string, op: DocsAgentAskPayload): string {
  const instruction = op.instruction.trim().replace(/[。.!！]+$/, '')
  const where = op.fromBlockIndex === op.toBlockIndex
    ? `第 ${op.fromBlockIndex + 1} 段`
    : `第 ${op.fromBlockIndex + 1}–${op.toBlockIndex + 1} 段`
  return `把 Word《${title}》${where}选中的内容改一下：${instruction}。`
}

let docsAgentAskWired = false

/** 全局只装一次（幂等）：docs 选区浮层 → 反查工作空间 → 广播渲染层注入对话框。 */
export function wireDocsAgentAsk(
  target: PreparedGenOfficeRuntime,
  deps: {
    resolveInstance(wcId: number): {
      fileId: string
      title: string
      kind: string
      roomId: string | null
      workspaceId?: string | null
    } | null
    forward(event: AgentAskForwardEvent): void
  },
): void {
  if (docsAgentAskWired) return
  // 老 runtime（未重建 genoffice）没有这个 hook：静默跳过，浮层保持关闭。
  if (typeof target.docs.setDocsAgentAskHook !== 'function') return
  target.docs.registerDocsIpc()
  target.docs.setDocsAgentAskHook(async (wcId, op) => {
    const instance = deps.resolveInstance(wcId)
    if (!instance) return { ok: false, error: '未找到该 Word 对应的打开实例' }
    const workspaceId = instance.workspaceId ?? instance.roomId ?? null
    if (!workspaceId) {
      return { ok: false, error: '该文件未归属任何工作空间，无法转发给 Agent（请在工作空间产物库中打开后再试）' }
    }
    deps.forward({
      roomId: instance.roomId,
      workspaceId,
      ...(op.mode === 'queue' ? { mode: 'queue' as const } : {}),
      title: instance.title,
      fileId: instance.fileId,
      message: buildDocsAgentAskMessage(instance.title, op),
      displayMessage: buildDocsAgentAskDisplayMessage(instance.title, op),
    })
    return { ok: true }
  })
  docsAgentAskWired = true
}

// ── 「AI 修改」转发：sheets 选区浮层提交 → 工作空间对话 ──

/**
 * sheets 选区浮层的载荷：宿主 sheets 工具按 **sheetId + A1 区域**定位（不认工作表
 * 名），所以这里带 sheetId，区域与表名只用于文案与交叉校验。
 */
export interface SheetsAgentAskPayload {
  instruction: string
  sheetId?: string
  sheetName?: string
  range?: string
  mode?: 'now' | 'queue'
}

function describeSheetsAskScope(op: SheetsAgentAskPayload): string {
  const sheet = op.sheetName?.trim() ? `工作表「${op.sheetName.trim()}」` : '当前工作表'
  const range = op.range?.trim()
  return range ? `${sheet} ${range}` : sheet
}

/** 注入对话的用户消息：用户口吻的修改指令 + 给 Agent 的工具定位提示。 */
export function buildSheetsAgentAskMessage(title: string, op: SheetsAgentAskPayload): string {
  const sheetId = op.sheetId?.trim() ? `（sheetId=${op.sheetId.trim()}）` : ''
  return (
    `请修改 Excel《${title}》${describeSheetsAskScope(op)}${sheetId} 选中的内容：${op.instruction.trim()}。`
    + '先用 sheets_agent_read 读一次工作簿确认 sheetId 与区域，再用 sheets_agent_edit 下发'
    + ' read_range / propose_operations，只改这块区域，其他单元格保持不动。'
  )
}

/** 同一请求的用户可见文案：只留位置与修改意图，sheetId 与工具名不出现在社交层。 */
export function buildSheetsAgentAskDisplayMessage(title: string, op: SheetsAgentAskPayload): string {
  const instruction = op.instruction.trim().replace(/[。.!！]+$/, '')
  return `把 Excel《${title}》${describeSheetsAskScope(op)}选中的内容改一下：${instruction}。`
}

let sheetsAgentAskWired = false

/** 全局只装一次（幂等）：sheets 选区浮层 → 反查工作空间 → 广播渲染层注入对话框。 */
export function wireSheetsAgentAsk(
  target: PreparedGenOfficeRuntime,
  deps: {
    resolveInstance(wcId: number): {
      fileId: string
      title: string
      kind: string
      roomId: string | null
      workspaceId?: string | null
    } | null
    forward(event: AgentAskForwardEvent): void
  },
): void {
  if (sheetsAgentAskWired) return
  // 老 runtime（未重建 genoffice）没有这个 hook：静默跳过，浮层保持关闭。
  if (typeof target.sheets.setSheetsAgentAskHook !== 'function') return
  target.sheets.registerSheetsIpc()
  target.sheets.setSheetsAgentAskHook(async (wcId, op) => {
    const instance = deps.resolveInstance(wcId)
    if (!instance) return { ok: false, error: '未找到该 Excel 对应的打开实例' }
    const workspaceId = instance.workspaceId ?? instance.roomId ?? null
    if (!workspaceId) {
      return { ok: false, error: '该文件未归属任何工作空间，无法转发给 Agent（请在工作空间产物库中打开后再试）' }
    }
    deps.forward({
      roomId: instance.roomId,
      workspaceId,
      ...(op.mode === 'queue' ? { mode: 'queue' as const } : {}),
      title: instance.title,
      fileId: instance.fileId,
      message: buildSheetsAgentAskMessage(instance.title, op),
      displayMessage: buildSheetsAgentAskDisplayMessage(instance.title, op),
    })
    return { ok: true }
  })
  sheetsAgentAskWired = true
}

export interface GeneratedDocx {
  filePath: string
  bytes: Buffer
  title: string
  /** 出稿提示（模版骨架回落、自检软伤）：必须能传到面板，否则用户只看到成品、猜不到原因。 */
  warnings?: string[]
}

/** Agent 生成产物的临时落盘（导入成功后由 bridge 清理；失败保留供恢复）。 */
async function writeGeneratedTempFile(bytes: Buffer, ext: string): Promise<string> {
  const dir = join(app.getPath('temp'), 'everroom-agent-office')
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${randomUUID()}${ext}`)
  await writeFile(filePath, bytes)
  return filePath
}

/**
 * 离屏生成一份 Word：隐藏 docs view 启动为空白文档 → 渲染端 boot 消费
 * 排队的 AI 内容（受限 HTML → ProseMirror → docx）→ 静默 save-new 落到
 * GenOffice defaultSaveDir → fileSavedHook 回传路径。调用方负责导入后清理
 * 临时文件（失败时保留以便恢复）。
 */
export async function generateDocxFromHtml(
  input: { title: string; html: string },
  onPhase?: (phase: DocxGenerationPhase) => void,
): Promise<GeneratedDocx> {
  const title = input.title.trim().slice(0, 120)
  if (!title) throw new Error('文档标题不能为空')
  const { docs } = ensureRuntime()
  const view: WebContentsView = docs.createDocsView(undefined, { hostMode: 'everroom' })
  const contents = view.webContents
  const wcId = contents.id

  const cleanup = () => {
    pendingSaves.delete(wcId)
    if (!contents.isDestroyed()) {
      try { docs.teardownDocsRenderer(contents) } catch { /* already torn down */ }
      contents.close({ waitForBeforeUnload: false })
    }
  }

  try {
    const saved = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSaves.delete(wcId)
        reject(new Error('Word 文档生成超时，请重试。'))
      }, GENERATION_TIMEOUT_MS)
      pendingSaves.set(wcId, (filePath) => {
        clearTimeout(timer)
        resolve(filePath)
      })
    })
    // 同一同步块内先挂 hook 再排队内容：渲染端 boot 消费必然晚于本块。
    docs.markDocsNewBlank(wcId)
    docs.queueDocsAiContent(wcId, { title, html: input.html })
    onPhase?.('rendering')
    const filePath = await saved
    onPhase?.('saved')
    return { filePath, bytes: await readFile(filePath), title }
  } finally {
    cleanup()
  }
}

export interface GeneratedPptx {
  filePath: string
  bytes: Buffer
  title: string
  /** 页级容错警告（无效元素被丢弃等），供工具回传给模型自纠。 */
  warnings: string[]
}

/** 源论文 docx → 块大纲（论文排版映射的区间事实源）。 */
export async function describeThesisDocxBlocks(sourceBytes: Buffer) {
  const { docs } = ensureRuntime()
  return docs.describeThesisBlocks(new Uint8Array(sourceBytes))
}

/** 取一级标题的中文字体（自检抽样用；格式卡结构宽松，这里做防御式读取）。 */
function headingFontOf(card: ThesisFormatCardPayload): string | undefined {
  const headings = (card as { headings?: Array<{ level?: number; font?: { eastAsia?: string } }> }).headings ?? []
  const first = headings.find((entry) => entry.level === 1) ?? headings[0]
  return typeof first?.font?.eastAsia === 'string' ? first.font.eastAsia : undefined
}

export interface ThesisUnmatchedRange {
  start?: number
  end?: number
  label?: string
}

/**
 * 出稿自检口径：哪些未匹配区间**会**在成品里单独成「未归类内容」小节。
 *
 * start===0 的区间是论文开头（题目/摘要/说明）：两个渲染器都把它原样落在首个章节
 * 之前、故意不打「未归类」标记——那是文档本来该有的开头，标红等于把封面当成垃圾。
 * 因此自检的「报告说有未匹配、成品里却没看到小节」必须只数这些**非开头**区间，
 * 否则正常出稿会被硬伤拦下、用户拿不到文件（真实模版实测必中）。
 */
export function unmatchedRangesBeyondFront(
  spec: { unmatchedBlocks?: ThesisUnmatchedRange[] } | null | undefined,
): ThesisUnmatchedRange[] {
  const ranges = Array.isArray(spec?.unmatchedBlocks) ? spec!.unmatchedBlocks! : []
  return ranges.filter((range) => range?.start !== 0)
}

/** 论文装订：源 docx + 格式卡 + 装订规格 → 装订版 docx（主进程纯函数，无渲染端）。 */
export async function generateThesisDocx(
  input: {
    sourceBytes: Buffer
    /** 模版原文件：有则走 v3「模板骨架」装订（模版元素原位置保留）。 */
    templateBytes?: Buffer
    formatCard: ThesisFormatCardPayload
    bindingSpec: ThesisBindingSpecPayload
    /** false = 不回填模版 Logo（规则面板勾选项）。 */
    keepLogo?: boolean
  },
  onPhase?: (phase: DocxGenerationPhase) => void,
): Promise<GeneratedDocx> {
  const title = (input.bindingSpec.title || input.bindingSpec.coverFields.title || '论文').trim().slice(0, 120)
  const { docs } = ensureRuntime()
  onPhase?.('rendering')
  // v3：以模版为底装订——封面/核心信息区/表格/教师评价表/目录按模版原位置透传，
  // 只替换内容槽位。没有模版字节（老格式卡）时回落 v2 的重建路径。
  const templateBytes = input.templateBytes
  const canUseTemplateSkeleton = Boolean(templateBytes && templateBytes.length > 0)
    && typeof docs.buildThesisDocxOnTemplate === 'function'
  let usedTemplateSkeleton = false
  /** v3 失败原因：透出到 warnings，让面板提示「为什么退回了内容重建」。 */
  let skeletonFallbackReason: string | null = null
  /** v3 成功但没匹配到任何章节锚点时的诊断说明（模版原样保留、正文追加文末）。 */
  let skeletonDiagnosticNote: string | null = null
  let bytes: Uint8Array
  if (canUseTemplateSkeleton) {
    try {
      const skeleton = await docs.buildThesisDocxOnTemplate({
        templateBytes: new Uint8Array(templateBytes!),
        sourceBytes: new Uint8Array(input.sourceBytes),
        card: input.formatCard,
        spec: input.bindingSpec,
      })
      bytes = skeleton.bytes
      usedTemplateSkeleton = true
      // 锚点一个都没命中：**不再回落 v2**。v2 会按内容重建封面/目录，把模版里
      // 核心信息区下方的表格、教师评价表搬到别处——这正是用户反复反馈的问题。
      // 模版原样透传 + 正文追加文末虽然版式不完美，但模版元素位置 100% 不动。
      if (skeleton.diagnostics.templateFirstDowngraded) {
        // 「模版只有目录、正文没有章节标题」这类模版：骨架排版降级为内容重建。
        // 必须说清楚原因和出路，否则用户只会看到「排版结果不像模版」。
        skeletonDiagnosticNote = '模版正文里没有可识别的章节标题（常见于「只有目录 + 格式说明」的模版），'
          + '本次已按论文内容重建排版；用 Word/WPS 给模版正文的「第一章」等标题套用「标题1/标题2」样式后重新导入，'
          + '即可按模版骨架排版'
      } else if (skeleton.diagnostics.appendedOnly) {
        skeletonDiagnosticNote = `模版章节骨架未识别（slots=${skeleton.diagnostics.slots}，`
          + `候选=${skeleton.diagnostics.anchors}，正文区起点=${skeleton.diagnostics.bodyStart}，`
          + `章节=${skeleton.diagnostics.chapters}），模版表格与表单位置已原样保留，`
          + '论文正文已追加到文末；重新导入一次模版可让排版重新识别章节位置'
      }
    } catch (error) {
      // 真正的异常（文件损坏、OOXML 不可解析）才回落 v2，否则宁可给「模版原样 + 正文追加」。
      console.warn('[thesis] 模板骨架装订失败，回落内容重建', error)
      skeletonFallbackReason = error instanceof Error ? error.message : String(error)
      bytes = await docs.buildThesisDocx(
        new Uint8Array(input.sourceBytes),
        input.formatCard,
        input.bindingSpec,
      )
    }
  } else {
    bytes = await docs.buildThesisDocx(
      new Uint8Array(input.sourceBytes),
      input.formatCard,
      input.bindingSpec,
    )
  }
  // 模版页眉的校徽 logo 回填：装订是「重排版」，页眉部件由引擎新生成，
  // 模版页眉图片不会自动带入——这里从格式卡的 header.images 原样写回。
  // v3 模板骨架装订不需要回填：模版的页眉/封面部件本来就原样保留，再补一次
  // 会在同一页出现两个 logo。
  const keepLogo = input.keepLogo !== false && !usedTemplateSkeleton
  const headerImages = keepLogo ? input.formatCard.header?.images : undefined
  if (Array.isArray(headerImages) && headerImages.length > 0) {
    try {
      bytes = await backfillThesisHeaderLogos(bytes, headerImages)
    } catch (error) {
      // 回填失败不阻断出稿，但要在 warnings 通道可见——挂到控制台与广播 phase
      console.warn('[thesis] 页眉 logo 回填失败', error)
    }
  }
  // 模版封面上的校徽/校名标识：装订重建封面不会带入，这里补到正文最前。
  const coverLogo = keepLogo ? (input.formatCard.cover as { logo?: Record<string, unknown> } | undefined)?.logo : undefined
  if (coverLogo) {
    try {
      bytes = await backfillThesisCoverLogo(bytes, coverLogo)
    } catch (error) {
      console.warn('[thesis] 封面 logo 回填失败', error)
    }
  }
  // 出稿前自检（方案 §7.3）：logo 字节、页眉页脚、目录域、未归类小节、标题字体。
  // 硬伤直接抛错——宁可不给文件，也不给一个"看起来正常"的假货；软伤进 warnings。
  const selfCheck = await selfCheckThesisDocx(bytes, {
    expectLogos: [
      ...(Array.isArray(headerImages) ? headerImages.map((image, index) => ({ role: `header#${index}`, dataUrl: String((image as { dataUrl?: unknown }).dataUrl ?? '') })) : []),
      ...(coverLogo ? [{ role: 'cover', dataUrl: String(coverLogo.dataUrl ?? '') }] : []),
    ].filter((entry) => entry.dataUrl.startsWith('data:image/')),
    // v3 模板骨架装订：页眉页脚/目录都是模版自己的部件，原样保留，不按卡片声明核对
    // （卡片声明与模版部件不一致时那是解析问题，不该把好文件判成硬伤）。
    headerEnabled: usedTemplateSkeleton ? false : input.formatCard.header?.enabled === true,
    footerEnabled: usedTemplateSkeleton ? false : input.formatCard.footer?.enabled === true,
    tocEnabled: (input.formatCard.toc as { enabled?: boolean } | undefined)?.enabled === true,
    // 只有「真正没地方放」的区间才会在成品里出现「未归类内容」小节。
    // start===0 的是论文开头（题目/摘要/说明）：两个渲染器都把它落在首个章节之前、
    // 故意不打「未归类」标记（打上去等于把封面标题标成垃圾）。用「有未匹配块」当
    // 判据会把这种正常出稿判成硬伤——实测真实论文必中，用户拿不到任何文件。
    expectUnmatchedSection: unmatchedRangesBeyondFront(input.bindingSpec).length > 0,
    ...(headingFontOf(input.formatCard) ? { expectHeadingFont: headingFontOf(input.formatCard)! } : {}),
  })
  if (!selfCheck.ok) {
    throw new Error(`论文排版自检未通过：${selfCheck.failures.join('；')}`)
  }
  if (selfCheck.warnings.length > 0) {
    console.warn('[thesis] 自检提示', selfCheck.warnings)
  }
  // 回落提示排在前面：用户先要知道「模版骨架没用上」，再看其它细节提示。
  const warnings = [
    ...(skeletonFallbackReason
      ? [`模版结构未识别（${skeletonFallbackReason}），已按内容重建排版，请检查模版是否含可识别的章节标题`]
      : []),
    ...(skeletonDiagnosticNote ? [skeletonDiagnosticNote] : []),
    ...selfCheck.warnings,
  ]

  onPhase?.('saved')
  return {
    filePath: await writeGeneratedTempFile(Buffer.from(bytes), '.docx'),
    bytes: Buffer.from(bytes),
    title,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * 离屏生成一份 PPT：页 spec JSON（1280×720 PageSpec，LLM 直接输出）经
 * fork 导出的 buildAgentDeckPptx 在主进程本地拼装——无渲染端、无会话。
 */
export async function generatePptxFromPageSpecs(
  input: { title: string; pages: string[] },
  onPhase?: (phase: DocxGenerationPhase) => void,
  imageResolver?: GenOfficeMaterialResolver,
): Promise<GeneratedPptx> {
  const title = input.title.trim().slice(0, 120)
  if (!title) throw new Error('演示标题不能为空')
  const pages = Array.isArray(input.pages) ? input.pages : []
  if (pages.length === 0) throw new Error('至少需要一页幻灯片')
  const { slides } = ensureRuntime()
  onPhase?.('rendering')
  const built = await slides.buildAgentDeckPptx(pages, imageResolver)
  if (!built.ok) throw new Error(`PPT 生成失败：${built.error}`)
  onPhase?.('saved')
  const bytes = Buffer.from(built.deck.bytes)
  const warnings = built.deck.warnings.map(({ page, messages }) => `第 ${page} 页：${messages.join('；')}`)
  for (const failure of built.deck.imageFailures) {
    warnings.push(`第 ${failure.page} 页图片 ${failure.url} 下载失败，已跳过`)
  }
  return { filePath: await writeGeneratedTempFile(bytes, '.pptx'), bytes, title, warnings }
}

export interface GeneratedXlsx {
  filePath: string
  bytes: Buffer
  title: string
}

/** 生成一份 Excel：LLM 输出的 sheets→rows JSON 直接拼标准 OOXML（jszip）。 */
export async function generateXlsxFromSheets(
  input: { title: string; sheets: AgentSheetInput[] },
  onPhase?: (phase: DocxGenerationPhase) => void,
): Promise<GeneratedXlsx> {
  const title = input.title.trim().slice(0, 120)
  if (!title) throw new Error('表格标题不能为空')
  onPhase?.('rendering')
  const bytes = await buildAgentXlsxBytes(input.sheets)
  onPhase?.('saved')
  return { filePath: await writeGeneratedTempFile(bytes, '.xlsx'), bytes, title }
}
