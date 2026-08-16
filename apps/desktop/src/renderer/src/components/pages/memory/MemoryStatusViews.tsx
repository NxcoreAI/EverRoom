import { PowerOff, RefreshCw, Unplug } from 'lucide-react'

import type { MemoryFailure } from './useMemoryData'

export function MemoryDisabledView() {
  return (
    <div className="mem-status" data-kind="disabled">
      <PowerOff aria-hidden="true" strokeWidth={1.6} />
      <h2>记忆服务未启用</h2>
      <p>
        EverRoom 通过 TencentDB Agent Memory（MemoryCore）沉淀长期记忆。
        在网关配置 <code>NXCORE_MEMORY_ENABLED=true</code> 并指向运行中的 MemoryCore 实例后，
        与 AI 助手的对话将自动提炼为记忆。
      </p>
    </div>
  )
}

export function MemoryUnreachableView({ failure, onRetry }: {
  failure: MemoryFailure
  onRetry: () => void
}) {
  return (
    <div className="mem-status" data-kind="unreachable">
      <Unplug aria-hidden="true" strokeWidth={1.6} />
      <h2>无法连接记忆服务</h2>
      <p>{failure.message}MemoryCore 是独立进程，可能晚于 EverRoom 启动。</p>
      <button type="button" className="mem-retry" onClick={onRetry}>
        <RefreshCw aria-hidden="true" strokeWidth={1.8} />重试
      </button>
    </div>
  )
}

export function MemoryEmptyView({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mem-status" data-kind="empty">
      <h2>{title}</h2>
      {hint ? <p>{hint}</p> : null}
    </div>
  )
}
