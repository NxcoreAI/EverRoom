/**
 * FA 分析控制台到 Gateway 的 HTTP 客户端。
 *
 * 全部走同源 Vite 代理 `/@agent-debug/*`（Node 侧注入 Bearer token，token 不进
 * 浏览器）；POST 只放行 FA 控制台白名单（模板纯读 / agent run / 投资人匹配），
 * 与 vite.agent-debug.config.mts 的 PROXY_POST_PREFIXES 一致。
 */

const DEBUG_ROOT = '/@agent-debug'

export interface FaConsoleNodeIo {
  label: string
  detail: string
}

export interface FaConsoleNodeExecute {
  method: 'GET' | 'POST'
  path: string
  sampleBody?: Record<string, unknown>
  inputQuery?: string
  paramOptions?: Record<string, Array<{ value: string; label: string }>>
}

export interface FaConsoleNode {
  id: string
  stage: string
  name: string
  kind: 'data' | 'prompt' | 'template'
  description: string
  inputs: FaConsoleNodeIo[]
  outputs: FaConsoleNodeIo[]
  tools: string[]
  execute: FaConsoleNodeExecute | null
}

export interface FaConsoleRoom {
  id: string
  title: string
  kind: string
}

export interface DebugSource {
  id: string
  label: string
  baseUrl: string
  version: string
  backend: 'live' | 'archive'
  available: boolean
}

async function responseError(response: Response): Promise<Error> {
  let detail = ''
  try {
    const body: unknown = await response.json()
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>
      const message = record.message ?? record.error
      if (typeof message === 'string' && message.trim()) detail = message
    }
  } catch {
    // 非 JSON 响应只保留状态码。
  }
  return new Error(`${response.status} ${response.statusText}${detail ? ` · ${detail}` : ''}`)
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw await responseError(response)
  return (await response.json()) as T
}

export async function getJson<T>(sourceId: string, path: string): Promise<T> {
  const response = await fetch(`${DEBUG_ROOT}/gateway/${sourceId}${path}`, { method: 'GET' })
  return readJson<T>(response)
}

export async function postJson<T>(sourceId: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${DEBUG_ROOT}/gateway/${sourceId}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return readJson<T>(response)
}

export async function loadSources(): Promise<DebugSource[]> {
  const response = await fetch(`${DEBUG_ROOT}/sources`)
  if (!response.ok) throw await responseError(response)
  const sources = (await response.json()) as DebugSource[]
  return sources.filter((source) => source.backend === 'live')
}

export function loadNodes(sourceId: string): Promise<{ nodes: FaConsoleNode[] }> {
  return getJson(sourceId, '/v1/fa-console/nodes')
}

export function loadRooms(sourceId: string, kind?: string): Promise<{ items: FaConsoleRoom[] }> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : ''
  return getJson(sourceId, `/v1/fa-console/rooms${query}`)
}

// ── 节点专用数据通道（与网关路由一一对应）──

export interface FactItem {
  id: string
  factId: string
  content: string
  type: string
  grade: string
  numeric: { value?: number; unit?: string; period?: string; currency?: string; audited?: boolean } | null
  sourceKind: string
  sourceId: string
  createdAt: string | null
}

export function loadFacts(sourceId: string, roomId: string, grade?: string): Promise<{ items: FactItem[] }> {
  const query = grade ? `?grade=${encodeURIComponent(grade)}` : ''
  return getJson(sourceId, `/v1/fa-console/rooms/${encodeURIComponent(roomId)}/facts${query}`)
}

export function loadVerifiedFacts(sourceId: string, roomId: string, grade?: string): Promise<{ items: FactItem[] }> {
  const query = grade ? `?grade=${encodeURIComponent(grade)}` : ''
  return getJson(sourceId, `/v1/fa/rooms/${encodeURIComponent(roomId)}/verified-facts${query}`)
}

export interface FaFund {
  id: string
  name: string
  status: string
  currency: string | null
  vintageYear: number | null
  investmentPeriodEnd: number | null
  confirmedBy: string | null
}

export interface FaInvestment {
  id: string
  portfolioCompany: string
  round: string | null
  investedOn: string | null
  role: string
  relationToPortfolio: string
  confirmedBy: string | null
}

export interface FaPosition {
  id: string
  personRoomId: string
  title: string | null
  icMember: boolean | null
  canLead: boolean | null
  sectors: string[] | null
  confirmedBy: string | null
}

export function loadFunds(sourceId: string, roomId: string): Promise<{ items: FaFund[] }> {
  return getJson(sourceId, `/v1/fa/institutions/${encodeURIComponent(roomId)}/funds`)
}

export function loadInvestments(sourceId: string, roomId: string): Promise<{ items: FaInvestment[] }> {
  return getJson(sourceId, `/v1/fa/institutions/${encodeURIComponent(roomId)}/investments`)
}

export function loadPositions(sourceId: string, roomId: string): Promise<{ items: FaPosition[] }> {
  return getJson(sourceId, `/v1/fa/institutions/${encodeURIComponent(roomId)}/positions`)
}

export interface BpTemplateResult {
  ok: boolean
  trackId: string
  stage: string
  moduleCount: number
  brief: string
  error?: string
}

export function loadBpTemplate(
  sourceId: string,
  body: { trackId: string; stage: string; narrativeOrderIndex?: number; includeX01?: boolean; addonIds?: string[] },
): Promise<BpTemplateResult> {
  return postJson(sourceId, '/v1/fa-console/bp-template', body)
}

export interface MatchCandidate {
  institutionRoomId: string
  institutionTitle: string
  passed: boolean
  reasons: string[]
  unknowns: string[]
  fitScore: number
  scoreBreakdown: Array<{ factor: string; points: number; basis: string }>
  portfolioNotes: Array<{ company: string; interpretation: string }>
  positions: Array<{ personRoomId: string; title: string | null; icMember: boolean | null; canLead: boolean | null }>
  latestDisposition: string | null
}

export function runMatch(
  sourceId: string,
  body: {
    projectRoomId: string
    round?: string
    askAmount?: number
    askCurrency?: string
    sectors?: string[]
    comparableCompanies?: string[]
  },
): Promise<{ items: MatchCandidate[] }> {
  return postJson(sourceId, '/v1/fa/match', body)
}

export interface MeetingBrief {
  institution: { id: string; title: string }
  funds: Array<{ name: string; currency: string | null; status: string; investmentPeriodEnd: number | null }>
  positions: Array<{ personRoomId: string; title: string | null; icMember: boolean | null; canLead: boolean | null }>
  relevantInvestments: Array<{ portfolioCompany: string; round: string | null; investedOn: string | null; role: string; relationToPortfolio: string }>
  pastFeedbacks: Array<{ meetingAt: string | null; disposition: string; passReasons: string[] | null; reopenConditions: string | null; status: string }>
  institutionSignals: string[]
  personSignals: string[]
  pendingReopenConditions: string[]
  verifiedProjectFacts: string[]
}

export function loadMeetingBrief(
  sourceId: string,
  query: { projectRoomId: string; institutionRoomId: string; personRoomId?: string },
): Promise<MeetingBrief> {
  const params = new URLSearchParams({ projectRoomId: query.projectRoomId, institutionRoomId: query.institutionRoomId })
  if (query.personRoomId) params.set('personRoomId', query.personRoomId)
  return getJson(sourceId, `/v1/fa/meeting-brief?${params.toString()}`)
}

export interface FeedbackRow {
  id: string
  roomId: string
  institutionRoomId: string | null
  personRoomId: string | null
  meetingAt: string | null
  disposition: string
  passReasons: string[] | null
  reopenConditions: string | null
  projectUpdates: string | null
  status: string
  createdAt?: string
}

export function loadFeedbacks(
  sourceId: string,
  query: { roomId?: string; status?: string } = {},
): Promise<{ items: FeedbackRow[] }> {
  const params = new URLSearchParams()
  if (query.roomId) params.set('roomId', query.roomId)
  if (query.status) params.set('status', query.status)
  const suffix = params.toString() ? `?${params.toString()}` : ''
  return getJson(sourceId, `/v1/fa/feedbacks${suffix}`)
}

// ── 提示词节点：真实 agent run 通道 + trace 读取 ──

export interface AgentSession {
  id: string
  pageLabel: string
  title: string | null
  status: string
  updatedAt: string
}

export function listAgentSessions(sourceId: string): Promise<AgentSession[]> {
  return getJson(sourceId, '/v1/agent/sessions')
}

export function createAgentSession(
  sourceId: string,
  pageLabel: string,
): Promise<AgentSession> {
  return postJson(sourceId, '/v1/agent/sessions', { pageLabel })
}

export interface AgentRun {
  id: string
  sessionId: string
  status: string
  prompt: string
  error: string | null
  createdAt: string
}

export function startAgentRun(
  sourceId: string,
  sessionId: string,
  prompt: string,
  idempotencyKey: string,
): Promise<AgentRun> {
  return postJson(sourceId, `/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs`, {
    prompt,
    idempotencyKey,
    captureMemory: false,
    recallMemory: false,
  })
}

export interface DebugRun {
  runId: string
  agentId: string
  agentName: string
  sessionId: string | null
  task: string
  status: string
  startedAt: string
  completedAt: string | null
  toolCallCount: number
  reasoningChars: number
  errorMessage: string | null
}

export interface DebugEvent {
  seq: number
  type: string
  occurredAt: string
  payload: unknown
}

export interface DebugRunEvents {
  run: DebugRun
  events: DebugEvent[]
  latestSeq: number
}

export function loadSnapshot(sourceId: string): Promise<{ runs: DebugRun[] }> {
  return getJson(sourceId, '/v1/agent-debug/snapshot?runs=100')
}

export function loadRunEvents(sourceId: string, runId: string, afterSeq = 0): Promise<DebugRunEvents> {
  return getJson(sourceId, `/v1/agent-debug/runs/${encodeURIComponent(runId)}/events?afterSeq=${afterSeq}&limit=3000`)
}
