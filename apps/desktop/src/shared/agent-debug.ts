/**
 * Agent 调试面板的桌面共享类型：主进程桥（agent-debug-gateway-bridge）、preload
 * 与「Agent 调试」面板共用。形状与网关 /v1/agent-debug/* 的响应一致
 * （apps/gateway/src/modules/agent-debug），仅用于只读展示。
 *
 * 数据来自运行时的 describe()（实际装配的 systemPrompt/工具/模型），
 * 而不是 agents/<id>/agent.yaml 的声明——声明里的 tools/capabilities 在网关里
 * 未参与装配，不能当作「实际能力」展示。
 */

export type AgentDebugKind = 'builtin' | 'subagent'

export type AgentDebugState = 'running' | 'idle' | 'error' | 'unknown'

export type AgentDebugActivityStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** 模型参数（不含 apiKey；这些值来自用户本机配置）。 */
export interface AgentDebugModelInfo {
  provider: string | null
  model: string | null
  baseUrl: string | null
  api: string | null
  reasoning: string | null
  temperature: number | null
  maxTokens: number | null
  contextWindow: number | null
}

export interface AgentDebugSkillInfo {
  name: string
  /** 相对 Agent 目录的路径（如 `./skills/document-export`）；读不到时为 null。 */
  path: string | null
  /** SKILL.md 全文；子 Agent 的 Skill 走 read 工具发现，不内联，此时为 null。 */
  prompt: string | null
}

/** 实际挂载到该 Agent 的工具。`builtin` = pi 内置工具，`custom` = 网关注入工具。 */
export interface AgentDebugToolInfo {
  name: string
  label: string | null
  description: string | null
  source: 'builtin' | 'custom'
}

export interface AgentDebugCapabilities {
  streaming: boolean
  reasoning: boolean
  tools: boolean
  steering: boolean
  resume: boolean
}

/** 运行预算（pi runtime 参数），全部可空。 */
export interface AgentDebugLimits {
  maxToolCallsPerRun: number | null
  maxToolResultChars: number | null
  runContextGuard: { triggerTokens: number; keepRecentTurns: number } | null
}

/** 子 Agent 策略。 */
export interface AgentDebugPolicy {
  allowedCallers: string[]
  maxConcurrency: number
  timeoutMs: number
  maxToolCalls: number
  model?: {
    maxTokens?: number
    contextWindow?: number
    reasoning?: string
  } | null
}

/** 子 Agent 的 manifest 绑定（MCP 服务器 + 工具白名单）。 */
export interface AgentDebugSubagentMcpBinding {
  server: string
  includeTools: string[] | null
  excludeTools: string[] | null
}

export interface AgentDebugSubagentInfo {
  revisionId: string
  version: number
  digest: string
  agentDirectory: string
  manifest: Record<string, unknown>
  skills: string[]
  mcp: AgentDebugSubagentMcpBinding[]
  inputSchema: Record<string, unknown> | null
  outputSchema: Record<string, unknown> | null
}

export interface AgentDebugActivityItem {
  id: string
  task: string
  status: AgentDebugActivityStatus
  startedAt: string | null
  completedAt: string | null
  pageLabel: string | null
  /** 子 Agent 调用来源（primary-agent / scheduler / internal-workflow）；内置 Agent 为 null。 */
  source: string | null
}

export interface AgentDebugAgentSummary {
  id: string
  kind: AgentDebugKind
  name: string
  description: string
  /** `pi` / `openai-completions`；未知时为 null。 */
  runtime: string | null
  /** `user-facing` / `internal`。 */
  runtimeRole: string | null
  /** 展示用 `provider/model`；未配置时为 null。 */
  model: string | null
  state: AgentDebugState
  activeRunCount: number
  /** 正在进行的那次运行（内置 = run；子 Agent = invocation）；无则为 null。 */
  currentRun: AgentDebugActivityItem | null
  /** 实际挂载的工具数（内置 + 自定义，不含 MCP）。 */
  toolCount: number
  skillCount: number
  revisionId: string | null
  updatedAt: string
}

export interface AgentDebugAgentDetail extends AgentDebugAgentSummary {
  /** bundle 的 SYSTEM.md 原文（运行期还会追加 locale / skills / guidelines）。 */
  systemPrompt: string
  skills: AgentDebugSkillInfo[]
  tools: AgentDebugToolInfo[]
  /** 已挂载的 MCP 服务器名（工具清单由 MCP 服务器自身决定，网关不可见）。 */
  mcpServers: string[]
  /** 追加到系统提示词末尾的规范条目（DocumentMcpHost.promptGuidelines）。 */
  promptGuidelines: string[]
  modelInfo: AgentDebugModelInfo | null
  capabilities: AgentDebugCapabilities | null
  limits: AgentDebugLimits | null
  policy: AgentDebugPolicy | null
  subagent: AgentDebugSubagentInfo | null
  recentActivity: AgentDebugActivityItem[]
}

export interface AgentDebugAgentsResponse {
  agents: AgentDebugAgentSummary[]
  generatedAt: string
}

export interface AgentDebugAgentResponse {
  agent: AgentDebugAgentDetail
  generatedAt: string
}

/* ── 使用记录（GET /v1/agent-debug/agents/:agentId/usage） ─────────────── */

/** 一条使用记录：内置 Agent 是 agent_runs，子 Agent 是 subagent_invocations。 */
export interface AgentDebugUsageRecord {
  id: string
  kind: 'run' | 'invocation'
  sessionId: string | null
  sessionTitle: string | null
  /** 内置 = 用户 prompt（已脱敏）；子 Agent = task。 */
  task: string
  status: AgentDebugActivityStatus
  roomId: string | null
  pageLabel: string | null
  startedAt: string | null
  completedAt: string | null
  durationMs: number | null
  /** 本次运行实际发生的工具调用次数（tool.started 事件数）。 */
  toolCalls: number
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  error: string | null
  /** 子 Agent 调用来源（primary-agent / scheduler / internal-workflow）。 */
  source: string | null
  revisionId: string | null
}

export interface AgentDebugUsageTotals {
  runs: number
  inputTokens: number
  outputTokens: number
}

export interface AgentDebugUsageResponse {
  agentId: string
  records: AgentDebugUsageRecord[]
  totals: AgentDebugUsageTotals
  generatedAt: string
}