import { useEffect, useRef, useState } from 'react'

import {
  foldSubagentToolEvents,
  type DisplayAgentToolCall,
} from './agentRunActivity'

const POLL_INTERVAL_MS = 1_000

/**
 * 一次子代理调用的工具流。活跃调用每秒增量轮询（afterSeq 递进到本地最大 seq），
 * 终态调用首次展开时拉一次即停。拉取失败静默降级——嵌套工具流只是子代理行的
 * 附加展示，缺席不应影响时间线主流程。
 */
export function useSubagentInvocationTools(
  invocationId: string | undefined,
  active: boolean,
  enabled: boolean,
): DisplayAgentToolCall[] {
  const [tools, setTools] = useState<DisplayAgentToolCall[]>([])
  const loadedIdRef = useRef<string | undefined>(undefined)
  const afterSeqRef = useRef(0)
  const toolsRef = useRef<DisplayAgentToolCall[]>([])

  // 换调用重置：数据留在 state 里清空，重置逻辑放 effect（非渲染期），严格模式双跑安全。
  useEffect(() => {
    if (loadedIdRef.current === invocationId) return
    loadedIdRef.current = invocationId
    afterSeqRef.current = 0
    toolsRef.current = []
    setTools([])
  }, [invocationId])

  useEffect(() => {
    const api = window.nxcore?.contextRooms
    if (!api?.listSubagentInvocationEvents || !invocationId || !enabled) return undefined
    let cancelled = false
    const load = async () => {
      try {
        const events = await api.listSubagentInvocationEvents(invocationId, afterSeqRef.current)
        if (cancelled || !events.length) return
        // 接口按 seq 升序返回，末尾即最新；本地已有部分时做增量折叠。
        afterSeqRef.current = events[events.length - 1]!.seq
        const next = foldSubagentToolEvents(toolsRef.current, invocationId, events)
        toolsRef.current = next
        setTools(next)
      } catch {
        // 静默降级：下次 tick 重试
      }
    }
    void load()
    if (!active) return () => {
      cancelled = true
    }
    const timer = window.setInterval(load, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [active, enabled, invocationId])

  return tools
}
