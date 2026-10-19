/**
 * 外部 Agent 访问（PRD 0.2.0 第 7 章）的桌面共享类型：
 * 主进程桥（agent-access-gateway-bridge）、preload 与渲染层连接页共用。
 * 与网关 /v1/agent-access/* 的 DTO 形状保持一致（apps/gateway/src/modules/agent-access）。
 */

export interface AgentAccessScopesDto {
  roomIds: string[] | 'all'
  capabilities: string[]
  writebackRoomId: string | null
}

export interface AgentConnectionDto {
  id: string
  name: string
  tool: string
  status: 'active' | 'paused' | 'revoked'
  scopes: AgentAccessScopesDto
  tokenPrefix: string
  createdAt: string
  updatedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  exampleQueryAt: string | null
}

export interface AgentAccessCreateInput {
  name: string
  tool: string
  scopes: AgentAccessScopesDto
}

export interface AgentAccessUpdateInput {
  name?: string
  scopes?: AgentAccessScopesDto
  status?: 'active' | 'paused'
}

export interface AgentAccessInstallPlanDto {
  target: string
  url: string
  headers: Record<string, string>
  mcpConfig: string
  skillFiles: Array<{ path: string; content: string }>
  skillRoot: string | null
  notes: string[]
}

export interface AgentAccessInstallOutcomeDto {
  writtenFiles: string[]
  backups: string[]
  manualSteps: Array<{ title: string; content: string }>
  notes: string[]
}

export interface AgentAccessUninstallOutcomeDto {
  removed: string[]
  backups: string[]
}

export interface AgentAccessSelftestDto {
  steps: {
    list: { status: string; message?: string }
    search: { status: string; message?: string; data?: { hits?: Array<Record<string, unknown>> } }
    fetch: { status: string; message?: string }
    submit: { status: string; message?: string }
  }
  query: string
}

export interface AgentAccessExampleQueryDto {
  query: string
  result: {
    status: string
    message?: string
    data?: { hits?: Array<Record<string, unknown>> }
  }
}

export interface AgentAccessSettingsDto {
  fixedPort: number | null
  currentPort: number | null
}
