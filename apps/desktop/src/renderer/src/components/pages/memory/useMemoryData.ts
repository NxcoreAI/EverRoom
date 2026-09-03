import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translate } from '@/i18n/LocaleContext'

import type { MemoryOverviewDto } from '../../../../../shared/memory'

/** 记忆功能的失败分类，决定降级 UI。 */
export interface MemoryFailure {
  kind: 'disabled' | 'unreachable' | 'error'
  messageKey: string
  detail?: string
}

/** IPC 错误 message 中带有 gateway 的 `[memory_*]` 前缀；据此分类。 */
export function toMemoryFailure(error: unknown): MemoryFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('[memory_disabled]')) {
    return { kind: 'disabled', messageKey: 'memory:failure.disabled' }
  }
  if (message.includes('[memory_unreachable]')) {
    return { kind: 'unreachable', messageKey: 'memory:failure.unreachable' }
  }
  if (message.includes('[memory_error]')) {
    const detail = message.replace(/\[memory_error\]\s*/, '').trim()
    return {
      kind: 'error',
      messageKey: 'memory:failure.requestFailed',
      ...(detail ? { detail } : {}),
    }
  }
  return { kind: 'unreachable', messageKey: 'memory:failure.gatewayUnavailable' }
}

export function memoryFailureText(failure: MemoryFailure, t: Translate): string {
  return failure.detail || t(failure.messageKey)
}

interface AsyncState<T> {
  data: T | null
  failure: MemoryFailure | null
  loading: boolean
}

/** 极简异步加载 hook：手动 refresh + 卸载后忽略结果。 */
export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> & { refresh: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, failure: null, loading: true })
  const aliveRef = useRef(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    aliveRef.current = true
    setState((prev) => ({ ...prev, loading: true }))
    loader()
      .then((data) => {
        if (aliveRef.current) setState({ data, failure: null, loading: false })
      })
      .catch((error: unknown) => {
        if (aliveRef.current) setState({ data: null, failure: toMemoryFailure(error), loading: false })
      })
    return () => {
      aliveRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps])

  const refresh = useCallback(() => setTick((value) => value + 1), [])
  return { ...state, refresh }
}

/**
 * 带离线快照的数据加载（网关断联时记忆页仍可查看，2026-09-03）：
 * 成功时把最后一份好数据写入 localStorage；失败时回落到快照并置 stale，
 * 且每 30s 自动重试——网关恢复后自动回到实时数据。只读兜底，不缓存写操作。
 */
const SNAPSHOT_PREFIX = 'mem-snapshot:'
const STALE_RETRY_MS = 30_000
const SNAPSHOT_MAX_BYTES = 512 * 1024

interface SnapshotEnvelope<T> {
  at: number
  data: T
}

function readSnapshot<T>(key: string): SnapshotEnvelope<T> | null {
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SnapshotEnvelope<T>
    return parsed && typeof parsed.at === 'number' && 'data' in parsed ? parsed : null
  } catch {
    return null
  }
}

function writeSnapshot<T>(key: string, data: T): void {
  try {
    const raw = JSON.stringify({ at: Date.now(), data } satisfies SnapshotEnvelope<T>)
    // 超预算直接放弃（本页各源均为小载荷；大列表源不应使用本钩子）。
    if (raw.length > SNAPSHOT_MAX_BYTES) return
    window.localStorage.setItem(SNAPSHOT_PREFIX + key, raw)
  } catch {
    // 配额满等写入失败不影响主流程。
  }
}

export function useSnapshottedAsyncData<T>(
  snapshotKey: string,
  loader: () => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> & { refresh: () => void; stale: boolean; snapshotAt: number | null } {
  const [state, setState] = useState<AsyncState<T> & { stale: boolean; snapshotAt: number | null }>({
    data: null,
    failure: null,
    loading: true,
    stale: false,
    snapshotAt: null,
  })
  const aliveRef = useRef(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    aliveRef.current = true
    let retryTimer: number | null = null
    const run = (): void => {
      setState((prev) => ({ ...prev, loading: true }))
      loader()
        .then((data) => {
          if (!aliveRef.current) return
          writeSnapshot(snapshotKey, data)
          setState({ data, failure: null, loading: false, stale: false, snapshotAt: null })
        })
        .catch((error: unknown) => {
          if (!aliveRef.current) return
          const snapshot = readSnapshot<T>(snapshotKey)
          if (snapshot) {
            setState({
              data: snapshot.data,
              failure: toMemoryFailure(error),
              loading: false,
              stale: true,
              snapshotAt: snapshot.at,
            })
            // 网关恢复后自动回实时：stale 期间低频重试。
            retryTimer = window.setTimeout(run, STALE_RETRY_MS)
          } else {
            setState({ data: null, failure: toMemoryFailure(error), loading: false, stale: false, snapshotAt: null })
          }
        })
    }
    run()
    return () => {
      aliveRef.current = false
      if (retryTimer) window.clearTimeout(retryTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, snapshotKey, ...deps])

  const refresh = useCallback(() => setTick((value) => value + 1), [])
  return { ...state, refresh }
}

export type MemoryTabId = 'overview' | 'conversation' | 'documents' | 'atomic' | 'scenario' | 'core' | 'writing-style' | 'ledger' | 'filter-rules' | 'org-preferences'

/** 翻页/换筛选后把记忆页滚动容器（.mem-content）回顶。 */
export function scrollPaneToTop(): void {
  document.querySelector('.mem-content')?.scrollTo({ top: 0 })
}

export function useMemoryOverview() {
  return useAsyncData<MemoryOverviewDto>(
    () => window.nxcore!.memory.overview(),
  )
}

export function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
