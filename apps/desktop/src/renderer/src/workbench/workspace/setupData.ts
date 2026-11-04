/**
 * 新建空间引导（SetupWizard）的数据层：导入结果归一 + 本地 id + 错误文案。
 *
 * 归一函数一律接受 `unknown`：真实桥、浏览器 mock（形状可能不同）与桥缺失都可能
 * 传进来，任何异常形状都要降级成空结果而不是让引导崩掉。
 */

/* ───────────────── 通用取值工具 ───────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** 本地唯一 id（引导里的结果行 key；不依赖 crypto.randomUUID，旧渲染环境也能跑）。 */
export function createLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/* ───────────────── 引导：导入结果归一 ───────────────── */

export interface ImportOutcomeView {
  filename: string
  ok: boolean
  skipped: boolean
  error: string | null
}

/**
 * 把 `files.pickAndImport()` 的返回值归一成逐文件结果。
 * 真实返回 `FileImportOutcome[]`；浏览器 mock/桥异常可能返回对象，一律降级为空。
 */
export function normalizeImportOutcomes(raw: unknown): ImportOutcomeView[] {
  if (!Array.isArray(raw)) return []
  const outcomes: ImportOutcomeView[] = []
  for (const item of raw) {
    const record = asRecord(item)
    if (!record) continue
    const filename = asString(record.filename) ?? asString(record.originalName) ?? '未命名文件'
    const error = asString(record.error)
    const skippedReason = asString(record.skippedReason)
    const hasFileId = typeof record.fileId === 'string' && record.fileId.length > 0
    const ok = !error && (hasFileId || Boolean(skippedReason))
    outcomes.push({
      filename,
      ok,
      skipped: Boolean(skippedReason) || record.deduped === true,
      error,
    })
  }
  return outcomes
}

export interface ImportSummary {
  total: number
  succeeded: number
  failed: number
  skipped: number
}

export function summarizeImportOutcomes(outcomes: readonly ImportOutcomeView[]): ImportSummary {
  return outcomes.reduce<ImportSummary>(
    (summary, outcome) => ({
      total: summary.total + 1,
      succeeded: summary.succeeded + (outcome.ok ? 1 : 0),
      failed: summary.failed + (outcome.ok ? 0 : 1),
      skipped: summary.skipped + (outcome.skipped ? 1 : 0),
    }),
    { total: 0, succeeded: 0, failed: 0, skipped: 0 },
  )
}

/* ───────────────── 错误文案 ───────────────── */

/** 桥抛出的错误转成可读文案（Electron 的 invoke 错误带 Error.message）。 */
export function bridgeErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}