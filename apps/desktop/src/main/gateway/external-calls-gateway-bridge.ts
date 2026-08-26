import type {
  ExternalCallAudit,
  ExternalCallPage,
  ExternalCallPolicy,
  ExternalCallPolicyInput,
  ExternalCallQuery,
  ExternalCallUsage,
} from '../../shared/external-calls'
import { redactDesktopText } from '../security/secret-redaction'
import type { GatewaySupervisor } from './gateway-supervisor'

function queryString(query: ExternalCallQuery = {}): string {
  const values = Object.entries(query).filter(([, value]) => value !== undefined)
  return values.length ? `?${new URLSearchParams(values.map(([key, value]) => [key, String(value)])).toString()}` : ''
}

export class ExternalCallsGatewayBridge {
  constructor(private readonly supervisor: GatewaySupervisor) {}

  listPolicies(query?: ExternalCallQuery): Promise<ExternalCallPage<ExternalCallPolicy>> {
    return this.request(`/v1/external-calls/policies${queryString(query)}`)
  }

  savePolicy(input: ExternalCallPolicyInput): Promise<ExternalCallPolicy> {
    return this.request('/v1/external-calls/policies', { method: 'PUT', body: JSON.stringify(input) })
  }

  deletePolicy(id: string): Promise<void> {
    return this.request(`/v1/external-calls/policies/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  listUsage(query?: ExternalCallQuery): Promise<ExternalCallPage<ExternalCallUsage>> {
    return this.request(`/v1/external-calls/usage${queryString(query)}`)
  }

  listAudits(query?: ExternalCallQuery): Promise<ExternalCallPage<ExternalCallAudit>> {
    return this.request(`/v1/external-calls/audits${queryString(query)}`)
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    const response = await fetch(`${connection.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: unknown; error?: unknown } | null
      const message = typeof body?.message === 'string' ? body.message
        : typeof body?.error === 'string' ? body.error : `External call request failed (${response.status})`
      throw new Error(redactDesktopText(message))
    }
    if (response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }
}
