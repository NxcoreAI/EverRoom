import type { DisplayAgentToolCall } from './agentRunActivity'

/**
 * 「本轮产生的关键文件」解析：从 run 的工具调用结果里提取本轮生成的 Office 产物
 * （Word / Excel / PPT / PDF / Markdown），按 DSH 的产物卡样式展示在 assistant 正文下方。
 *
 * 数据来源是工具调用的结构化结果（fileEntryId + originalName/format），不依赖
 * office:agent-file 广播——广播是全局扇出的，无法归属到具体某轮对话；工具结果
 * 天然带 runId，恢复会话（事件回放）时也齐全。
 *
 * slides_draft 的产物不在此列：SlidesProgressCard 已是该链路专属的任务卡
 * （进度 + 打开成品入口），再出一张文件卡只会重复。
 */

/** 一条文件产物（解析自工具结果，只保留展示必需的字段）。 */
export interface AgentTurnFile {
  /** file_entries 条目 id（打开文件用）。 */
  fileEntryId: string
  /** 展示名（originalName；生成类工具有，导出 PDF 用 originalName）。 */
  name: string
  /** 文件格式（决定图标；缺省按扩展名推断）。 */
  format: 'docx' | 'pptx' | 'xlsx' | 'pdf' | 'md'
  /** 产生方式（决定副文案）：created = 新生成，exported = 从已有文件导出。 */
  origin: 'created' | 'exported'
}

/** 解析后的整轮文件列表：按完成时间升序（先完成的在前），同 fileId 去重（取首次）。 */
export type AgentTurnFiles = AgentTurnFile[]

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * 工具结果根候选：与 agentNavigation 同一套口径。
 * 渲染层收到的 tool.completed 载荷里，结构化结果在 details（pi 的 ToolResult
 * details 字段）；content 是 JSON 字符串（success() 的序列化形态）。
 */
function resultCandidates(result: unknown): Record<string, unknown>[] {
  const root = record(result)
  if (!root) return []
  const candidates: Record<string, unknown>[] = []
  const contentText = Array.isArray(root.content)
    ? root.content.map((item) => record(item)).find((item) => typeof item?.text === 'string')?.text
    : undefined
  for (const value of [root, root.details, root.structuredContent, contentText]) {
    const candidate = record(value)
    if (candidate) candidates.push(candidate)
  }
  return candidates
}

function formatFromExtension(name: string): AgentTurnFile['format'] | null {
  if (/\.docx?$/i.test(name)) return 'docx'
  if (/\.pptx?$/i.test(name)) return 'pptx'
  if (/\.xlsx?$/i.test(name)) return 'xlsx'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (/\.md$/i.test(name)) return 'md'
  return null
}

function normalizeFormat(value: unknown, name: string): AgentTurnFile['format'] | null {
  if (value === 'docx' || value === 'pptx' || value === 'xlsx' || value === 'pdf' || value === 'md') return value
  return formatFromExtension(name)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** 从单个候选记录提取文件产物；无有效条目返回 null。 */
function fileFromRecord(candidate: Record<string, unknown>, origin: AgentTurnFile['origin']): AgentTurnFile | null {
  // word_export_pdf 的 id 字段叫 fileId（不是 fileEntryId）。
  const fileEntryId = text(candidate.fileEntryId) ?? text(candidate.fileId)
  if (!fileEntryId) return null
  const name = text(candidate.originalName) ?? text(candidate.fileName) ?? text(candidate.title)
  if (!name) return null
  const format = normalizeFormat(candidate.format, name)
  if (!format) return null
  return { fileEntryId, name, format, origin }
}

/**
 * 已知会产出文件的网关工具 → 产出方式。
 * 与 office-plugin / subagents 工具面的名字对齐；旧数据里 context_room_ 前缀
 * 的同名工具也认（渲染层 agentRunActivity 保留旧映射的原因相同）。
 */
const CREATING_TOOLS = new Set([
  'office_create',
  'markdown_create',
  'sheets_create',
  'slides_create',
  'context_room_office_create',
  'context_room_sheets_create',
  'context_room_slides_create',
])

const EXPORTING_TOOLS = new Set(['word_export_pdf'])

/** 候选记录 → 文件列表：同一结果的不同候选形态（details/structuredContent/
 *  content JSON）会命中同一文件，按 fileEntryId 去重取首个。 */
function filesFromCandidates(
  result: unknown,
  origin: AgentTurnFile['origin'],
): AgentTurnFile[] {
  const byId = new Map<string, AgentTurnFile>()
  for (const candidate of resultCandidates(result)) {
    const file = fileFromRecord(candidate, origin)
    if (file && !byId.has(file.fileEntryId)) byId.set(file.fileEntryId, file)
  }
  return [...byId.values()]
}

/** 单个工具调用产出的文件（非产出型工具为空数组）。
 *  逐工具缓存：会话每帧重扫全部工具调用，结果 JSON 解析很贵；工具对象转终态
 *  后不再重建（与 agentNavigation 的 navigationTargetCache 同一模式）。 */
const turnFilesCache = new WeakMap<DisplayAgentToolCall, AgentTurnFile[]>()

export function toolTurnFiles(tool: DisplayAgentToolCall): AgentTurnFile[] {
  const cached = turnFilesCache.get(tool)
  if (cached) return cached
  const files = computeToolTurnFiles(tool)
  turnFilesCache.set(tool, files)
  return files
}

function computeToolTurnFiles(tool: DisplayAgentToolCall): AgentTurnFile[] {
  if (tool.status !== 'completed') return []
  const name = tool.name.toLowerCase()
  // slides_draft 的成品由 SlidesProgressCard 承载（进度 + 打开），不重复出卡。
  if (name === 'slides_draft') return []
  if (CREATING_TOOLS.has(name)) return filesFromCandidates(tool.result, 'created')
  if (EXPORTING_TOOLS.has(name)) return filesFromCandidates(tool.result, 'exported')
  return []
}

/**
 * 汇总一个 run 的全部文件产物：
 * - 只看已完成工具（失败/中止的生成没有可信条目）；
 * - 同 fileId 去重（编辑链路重生成同 id 只留最新一次，按工具时间序覆盖）；
 * - 按完成时间升序排（与产物落库顺序一致，先出的文件排前面）。
 */
export function agentTurnFilesFromTools(tools: DisplayAgentToolCall[]): AgentTurnFiles {
  const byId = new Map<string, AgentTurnFile>()
  const ordered: DisplayAgentToolCall[] = [...tools].sort((left, right) => (
    Date.parse(left.completedAt ?? left.startedAt) - Date.parse(right.completedAt ?? right.startedAt)
  ))
  for (const tool of ordered) {
    for (const file of toolTurnFiles(tool)) {
      byId.set(file.fileEntryId, file)
    }
  }
  return [...byId.values()]
}
