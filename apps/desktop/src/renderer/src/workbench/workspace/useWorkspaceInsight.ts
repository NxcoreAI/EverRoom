import type { AgentSession } from '@nxcore/agent-contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  INSIGHT_CACHE_TTL_MS,
  INSIGHT_FAILURE_COOLDOWN_MS,
  deriveWorkspaceInsight,
  initialWorkspaceInsight,
  pickLatestSession,
  scopedSessions,
  sessionSignature,
  unavailableInsight,
  type WorkspaceInsight,
  type WorkspaceInsightReader,
  type WorkspaceInsightStats,
} from './insight'

/**
 * 概览「洞察」的状态机（规格 §6 / §7）。
 *
 * 职责：
 * - 选本空间最近更新的会话，抓最后一条 assistant 正文（快照优先、事件兜底）；
 * - 维护 8 个状态与转移：unavailable / empty / loading / no-content / ready / updating / refreshing / error；
 * - 单飞、按空间缓存（60s TTL）、失败冷却（60s）、超时与重试（由 `deriveWorkspaceInsight` 执行）；
 * - 切换空间立即作废旧请求，绝不把上一个空间的文本写到新空间（防串台）。
 *
 * 页面只消费 `insight`、`refreshing`、`refresh()`，不感知桥/重试细节。
 */

interface CacheEntry {
  insight: WorkspaceInsight
  /** 派生时的会话指纹：指纹变了就必须重取。 */
  signature: string
  capturedAt: number
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<WorkspaceInsight>>()
const cooldownUntil = new Map<string, number>()

/** 测试注入：缩短/关闭重试间隔（生产用 `INSIGHT_RETRY_DELAYS_MS`）。 */
let retryDelaysOverride: readonly number[] | null = null
/** 测试注入：去抖间隔（生产 800ms；单测传 0 立即执行）。 */
let debounceMsOverride: number | null = null
/** 测试注入：失败冷却时长（生产 60s；单测传短值验证到期自动恢复）。 */
let cooldownMsOverride: number | null = null
const INSIGHT_DEBOUNCE_MS = 800

/* ───────────────── 测试辅助（仅单测使用） ───────────────── */

/** 清空跨用例的模块级缓存（单测 beforeEach 调用）。 */
export function __resetInsightStateForTests(): void {
  cache.clear()
  inflight.clear()
  cooldownUntil.clear()
  retryDelaysOverride = null
  debounceMsOverride = null
  cooldownMsOverride = null
}

/** 覆盖去抖间隔：传 0 立即执行（单测避免真实等待）。 */
export function __setInsightDebounceForTests(ms: number | null): void {
  debounceMsOverride = ms
}

/** 覆盖失败冷却时长（单测传短值验证「冷却到期自动再试」）。 */
export function __setInsightCooldownForTests(ms: number | null): void {
  cooldownMsOverride = ms
}

/** 覆盖重试间隔：传 `[]` 关闭重试（单测避免真实等待）。 */
export function __setInsightRetryDelaysForTests(delays: readonly number[] | null): void {
  retryDelaysOverride = delays
}

/* ───────────────── 桥适配 ───────────────── */

function getInsightReader(): WorkspaceInsightReader | null {
  const agent = typeof window === 'undefined' ? undefined : window.nxcore?.agent
  if (typeof agent?.getSession !== 'function') return null
  return {
    getSession: (sessionId) => agent.getSession(sessionId),
    ...(typeof agent.getEvents === 'function'
      ? {
          getEvents: (sessionId: string, runId: string, afterSeq: number) =>
            agent.getEvents(sessionId, runId, afterSeq),
        }
      : {}),
  }
}

function hasBridge(): boolean {
  return typeof window !== 'undefined' && typeof window.nxcore?.agent?.getSession === 'function'
}

/* ───────────────── 状态辅助 ───────────────── */

/**
 * 缓存文本仍然可用时，只把状态对齐到「最新会话是否在跑」：
 * - 运行中 → updating（正文保留，角标提示）；
 * - 已结束 → ready。
 */
function withLiveStatus(
  insight: WorkspaceInsight,
  latestStatus: AgentSession['status'],
): WorkspaceInsight {
  if (!insight.text) return insight
  if (latestStatus === 'running') {
    return insight.status === 'updating' ? insight : { ...insight, status: 'updating' }
  }
  return insight.status === 'ready' ? insight : { ...insight, status: 'ready' }
}

function withFileCount(
  insight: WorkspaceInsight,
  fileCount: number | undefined,
): WorkspaceInsight {
  if (insight.stats.fileCount === fileCount) return insight
  if (fileCount === undefined) {
    const nextStats: WorkspaceInsightStats = { workCount: insight.stats.workCount }
    return { ...insight, stats: nextStats }
  }
  return { ...insight, stats: { ...insight.stats, fileCount } }
}

/* ───────────────── Hook ───────────────── */

export interface UseWorkspaceInsightOptions {
  workspaceId: string
  /** 上层传入的会话清单（`WorkspaceTabHost` 已按空间过滤；这里再防御一次）。 */
  sessions: readonly AgentSession[]
  /** 本空间文件数；文件库未就绪时传 undefined（来源行省略该分句）。 */
  fileCount?: number
}

export interface WorkspaceInsightController {
  insight: WorkspaceInsight
  /** 手动刷新进行中（按钮转圈）。 */
  refreshing: boolean
  /** 手动重新派生；返回是否成功（失败静默，由埋点记录）。 */
  refresh: () => Promise<boolean>
}

export function useWorkspaceInsight({
  workspaceId,
  sessions,
  fileCount,
}: UseWorkspaceInsightOptions): WorkspaceInsightController {
  const debounceMs = debounceMsOverride ?? INSIGHT_DEBOUNCE_MS
  const scoped = useMemo(() => scopedSessions(sessions, workspaceId), [sessions, workspaceId])
  const latest = useMemo(() => pickLatestSession(scoped), [scoped])
  const signature = useMemo(() => sessionSignature(scoped), [scoped])

  const [state, setState] = useState<WorkspaceInsight>(() =>
    initialWorkspaceInsight(workspaceId, sessions, fileCount))
  const [refreshing, setRefreshing] = useState(false)

  // 请求序号：切空间/新派生/卸载都 +1，旧的异步结果直接丢弃。
  const requestSeqRef = useRef(0)
  const lastWorkspaceRef = useRef(workspaceId)
  const ctxRef = useRef({ workspaceId, scoped, latest, signature, fileCount })
  ctxRef.current = { workspaceId, scoped, latest, signature, fileCount }

  const run = useCallback(
    async (options: { manual?: boolean; force?: boolean } = {}): Promise<boolean> => {
      const seq = requestSeqRef.current + 1
      requestSeqRef.current = seq
      const ctx = ctxRef.current
      const now = Date.now()

      const reader = getInsightReader()
      if (!reader) {
        setState(unavailableInsight(workspaceId, ctx.scoped, ctx.fileCount))
        return false
      }
      if (!ctx.latest) {
        setState(initialWorkspaceInsight(workspaceId, ctx.scoped, ctx.fileCount))
        return true
      }

      const cached = cache.get(workspaceId)
      const cacheFresh = Boolean(
        cached &&
          cached.signature === ctx.signature &&
          now - cached.capturedAt < INSIGHT_CACHE_TTL_MS,
      )
      if (!options.manual && !options.force && cacheFresh && cached) {
        setState(withLiveStatus(cached.insight, ctx.latest.status))
        return true
      }
      if (
        !options.manual &&
        !options.force &&
        (cooldownUntil.get(workspaceId) ?? 0) > now
      ) {
        if (cached) setState(withLiveStatus(cached.insight, ctx.latest.status))
        return false
      }

      // 有旧文本时保留正文（转 updating/refreshing），只有首屏才显示骨架。
      setState((previous) => {
        const keepText = previous.workspaceId === workspaceId && Boolean(previous.text)
        if (!keepText) return initialWorkspaceInsight(workspaceId, ctx.scoped, ctx.fileCount)
        return {
          ...previous,
          status: options.manual
            ? 'refreshing'
            : ctx.latest!.status === 'running'
              ? 'updating'
              : 'refreshing',
        }
      })

      // §6.4 不变量 1：单飞按 workspaceId 计——同空间同时最多 1 个真实请求。
      // 派生进行中签名又变了：复用在飞请求（结果由 seq 校验决定去留），不并发再发。
      let request = inflight.get(workspaceId)
      if (!request) {
        request = deriveWorkspaceInsight({
          workspaceId,
          sessions: ctx.scoped,
          ...(ctx.fileCount === undefined ? {} : { fileCount: ctx.fileCount }),
          reader,
          ...(retryDelaysOverride === null ? {} : { retryDelaysMs: retryDelaysOverride }),
        }).finally(() => {
          inflight.delete(workspaceId)
        })
        inflight.set(workspaceId, request)
      }
      const result = await request
      if (seq !== requestSeqRef.current) return false

      if (result.status === 'error') {
        cooldownUntil.set(workspaceId, Date.now() + (cooldownMsOverride ?? INSIGHT_FAILURE_COOLDOWN_MS))
        const fallback = cache.get(workspaceId)
        if (fallback?.insight.text) {
          // 保留旧正文；状态对齐「最新会话是否在跑」（§6.1 updating 语义）。
          setState({
            ...fallback.insight,
            status: ctx.latest!.status === 'running' ? 'updating' : 'ready',
            error: result.error,
          })
          return false
        }
        setState(result)
        return false
      }

      cooldownUntil.delete(workspaceId)
      if (
        result.status === 'ready' ||
        result.status === 'updating' ||
        result.status === 'no-content'
      ) {
        cache.set(workspaceId, { insight: result, signature: ctx.signature, capturedAt: Date.now() })
      }
      setState(result)
      return true
    },
    [workspaceId],
  )

  // 空间 / 会话指纹变化 → 重新派生（§6.2 T6/T8：800ms 去抖合并连发变化）。
  // 切空间立即执行（不等待去抖窗口），避免新空间白等。
  useEffect(() => {
    const workspaceChanged = lastWorkspaceRef.current !== workspaceId
    if (workspaceChanged) {
      lastWorkspaceRef.current = workspaceId
      setState(initialWorkspaceInsight(workspaceId, ctxRef.current.scoped, ctxRef.current.fileCount))
    }
    if (!workspaceChanged && debounceMs > 0) {
      const timer = setTimeout(() => { void run() }, debounceMs)
      return () => { clearTimeout(timer); requestSeqRef.current += 1 }
    }
    void run()
    return () => { requestSeqRef.current += 1 }
  }, [workspaceId, signature, run, debounceMs])

  // §8.7：失败冷却到期后自动再试一次（否则网关恢复但会话无变化时会永久停在错误态）。
  const cooldown = cooldownUntil.get(workspaceId) ?? 0
  const cooldownRemaining = Math.max(0, cooldown - Date.now())
  useEffect(() => {
    if (cooldownRemaining <= 0) return
    const timer = setTimeout(() => { void run() }, cooldownRemaining + 10)
    return () => { clearTimeout(timer) }
    // cooldownRemaining 每次渲染重算；只在「进入冷却」的时刻安排一次到期重试。
  }, [cooldown > 0, workspaceId, run])

  // 文件数只影响来源行，不触发重新派生。
  useEffect(() => {
    setState((previous) => withFileCount(previous, fileCount))
  }, [fileCount])

  const refresh = useCallback(async (): Promise<boolean> => {
    setRefreshing(true)
    try {
      return await run({ manual: true, force: true })
    } finally {
      setRefreshing(false)
    }
  }, [run])

  // 渲染时兜底：state 还是旧空间（effect 尚未跑）就先用新空间的初始态，绝不显示别人的文本。
  const insight = state.workspaceId === workspaceId
    ? state
    : hasBridge()
      ? initialWorkspaceInsight(workspaceId, scoped, fileCount)
      : unavailableInsight(workspaceId, scoped, fileCount)

  return { insight, refreshing, refresh }
}
