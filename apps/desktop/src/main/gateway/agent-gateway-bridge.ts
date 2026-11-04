import type {
  AgentEvent,
  AgentActiveFileContext,
  AgentOpenFileContext,
  AgentPermissionMode,
  AgentPermissionModeState,
  AgentThinkingLevel,
  AgentThinkingLevelUpdate,
  AgentSpaceCandidate,
  AgentSpaceDefaultRoot,
  AgentSpaceDetectResult,
  AgentSpaceLayout,
  AgentSpaceBackfillReport,
  AgentSpaceCacheGcResult,
  AgentSpaceCacheStats,
  AgentScratchListing,
  AgentSpaceReconcileReport,
  AgentSpaceRepairReport,
  AgentWorkspace,
  CreateAgentWorkspaceInput,
  UpdateAgentWorkspaceInput,
  WorkspaceActivityPage,
  WorkspaceActivityQuery,
  PendingAgentIntent,
  AgentRun,
  AgentStatusSnapshot,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  AgentUsageRange,
  AgentUsageSnapshot,
  AgentSocketFrame,
  CreateAgentSessionInput,
  CreateAgentSessionLinkInput,
  StartAgentRunInput,
  SubmitPendingAgentIntentInput,
  UpdateAgentSessionInput,
  PlanItem,
  PlanItemEvent,
  PlanItemListQuery,
  CreatePlanItemInput,
  UpdatePlanItemInput,
  MovePlanItemInput,
  PlanAssignResult,
  PlanClaimPackage,
  PlanBatchInput,
  PlanBatchResult,
} from '@nxcore/agent-contract'
import { isAgentSocketFrame } from '@nxcore/agent-contract'
import type {
  AgentPersonaDto, AgentSkillDetailDto, AgentSkillDto, AgentSkillsSnapshotDto,
  CreateAgentSkillInput, JournalTodayDto, MemoryEntryDto, MemoryProfileDto,
} from '../../shared/sources'
import type { AxiosRequestConfig } from 'axios'
import { isAxiosError } from 'axios'
import type { WebContents } from 'electron'
import WebSocket from 'ws'
import type { LocalAgentDispatchDetail } from '../../shared/local-agents'
import type { AgentApprovalDecision } from '../../shared/sources'
import { desktopText } from '../desktop-locale'
import { createLoggedHttpClient } from '../network/http-client'
import type { GatewaySupervisor } from './gateway-supervisor'
import { WebContentsLifecycle } from './web-contents-lifecycle'

const AGENT_EVENT_CHANNEL = 'agent:event'
const http = createLoggedHttpClient('gateway-agent')
const RECOVERABLE_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ERR_SOCKET_CLOSED',
])

function isRecoverableConnectionError(error: unknown): boolean {
  if (!isAxiosError(error)) return false
  if (error.code && RECOVERABLE_CONNECTION_ERROR_CODES.has(error.code)) return true
  return typeof error.message === 'string' && /socket hang up/i.test(error.message)
}

/** openFiles 的条目带 active 标记；activeFile 的 schema 不允许这个字段。 */
function stripOpenFileFlag(file: AgentOpenFileContext): AgentActiveFileContext {
  const { active: _active, ...rest } = file
  return rest
}

interface Subscription {
  sessionId: string
  socket: WebSocket | null
  closed: boolean
  reconnectTimer: NodeJS.Timeout | null
}

interface PlanSubscription {
  workspaceId: string
  controller: AbortController
  closed: boolean
  reconnectTimer: NodeJS.Timeout | null
}

interface RunWatch {
  sessionId: string
  socket: WebSocket | null
  reconnectTimer: NodeJS.Timeout | null
  closed: boolean
}

export class AgentGatewayBridge {
  private readonly subscriptions = new Map<number, Subscription>()
  private readonly contentsLifecycle = new WebContentsLifecycle()
  /** 每个窗口可同时订阅多个空间（两个工作空间标签都停在计划页时）。 */
  private readonly planSubscriptions = new Map<number, Map<string, PlanSubscription>>()
  private readonly runWatches = new Map<string, RunWatch>()
  private eventObserver: ((event: AgentEvent) => void) | null = null

  constructor(
    private readonly supervisor: GatewaySupervisor,
    private readonly activity?: {
      trackRun(run: AgentRun): void
      trackEvent(event: AgentEvent): void
    },
    options: {
      eventChannel?: string
      /**
       * 主进程侧的「用户当前正在浏览的 Office 文件」取值器：每次 startRun 时
       * 注入 context.activeFile。放在 main 而不是渲染端——页签状态只有 main 的
       * Office 预览注册表是权威（焦点实例），且所有入口（输入框/卡片/AI 修改）
       * 都经过这里，不会漏。
       */
      activeFile?: () => AgentActiveFileContext | null
      /**
       * 工作区当前打开的全部 Office 页签（含 active 标记）。给了它就不必再单独
       * 给 activeFile：焦点项会从清单里推出来，两份数据不会互相打架。
       */
      openFiles?: () => readonly AgentOpenFileContext[]
    } = {},
  ) {
    // 默认 'agent:event' 是主 Agent UI 的通道；补全等旁路桥必须传独立
    // channel，否则两个桥的 websocket 帧会在同一渲染进程通道里串台。
    this.eventChannel = options.eventChannel ?? AGENT_EVENT_CHANNEL
    this.activeFile = options.activeFile ?? null
    this.openFiles = options.openFiles ?? null
  }

  private readonly eventChannel: string
  private readonly activeFile: (() => AgentActiveFileContext | null) | null
  private readonly openFiles: (() => readonly AgentOpenFileContext[]) | null

  setEventObserver(observer: ((event: AgentEvent) => void) | null): void {
    this.eventObserver = observer
  }

  startRemoteRun(input: { commandId: string; idempotencyKey: string; prompt: string; title?: string; sessionId?: string }): Promise<AgentRun> {
    if (input.sessionId) {
      return this.startRun(input.sessionId, {
        prompt: input.prompt,
        idempotencyKey: input.idempotencyKey,
        toolsEnabled: false,
      })
    }
    return this.request<AgentRun>('/v1/agent/remote/commands', { method: 'POST', data: input })
      .then((run) => { this.activity?.trackRun(run); this.watchRun(run); return run })
  }

  cancelRemoteRun(commandId: string, runId?: string, sessionId?: string): Promise<AgentRun> {
    return this.request<AgentRun>(`/v1/agent/remote/commands/${encodeURIComponent(commandId)}/cancel`, {
      method: 'POST',
      data: { ...(runId ? { runId } : {}), ...(sessionId ? { sessionId } : {}) },
    })
  }

  getStatus(): Promise<AgentStatusSnapshot> {
    return this.request('/v1/agent/status')
  }

  /** 单个 Agent 的人格定义（名称/简介/系统提示词/技能），「智能体」页人格段用。 */
  getAgentDefinition(agentId: string): Promise<AgentPersonaDto> {
    return this.request(`/v1/agent/definition/${encodeURIComponent(agentId)}`)
  }

  /** 「技能」页清单：内置 Agent bundle 与子 Agent 清单里的 SKILL.md。 */
  listSkills(): Promise<AgentSkillsSnapshotDto> {
    return this.request('/v1/skills')
  }

  /** 技能详情（含 SKILL.md 全文）。 */
  async getSkill(skillId: string): Promise<AgentSkillDetailDto | null> {
    try {
      return await this.request<AgentSkillDetailDto>(`/v1/skills/${encodeURIComponent(skillId)}`)
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return null
      throw error
    }
  }

  /** 启停技能；网关落库后立即重装运行时。 */
  setSkillEnabled(skillId: string, enabled: boolean): Promise<AgentSkillDto> {
    return this.request<AgentSkillDto>(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      data: { enabled },
    })
  }

  /** 手写一个用户技能（网关生成 SKILL.md 并立即重装运行时）。 */
  createSkill(input: CreateAgentSkillInput): Promise<AgentSkillDto> {
    return this.request<AgentSkillDto>('/v1/skills', { method: 'POST', data: input })
  }

  /** 从一个含 SKILL.md 的本地文件夹导入技能。 */
  importSkillDirectory(sourceDirectory: string): Promise<AgentSkillDto> {
    return this.request<AgentSkillDto>('/v1/skills/import', {
      method: 'POST',
      data: { sourceDirectory },
    })
  }

  /** 删除用户技能（网关同时重装运行时）。 */
  deleteSkill(skillId: string): Promise<void> {
    return this.request<{ removed: boolean }>(`/v1/skills/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
    }).then(() => undefined)
  }

  /** 长期记忆条目（hippo-memory，网关进程内库）。 */
  listMemoryEntries(input: { limit?: number; scope?: string } = {}): Promise<{ items: MemoryEntryDto[] }> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.scope !== undefined) query.set('scope', input.scope)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request(`/v1/memory/entries${suffix}`)
  }

  /**
   * 用户画像（网关 `/v1/memory/profile`）：聚合产物优先，没有聚合时按标签兜底分组。
   * 分组口径只维护在网关侧，渲染层不做标签白名单——两处各一份必然对不上。
   */
  getMemoryProfile(input: { limit?: number } = {}): Promise<MemoryProfileDto> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return this.request(`/v1/memory/profile${suffix}`)
  }

  /** 当天日记的当前版本（主页「今日洞察」）。无条目时 entry=null，不是错误。 */
  getJournalToday(): Promise<JournalTodayDto> {
    return this.request('/v1/journal/today')
  }

  /** 手动重写当天日记（绕过最小间隔；去抖与单飞行仍在网关侧生效）。 */
  refreshJournal(): Promise<JournalTodayDto> {
    return this.request('/v1/journal/refresh', { method: 'POST' })
  }

  /** 计划看板：本空间的全部任务（服务端按 rank 排序，渲染层按列分组）。 */
  listPlanItems(query: PlanItemListQuery): Promise<{ items: PlanItem[] }> {
    const search = new URLSearchParams({ workspaceId: query.workspaceId })
    if (query.status) search.set('status', query.status)
    if (query.owner) search.set('owner', query.owner)
    if (query.q) search.set('q', query.q)
    if (query.limit) search.set('limit', String(query.limit))
    return this.request(`/v1/plan/items?${search.toString()}`)
  }

  createPlanItem(input: CreatePlanItemInput): Promise<PlanItem> {
    return this.request('/v1/plan/items', { method: 'POST', data: input })
  }

  getPlanItem(itemId: string): Promise<PlanItem> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}`)
  }

  updatePlanItem(itemId: string, input: UpdatePlanItemInput): Promise<PlanItem> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', data: input })
  }

  movePlanItem(itemId: string, input: MovePlanItemInput): Promise<PlanItem> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}/move`, { method: 'POST', data: input })
  }

  releasePlanItem(itemId: string, reason: string): Promise<PlanItem> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}/release`, {
      method: 'POST',
      data: { reason },
    })
  }

  assignPlanItem(itemId: string, agentId?: string): Promise<PlanAssignResult> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}/assign`, {
      method: 'POST',
      data: agentId ? { agentId } : {},
    })
  }

  deletePlanItem(itemId: string): Promise<PlanItem> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}`, { method: 'DELETE' })
  }

  batchPlanItems(input: PlanBatchInput): Promise<PlanBatchResult> {
    return this.request('/v1/plan/items/batch', { method: 'POST', data: input })
  }

  listPlanEvents(itemId: string): Promise<{ events: PlanItemEvent[] }> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}/events`)
  }

  getPlanClaimPackage(itemId: string): Promise<PlanClaimPackage> {
    return this.request(`/v1/plan/items/${encodeURIComponent(itemId)}/claim-package`)
  }

  /**
   * 看板实时流（SSE → 渲染层 `plan:changed`）。
   *
   * 每个窗口一条订阅（同一时刻只看一个空间），断线 1s 后自动重连；
   * 渲染层还有 30s 兜底轮询，所以这里丢事件不会造成不一致。
   */
  subscribePlanEvents(contents: WebContents, workspaceId: string): void {
    const rooms = this.planSubscriptions.get(contents.id) ?? new Map<string, PlanSubscription>()
    this.planSubscriptions.set(contents.id, rooms)
    this.contentsLifecycle.observe(contents, () => this.unsubscribePlanEvents(contents))
    if (rooms.has(workspaceId)) return
    const subscription: PlanSubscription = {
      workspaceId,
      controller: new AbortController(),
      closed: false,
      reconnectTimer: null,
    }
    rooms.set(workspaceId, subscription)
    void this.runPlanStream(contents, subscription)
  }

  /** 不传 workspaceId = 退订该窗口的全部计划流（窗口销毁时用）。 */
  unsubscribePlanEvents(contents: WebContents, workspaceId?: string): void {
    const rooms = this.planSubscriptions.get(contents.id)
    if (!rooms) return
    const closing = workspaceId ? [workspaceId] : [...rooms.keys()]
    for (const key of closing) {
      const subscription = rooms.get(key)
      if (!subscription) continue
      rooms.delete(key)
      subscription.closed = true
      if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer)
      subscription.controller.abort()
    }
    if (rooms.size === 0) this.planSubscriptions.delete(contents.id)
  }

  private async runPlanStream(contents: WebContents, subscription: PlanSubscription): Promise<void> {
    try {
      const connection = await this.supervisor.ensureConnection()
      const url = new URL('/v1/plan/stream', connection.baseUrl)
      url.searchParams.set('workspaceId', subscription.workspaceId)
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${connection.token}` },
        signal: subscription.controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`plan_stream_${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'))
          if (dataLine) {
            try {
              const payload = JSON.parse(dataLine.slice(5).trim()) as unknown
              if (!contents.isDestroyed() && !subscription.closed) {
                contents.send('plan:changed', payload)
              }
            } catch {
              // 半条 SSE 帧（网关重启）忽略，重连后靠轮询补齐。
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // 连接失败/被中止都走同一条重连路径。
    }
    if (subscription.closed || contents.isDestroyed()) return
    subscription.reconnectTimer = setTimeout(() => {
      subscription.reconnectTimer = null
      if (subscription.closed || contents.isDestroyed()) return
      void this.runPlanStream(contents, subscription)
    }, 1_000)
  }

  createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return this.request('/v1/agent/sessions', { method: 'POST', data: input })
  }

  createSessionLink(input: CreateAgentSessionLinkInput): Promise<AgentSessionLink> {
    return this.request('/v1/agent/session-links', { method: 'POST', data: input })
  }

  listSessionLinks(sessionId: string): Promise<AgentSessionLink[]> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/links`)
  }

  markSessionLinkReturned(linkId: string): Promise<AgentSessionLink> {
    return this.request(`/v1/agent/session-links/${encodeURIComponent(linkId)}/return`, { method: 'POST' })
  }

  listSessions(
    pageLabel?: string,
    roomId?: string | null,
    workspaceId?: string,
  ): Promise<AgentSession[]> {
    const query = new URLSearchParams()
    if (pageLabel) query.set('pageLabel', pageLabel)
    if (roomId !== undefined) query.set('roomId', roomId ?? '')
    if (workspaceId) query.set('workspaceId', workspaceId)
    return this.request(`/v1/agent/sessions?${query}`)
  }

  listAllSessions(): Promise<AgentSession[]> {
    return this.listSessions()
  }

  async listAllSessionSnapshots(): Promise<AgentSessionSnapshot[]> {
    const sessions = await this.listSessions()
    const snapshots = await Promise.all(sessions.map(async (session) => {
      try {
        return await this.getSession(session.id)
      } catch {
        return null
      }
    }))
    return snapshots.filter((snapshot): snapshot is AgentSessionSnapshot => snapshot !== null)
  }

  updateSession(sessionId: string, input: UpdateAgentSessionInput): Promise<AgentSession> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      data: input,
    })
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  }

  getSession(sessionId: string): Promise<AgentSessionSnapshot> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}`)
  }

  getUsage(range: AgentUsageRange = '7d'): Promise<AgentUsageSnapshot> {
    return this.request(`/v1/agent/usage?range=${encodeURIComponent(range)}`)
  }

  listWorkspaces(): Promise<AgentWorkspace[]> {
    return this.request('/v1/agent/workspaces')
  }

  createWorkspace(input: CreateAgentWorkspaceInput): Promise<AgentWorkspace> {
    return this.request('/v1/agent/workspaces', { method: 'POST', data: input })
  }

  /**
   * 概览「动态」：网关按 (at, id) 游标派生的一页事件（runs + 文件库 + 计划事件流）。
   * 不是独立实体，见 `docs/workspace-overview-activity-plan.zh-CN.md` §5。
   */
  listWorkspaceActivities(workspaceId: string, query: WorkspaceActivityQuery = {}): Promise<WorkspaceActivityPage> {
    const search = new URLSearchParams()
    if (query.limit !== undefined) search.set('limit', String(query.limit))
    if (query.beforeAt) search.set('beforeAt', query.beforeAt)
    if (query.beforeId) search.set('beforeId', query.beforeId)
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    return this.request(
      `/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/activities${suffix}`,
    )
  }

  updateWorkspace(workspaceId: string, input: UpdateAgentWorkspaceInput): Promise<AgentWorkspace> {
    return this.request(`/v1/agent/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      data: input,
    })
  }

  deleteWorkspace(workspaceId: string): Promise<void> {
    return this.request(`/v1/agent/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' })
  }

  /** 项目空间默认落点预览（`<dataDir>/Workspace/<slug>`），新建弹窗用。 */
  previewDefaultRoot(name: string): Promise<AgentSpaceDefaultRoot | null> {
    return this.request(`/v1/workspaces/default-root?name=${encodeURIComponent(name)}`)
  }

  /** 判定某目录是不是项目空间（只看 `.everoffice/space.json`；v1 的根上 `space.everoffice` 也认）。 */
  detectSpace(dir: string): Promise<AgentSpaceDetectResult> {
    return this.request('/v1/workspaces/detect', { method: 'POST', data: { dir } })
  }

  /** 接管已有目录为项目空间（保留 spaceId；复制品可 reassignSpaceId）。 */
  adoptSpace(input: { dir: string; name?: string; reassignSpaceId?: boolean }): Promise<AgentWorkspace> {
    return this.request('/v1/workspaces/adopt', { method: 'POST', data: input })
  }

  /** 搬移空间目录（整个目录跟着走）。 */
  relocateSpace(workspaceId: string, dir: string): Promise<AgentWorkspace> {
    return this.request(`/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/relocate`, {
      method: 'POST',
      data: { dir },
    })
  }

  /** 扫容器根，列出磁盘上发现的项目空间（含是否已注册）。 */
  discoverSpaces(): Promise<AgentSpaceCandidate[]> {
    return this.request('/v1/workspaces/discover')
  }

  /** 空间目录快照（路径 + 健康）；未绑定目录时网关返回 409，调用方按空态处理。 */
  getSpaceLayout(workspaceId: string): Promise<AgentSpaceLayout> {
    return this.request<AgentSpaceLayout>(`/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/layout`)
  }

  /** 幂等修复：补缺失目录 / 补缺失标记。 */
  repairSpaceLayout(workspaceId: string): Promise<AgentSpaceRepairReport> {
    return this.request<AgentSpaceRepairReport>(
      `/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/layout/repair`,
      { method: 'POST' },
    )
  }

  /** 资料库对账：盘上删了→missing、回来了→恢复、多了→入库。 */
  reconcileSpaceLibrary(workspaceId: string): Promise<AgentSpaceReconcileReport> {
    return this.request<AgentSpaceReconcileReport>(
      `/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/library/reconcile`,
      { method: 'POST' },
    )
  }

  /** 空间缓存占用（tmp / derived / objects）。 */
  spaceCacheStats(workspaceId: string): Promise<AgentSpaceCacheStats> {
    return this.request<AgentSpaceCacheStats>(`/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/cache`)
  }

  /** `.tmp/` 只读清单（临时文件入口；网关只读目录，不写库）。 */
  spaceScratchFiles(workspaceId: string): Promise<AgentScratchListing> {
    return this.request<AgentScratchListing>(
      `/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/cache/scratch`,
    )
  }

  /** 缓存回收：tmp/derived 按龄、objects 按引用、回收站 30 天。 */
  gcSpaceCache(workspaceId: string): Promise<AgentSpaceCacheGcResult> {
    return this.request<AgentSpaceCacheGcResult>(
      `/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/cache/gc`,
      { method: 'POST' },
    )
  }

  /** 存量懒回填：把只在对象库里的老条目落到空间 Library。 */
  backfillSpaceLibrary(workspaceId: string, limit = 100): Promise<AgentSpaceBackfillReport> {
    return this.request<AgentSpaceBackfillReport>(
      `/v1/agent/workspaces/${encodeURIComponent(workspaceId)}/library/backfill`,
      { method: 'POST', data: { limit } },
    )
  }

  getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]> {
    const query = new URLSearchParams({ runId, afterSeq: String(afterSeq) })
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/events?${query}`)
  }

  getLocalAgentDispatch(sessionId: string, taskId: string): Promise<LocalAgentDispatchDetail> {
    return this.request(
      `/v1/agent/sessions/${encodeURIComponent(sessionId)}/local-agent-dispatches/${encodeURIComponent(taskId)}`,
    )
  }

  resolveApproval(
    approvalId: string,
    decision: AgentApprovalDecision,
    feedback?: string,
  ): Promise<{ approvalId: string; decision: string }> {
    return this.request(`/v1/agent/approvals/${encodeURIComponent(approvalId)}/resolve`, {
      method: 'POST',
      data: { decision, ...(feedback ? { feedback } : {}) },
    })
  }

  getPermissionMode(sessionId: string): Promise<AgentPermissionModeState> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/permission-mode`)
  }

  setPermissionMode(sessionId: string, mode: AgentPermissionMode): Promise<{ mode: AgentPermissionMode; applied: boolean }> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
      method: 'PUT',
      data: { mode },
    })
  }

  /** 修改会话思考档位（null=跟随模型配置）：网关落库，从下一轮 run 起生效。 */
  setThinkingLevel(sessionId: string, level: AgentThinkingLevel | null): Promise<AgentThinkingLevelUpdate> {
    return this.request(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/thinking-level`, {
      method: 'PUT',
      data: { level },
    })
  }

  async startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun> {
    // 当前浏览的 Office 文件以 main 的焦点实例为准：渲染端只知道自己开了哪些
    // 页签，谁真正可见由主进程的 setActiveInstance 决定。openFiles 是同一份
    // 注册表的全量页签，activeFile 从清单里的 active 项推出。
    // 20 与网关 route schema maxItems 对齐：清单本身焦点在前，截断不会丢掉当前项。
    const openFiles = (this.openFiles?.() ?? []).slice(0, 20)
    const focused = openFiles.find((file) => file.active)
    const activeFile = this.activeFile?.()
      ?? (focused ? stripOpenFileFlag(focused) : null)
    const context = {
      ...input.context,
      ...(activeFile ? { activeFile } : {}),
      ...(openFiles.length ? { openFiles } : {}),
    }
    const data = Object.keys(context).length ? { ...input, context } : input
    const run = await this.request<AgentRun>(`/v1/agent/sessions/${encodeURIComponent(sessionId)}/runs`, {
      method: 'POST',
      data,
    })
    this.activity?.trackRun(run)
    this.watchRun(run)
    return run
  }

  async submitPendingIntent(
    intentId: string,
    input: SubmitPendingAgentIntentInput,
  ): Promise<{ intent: PendingAgentIntent; run: AgentRun }> {
    const result = await this.request<{ intent: PendingAgentIntent; run: AgentRun }>(`/v1/agent/pending-intents/${encodeURIComponent(intentId)}/submit`, {
      method: 'POST',
      data: input,
    })
    this.activity?.trackRun(result.run)
    this.watchRun(result.run)
    return result
  }

  async cancelRun(runId: string): Promise<AgentRun> {
    const run = await this.request<AgentRun>(`/v1/agent/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' })
    const cancelledEvent: AgentEvent = {
      id: `local-cancel-${run.id}`,
      sessionId: run.sessionId,
      runId: run.id,
      seq: run.lastEventSeq,
      type: 'run.cancelled',
      occurredAt: run.completedAt ?? new Date().toISOString(),
      payload: {},
    }
    this.activity?.trackEvent(cancelledEvent)
    this.eventObserver?.(cancelledEvent)
    this.stopRunWatch(run.id)
    return run
  }

  generateSessionTitle(input: {
    sessionId: string
    userText: string
    assistantText: string
    language?: string
  }): Promise<{ title: string }> {
    return this.request('/v1/processing/session-title', {
      method: 'POST',
      data: input,
      timeout: 30_000,
    })
  }

  suggestConversationPrompt(input: {
    sessionId: string | null
    pageLabel?: string
    roomTitle: string | null
    messages: Array<{ role: 'user' | 'assistant'; text: string }>
    recentSessions?: Array<{ title: string | null; updatedAt: string }>
    language?: string
  }): Promise<{ suggestion: string }> {
    return this.request('/v1/processing/conversation-suggestion', {
      method: 'POST',
      data: input,
      timeout: 15_000,
    })
  }

  suggestStarterPrompts(input: {
    pageLabel?: string
    roomTitle: string | null
    recentSessions: Array<{ title: string | null; updatedAt: string }>
    language?: string
  }): Promise<{ prompts: string[] }> {
    return this.request('/v1/processing/starter-prompts', {
      method: 'POST',
      data: input,
      timeout: 20_000,
    })
  }

  subscribe(contents: WebContents, sessionId: string): void {
    this.unsubscribe(contents.id)
    const subscription: Subscription = {
      sessionId,
      socket: null,
      closed: false,
      reconnectTimer: null,
    }
    this.subscriptions.set(contents.id, subscription)
    this.contentsLifecycle.observe(contents, () => this.unsubscribe(contents.id))
    try {
      subscription.socket = this.openSocket(contents, sessionId)
    } catch {
      // 网关尚未就绪：保留订阅，驱动拉起，起来后由重连补上。
      void this.supervisor.ensureConnection().catch(() => undefined)
      this.scheduleSessionReconnect(contents, sessionId, 750)
    }
  }

  unsubscribe(contentsId: number): void {
    const subscription = this.subscriptions.get(contentsId)
    if (!subscription) return
    subscription.closed = true
    if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer)
    subscription.socket?.close()
    this.subscriptions.delete(contentsId)
  }

  dispose(): void {
    for (const contentsId of [...this.subscriptions.keys()]) this.unsubscribe(contentsId)
    for (const runId of [...this.runWatches.keys()]) this.stopRunWatch(runId)
  }

  private watchRun(run: AgentRun): void {
    if (!this.activity || this.runWatches.has(run.id)) return
    const watch: RunWatch = {
      sessionId: run.sessionId,
      socket: null,
      reconnectTimer: null,
      closed: false,
    }
    this.runWatches.set(run.id, watch)
    watch.socket = this.openRunWatch(run.id, watch)
  }

  private openRunWatch(runId: string, watch: RunWatch): WebSocket {
    const connection = this.supervisor.getConnection()
    const url = new URL(connection.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(watch.sessionId)}/stream`
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    socket.on('message', (data) => {
      try {
        const frame: unknown = JSON.parse(data.toString())
        if (!isAgentSocketFrame(frame) || frame.type !== 'event' || frame.event.runId !== runId) return
        this.activity?.trackEvent(frame.event)
        this.eventObserver?.(frame.event)
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(frame.event.type)) {
          this.stopRunWatch(runId)
        }
      } catch {
        // Invalid frames are ignored; reconnect/replay keeps the status projection recoverable.
      }
    })
    socket.on('close', () => {
      this.scheduleRunWatchReconnect(runId, 750)
    })
    socket.on('error', () => undefined)
    return socket
  }

  private stopRunWatch(runId: string): void {
    const watch = this.runWatches.get(runId)
    if (!watch) return
    watch.closed = true
    if (watch.reconnectTimer) clearTimeout(watch.reconnectTimer)
    watch.socket?.close()
    this.runWatches.delete(runId)
  }

  /** 网关重启窗口内 getConnection 会抛“尚未就绪”；兜住并驱动 supervisor 拉起网关，watch 保留等下一轮。 */
  private scheduleRunWatchReconnect(runId: string, delayMs: number): void {
    const watch = this.runWatches.get(runId)
    if (!watch || watch.closed) return
    if (watch.reconnectTimer) clearTimeout(watch.reconnectTimer)
    watch.reconnectTimer = setTimeout(() => {
      const current = this.runWatches.get(runId)
      if (!current || current.closed) return
      try {
        current.socket = this.openRunWatch(runId, current)
        current.reconnectTimer = null
      } catch {
        void this.supervisor.ensureConnection().catch(() => undefined)
        this.scheduleRunWatchReconnect(runId, 750)
      }
    }, delayMs)
  }

  private openSocket(contents: WebContents, sessionId: string): WebSocket {
    const connection = this.supervisor.getConnection()
    const url = new URL(connection.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = `/v1/agent/sessions/${encodeURIComponent(sessionId)}/stream`
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } })
    socket.on('message', (data) => {
      if (contents.isDestroyed()) return
      try {
        const frame: unknown = JSON.parse(data.toString())
        if (isAgentSocketFrame(frame)) {
          contents.send(this.eventChannel, frame)
          if (frame.type === 'event') {
            this.activity?.trackEvent(frame.event)
            this.eventObserver?.(frame.event)
          }
        }
      } catch {
        // Invalid runtime frames are ignored and will be recovered from history.
      }
    })
    socket.on('close', () => {
      this.scheduleSessionReconnect(contents, sessionId, 750)
    })
    socket.on('error', () => undefined)
    return socket
  }

  /** 网关重启窗口内 getConnection 会抛“尚未就绪”；兜住并驱动 supervisor 拉起网关，订阅保留等下一轮。 */
  private scheduleSessionReconnect(contents: WebContents, sessionId: string, delayMs: number): void {
    const subscription = this.subscriptions.get(contents.id)
    if (!subscription || subscription.closed || contents.isDestroyed()) return
    if (subscription.reconnectTimer) clearTimeout(subscription.reconnectTimer)
    subscription.reconnectTimer = setTimeout(() => {
      const current = this.subscriptions.get(contents.id)
      if (!current || current.closed || contents.isDestroyed()) return
      try {
        current.socket = this.openSocket(contents, sessionId)
        current.reconnectTimer = null
      } catch {
        void this.supervisor.ensureConnection().catch(() => undefined)
        this.scheduleSessionReconnect(contents, sessionId, 750)
      }
    }, delayMs)
  }

  private async request<T>(path: string, config: AxiosRequestConfig = {}): Promise<T> {
    const connection = await this.supervisor.ensureConnection()
    try {
      return await this.requestWithConnection<T>(connection, path, config)
    } catch (error) {
      if (!isRecoverableConnectionError(error)) throw error
      const recoveredConnection = await this.supervisor.recoverConnection(connection)
      return this.requestWithConnection<T>(recoveredConnection, path, config)
    }
  }

  private async requestWithConnection<T>(
    connection: ReturnType<GatewaySupervisor['getConnection']>,
    path: string,
    config: AxiosRequestConfig,
  ): Promise<T> {
    const hasBody = config.data !== undefined && config.data !== null
    const response = await http.request<T & { message?: unknown }>({
      url: `${connection.baseUrl}${path}`,
      ...config,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': hasBody ? 'application/json' : false,
        ...config.headers,
      },
      validateStatus: () => true,
    })
    if (response.status >= 400) {
      const body = response.data as (T & { error?: unknown; message?: unknown }) | undefined
      // 网关对 AI 中转余额耗尽返回结构化 402：抛本地化文案，
      // 渲染层弹"AI 额度不足"而不是笼统的 "An internal gateway error occurred"。
      if (body?.error === 'ai_quota_exhausted') {
        throw new Error(desktopText('error.quota.message'))
      }
      throw new Error(
        typeof body?.message === 'string'
          ? body.message
          : `Agent 请求失败（${response.status}）`,
      )
    }
    if (response.status === 204) return undefined as T
    return response.data
  }
}
