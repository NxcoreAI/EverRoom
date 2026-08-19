export type ConnectorResourceType = 'email' | 'document' | 'calendar' | 'generic'
export type ConnectorJobStatus = 'draft' | 'active' | 'paused' | 'archived'
export type ConnectorScheduleType = 'manual' | 'interval'

export interface ConnectorRetryPolicy {
  maxAttempts: number
  baseDelayMs: number
}

export interface ConnectorSyncJobInput {
  name: string
  service: string
  dataset: string
  resourceType: ConnectorResourceType
  connectionName?: string | null
  allowedActions: string[]
  input: Record<string, unknown>
  goal: string
  promptProfileId?: string | null
  promptOverride?: string | null
  schemaVersion?: number
  scheduleType: ConnectorScheduleType
  intervalMs: number
  timezone: string
  retryPolicy?: ConnectorRetryPolicy
  priority?: number
  status: ConnectorJobStatus
}

export interface ConnectorSyncJob extends ConnectorSyncJobInput {
  id: string
  ownerId: string
  action: string
  promptProfileId: string | null
  promptOverride: string | null
  promptVersion: number
  schemaVersion: number
  retryPolicy: ConnectorRetryPolicy
  priority: number
  configVersion: number
  enabled: boolean
  nextRunAt: string | null
  lastRunAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  checkpoint: Record<string, unknown> | null
  consecutiveFailures: number
  running: boolean
}

export interface ConnectorPromptProfile {
  id: string
  service: string
  resourceType: ConnectorResourceType
  name: string
  version: number
  schemaVersion: number
  contentHash: string
  status: 'draft' | 'published' | 'retired'
  createdAt: string
  updatedAt: string
}

export interface ConnectorAccount {
  id: string
  ownerId: string
  service: string
  connectionName: string
  displayName: string | null
  accountLabel: string | null
  status: 'active' | 'needs_connection' | 'disabled'
  createdAt: string
  updatedAt: string
}

export interface ConnectorSyncRun {
  id: string
  jobId: string
  status: 'running' | 'success' | 'failed' | 'blocked_runtime' | 'needs_connection'
  discovered: number
  inserted: number
  updated: number
  unchanged: number
  quarantined: number
  failed: number
  errorCode: string | null
  errorMessage: string | null
  agentModel: string | null
  promptVersion: number
  promptProfileVersion: number | null
  schemaVersion: number
  renderedPromptHash: string | null
  inputCheckpoint: Record<string, unknown> | null
  outputCheckpoint: Record<string, unknown> | null
  startedAt: string
  finishedAt: string | null
}

export interface ConnectorQuarantinedRecord {
  id: string
  runId: string
  sourceRecordId: string | null
  reason: string
  payload: Record<string, unknown>
  createdAt: string
}

export interface ConnectorDataRecord {
  id: string
  resourceType?: ConnectorResourceType
  service: string
  sourceRecordId: string
  title?: string
  snippet?: string
  syncedAt: string
  sourceUpdatedAt?: string | null
  [key: string]: unknown
}

export interface ConnectorSyncStatus {
  enabled: boolean
  runtimeConfigured: boolean
  jobs: ConnectorSyncJob[]
  recordCount: number
  domainRecordCount: number
}

export interface ConnectorDataQuery {
  service?: string
  dataset?: string
  query?: string
  limit?: number
  includeExpired?: boolean
}
