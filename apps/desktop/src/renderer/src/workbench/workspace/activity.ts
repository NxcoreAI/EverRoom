import type { AgentEvent, AgentSession } from '@nxcore/agent-contract'

import type { RealOfficeFile } from '@/office-proto/data'

/**
 * 工作空间概览页的派生数据。
 *
 * 后端没有「动态」「洞察」实体（见 `docs/design/product-data-map.zh-CN.md` §9）：
 * - 动态 = 本空间 sessions + 文件库条目按时间合并的倒序时间线；
 * - 洞察 = 最近更新会话的最后一条 assistant 文本（消息快照优先，run 事件兜底）。
 *
 * 这里全部是纯函数，页面渲染与单测共用，不在渲染层写 mock 文案。
 */

export type ActivityKind =
  | 'session-created'
  | 'session-run'
  | 'session-done'
  | 'session-updated'
  | 'file-generated'
  | 'file-added'

export type ActivityTarget =
  | { type: 'session'; sessionId: string }
  | { type: 'file'; file: RealOfficeFile['file'] }

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** 一句话文案（已带《》书名号），相对时间由页面单独渲染。 */
  label: string
  /** ISO 时间；解析失败时排序沉底。 */
  at: string
  target: ActivityTarget
}

/** 概览动态默认最多 8 条，点「显示更早」最多展开到 20 条。 */
export const ACTIVITY_COLLAPSED_LIMIT = 8
export const ACTIVITY_EXPANDED_LIMIT = 20

/** 概览只需要会话的这几个字段，方便单测构造最小 fixture。 */
export type SessionActivityInput = Pick<
  AgentSession,
  'id' | 'title' | 'status' | 'createdAt' | 'updatedAt'
>

/** `updatedAt` 与 `createdAt` 落在 1s 内视为「刚建好、还没真正跑过」。 */
const SESSION_CREATED_WINDOW_MS = 1000

function sessionTitleOf(session: SessionActivityInput): string {
  return session.title?.trim() || '新工作'
}

function sessionKindOf(session: SessionActivityInput): ActivityKind {
  if (session.status === 'running') return 'session-run'
  if (session.status === 'closed' || session.status === 'interrupted') return 'session-done'
  const created = Date.parse(session.createdAt)
  const updated = Date.parse(session.updatedAt)
  if (
    Number.isFinite(created)
    && Number.isFinite(updated)
    && Math.abs(updated - created) <= SESSION_CREATED_WINDOW_MS
  ) {
    return 'session-created'
  }
  return 'session-updated'
}

function sessionLabelOf(kind: ActivityKind, session: SessionActivityInput): string {
  const title = sessionTitleOf(session)
  switch (kind) {
    case 'session-created': return `新建了工作《${title}》`
    case 'session-run': return `开始了工作《${title}》`
    case 'session-done': return `结束了工作《${title}》`
    default: return `更新了工作《${title}》`
  }
}

function sessionTimeOf(session: SessionActivityInput): string {
  if (Number.isFinite(Date.parse(session.updatedAt))) return session.updatedAt
  return session.createdAt
}

function sessionActivityOf(session: SessionActivityInput): ActivityItem {
  const kind = sessionKindOf(session)
  return {
    id: `session:${session.id}`,
    kind,
    label: sessionLabelOf(kind, session),
    at: sessionTimeOf(session),
    target: { type: 'session', sessionId: session.id },
  }
}

function fileActivityOf(entry: RealOfficeFile): ActivityItem {
  // 只有 Agent 生成的算「产物」；导入产物/上传/连接器统一算「添加了材料」。
  const generated = entry.catalog.sourceKind === 'agent-generated'
  const name = entry.file.name
  return {
    id: `file:${entry.catalog.id}`,
    kind: generated ? 'file-generated' : 'file-added',
    label: generated ? `生成了《${name}》` : `添加了材料《${name}》`,
    at: entry.catalog.updatedAt,
    target: { type: 'file', file: entry.file },
  }
}

function timestampOf(item: ActivityItem): number {
  const parsed = Date.parse(item.at)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function targetRank(item: ActivityItem): number {
  return item.target.type === 'session' ? 0 : 1
}

/** 时间倒序；同一时刻工作在前、文件在后，再按 id 兜底保证稳定。 */
function compareActivities(left: ActivityItem, right: ActivityItem): number {
  const leftTime = timestampOf(left)
  const rightTime = timestampOf(right)
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1
  const rank = targetRank(left) - targetRank(right)
  if (rank !== 0) return rank
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export interface BuildActivitiesInput {
  sessions?: readonly SessionActivityInput[]
  files?: readonly RealOfficeFile[]
}

/** 合并「本空间会话 + 文件库条目」，按时间倒序返回完整列表（截断交给 collapseActivities）。 */
export function buildActivities({ sessions = [], files = [] }: BuildActivitiesInput = {}): ActivityItem[] {
  return [
    ...sessions.map(sessionActivityOf),
    ...files.map(fileActivityOf),
  ].sort(compareActivities)
}

export interface CollapsedActivities {
  visible: ActivityItem[]
  /** 折叠后没显示出来的条数（展开态为超出 20 条的剩余）。 */
  hiddenCount: number
}

/** 动态折叠：默认 8 条，展开后 20 条（需求上限，不再做第二级展开）。 */
export function collapseActivities(
  items: readonly ActivityItem[],
  expanded: boolean,
): CollapsedActivities {
  const limit = expanded ? ACTIVITY_EXPANDED_LIMIT : ACTIVITY_COLLAPSED_LIMIT
  const visible = items.slice(0, limit)
  return { visible, hiddenCount: Math.max(0, items.length - visible.length) }
}

/* ───────────────── 洞察文本 ───────────────── */

/** 洞察摘要最多 4 行、240 字，超出折成一段话加省略号。 */
const INSIGHT_MAX_LINES = 4
const INSIGHT_MAX_CHARS = 240

export interface InsightMessageLike {
  role: string
  content: string
}

function isMarkdownNoise(line: string): boolean {
  // 分隔线、表格分隔行、纯 HTML 标签行都不是正文。
  if (/^[-*_]{3,}$/.test(line)) return true
  if (line.includes('|') && /^[\s|:-]+$/.test(line)) return true
  if (/^<[^>]+>$/.test(line)) return true
  return false
}

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 把一条 assistant 正文折成 2–4 行的短段落；没有正文时返回 null。 */
export function normalizeInsightText(raw: string): string | null {
  if (!raw || !raw.trim()) return null
  const lines = raw.split(/\r?\n/)
  const picked: string[] = []
  let inFence = false
  let truncated = false
  let chars = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || !trimmed) continue
    if (isMarkdownNoise(trimmed)) continue
    const cleaned = stripInlineMarkdown(trimmed)
    if (!cleaned) continue
    if (picked.length >= INSIGHT_MAX_LINES) {
      truncated = true
      break
    }
    if (picked.length > 0 && chars + cleaned.length > INSIGHT_MAX_CHARS) {
      truncated = true
      break
    }
    picked.push(cleaned)
    chars += cleaned.length + 1
  }

  if (picked.length === 0) return null
  const full = picked.join('\n')
  const clipped = full.length > INSIGHT_MAX_CHARS ? full.slice(0, INSIGHT_MAX_CHARS).trimEnd() : full
  return truncated || clipped !== full ? `${clipped}…` : clipped
}

/** 从会话消息里取最后一条有正文的 assistant 消息，折成洞察文本。 */
export function extractInsightText(messages: readonly InsightMessageLike[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    const text = normalizeInsightText(message.content)
    if (text) return text
  }
  return null
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : null
}

/**
 * 消息快照为空时的兜底：把 run 事件里的 `message.completed` / `message.delta`
 * 折回一段 assistant 正文。
 */
export function insightTextFromEvents(events: readonly AgentEvent[]): string | null {
  let completed: string | null = null
  const deltas: string[] = []

  for (const event of events) {
    if (event.type === 'message.delta') {
      const delta = readPayloadString(event.payload, 'delta')
      if (delta) deltas.push(delta)
      continue
    }
    if (event.type === 'message.completed') {
      const content = readPayloadString(event.payload, 'content')
      const role = readPayloadString(event.payload, 'role')
      if (content?.trim() && (role === null || role === 'assistant')) completed = content
    }
  }

  const fromCompleted = completed ? normalizeInsightText(completed) : null
  if (fromCompleted) return fromCompleted
  const streamed = deltas.join('')
  return streamed ? normalizeInsightText(streamed) : null
}
