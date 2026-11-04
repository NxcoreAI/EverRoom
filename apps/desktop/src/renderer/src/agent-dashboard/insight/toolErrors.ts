/**
 * 工具错误自动归类。
 *
 * 埋点里的失败信息是原始文本（`tool.failed.payload.result`，可能是 MCP 风格
 * `{content:[{type:'text',text}],details}`，也可能直接是字符串），看板需要在没有
 * 统一错误码的前提下尽量把「参数写错 / 超时 / 上游挂了 / 没权限」分开，否则
 * 3000 次失败在表里只是一片红。归类规则是纯文本启发式，宁可归到 other 也不硬猜。
 */
import type { ToolErrorClass } from './types'

export interface ErrorClassification {
  errorClass: ToolErrorClass
  /** 给 UI 的中文标签（短，可直接放进表格单元格）。 */
  label: string
  /** 从错误文本里抽出的首行结论（压缩换行，最多 160 字）。 */
  summary: string
}

const LABELS: Record<ToolErrorClass, string> = {
  arg_validation: '参数校验失败',
  timeout: '超时',
  not_found: '目标不存在',
  auth: '权限/认证',
  rate_limit: '限流',
  upstream: '上游 5xx',
  cancelled: '被取消',
  runtime: '运行时异常',
  other: '其它',
}

/** 判定顺序重要：参数校验 → 超时 → 认证 → 限流 → 上游 → 不存在 → 取消。 */
const RULES: ReadonlyArray<{ errorClass: ToolErrorClass; pattern: RegExp }> = [
  {
    errorClass: 'arg_validation',
    pattern: /validation failed|must have required|invalid (arguments?|params?|input)|argument .*(invalid|missing)|schema .*(invalid|fail)|content_invalid|result_invalid|invalid (result|content|payload|field)|zod|unexpected token .*json|is not valid json/i,
  },
  { errorClass: 'timeout', pattern: /timed? ?out|timeout|etimedout|deadline exceeded|exceeded .*time/i },
  { errorClass: 'auth', pattern: /\b(401|403)\b|unauthori[sz]ed|forbidden|permission denied|invalid api key|no permission|insufficient (scope|privilege)/i },
  { errorClass: 'rate_limit', pattern: /\b429\b|rate ?limit|too many requests|quota exceeded|overloaded/i },
  { errorClass: 'upstream', pattern: /\b5\d\d\b|bad gateway|service unavailable|internal server error|upstream|relay session is not active|econnreset|socket hang up/i },
  { errorClass: 'not_found', pattern: /\b404\b|not found|enoent|no such (file|document|room)|unknown (tool|document)/i },
  { errorClass: 'cancelled', pattern: /cancel|abort(ed)?\b|interrupted|stopped by user/i },
  { errorClass: 'runtime', pattern: /typeerror|referenceerror|is not a function|cannot read propert|undefined is not|unhandled/i },
]

/** 命中第一条规则即归类；都不命中给 other。 */
export function classifyErrorText(text: string): ToolErrorClass {
  if (!text) return 'other'
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.errorClass
  }
  return 'other'
}

/** 把任意 payload 压成一段可搜索的错误文本（保留前 4000 字符）。 */
export function errorTextOf(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result.slice(0, 4000)
  if (typeof result === 'object') {
    const record = result as Record<string, unknown>
    const content = record.content
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const item of content) {
        if (item && typeof item === 'object') {
          const text = (item as Record<string, unknown>).text
          if (typeof text === 'string') parts.push(text)
          continue
        }
        if (typeof item === 'string') parts.push(item)
      }
      if (parts.length > 0) return parts.join('\n').slice(0, 4000)
    }
    for (const key of ['message', 'error', 'detail', 'reason']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.slice(0, 4000)
    }
    try {
      return JSON.stringify(result).slice(0, 4000)
    } catch {
      return ''
    }
  }
  return String(result).slice(0, 4000)
}

/**
 * 错误摘要：优先抽 JSON 里的 message/error 字段（工具失败常带一段被序列化的 JSON），
 * 否则取首行；去掉 `error :` 之类的键名噪音，压缩空白，最长 160 字。
 */
export function errorSummaryOf(text: string): string {
  const messageMatch = /"(?:message|error|detail|reason)"\s*:\s*"((?:\\.|[^"\\]){4,})"/.exec(text)
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const candidate = messageMatch ? messageMatch[1] : (lines[0] ?? '')
  const compact = candidate
    .replace(/\\[nrt]/g, ' ')
    .replace(/^error\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact
}

export function classifyToolError(result: unknown): ErrorClassification {
  const text = errorTextOf(result)
  const errorClass = classifyErrorText(text)
  return { errorClass, label: LABELS[errorClass], summary: errorSummaryOf(text) }
}

export function errorClassLabel(errorClass: ToolErrorClass): string {
  return LABELS[errorClass]
}

/** 覆盖率最高的错误类（工具统计卡片的「主要失败原因」）。 */
export function dominantErrorClass(
  classes: Partial<Record<ToolErrorClass, number>> | null | undefined,
): ToolErrorClass | null {
  if (!classes) return null
  let best: ToolErrorClass | null = null
  let bestCount = 0
  for (const [key, count] of Object.entries(classes)) {
    if (typeof count !== 'number' || count <= bestCount) continue
    best = key as ToolErrorClass
    bestCount = count
  }
  return best
}
