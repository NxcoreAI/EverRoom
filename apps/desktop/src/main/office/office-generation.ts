import { readFile } from 'node:fs/promises'

import type { WebContentsView } from 'electron'

import { loadPreparedGenOfficeRuntime, type PreparedGenOfficeRuntime } from './office-runtime'

/** 生成卡死兜底：渲染端 boot → 填充 → 静默保存正常在秒级完成。 */
const GENERATION_TIMEOUT_MS = 3 * 60_000

let runtime: PreparedGenOfficeRuntime | null = null
let hookWired = false

// setDocsFileSavedHook 是全局单槽位：按 webContents id 扇出给并发生成请求。
const pendingSaves = new Map<number, (filePath: string) => void>()

/** 生成阶段（渲染层做进度提示用）：视图就绪 → 落盘。 */
export type DocxGenerationPhase = 'rendering' | 'saved'

function ensureRuntime(): PreparedGenOfficeRuntime {
  runtime ??= loadPreparedGenOfficeRuntime()
  if (!hookWired) {
    // registerDocsIpc 自带进程级幂等守卫，与 Office 预览共存安全。
    runtime.docs.registerDocsIpc()
    runtime.docs.setDocsFileSavedHook((contents, filePath) => {
      const resolve = pendingSaves.get(contents.id)
      if (resolve) {
        pendingSaves.delete(contents.id)
        resolve(filePath)
      }
    })
    hookWired = true
  }
  return runtime
}

export interface GeneratedDocx {
  filePath: string
  bytes: Buffer
  title: string
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
