import { useCallback, useEffect, useRef, useState } from 'react'

import type { MemoryOverviewDto } from '../../../../../shared/memory'

/** 记忆功能的失败分类，决定降级 UI。 */
export interface MemoryFailure {
  kind: 'disabled' | 'unreachable' | 'error'
  message: string
}

/** IPC 错误 message 中带有 gateway 的 `[memory_*]` 前缀；据此分类。 */
export function toMemoryFailure(error: unknown): MemoryFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('[memory_disabled]')) {
    return { kind: 'disabled', message: '记忆服务未启用。' }
  }
  if (message.includes('[memory_unreachable]')) {
    return { kind: 'unreachable', message: 'MemoryCore 记忆服务暂时不可达。' }
  }
  if (message.includes('[memory_error]')) {
    return { kind: 'error', message: message.replace(/\[memory_error\]\s*/, '') || '记忆服务请求失败。' }
  }
  return { kind: 'unreachable', message: '记忆数据请求失败，请确认网关与 MemoryCore 正在运行。' }
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

export type MemoryTabId = 'overview' | 'conversation' | 'documents' | 'atomic' | 'scenario' | 'core'

export function useMemoryOverview() {
  return useAsyncData<MemoryOverviewDto>(
    () => window.nxcore!.memory.overview(),
  )
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
