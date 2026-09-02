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
