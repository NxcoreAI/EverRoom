import { basename, extname, resolve } from 'node:path'

import type { OsOpenedDocument } from '../../shared/office'

/**
 * 系统文件管理器（访达「打开方式」/ 资源管理器双击）直接交给 EverOffice 的格式。
 * 与 `package.json` 的 `build.mac.extendInfo.CFBundleDocumentTypes` /
 * `build.win.fileAssociations`、`shared/sources.ts` 的 `officePreviewKindForFileName`
 * 保持一致：这里只登记内嵌预览能打开的格式，旧版 .doc/.xls/.ppt 依赖本机
 * LibreOffice 转换，转换失败会回退系统默认应用。
 */
export const OS_OPEN_DOCUMENT_EXTENSIONS = [
  '.docx', '.doc',
  '.xlsx', '.xls', '.xlsm',
  '.pptx', '.ppt',
  '.md', '.markdown',
] as const

/** 单个 argv 项是否是可以交给 EverOffice 打开的文档路径（排除以 - 开头的开关）。 */
export function isOsOpenDocumentPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.startsWith('-')) return false
  return (OS_OPEN_DOCUMENT_EXTENSIONS as readonly string[]).includes(extname(value).toLowerCase())
}

/**
 * 从启动参数里挑出文档路径：Windows/Linux 双击文件时由系统把路径塞进 argv；
 * macOS 走 `open-file` 事件（argv 里只有 -psn_* 之类的开关，会被过滤掉）。
 * 按绝对路径去重，保留用户给的相对写法。
 */
export function osOpenPathsFromArgv(argv: readonly string[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const argument of argv) {
    if (!isOsOpenDocumentPath(argument)) continue
    const key = resolve(argument)
    if (seen.has(key)) continue
    seen.add(key)
    paths.push(argument)
  }
  return paths
}

/**
 * 系统打开请求的串行队列：macOS 可能在 `app.whenReady()` 之前就派发 open-file，
 * 而导入 + 打开预览要等网关与文件桥就绪，所以先排队，处理器装好后再按序排空。
 */
export class OsOpenQueue {
  private readonly pending: string[] = []
  private handler: ((filePath: string) => Promise<void>) | null = null
  private draining = false

  /** 入队（按绝对路径去重）；处理器未就绪时只排不跑。 */
  push(...paths: readonly string[]): void {
    for (const filePath of paths) {
      const resolved = resolve(filePath)
      if (this.pending.some((queued) => resolve(queued) === resolved)) continue
      this.pending.push(filePath)
    }
    void this.drain()
  }

  /** 装处理器（启动链里文件桥就位后调用）：已排队的请求立即开跑。 */
  setHandler(handler: (filePath: string) => Promise<void>): void {
    this.handler = handler
    void this.drain()
  }

  /** 队列长度（诊断/测试用）。 */
  get size(): number {
    return this.pending.length
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    const handler = this.handler
    if (!handler) return
    this.draining = true
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift()!
        try {
          await handler(next)
        } catch (error) {
          console.error('[os-open] failed to open document from the system file manager', next, error)
        }
      }
    } finally {
      this.draining = false
    }
  }
}

/** 文件库导入结果里本模块关心的字段（FileImportOutcome 的子集，便于测试注入）。 */
export interface SystemOpenOutcome {
  fileId: string | null
  filename: string
  error: string | null
  skippedReason: 'unsupported_format' | 'pending_review' | null
}

/** 系统打开失败的原因：由宿主决定提示文案（主进程用原生弹窗 + 本地化文案）。 */
export type SystemOpenFailure =
  | { kind: 'service_unavailable' }
  | { kind: 'unsupported_format' }
  | { kind: 'error'; message: string }

export interface SystemOpenHandlers {
  /** 导入文件库；null = 文件服务尚未就绪。抛错 = 导入失败。 */
  importFile: (filePath: string) => Promise<SystemOpenOutcome | null>
  /** 导入成功：交给渲染层用内嵌 Office 预览打开。 */
  open: (document: OsOpenedDocument) => void
  fail: (name: string, failure: SystemOpenFailure) => void
}

/**
 * 访达/资源管理器打开一个 Word/Excel/PPT 的主流程：导入文件库（同路径重入命中
 * 同一 entry，版本级去重）→ 交给渲染层打开。失败一律经 fail 回调，绝不抛出，
 * 保证同一批排队的后续文件不被一个坏文件卡住。
 */
export async function openDocumentFromSystem(
  filePath: string,
  handlers: SystemOpenHandlers,
): Promise<void> {
  const name = basename(filePath)
  let outcome: SystemOpenOutcome | null
  try {
    outcome = await handlers.importFile(filePath)
  } catch (error) {
    handlers.fail(name, { kind: 'error', message: error instanceof Error ? error.message : String(error) })
    return
  }
  if (outcome === null) {
    handlers.fail(name, { kind: 'service_unavailable' })
    return
  }
  if (!outcome.fileId) {
    if (outcome.skippedReason === 'unsupported_format') {
      handlers.fail(name, { kind: 'unsupported_format' })
      return
    }
    handlers.fail(name, { kind: 'error', message: outcome.error ?? '' })
    return
  }
  handlers.open({ fileId: outcome.fileId, originalName: outcome.filename || name })
}
