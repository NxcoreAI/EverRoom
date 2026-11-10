import type {
  AgentDebugAgentKind,
  AgentDebugRunStatus,
} from '@nxcore/agent-contract'
import { useEffect, useState } from 'react'

import { elapsedMs, formatClock, formatDuration } from '../format'

export const AGENT_KIND_LABEL: Record<AgentDebugAgentKind, string> = {
  builtin: '内置',
  developer: '子 Agent',
  local: '本机',
}

const RUN_STATUS_LABEL: Record<AgentDebugRunStatus, string> = {
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '取消',
  interrupted: '中断',
  timed_out: '超时',
}

export function runStatusLabel(status: AgentDebugRunStatus): string {
  return RUN_STATUS_LABEL[status] ?? status
}

/** 运行中按秒自增的耗时（各自独立计时，避免整页每秒重渲染）。 */
export function LiveDuration({ startedAt, completedAt, running, title }: {
  startedAt: string | null | undefined
  completedAt: string | null | undefined
  running: boolean
  title?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const duration = elapsedMs(startedAt, running ? null : completedAt, now)
  return (
    <span title={title ?? `开始于 ${formatClock(startedAt)}`}>
      {formatDuration(duration)}
    </span>
  )
}
