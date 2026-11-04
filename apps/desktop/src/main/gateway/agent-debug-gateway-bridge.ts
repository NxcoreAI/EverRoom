import type { GatewayConnection, GatewaySupervisor } from './gateway-supervisor'
import type { AgentDebugAgentResponse, AgentDebugAgentsResponse, AgentDebugUsageResponse } from '../../shared/agent-debug'

/**
 * Agent 调试面板的网关桥：只读的 /v1/agent-debug/*（Agent 列表 + 单个 Agent 的
 * 上下文详情）的桌面侧出口。模式同 AgentAccessGatewayBridge
 * （ensureConnection + bearer + 可恢复连接重试），另加 15s 超时——面板是纯读
 * 接口，网关卡住时应把可读错误尽快交回渲染层，而不是让 IPC 无限挂起。
 */

export type { AgentDebugAgentResponse, AgentDebugAgentsResponse, AgentDebugUsageResponse } from '../../shared/agent-debug'

const REQUEST_TIMEOUT_MS = 15_000

const RECOVERABLE_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
])

function isRecoverableConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const cause = error.cause
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && RECOVERABLE_CONNECTION_ERROR_CODES.has(code)) return true
  }
  return error instanceof TypeError && /fetch failed|network|socket/i.test(error.message)
}

/** AbortSignal.timeout 触发时 Node 抛 DOMException（name 为 TimeoutError/AbortError）。 */
function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'TimeoutError' || error.name === 'AbortError'
}

function readableRequestError(error: unknown): Error {
  if (isTimeoutError(error)) return new Error(`Agent 调试请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒）。`)
  return error instanceof Error ? error : new Error('Agent 调试请求失败。')
}

export class AgentDebugGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  listAgents(): Promise<AgentDebugAgentsResponse> {
    return this.request('/v1/agent-debug/agents')
  }

  getAgent(id: string): Promise<AgentDebugAgentResponse> {
    return this.request(`/v1/agent-debug/agents/${encodeURIComponent(id)}`)
  }

  /** 使用记录（内置 Agent = agent_runs，子 Agent = subagent_invocations）；不传 limit 由网关取默认条数。 */
  listUsage(id: string, limit?: number): Promise<AgentDebugUsageResponse> {
    const query = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`
    return this.request(`/v1/agent-debug/agents/${encodeURIComponent(id)}/usage${query}`)
  }

  private async request<T>(path: string): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    try {
      return await this.requestWithConnection<T>(connection, path)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw readableRequestError(error)
      const recovered = await this.supervisor.recoverConnection(connection)
      try {
        return await this.requestWithConnection<T>(recovered, path)
      } catch (retryError) {
        throw readableRequestError(retryError)
      }
    }
  }

  private async requestWithConnection<T>(connection: GatewayConnection, path: string): Promise<T> {
    const response = await fetch(`${connection.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null
      throw new Error(typeof body?.message === 'string' ? body.message
        : typeof body?.error === 'string' ? body.error : `Agent 调试请求失败（${String(response.status)}）`)
    }
    return response.json() as Promise<T>
  }
}