/**
 * 记忆 / RAG 检索的工具侧解析。
 *
 * 现状（2026-10 归档实测）：检索类工具（memory_search / conversation_search /
 * wiki_search / screen_memory_search）**不透出相似度得分**，召回内容以纯文本
 * （`result.content[0].text`）或 `result.details.<array>` 返回。因此：
 * - 有结构化条目就按条目展示（score 缺失记为 null，UI 显示「未透出」）；
 * - 只有文本就按行/段落切成片段，并明确标注「文本召回」。
 * 绝不伪造 similarity。
 */
import type { RetrievedChunk } from './types'

/** 参与「RAG 检索洞察」的工具名（其它工具走普通工具分析）。 */
export const RETRIEVAL_TOOLS: ReadonlySet<string> = new Set([
  'memory_search',
  'conversation_search',
  'wiki_search',
  'screen_memory_search',
])

export function isRetrievalTool(name: string | null | undefined): boolean {
  if (!name) return false
  return RETRIEVAL_TOOLS.has(name)
}

/** 检索式：按优先级抽第一个非空字符串参数（query/q/keyword/text/pattern/...）。 */
const QUERY_KEYS = ['query', 'q', 'keyword', 'keywords', 'search', 'text', 'pattern', 'name', 'room_id']

export function extractQuery(args: unknown): string {
  if (typeof args === 'string') return clampQuery(args)
  if (!args || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of QUERY_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return clampQuery(value)
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === 'string').join(' ')
      if (joined.trim()) return clampQuery(joined)
    }
  }
  const firstString = Object.values(record).find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  return firstString ? clampQuery(firstString) : ''
}

function clampQuery(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 120)}…` : compact
}

function textOf(result: unknown): string {
  if (typeof result === 'string') return result
  if (!result || typeof result !== 'object') return ''
  const content = (result as Record<string, unknown>).content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const item of content) {
      if (item && typeof item === 'object') {
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string') parts.push(text)
      } else if (typeof item === 'string') {
        parts.push(item)
      }
    }
    if (parts.length > 0) return parts.join('\n')
  }
  const record = result as Record<string, unknown>
  for (const key of ['text', 'message', 'result']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function detailsOf(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as Record<string, unknown>).details
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null
}

/** details 里可能装条目的数组字段（顺序即优先级）。 */
const DETAIL_ARRAY_KEYS = ['items', 'results', 'matches', 'hits', 'chunks', 'documents', 'wikis', 'memories', 'records']

function pickNumber(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function pickString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

function chunkFromItem(item: unknown, index: number): RetrievedChunk | null {
  if (typeof item === 'string') {
    const text = item.trim()
    return text ? { id: `chunk-${index}`, source: '文本召回', score: null, preview: clampPreview(text), chars: text.length } : null
  }
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const preview = pickString(record, ['text', 'content', 'snippet', 'summary', 'body', 'description', 'title', 'name', 'path'])
  if (!preview) return null
  const source = pickString(record, ['source', 'title', 'name', 'path', 'documentTitle', 'roomId', 'sessionId', 'id'])
  const score = pickNumber(record, ['score', 'similarity', 'relevance', 'distance'])
  return {
    id: pickString(record, ['id', 'chunkId']) || `chunk-${index}`,
    source: source || '未知来源',
    score,
    preview: clampPreview(preview),
    chars: preview.length,
  }
}

function clampPreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact
}

/** 把纯文本召回切成片段：优先按「- 」项目符号，其次按空行，再退化按行。 */
function chunksFromText(text: string): RetrievedChunk[] {
  const body = text.trim()
  if (!body) return []
  const bulletSplit = body.split(/\n(?=\s*[-*•]\s)/).map((part) => part.trim()).filter(Boolean)
  const blocks = bulletSplit.length > 1
    ? bulletSplit
    : body.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const source = blocks.length === 1 ? '整段召回' : '文本召回'
  return blocks.slice(0, 8).map((block, index) => ({
    id: `text-${index}`,
    source,
    score: null,
    preview: clampPreview(block),
    chars: block.length,
  }))
}

export interface RetrievalExtract {
  hitCount: number | null
  chunks: RetrievedChunk[]
  /** 命中数是否来自结构化 details（true）还是文本行数估算（false）。 */
  counted: boolean
}

/** 从检索工具的返回值里抽「召回了几条 + 每条的来源/得分/片段」。 */
export function extractRetrieval(result: unknown): RetrievalExtract {
  const details = detailsOf(result)
  let list: unknown[] | null = null
  if (details) {
    for (const key of DETAIL_ARRAY_KEYS) {
      const value = details[key]
      if (Array.isArray(value) && value.length > 0) {
        list = value
        break
      }
    }
  }
  if (list) {
    const chunks = list.map(chunkFromItem).filter((chunk): chunk is RetrievedChunk => chunk !== null)
    const declared = details ? pickNumber(details, ['count', 'total', 'hitCount', 'n']) : null
    return { hitCount: declared ?? chunks.length, chunks, counted: declared !== null }
  }

  const text = textOf(result)
  const chunks = chunksFromText(text)
  const declared = details ? pickNumber(details, ['count', 'total', 'hitCount', 'n']) : null
  if (declared !== null) return { hitCount: declared, chunks, counted: true }
  // 文本方案：只数「- 」项目符号，没有就不猜条数。
  const bulletCount = text.split('\n').filter((line) => /^\s*[-*•]\s/.test(line)).length
  return { hitCount: bulletCount > 0 ? bulletCount : null, chunks, counted: false }
}
