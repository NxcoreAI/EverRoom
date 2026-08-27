export interface NotificationPreferences {
  enabled: boolean
  iosEnabled: boolean
  macosEnabled: boolean
}

export interface AgentNotificationTarget {
  kind: 'agent_session'
  notificationId: string
  sourceDeviceId: string
  sessionId: string
  runId: string
  roomId: string | null
}

export interface AgentNotificationRequest {
  title: string
  body: string
  platforms: Array<'ios' | 'macos'>
  sessionId: string
  runId: string
  roomId: string | null
  idempotencyKey: string
}

export interface AgentNotificationResult {
  notificationId: string
  deliveryCount: number
  createdAt: string
  deduplicated: boolean
}

export interface CloudAgentSessionSummary {
  id: string
  roomId: string | null
  pageLabel: string
  runtimeId: string
  title: string | null
  status: 'idle' | 'running' | 'interrupted' | 'closed'
  createdAt: string
  updatedAt: string
}

export interface CloudAgentMessage {
  id: string
  sessionId?: string
  runId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
}

export interface CloudAgentMessagePage {
  items: CloudAgentMessage[]
  nextBefore: string | null
}

function nonEmptyString(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null
}

export function parseAgentNotificationTarget(value: unknown): AgentNotificationTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  let candidate = root
  if (root.userInfo && typeof root.userInfo === 'object' && !Array.isArray(root.userInfo)) {
    candidate = root.userInfo as Record<string, unknown>
  }
  if (candidate.everroom && typeof candidate.everroom === 'object' && !Array.isArray(candidate.everroom)) {
    candidate = candidate.everroom as Record<string, unknown>
  }
  const notificationId = nonEmptyString(candidate.notificationId)
  const sourceDeviceId = nonEmptyString(candidate.sourceDeviceId)
  const sessionId = nonEmptyString(candidate.sessionId)
  const runId = nonEmptyString(candidate.runId)
  if (candidate.kind !== 'agent_session' || !notificationId || !sourceDeviceId || !sessionId || !runId) return null
  return {
    kind: 'agent_session',
    notificationId,
    sourceDeviceId,
    sessionId,
    runId,
    roomId: nonEmptyString(candidate.roomId) ?? null,
  }
}
