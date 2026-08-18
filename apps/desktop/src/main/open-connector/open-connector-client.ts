import type { OpenConnectorConnectionSummary } from '../../shared/open-connector'

interface ResponseEnvelope<T> {
  success?: boolean
  message?: string
  data?: T
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export class OpenConnectorAdminClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminToken: string,
  ) {}

  async listConnections(): Promise<OpenConnectorConnectionSummary[]> {
    const payload = await this.request<unknown>('/api/connections')
    const root = objectValue(payload)
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(root.connections) ? root.connections : []

    return items.flatMap((item) => {
      const connection = objectValue(item)
      const profile = objectValue(connection.profile)
      const service = text(connection.service) ?? text(connection.provider)
      if (!service) return []
      const connectionName = text(connection.connectionName) ?? text(connection.name)
      const profileScopes = stringList(profile.grantedScopes)
      return [{
        service,
        connectionName,
        displayName: text(profile.displayName)
          ?? text(profile.username)
          ?? text(connection.accountLabel)
          ?? connectionName
          ?? service,
        accountId: text(profile.accountId) ?? text(connection.accountId),
        authType: text(connection.authType) ?? 'unknown',
        status: text(connection.status) ?? 'connected',
        scopes: profileScopes.length > 0 ? profileScopes : stringList(connection.scopes),
        isDefault: connection.isDefault === true || connectionName === null,
      }]
    })
  }

  async health(runtimeToken?: string): Promise<boolean> {
    try {
      const response = await fetch(new URL('/v1/health', this.baseUrl), {
        headers: runtimeToken ? { authorization: `Bearer ${runtimeToken}` } : undefined,
        signal: AbortSignal.timeout(2_000),
      })
      if (!response.ok) return false
      const result = await response.json() as ResponseEnvelope<{ ok?: boolean }>
      return result.success === true && result.data?.ok === true
    } catch {
      return false
    }
  }

  private async request<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      headers: { authorization: `Bearer ${this.adminToken}` },
      signal: AbortSignal.timeout(15_000),
    })
    const payload = await response.json().catch(() => null) as ResponseEnvelope<T> | null
    if (!response.ok) {
      throw new Error(payload?.message || `OpenConnector 请求失败（${response.status}）。`)
    }
    return (payload?.data ?? payload) as T
  }
}

