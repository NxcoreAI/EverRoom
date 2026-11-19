import { useEffect, useState } from 'react'

/**
 * 判定一条会话错误是否为「中转会话未激活」（额度耗尽后 AiRelayKeeper 会清掉
 * gateway 的中转会话，后续 Agent 运行经 /ai-relay 代理拿到的就是这条 503）。
 * 上游报错原文形如：
 *   503: {"message":"AI relay session is not active","type":"ai_relay_not_ready","code":"ai_relay_not_ready"}
 */
export function isAiRelayNotReadyError(message: string): boolean {
  return message.includes('ai_relay_not_ready') || message.includes('AI relay session is not active')
}

/**
 * 跟踪「本周期 LLM 额度已用尽」（SaaS 403/402 权威判定）：
 * - 以 `aiRelay.verdict().quotaExhausted` 为准——直接映射主进程 keeper 的
 *   权威标记，不自行从余量推断（已配置但余额为 0 的按量/未订阅态语义不同）。
 * - `quota-exhausted` 事件即时置位；`session-activated`（续签成功，充值/周期
 *   重置后发出）复核 verdict，避免组件长挂期间状态不复位。
 * - 挂载时先查一次：覆盖窗口重启后事件丢失的场景。
 */
export function useAiRelayQuotaExhausted(): boolean {
  const [exhausted, setExhausted] = useState(false)

  useEffect(() => {
    const api = window.nxcore?.aiRelay
    if (!api?.verdict || !api.onEvent) return undefined

    let cancelled = false
    const reconcile = () => {
      void api.verdict()
        .then((verdict) => { if (!cancelled) setExhausted(verdict.quotaExhausted) })
        .catch(() => undefined)
    }

    reconcile()
    const removeListener = api.onEvent((event) => {
      if (event.type === 'quota-exhausted') setExhausted(true)
      // 会话重新激活（充值/周期重置后续签成功）：复核权威标记，可能复位。
      else if (event.type === 'session-activated') reconcile()
    })
    return () => {
      cancelled = true
      removeListener()
    }
  }, [])

  return exhausted
}
