import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'
import type { WebContents, WebContentsView } from 'electron'

import { loadPreparedGenOfficeRuntime, type PreparedGenOfficeRuntime } from './office-runtime'
import { buildAgentXlsxBytes, type AgentSheetInput } from './xlsx-generation'

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

export interface GeneratedDocx {
  filePath: string
  bytes: Buffer
  title: string
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

/**
 * 离屏生成一份 PPT：页 spec JSON（1280×720 PageSpec，LLM 直接输出）经
 * fork 导出的 buildAgentDeckPptx 在主进程本地拼装——无渲染端、无会话。
 */
export async function generatePptxFromPageSpecs(
  input: { title: string; pages: string[] },
  onPhase?: (phase: DocxGenerationPhase) => void,
): Promise<GeneratedPptx> {
  const title = input.title.trim().slice(0, 120)
  if (!title) throw new Error('演示标题不能为空')
  const pages = Array.isArray(input.pages) ? input.pages : []
  if (pages.length === 0) throw new Error('至少需要一页幻灯片')
  const { slides } = ensureRuntime()
  onPhase?.('rendering')
  const built = await slides.buildAgentDeckPptx(pages)
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
