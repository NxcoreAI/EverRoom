export type ExternalCallService = 'WEB_SEARCH' | 'MCP' | 'CONNECTOR'
export type ExternalCallPeriod = 'UTC_DAY' | 'UTC_MONTH'
export type ExternalCallEnforcement = 'BLOCK' | 'AUDIT_ONLY'
export type ExternalCallScope = 'user' | 'workspace' | 'service'

export interface ExternalCallPolicyInput {
  id?: string
  subjectScope: 'service'
  subjectId: ExternalCallService
  service: ExternalCallService
  period: ExternalCallPeriod
  limit: number
  warningThreshold: number
  enforcement: ExternalCallEnforcement
}

export interface ExternalCallPolicy extends Omit<ExternalCallPolicyInput, 'subjectScope'> {
  subjectScope: ExternalCallScope
  id: string
  createdAt: string
  updatedAt: string
}

export interface ExternalCallUsage {
  policyId: string
  subjectScope: ExternalCallScope
  subjectId: string
  service: ExternalCallService
  period: ExternalCallPeriod
  periodStart: string
  reservedCalls: number
  consumedCalls: number
  limit: number
  warningThreshold: number
  enforcement: ExternalCallEnforcement
  nearLimit: boolean
  atLimit: boolean
}

export interface ExternalCallAudit {
  id: string
  subjectScope: ExternalCallScope
  subjectId: string
  workspaceId: string | null
  userId: string | null
  service: ExternalCallService
  tool: string
  occurredAt: string
  source: string
  runId: string | null
  correlationId: string | null
  reservedCalls: number
  consumedCalls: number
  durationMs: number
  outcome: 'SUCCEEDED' | 'FAILED' | 'RELEASED' | 'BLOCKED'
  failureCode: 'PROVIDER_FAILURE' | 'NOT_DISPATCHED' | 'BUDGET_EXCEEDED' | 'CANCELLED' | null
}

export interface ExternalCallPage<T> {
  items: T[]
  limit: number
  offset: number
  total: number
}

export interface ExternalCallQuery {
  service?: ExternalCallService
  subjectScope?: ExternalCallScope
  subjectId?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}
