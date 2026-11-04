import { useCallback, useEffect, useState } from 'react'

/**
 * Agent 页的真实数据层：`agent.getStatus` / `agent.discoverLocalAgents` /
 * `mcp.listServers` / `agent.getUsage('7d')` 四路并行，各自独立成败。
 *
 * 归一函数全部接受 `unknown`：preload 桥、浏览器 mock（形状可能不同）或桥缺失
 * 都可能传进来，异常形状降级成空列表/不可用态而不是让页面崩掉。
 */

export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error' }

export type RuntimeAgentState = 'idle' | 'running' | 'error' | 'unknown'
export type RuntimeAgentKind = 'builtin' | 'developer' | 'unknown'

export interface RuntimeAgentView {
  id: string
  name: string
  description: string
  kind: RuntimeAgentKind
  state: RuntimeAgentState
  activeRunCount: number
  currentRunTask: string | null
  lastRunAt: string | null
}

export interface RuntimeView {
  summary: { total: number; running: number; idle: number; error: number }
  agents: RuntimeAgentView[]
}

export interface LocalAgentView {
  id: string
  displayName: string
  provider: string
  status: string
  callable: boolean
  version: string | null
  executablePath: string | null
  error: string | null
}

export interface McpServerView {
  name: string
  command: string | null
  url: string | null
  lifecycle: string | null
  disabled: boolean
}

export interface McpView {
  servers: McpServerView[]
  configPath: string | null
  enabledCount: number
}

export interface UsageView {
  provider: string | null
  model: string | null
  inputTokens: number
  outputTokens: number
  cacheHitTokens: number
  totalTokens: number
}

export interface AgentOverview {
  runtime: Loadable<RuntimeView>
  localAgents: Loadable<LocalAgentView[]>
  mcp: Loadable<McpView>
  usage: Loadable<UsageView | null>
  reload(): void
}

/* ───────────────── 取值工具（防御未知形状） ───────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asSeries(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value
  const nested = asRecord(value)?.[key]
  return Array.isArray(nested) ? nested : []
}

/* ───────────────── 归一 ───────────────── */

const RUNTIME_STATES: readonly RuntimeAgentState[] = ['idle', 'running', 'error']
const RUNTIME_KINDS: readonly RuntimeAgentKind[] = ['builtin', 'developer']

function pick<T extends string>(candidate: unknown, allowed: readonly T[]): T | null {
  return typeof candidate === 'string' && (allowed as readonly string[]).includes(candidate)
    ? candidate as T
    : null
}

export function normalizeRuntime(raw: unknown): RuntimeView {
  const record = asRecord(raw)
  const agents: RuntimeAgentView[] = []
  for (const item of asSeries(record?.agents, 'agents')) {
    const agent = asRecord(item)
    if (!agent) continue
    const id = asString(agent.agentId) ?? asString(agent.id)
    if (!id) continue
    const currentRun = asRecord(agent.currentRun)
    const lastRun = asRecord(agent.lastRun)
    agents.push({
      id,
      name: asString(agent.name) ?? id,
      description: asString(agent.description) ?? '',
      kind: pick(agent.kind, RUNTIME_KINDS) ?? 'unknown',
      state: pick(agent.state, RUNTIME_STATES) ?? 'unknown',
      activeRunCount: asNumber(agent.activeRunCount) ?? 0,
      currentRunTask: asString(currentRun?.task),
      lastRunAt: asString(lastRun?.completedAt) ?? asString(lastRun?.startedAt),
    })
  }

  const summary = asRecord(record?.summary)
  return {
    summary: {
      total: asNumber(summary?.total) ?? agents.length,
      running: asNumber(summary?.running) ?? agents.filter((agent) => agent.state === 'running').length,
      idle: asNumber(summary?.idle) ?? agents.filter((agent) => agent.state === 'idle').length,
      error: asNumber(summary?.error) ?? agents.filter((agent) => agent.state === 'error').length,
    },
    agents,
  }
}

const LOCAL_STATUSES: readonly string[] = ['discovered', 'verified', 'history_available', 'unavailable']

export function normalizeLocalAgents(raw: unknown): LocalAgentView[] {
  const agents: LocalAgentView[] = []
  for (const item of asSeries(raw, 'agents')) {
    const agent = asRecord(item)
    if (!agent) continue
    const id = asString(agent.id)
    if (!id) continue
    const status = asString(agent.status)
    agents.push({
      id,
      displayName: asString(agent.displayName) ?? asString(agent.name) ?? id,
      provider: asString(agent.provider) ?? 'custom',
      status: status && LOCAL_STATUSES.includes(status) ? status : 'unknown',
      callable: agent.callable === true,
      version: asString(agent.version),
      executablePath: asString(agent.executablePath),
      error: asString(agent.error),
    })
  }
  return agents
}

export function normalizeMcp(raw: unknown): McpView {
  const record = asRecord(raw)
  if (!record) return { servers: [], configPath: null, enabledCount: 0 }
  const source = record.servers
  const rows: Array<[string | null, unknown]> = Array.isArray(source)
    ? source.map((item) => [asString(asRecord(item)?.name), item])
    : source && typeof source === 'object'
      ? Object.entries(source as Record<string, unknown>)
      : []

  const servers: McpServerView[] = []
  for (const [key, item] of rows) {
    const definition = asRecord(item)
    const name = key ?? asString(definition?.name)
    if (!name) continue
    const args = Array.isArray(definition?.args)
      ? definition.args.filter((arg): arg is string => typeof arg === 'string')
      : []
    const command = asString(definition?.command)
    servers.push({
      name,
      command: command ? [command, ...args].join(' ') : null,
      url: asString(definition?.url),
      lifecycle: asString(definition?.lifecycle),
      disabled: definition?.disabled === true,
    })
  }
  servers.sort((left, right) => left.name.localeCompare(right.name))
  return {
    servers,
    configPath: asString(record.configPath),
    enabledCount: servers.filter((server) => !server.disabled).length,
  }
}

export function normalizeUsage(raw: unknown): UsageView | null {
  const record = asRecord(raw)
  if (!record) return null
  const inputTokens = asNumber(record.inputTokens) ?? 0
  const outputTokens = asNumber(record.outputTokens) ?? 0
  const cacheHitTokens = asNumber(record.cacheHitTokens) ?? 0
  return {
    provider: asString(record.provider),
    model: asString(record.model),
    inputTokens,
    outputTokens,
    cacheHitTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

/* ───────────────── hook ───────────────── */

export function useAgentOverview(): AgentOverview {
  const [runtime, setRuntime] = useState<Loadable<RuntimeView>>({ status: 'loading' })
  const [localAgents, setLocalAgents] = useState<Loadable<LocalAgentView[]>>({ status: 'loading' })
  const [mcp, setMcp] = useState<Loadable<McpView>>({ status: 'loading' })
  const [usage, setUsage] = useState<Loadable<UsageView | null>>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  const reload = useCallback(() => {
    setRuntime({ status: 'loading' })
    setLocalAgents({ status: 'loading' })
    setMcp({ status: 'loading' })
    setUsage({ status: 'loading' })
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = <T,>(
      load: () => Promise<unknown>,
      normalize: (raw: unknown) => T,
      apply: (value: Loadable<T>) => void,
    ) => {
      Promise.resolve()
        .then(load)
        .then((raw) => { if (!cancelled) apply({ status: 'ready', value: normalize(raw) }) })
        .catch(() => { if (!cancelled) apply({ status: 'error' }) })
    }

    const api = window.nxcore
    const agentApi = api?.agent
    const mcpApi = api?.mcp

    if (agentApi?.getStatus) run(() => agentApi.getStatus(), normalizeRuntime, setRuntime)
    else setRuntime({ status: 'error' })

    if (agentApi?.discoverLocalAgents) run(() => agentApi.discoverLocalAgents(), normalizeLocalAgents, setLocalAgents)
    else setLocalAgents({ status: 'error' })

    if (mcpApi?.listServers) run(() => mcpApi.listServers(), normalizeMcp, setMcp)
    else setMcp({ status: 'error' })

    // 用量是可选的：没有接口时直接隐藏（ready + null），失败才显示不可用。
    if (agentApi?.getUsage) run(() => agentApi.getUsage('7d'), normalizeUsage, setUsage)
    else setUsage({ status: 'ready', value: null })

    return () => { cancelled = true }
  }, [nonce])

  return { runtime, localAgents, mcp, usage, reload }
}
