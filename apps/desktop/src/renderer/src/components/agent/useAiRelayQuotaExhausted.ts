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
 * 订阅主进程中转保活事件，跟踪「LLM 额度已用尽」状态：
 * - `quota-exhausted`（SaaS 403 权威判定）置位；`fallback-restored` /
 *   重新签发成功（无事件到达）时由 status 复核兜底复位。
 * - 挂载时先查一次 `aiRelay.status()`：跨窗口重启后事件丢失的场景，
 *   以 remainingCredits <= 0 且已配置为准。
 */
export function useAiRelayQuotaExhausted(): boolean {
  const [exhausted, setExhausted] = useState(false)

  useEffect(() => {
    const api = window.nxcore?.aiRelay
    if (!api) return undefined

    let cancelled = false
    const reconcile = () => {
      void api.status()
        .then((status) => {
          if (cancelled) return
          // 未配置/无订阅记录时 data 为 null——不构成额度不足。
          if (status?.configured && status.remainingCredits <= 0) setExhausted(true)
        })
        .catch(() => undefined)
    }

    reconcile()
    const removeListener = api.onEvent((event) => {
      if (event.type === 'quota-exhausted') {
        setExhausted(true)
        return
      }
      // 网络兜底切换/恢复都不代表额度恢复，复核一次服务端余量。
      if (event.type === 'fallback-user' || event.type === 'fallback-restored') reconcile()
    })
    return () => {
      cancelled = true
      removeListener()
    }
  }, [])

  return exhausted
}
