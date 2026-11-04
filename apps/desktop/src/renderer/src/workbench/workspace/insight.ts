import type { AgentEvent, AgentSession, AgentSessionSnapshot } from '@nxcore/agent-contract'

import {
  INSIGHT_MAX_CHARS,
  INSIGHT_MAX_LINES,
  extractInsightDetail,
  insightTextFromEvents,
} from './activity'

/**
 * 工作空间「概览 · 洞察」的模型与派生规则。
 *
 * 产品没有洞察实体（见 `docs/design/product-data-map.zh-CN.md` §9）：洞察 = 本空间
 * 最近更新会话的最后一条 assistant 正文，消息快照优先、run 事件兜底，客户端规整成
 * 2–4 行的一段话（`activity.ts` 的 `normalizeInsightText`）。
 *
 * 本文件是纯逻辑（无 React、无 window 依赖），页面与单测共用：
 * - `deriveWorkspaceInsight` 负责「选会话 → 取正文 → 兜底 → 组装 ViewModel」；
 * - 超时/重试/错误码在这里收敛，页面只按 `status` 渲染；
 * - 不造 mock：失败返回 `error`，调用方不得注入固定文案。
 *
 * 规格：`docs/workspace-overview-insight-spec.zh-CN.md` §6 / §8。
 */

/* ───────────────── 状态与 ViewModel ───────────────── */

/** 洞察卡状态：与规格 §6.1 一一对应。 */
export type WorkspaceInsightStatus =
  /** 无桥/能力缺失 → 不渲染。 */
  | 'unavailable'
  /** 本空间无工作。 */
  | 'empty'
  /** 首次取文本（无缓存）。 */
  | 'loading'
  /** 有会话但没有任何可归纳的 assistant 正文。 */
  | 'no-content'
  /** 文本新鲜。 */
  | 'ready'
  /** 文本可用，但最新会话仍在运行 / 文本落后于会话更新。 */
  | 'updating'
  /** 后台重新派生中（手动刷新或产物落盘触发）。 */
  | 'refreshing'
  /** 取文本失败且没有可展示的缓存。 */
  | 'error'

export type WorkspaceInsightErrorCode =
  | 'bridge-unavailable'
  | 'session-fetch-failed'
  | 'timeout'
  | 'no-assistant-message'

/** 文本出处：用于证据浮层、埋点与排障；不直接展示给用户。 */
export interface WorkspaceInsightOrigin {
  sessionId: string
  /** 被采纳的 assistant 消息；run 事件兜底时为 null。 */
  messageId: string | null
  /** run 事件兜底时命中的 run；消息快照命中时为 `activeRun?.id ?? null`。 */
  runId: string | null
  /** 本轮抓取时间（ISO）。 */
  capturedAt: string
  /** 来源会话的 updatedAt（ISO）：判断新鲜度、展示「更新于」。 */
  sourceUpdatedAt: string
}

/** 来源统计：只允许真实数据；缺数据的字段必须缺省，禁止编造。 */
export interface WorkspaceInsightStats {
  /** 本空间会话数。 */
  workCount: number
  /** 本空间文件数；文件库未就绪时缺省 → 来源行省略该分句。 */
  fileCount?: number
  /** 无空间维度数据源，本版恒缺省；禁止用全局记忆数凑数。 */
  memoryCount?: number
}

export interface WorkspaceInsightError {
  code: WorkspaceInsightErrorCode
  message?: string
}

export interface WorkspaceInsight {
  workspaceId: string
  status: WorkspaceInsightStatus
  /** 正文：ready/updating/refreshing 时必填；2–4 行、≤240 字（已过 normalize）。 */
  text: string | null
  origin: WorkspaceInsightOrigin | null
  stats: WorkspaceInsightStats
  /** 展示用时效 = `origin.sourceUpdatedAt`；尚未成功派生时为 null。 */
  updatedAt: string | null
  error: WorkspaceInsightError | null
}

/* ───────────────── 常量与文案 ───────────────── */

/** 单次 `getSession` 超时。 */
export const INSIGHT_TIMEOUT_MS = 8_000
/** 失败后的重试间隔（最多两次重试：1s / 3s）。 */
export const INSIGHT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000]
/** 成功派生结果的缓存时长。 */
export const INSIGHT_CACHE_TTL_MS = 60_000
/** 连续失败后的自动重试冷却，手动刷新不受限。 */
export const INSIGHT_FAILURE_COOLDOWN_MS = 60_000

/** 洞察卡的全部用户可见文案（zh-CN）。规格 §5.4 的落地版本。 */
export const INSIGHT_COPY = {
  title: '洞察',
  updating: '小 E 正在更新…',
  emptyTitle: '等待第一项工作',
  emptyBody: '空间刚建好。第一项工作落成后，小 E 会在这里汇总进展、给出建议。',
  noContent: '小 E 还没有可汇总的内容——等第一次工作跑完，这里会自动出现。',
  error: '洞察暂时不可用，稍后重试',
  retry: '重试',
  loading: '正在读取洞察',
  refreshLabel: '重新获取洞察',
  refreshToast: '洞察已更新',
  evidenceTitle: '这条洞察来自',
  evidenceOpen: '打开工作',
  footer: '—— 小 E · 你的工作台助理',
} as const

/* ───────────────── 会话选择 ───────────────── */

/** 派生只需要会话的这几个字段，方便单测构造最小 fixture。 */
export type InsightSessionLike = Pick<
  AgentSession,
  'id' | 'workspaceId' | 'title' | 'status' | 'createdAt' | 'updatedAt'
>

/** 只保留属于当前空间的会话（防御性过滤：上层可能传入全量会话）。 */
export function scopedSessions(
  sessions: readonly InsightSessionLike[],
  workspaceId: string,
): InsightSessionLike[] {
  return sessions.filter((session) => session.workspaceId === workspaceId)
}

/** 会话状态指纹：id / 状态 / 更新时间，用于判断是否要重新派生。 */
export function sessionSignature(sessions: readonly InsightSessionLike[]): string {
  return sessions.map((session) => `${session.id}:${session.status}:${session.updatedAt}`).join('|')
}

function compareSessionsForLatest(
  left: InsightSessionLike,
  right: InsightSessionLike,
): number {
  const leftTime = Date.parse(left.updatedAt)
  const rightTime = Date.parse(right.updatedAt)
  const leftValue = Number.isFinite(leftTime) ? leftTime : Number.NEGATIVE_INFINITY
  const rightValue = Number.isFinite(rightTime) ? rightTime : Number.NEGATIVE_INFINITY
  if (leftValue !== rightValue) return leftValue < rightValue ? 1 : -1
  // 平手：创建更晚的优先；再平手用 id 保证稳定（不依赖入参顺序）。
  const leftCreated = Date.parse(left.createdAt)
  const rightCreated = Date.parse(right.createdAt)
  if (leftCreated !== rightCreated) return leftCreated < rightCreated ? 1 : -1
  return left.id < right.id ? 1 : left.id > right.id ? -1 : 0
}

/** 最近更新的会话；空数组返回 null。 */
export function pickLatestSession(
  sessions: readonly InsightSessionLike[],
): InsightSessionLike | null {
  let latest: InsightSessionLike | null = null
  for (const session of sessions) {
    if (!latest || compareSessionsForLatest(session, latest) < 0) latest = session
  }
  return latest
}

/* ───────────────── 初始态 / 派生 ───────────────── */

/** 派生所需的最小读取面（页面传 `window.nxcore.agent`，单测传假实现）。 */
export interface WorkspaceInsightReader {
  getSession(sessionId: string): Promise<AgentSessionSnapshot>
  getEvents?(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
}

export interface DeriveWorkspaceInsightInput {
  workspaceId: string
  /** 上层传入的会话清单（可为全量，内部按 workspaceId 过滤）。 */
  sessions: readonly InsightSessionLike[]
  /** 本空间文件数；文件库未就绪时省略。 */
  fileCount?: number
  reader: WorkspaceInsightReader | null
  timeoutMs?: number
  /** 重试间隔；空数组 = 不重试（单测用）。 */
  retryDelaysMs?: readonly number[]
  /** 注入时钟，方便单测断言 capturedAt。 */
  now?: () => number
}

function statsOf(
  sessions: readonly InsightSessionLike[],
  fileCount: number | undefined,
): WorkspaceInsightStats {
  return {
    workCount: sessions.length,
    ...(fileCount === undefined ? {} : { fileCount }),
  }
}

/** 首屏状态：无会话 → empty，否则 loading。 */
export function initialWorkspaceInsight(
  workspaceId: string,
  sessions: readonly InsightSessionLike[],
  fileCount?: number,
): WorkspaceInsight {
  const scoped = scopedSessions(sessions, workspaceId)
  return {
    workspaceId,
    status: scoped.length === 0 ? 'empty' : 'loading',
    text: null,
    origin: null,
    stats: statsOf(scoped, fileCount),
    updatedAt: null,
    error: null,
  }
}

/** 无桥时的状态：不渲染；仍保留真实计数。 */
export function unavailableInsight(
  workspaceId: string,
  sessions: readonly InsightSessionLike[],
  fileCount?: number,
): WorkspaceInsight {
  return {
    workspaceId,
    status: 'unavailable',
    text: null,
    origin: null,
    stats: statsOf(scopedSessions(sessions, workspaceId), fileCount),
    updatedAt: null,
    error: { code: 'bridge-unavailable' },
  }
}

class InsightTimeoutError extends Error {
  constructor() {
    super('insight derivation timed out')
    this.name = 'InsightTimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new InsightTimeoutError()), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface InsightTextHit {
  text: string
  messageId: string | null
  runId: string | null
}

/** 快照优先、事件兜底；没有正文返回 null（→ no-content）。 */
async function readInsightText(
  reader: WorkspaceInsightReader,
  sessionId: string,
): Promise<InsightTextHit | null> {
  const snapshot = await reader.getSession(sessionId)
  const detail = extractInsightDetail(snapshot.messages ?? [])
  const runId = snapshot.activeRun?.id ?? null
  if (detail) return { text: detail.text, messageId: detail.messageId, runId }

  if (runId && reader.getEvents) {
    const events = await reader.getEvents(sessionId, runId, 0)
    const text = insightTextFromEvents(events ?? [])
    if (text) return { text, messageId: null, runId }
  }
  return null
}

function errorCodeOf(error: unknown): WorkspaceInsightErrorCode {
  return error instanceof InsightTimeoutError ? 'timeout' : 'session-fetch-failed'
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'unknown error')
}

/**
 * 派生一次洞察：选最近会话 → 取最后一条 assistant 正文 → 规整 → 组装 ViewModel。
 *
 * - 不抛异常：失败折叠成 `status: 'error'`，由调用方决定保留缓存还是展示错误；
 * - 重试只覆盖 `getSession` / `getEvents` 的瞬时失败，不重试「无正文」；
 * - 运行中的会话也返回文本，状态标 `updating`（视觉上保留正文 + 角标）。
 */
export async function deriveWorkspaceInsight(
  input: DeriveWorkspaceInsightInput,
): Promise<WorkspaceInsight> {
  const now = input.now ?? Date.now
  const scoped = scopedSessions(input.sessions, input.workspaceId)
  const stats = statsOf(scoped, input.fileCount)

  if (!input.reader) {
    return {
      workspaceId: input.workspaceId,
      status: 'unavailable',
      text: null,
      origin: null,
      stats,
      updatedAt: null,
      error: { code: 'bridge-unavailable' },
    }
  }
  if (scoped.length === 0) {
    return {
      workspaceId: input.workspaceId,
      status: 'empty',
      text: null,
      origin: null,
      stats,
      updatedAt: null,
      error: null,
    }
  }

  const latest = pickLatestSession(scoped)!
  const timeoutMs = input.timeoutMs ?? INSIGHT_TIMEOUT_MS
  const retryDelays = input.retryDelaysMs ?? INSIGHT_RETRY_DELAYS_MS

  let lastError: unknown = null
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (attempt > 0) await sleep(retryDelays[attempt - 1] ?? 0)
    try {
      const hit = await withTimeout(readInsightText(input.reader, latest.id), timeoutMs)
      const capturedAt = new Date(now()).toISOString()
      if (!hit) {
        return {
          workspaceId: input.workspaceId,
          status: 'no-content',
          text: null,
          origin: {
            sessionId: latest.id,
            messageId: null,
            runId: null,
            capturedAt,
            sourceUpdatedAt: latest.updatedAt,
          },
          stats,
          updatedAt: latest.updatedAt,
          error: null,
        }
      }
      return {
        workspaceId: input.workspaceId,
        status: latest.status === 'running' ? 'updating' : 'ready',
        text: hit.text,
        origin: {
          sessionId: latest.id,
          messageId: hit.messageId,
          runId: hit.runId,
          capturedAt,
          sourceUpdatedAt: latest.updatedAt,
        },
        stats,
        updatedAt: latest.updatedAt,
        error: null,
      }
    } catch (error) {
      lastError = error
    }
  }

  return {
    workspaceId: input.workspaceId,
    status: 'error',
    text: null,
    origin: null,
    stats,
    updatedAt: null,
    error: { code: errorCodeOf(lastError), message: errorMessageOf(lastError) },
  }
}

/* ───────────────── 展示格式化 ───────────────── */

/** 「刚刚」不写成「更新于 刚刚」；其余拼「更新于 X」。 */
export function formatInsightUpdatedLabel(relativeLabel: string): string {
  if (!relativeLabel) return ''
  return relativeLabel === '刚刚' ? '刚刚更新' : `更新于 ${relativeLabel}`
}

/** 来源行：`基于本空间 N 项工作[与 M 个文件][ · 更新于 X]`。 */
export function formatInsightSourceLine(
  stats: WorkspaceInsightStats,
  updatedLabel: string,
): string {
  const parts = [
    stats.fileCount === undefined
      ? `基于本空间 ${stats.workCount} 项工作`
      : `基于本空间 ${stats.workCount} 项工作与 ${stats.fileCount} 个文件`,
  ]
  if (updatedLabel) parts.push(updatedLabel)
  return parts.join(' · ')
}

/* ───────────────── 文案校验（单测 / 生成侧共用） ───────────────── */

const FORBIDDEN_MARKETING_WORDS = ['赋能', '闭环', '抓手', '沉淀', '复用', '助力', '全面提升', '稳步推进', '继续保持']
const FORBIDDEN_VOICE = ['本 AI', '本系统', '作为助手', '作为一个 AI']
/** C11：免责/谦虚声明（生成侧易带出的口癖）。 */
const FORBIDDEN_DISCLAIMERS = ['希望对你有帮助', '希望这对你有帮助', '仅供参考', '如有需要请告诉我', '如有疑问请告诉我', '希望能够帮到你']

/** 句子按 。？！；切分（句末符号保留在句内，便于「问句在末句」判断）。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。？！；?;])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

/**
 * 校验一段洞察文案是否符合规格 §5.2 的硬约束 C1–C12（返回违规项，空数组 = 通过）。
 *
 * 仅用于单测与 P2 生成侧的兜底校验；P0/P1 展示的是会话原文的规整结果，
 * 不在运行时二次拒绝（避免把真实内容清空）。
 */
export function validateInsightCopy(text: string): string[] {
  const issues: string[] = []
  if (!text.trim()) issues.push('empty')
  if (text.length > INSIGHT_MAX_CHARS) issues.push('too-long')
  if (text.split('\n').length > INSIGHT_MAX_LINES) issues.push('too-many-lines')
  if (/^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s)/m.test(text)) issues.push('markdown-block')
  if (/\*\*|`|!\[|\]\(|\|/.test(text)) issues.push('markdown-inline')
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) issues.push('emoji')
  if (/[!！]/.test(text)) issues.push('exclamation')
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) issues.push('absolute-date')
  // C5：URL 与模板占位符。
  if (/(?:https?:\/\/|www\.)\S+/i.test(text)) issues.push('url')
  if (/\$\{|\$\(|\{\{/.test(text)) issues.push('template-placeholder')
  // C2：少于 40 字必须能独立成句（以句末符号收尾）。
  if (text.length > 0 && text.length < 40 && !/[。？！?]$/.test(text.trim())) issues.push('too-short-fragment')
  // C3：最多 3 句。
  const sentences = splitSentences(text)
  if (sentences.length > 3) issues.push('too-many-sentences')
  // C6 / C10 / C11 黑名单。
  for (const word of FORBIDDEN_MARKETING_WORDS) {
    if (text.includes(word)) issues.push(`marketing:${word}`)
  }
  for (const word of FORBIDDEN_VOICE) {
    if (text.includes(word)) issues.push(`voice:${word}`)
  }
  for (const word of FORBIDDEN_DISCLAIMERS) {
    if (text.includes(word)) issues.push('disclaimer')
  }
  const questions = (text.match(/[？?]/g) ?? []).length
  if (questions > 1) issues.push('too-many-questions')
  if (questions === 1 && !/[？?]\s*$/.test(text)) issues.push('question-not-last')
  return issues
}
