import type {
  AgentSession,
  AgentWorkspace,
  CreateAgentSessionInput,
  CreateAgentWorkspaceInput,
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
}