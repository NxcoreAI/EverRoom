import type { AgentSession, AgentSessionSnapshot, AgentRunStatus } from '@nxcore/agent-contract'
import type { ConnectorSyncJob, ConnectorSyncRun } from '../../../../shared/connector-sync'

export type OfficeAgentId =
  | 'core.conversation'
  | 'core.connector'
  | 'core.document'
  | 'core.memory'
  | 'core.perception'
  | 'core.task'

export type OfficeAgentStatus = 'idle' | 'running' | 'waiting' | 'blocked' | 'error' | 'offline'
export type OfficeActivityStatus = 'running' | 'waiting' | 'completed' | 'failed'

export interface OfficeActivity {
  id: string
  agentId: OfficeAgentId
  status: OfficeActivityStatus
  title: string
  detail: string
  sourceType: 'session' | 'connector_run' | 'connector_job'
  sourceId: string
  updatedAt: string
}
export interface OfficeAgent {
  id: OfficeAgentId
  name: string
  description: string
  icon: 'message' | 'plug' | 'file' | 'brain' | 'radio' | 'list'
  status: OfficeAgentStatus
  activities: OfficeActivity[]
  sessionCount: number
  sourceCount: number
  updatedAt: string | null
}

export const OFFICE_AGENT_DEFINITIONS: ReadonlyArray<Omit<OfficeAgent, 'status' | 'activities' | 'sessionCount' | 'sourceCount' | 'updatedAt'>> = [
  { id: 'core.conversation', name: '对话 Agent', description: '理解请求，组织跨页面的工作', icon: 'message' },
  { id: 'core.connector', name: '连接器 Agent', description: '访问邮箱、日程、文档和第三方服务', icon: 'plug' },
  { id: 'core.document', name: '文档 Agent', description: '创建、编辑和审阅工作文档', icon: 'file' },
  { id: 'core.memory', name: '记忆 Agent', description: '提取、召回和维护长期记忆', icon: 'brain' },
  { id: 'core.perception', name: '感知 Agent', description: '处理录音、转写和会议活动', icon: 'radio' },
  { id: 'core.task', name: '任务 Agent', description: '运行定时任务和后台自动化', icon: 'list' },
]

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>(['accepted', 'running'])

function latestDate(values: Array<string | null | undefined>): string | null {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
}

function formatSessionTitle(session: AgentSession): string {
  return session.title?.trim() || (session.roomId ? 'Context Room 对话' : '全局对话')
}

function buildConversationActivities(snapshots: AgentSessionSnapshot[]): OfficeActivity[] {
  return snapshots.flatMap((snapshot) => {
    const run = snapshot.activeRun
    if (!run) return []
    const isActive = ACTIVE_RUN_STATUSES.has(run.status)
    const isWaiting = run.status === 'accepted'
    return [{
      id: `session:${snapshot.session.id}:${run.id}`,
      agentId: 'core.conversation' as const,
      status: isActive ? (isWaiting ? 'waiting' : 'running') : run.status === 'failed' ? 'failed' : 'completed',
      title: formatSessionTitle(snapshot.session),
      detail: run.prompt.trim().replace(/\s+/gu, ' ').slice(0, 120) || '正在处理用户请求',
      sourceType: 'session' as const,
      sourceId: snapshot.session.id,
      updatedAt: run.completedAt ?? run.startedAt ?? run.createdAt,
    }]
  })
}

function connectorActivityStatus(run: ConnectorSyncRun | undefined, job: ConnectorSyncJob): OfficeActivityStatus {
  if (job.running || run?.status === 'running') return 'running'
  if (run?.status === 'needs_connection' || run?.status === 'blocked_runtime') return 'waiting'
  if (run?.status === 'failed' || Boolean(job.lastError)) return 'failed'
  return 'completed'
}

function buildConnectorActivities(jobs: ConnectorSyncJob[], runsByJob: Map<string, ConnectorSyncRun[]>): OfficeActivity[] {
  return jobs.filter((job) => job.status !== 'archived').flatMap((job) => {
    const latestRun = [...(runsByJob.get(job.id) ?? [])].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]
    const isVisible = job.running || Boolean(latestRun) || Boolean(job.lastError)
    if (!isVisible) return []
    const status = connectorActivityStatus(latestRun, job)
    return [{
      id: `connector:${job.id}:${latestRun?.id ?? 'job'}`,
      agentId: 'core.connector' as const,
      status,
      title: job.name,
      detail: `${job.service} · ${job.resourceType === 'email' ? '邮件' : job.resourceType === 'calendar' ? '日程' : job.resourceType === 'document' ? '文档' : '数据'}`,
      sourceType: latestRun ? 'connector_run' as const : 'connector_job' as const,
      sourceId: latestRun?.id ?? job.id,
      updatedAt: latestRun?.finishedAt ?? latestRun?.startedAt ?? job.lastRunAt ?? job.nextRunAt ?? new Date(0).toISOString(),
    }]
  })
}

function deriveStatus(agent: OfficeAgent, now = Date.now()): OfficeAgentStatus {
  if (agent.activities.some((activity) => activity.status === 'running')) return 'running'
  if (agent.activities.some((activity) => activity.status === 'waiting')) return 'waiting'
  if (agent.activities.some((activity) => activity.status === 'failed')) {
    const updatedAt = agent.updatedAt ? Date.parse(agent.updatedAt) : 0
    if (now - updatedAt < 10 * 60_000) return 'error'
  }
  return 'idle'
}

export function buildOfficeAgents(
  sessions: AgentSession[],
  snapshots: AgentSessionSnapshot[],
  jobs: ConnectorSyncJob[],
  runsByJob: Map<string, ConnectorSyncRun[]>,
  now = Date.now(),
): OfficeAgent[] {
  const conversationActivities = buildConversationActivities(snapshots)
  const connectorActivities = buildConnectorActivities(jobs, runsByJob)
  return OFFICE_AGENT_DEFINITIONS.map((definition) => {
    const activities = definition.id === 'core.conversation'
      ? conversationActivities
      : definition.id === 'core.connector' ? connectorActivities : []
    const matchingSessions = definition.id === 'core.conversation' ? sessions : []
    const updatedAt = latestDate([
      ...activities.map((activity) => activity.updatedAt),
      ...matchingSessions.map((session) => session.updatedAt),
    ])
    const agent: OfficeAgent = {
      ...definition,
      status: 'idle',
      activities: activities.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
      sessionCount: matchingSessions.length,
      sourceCount: definition.id === 'core.connector' ? new Set(jobs.map((job) => job.service)).size : 0,
      updatedAt,
    }
    agent.status = deriveStatus(agent, now)
    return agent
  })
}
