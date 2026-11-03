import type {
  PlanAssignResult,
  PlanClaimPackage,
  PlanItem,
  PlanItemEvent,
  PlanItemListQuery,
  AgentSession,
  AgentSpaceBackfillReport,
  AgentSpaceCacheGcResult,
  AgentSpaceCacheStats,
  AgentSpaceDefaultRoot,
  AgentSpaceLayout,
  AgentSpaceReconcileReport,
  AgentSpaceRepairReport,
  AgentScratchListing,
  AgentWorkspace,
  CreateAgentSessionInput,
  CreateAgentWorkspaceInput,
  CreatePlanItemInput,
  UpdatePlanItemInput,
  MovePlanItemInput,
  UpdateAgentWorkspaceInput,
} from '@nxcore/agent-contract'

/**
 * 工作台渲染层的网关适配。
 *
 * - 工作区与目录选择走 preload 的 `window.nxcore.workspace`
 * - 会话清单走 `window.nxcore.agent`（不传 pageLabel = 全量，再按 workspaceId 过滤）
 *
 * 桌面端之外（浏览器预览/单测）没有 bridge：抛可读错误，由顶层壳显示空态，
 * 不在这里造内存假数据，避免和真实网关状态分叉。
 */

function workspaceBridge(): NonNullable<Window['nxcore']>['workspace'] {
  const bridge = window.nxcore?.workspace
  if (!bridge) throw new Error('桌面服务工作区接口未就绪，请重启 EverRoom')
  return bridge
}

function planBridge(): NonNullable<Window['nxcore']>['plan'] {
  const bridge = window.nxcore?.plan
  if (!bridge) throw new Error('桌面服务计划接口未就绪，请重启 EverRoom')
  return bridge
}

function agentBridge(): NonNullable<Window['nxcore']>['agent'] {
  const bridge = window.nxcore?.agent
  if (!bridge) throw new Error('桌面服务 Agent 接口未就绪，请重启 EverRoom')
  return bridge
}

export const workbenchApi = {
  async listWorkspaces(): Promise<AgentWorkspace[]> {
    return workspaceBridge().list()
  },

  async createWorkspace(input: CreateAgentWorkspaceInput): Promise<AgentWorkspace> {
    const name = input.name.trim()
    if (!name) throw new Error('工作区名称不能为空')
    return workspaceBridge().create({ ...input, name })
  },

  async updateWorkspace(id: string, input: UpdateAgentWorkspaceInput): Promise<AgentWorkspace> {
    return workspaceBridge().update(id, input)
  },

  async deleteWorkspace(id: string): Promise<void> {
    await workspaceBridge().remove(id)
  },

  async pickDirectory(): Promise<string | null> {
    return workspaceBridge().pickDirectory()
  },

  /** 新建空间的默认落点预览（`<dataDir>/Workspace/<slug>`）。 */
  async defaultRoot(name: string): Promise<AgentSpaceDefaultRoot | null> {
    const bridge = workspaceBridge()
    if (typeof bridge.defaultRoot !== 'function') return null
    return bridge.defaultRoot(name)
  },

  /** 空间目录快照（路径 + 健康）；未绑定目录时网关 409，调用方按空态渲染。 */
  async spaceLayout(workspaceId: string): Promise<AgentSpaceLayout> {
    return workspaceBridge().layout(workspaceId)
  },

  /** 幂等修复空间目录（补缺失目录 / 补缺失标记）。 */
  async repairSpace(workspaceId: string): Promise<AgentSpaceRepairReport> {
    return workspaceBridge().repair(workspaceId)
  },

  /** 在访达里选中目录（找不到返回 false）。 */
  async revealDirectory(dir: string): Promise<boolean> {
    return workspaceBridge().reveal(dir)
  },

  /** 资料库对账（盘上删了→missing、回来了→恢复、多了→入库）。 */
  async reconcileLibrary(workspaceId: string): Promise<AgentSpaceReconcileReport> {
    return workspaceBridge().reconcileLibrary(workspaceId)
  },

  /** 存量懒回填：把只在对象库里的老条目落到空间 Library。 */
  async backfillLibrary(workspaceId: string, limit?: number): Promise<AgentSpaceBackfillReport> {
    return workspaceBridge().backfillLibrary(workspaceId, limit)
  },

  /** 接管已有目录为项目空间（复制品传 reassignSpaceId=true）。 */
  async adoptSpace(input: { dir: string; name?: string; reassignSpaceId?: boolean }): Promise<AgentWorkspace> {
    return workspaceBridge().adopt(input)
  },

  /** 搬移空间目录。 */
  async relocateSpace(workspaceId: string, dir: string): Promise<AgentWorkspace> {
    return workspaceBridge().relocate(workspaceId, dir)
  },

  /** 空间缓存占用（tmp / derived / objects）。 */
  async cacheStats(workspaceId: string): Promise<AgentSpaceCacheStats> {
    return workspaceBridge().cacheStats(workspaceId)
  },

  /** 缓存回收（tmp/derived 按龄、objects 按引用、回收站 30 天）。 */
  async gcCache(workspaceId: string): Promise<AgentSpaceCacheGcResult> {
    return workspaceBridge().gcCache(workspaceId)
  },

  /** `.tmp/` 只读清单（「临时文件」入口；不入资料库索引）。 */
  async scratchFiles(workspaceId: string): Promise<AgentScratchListing> {
    return workspaceBridge().scratchFiles(workspaceId)
  },

  /** 全量会话（跨工作区）；由 store 按 workspaceId 分组。 */
  async listSessions(): Promise<AgentSession[]> {
    return agentBridge().listSessions()
  },

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    return agentBridge().createSession(input)
  },

  async updateSession(sessionId: string, input: { title: string }): Promise<AgentSession> {
    return agentBridge().updateSession(sessionId, input)
  },

  async deleteSession(sessionId: string): Promise<void> {
    await agentBridge().deleteSession(sessionId)
  },

  /* ───────── 计划（任务 / todo） ───────── */

  async listPlanItems(workspaceId: string, filter: { status?: PlanItem['status']; q?: string } = {}): Promise<PlanItem[]> {
    const query: PlanItemListQuery = { workspaceId, ...filter }
    const result = await planBridge().list(query)
    return result.items
  },

  async createPlanItem(input: CreatePlanItemInput): Promise<PlanItem> {
    const title = input.title.trim()
    if (!title) throw new Error('任务标题不能为空')
    return planBridge().create({ ...input, title })
  },

  async updatePlanItem(itemId: string, input: UpdatePlanItemInput): Promise<PlanItem> {
    return planBridge().update(itemId, input)
  },

  async movePlanItem(itemId: string, input: MovePlanItemInput): Promise<PlanItem> {
    return planBridge().move(itemId, input)
  },

  async assignPlanItem(itemId: string, agentId?: string): Promise<PlanAssignResult> {
    return planBridge().assign(itemId, agentId)
  },

  async removePlanItem(itemId: string): Promise<PlanItem> {
    return planBridge().remove(itemId)
  },

  async planItemEvents(itemId: string): Promise<PlanItemEvent[]> {
    const result = await planBridge().events(itemId)
    return result.events
  },

  async batchPlanItems(ids: string[], action: 'move' | 'drop', status?: PlanItem['status']) {
    return planBridge().batch({ ids, action, ...(status ? { status } : {}) })
  },

  async planClaimPackage(itemId: string): Promise<PlanClaimPackage> {
    return planBridge().claimPackage(itemId)
  },

  /** 订阅空间计划变更；返回退订函数（无 bridge 时是 noop）。 */
  subscribePlanChanges(workspaceId: string, listener: (item: PlanItem) => void): () => void {
    const bridge = window.nxcore?.plan
    if (!bridge) return () => {}
    void bridge.subscribe(workspaceId).catch(() => undefined)
    const off = bridge.onChanged((payload) => {
      if (payload.workspaceId === workspaceId) listener(payload.item)
    })
    return () => {
      off()
      void bridge.unsubscribe?.(workspaceId).catch(() => undefined)
    }
  },
}