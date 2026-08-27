export interface NormalizedMigrationThread {
  stableKey: string
  agentId?: string
  externalSessionId: string
  title: string
  messages: Array<{ stableKey: string; role: 'user' | 'assistant'; content: string; occurredAt: string }>
}
