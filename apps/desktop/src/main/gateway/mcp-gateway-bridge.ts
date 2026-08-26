import type { McpServersMutation, McpServersSnapshot } from '../../shared/mcp'
import { redactDesktopText, registerDesktopSecret } from '../security/secret-redaction'
import type { GatewaySupervisor } from './gateway-supervisor'

/** 渲染器 → gateway agent MCP 管理路由的 IPC 桥（Bearer token 只在主进程）。 */
export class McpGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  list(): Promise<McpServersSnapshot> {
    return this.request('/v1/agent/mcp/servers')
  }

  save(servers: McpServersMutation): Promise<McpServersSnapshot> {
    for (const definition of Object.values(servers)) {
      for (const mutations of [definition.env, definition.headers]) {
        for (const mutation of Object.values(mutations ?? {})) {
          if (mutation.operation === 'set') registerDesktopSecret(mutation.value)
        }
      }
    }
    return this.request('/v1/agent/mcp/servers', {
      method: 'PUT',
      body: JSON.stringify({ servers }),
    })
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = this.supervisor.getConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null
      const message = typeof body?.message === 'string' && body.message
        ? body.message
        : typeof body?.error === 'string' ? body.error : `MCP 配置请求失败（${response.status}）`
      throw new Error(redactDesktopText(message))
    }
    return response.json() as Promise<T>
  }
}
