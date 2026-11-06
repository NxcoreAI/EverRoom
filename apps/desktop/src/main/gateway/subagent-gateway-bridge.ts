import type {
  SubagentInvocation,
  SubagentInvocationEvent,
  SubagentInvocationNode,
} from '@nxcore/agent-contract'

import type { SubagentSelectionRewriteInput } from '../../shared/sources'

import type { GatewaySupervisor } from './gateway-supervisor'

/**
 * 子代理调用桥：只保留仍活的 `/v1/subagent-invocations/*` 与划词改写派发。
 * 划词改写随 Context Room 模块删除迁到文档路由（Phase 2i-2），入参不再带 roomId。
 */
export class SubagentGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  /** 划词改写：派发 doc-writer 的 rewrite task，立即返回 invocationId（不等待终态）。 */

  getSubagentInvocation(invocationId: string): Promise<SubagentInvocation> {
    return this.request(`/v1/subagent-invocations/${encodeURIComponent(invocationId)}`)
  }

  /** 一次 run 的子代理调用树（含嵌套后代），对话时间线渲染用。 */
  listRunSubagentInvocations(rootRunId: string): Promise<SubagentInvocationNode[]> {
    return this.request(`/v1/subagent-invocations?rootRunId=${encodeURIComponent(rootRunId)}`)
  }

  /** 一次调用的执行事件（含每次工具调用），afterSeq 增量拉取。 */
  listSubagentInvocationEvents(invocationId: string, afterSeq = 0): Promise<SubagentInvocationEvent[]> {
    return this.request(`/v1/subagent-invocations/${encodeURIComponent(invocationId)}/events?afterSeq=${afterSeq}`)
  }

  cancelSubagentInvocation(invocationId: string): Promise<SubagentInvocation> {
    return this.request(`/v1/subagent-invocations/${encodeURIComponent(invocationId)}/cancel`, { method: 'POST' })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${connection.token}`)
    if (init?.body !== undefined && init.body !== null) headers.set('Content-Type', 'application/json')
    const response = await fetch(`${connection.baseUrl}${path}`, { ...init, headers })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      const message = typeof body?.message === 'string'
        ? body.message
        : typeof body?.error === 'string'
          ? body.error
          : `子代理请求失败（${response.status}）`
      throw new Error(message)
    }
    return response.json() as Promise<T>
  }
}
