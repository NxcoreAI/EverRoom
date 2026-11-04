import type { ConnectorConnection, ConnectorProviderSummary } from '@nxcore/connector-contract'
import type { AgentAuthEnvironmentStatus } from '@/shared/agent-auth'

/**
 * 连接器页数据层（快照式加载）。
 *
 * 目的：进入连接器页时不再「先画注册表兜底目录，再被异步数据改成真实目录」。
 * 页面首帧只在快照就绪后渲染真实内容；没有快照就走骨架屏，之后只有一次提交。
 *
 * - 一次加载 = providers / status / oauthConfigs / agentAuth.status 并行，
 *   Promise.allSettled 后合成一个快照，视图 setState 一次（避免中间态混搭）。
 * - 模块级缓存：重复进入页面首帧即真实内容（无需骨架、无闪烁）。
 * - 失败兜底（complete = false）不写缓存：网关还没起来时不能把「注册表全量」
 *   当成首屏数据缓存下来，否则下次进入又是一次目录跳变。
 * - 账号切换（登录/注销/换号）清缓存：目录与连接清单可能整体变化。
 */

export type ConnectorOauthCatalog =
  | Array<{ provider: string; displayName: string | null; iconUrl: string | null }>
  | string[]
  | null

export interface ConnectorsSnapshot {
  /** 网关注册表（providers()）；providers() 失败/为空时使用注册表兜底。 */
  providers: ConnectorProviderSummary[]
  /** 网关实时连接清单（同源多账号）。 */
  connections: ConnectorConnection[]
  /** 本地墓碑（键 service:connectionName）：凭据在但被关掉的连接。 */
  disconnected: ReadonlySet<string>
  /** SaaS 已配置 OAuth 的应用全集；null = 不可用（local 模式/未登录/旧主进程）。 */
  oauthCatalog: ConnectorOauthCatalog
  /** 飞书凭据状态（本机 lark-cli，不走 oo）。 */
  feishuAuth: AgentAuthEnvironmentStatus['feishu'] | null
  /** 连接器模块是否启用（网关配置）。 */
  enabled: boolean
  /** 是否存在桌面桥（纯 Web 预览时 false → 静态注册表终态）。 */
  hasApi: boolean
  /**
   * 目录/状态是否来自可信响应。false = 某一路调用失败后的兜底合成，
   * 只能当作「网关还没就绪」的临时结果：不缓存，视图继续重试并保持骨架。
   */
  complete: boolean
}

/** 无桥（纯 Web 预览）/ 网关旧版本时的注册表兜底；运行时被 providers() 覆盖。 */
const REGISTRY_FALLBACK: ConnectorProviderSummary[] = [
  { provider: 'gmail', label: 'gmail', category: 'mail', iconKey: 'gmail', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'outlook', label: 'outlook', category: 'mail', iconKey: 'outlook', dataTypes: ['mail'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'google-calendar', label: 'google-calendar', category: 'calendar', iconKey: 'google-calendar', dataTypes: ['event'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'google-docs', label: 'google-docs', category: 'docs', iconKey: 'google-docs', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'notion', label: 'notion', category: 'docs', iconKey: 'notion', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'slack', label: 'slack', category: 'docs', iconKey: 'slack', dataTypes: ['message'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
  { provider: 'feishu', label: 'feishu', category: 'docs', iconKey: 'feishu', dataTypes: ['document'], authChannel: 'nango-oauth', connected: false, comingSoon: false },
]

/** 最近一次「可信」快照（complete = true）；重复进入页面时作为首帧数据。 */
let cached: ConnectorsSnapshot | null = null
/** 在途请求：并发 mount / 预取 / 动作后刷新共用同一次加载。 */
let inflight: Promise<ConnectorsSnapshot> | null = null
/**
 * 账号代际：账号切换时 +1。加载回来时代际不同，说明结果是上一个账号的，
 * 必须丢弃重拉——否则旧账号的在途结果会重新写回缓存，新账号首帧又闪旧目录。
 */
let generation = 0
/** 加载序号：测试重置时 +1，让旧的在途加载不再写缓存（也不会自我重拉）。 */
let loadSeq = 0

// 账号切换后目录/连接清单可能整体变化：丢掉缓存并递增代际，
// 避免先显示上一个账号的连接器、再被刷新纠正（又是一次闪烁）。
if (typeof window !== 'undefined') {
  window.addEventListener('everroom-account-status-changed', () => {
    generation += 1
    cached = null
  })
}

/** 同步读缓存：视图用它决定首帧是「直接渲染真实内容」还是「骨架屏」。 */
export function peekConnectorsSnapshot(): ConnectorsSnapshot | null {
  return cached
}

/**
 * 预取：把快照提前拉进模块级缓存。当前未接启动调用（避免与并行开发的外壳文件冲突），
 * 如需「首次进入也是零骨架」，在应用外壳挂载时调用一次即可。
 */
export function prefetchConnectorsSnapshot(): void {
  void loadConnectorsSnapshot().catch(() => undefined)
}

/**
 * 加载最新快照（带缓存与在途去重）。
 * - 拿到可信快照 → 写缓存并返回；
 * - 拿到失败兜底 → 已有可信快照时沿用旧快照（避免页面从真实目录退回注册表全量）。
 */
export function loadConnectorsSnapshot(): Promise<ConnectorsSnapshot> {
  if (inflight) return inflight
  const loadId = ++loadSeq
  const run = (async (): Promise<ConnectorsSnapshot> => {
    for (;;) {
      const generationAtStart = generation
      const snapshot = await fetchConnectorsSnapshot(cached)
      // 被测试重置（或更新的加载取代）：结果可以返回，但不能再写缓存。
      if (loadId !== loadSeq) return snapshot
      // 账号在加载途中切换：本次结果属于旧账号，丢弃并按新账号重拉。
      if (generationAtStart !== generation) continue
      if (snapshot.complete) {
        cached = snapshot
        return snapshot
      }
      return cached ?? snapshot
    }
  })().finally(() => {
    // 只在仍是当前这次加载时清在途标记（重置/被取代后不要动新加载的状态）。
    if (loadId === loadSeq) inflight = null
  })
  inflight = run
  return run
}

/** 仅测试用：清空模块级缓存与在途请求，让下一次挂载重新走首屏加载。 */
export function resetConnectorsSnapshotForTests(): void {
  // 递增加载序号：上一个用例遗留的在途加载即使稍后返回，也不会写进本用例的缓存。
  loadSeq += 1
  cached = null
  inflight = null
}

async function fetchConnectorsSnapshot(previous: ConnectorsSnapshot | null): Promise<ConnectorsSnapshot> {
  const api = window.nxcore?.nangoConnector
  const agentAuth = window.nxcore?.agentAuth
  if (!api) {
    // 纯 Web 预览/单测没有桌面桥：静态注册表就是终态，不需要重试。
    return {
      providers: REGISTRY_FALLBACK,
      connections: [],
      disconnected: new Set<string>(),
      oauthCatalog: null,
      feishuAuth: null,
      enabled: true,
      hasApi: false,
      complete: true,
    }
  }

  // 桥方法理论上返回 Promise，但旧 preload/单测桩可能同步 throw：
  // 统一包一层 Promise.resolve().then，让同步异常也走 allSettled 的失败分支。
  const attempt = <T,>(run: () => Promise<T>): Promise<T> => Promise.resolve().then(run)
  const [providersResult, statusResult, catalogResult, authResult] = await Promise.allSettled([
    attempt(() => api.providers()),
    attempt(() => api.status()),
    // 旧主进程可能没有 oauthConfigs：按「不可用」处理，目录回落注册表。
    attempt(() => api.oauthConfigs ? api.oauthConfigs() : Promise.resolve(null)),
    // 飞书凭据在 lark-cli（本机安全存储），与 oo 连接清单相互独立。
    attempt(() => agentAuth ? agentAuth.status() : Promise.resolve(null)),
  ])

  const providersPayload = providersResult.status === 'fulfilled' ? providersResult.value : null
  const statusPayload = statusResult.status === 'fulfilled' ? statusResult.value : null
  const catalogPayload = catalogResult.status === 'fulfilled' ? catalogResult.value : null
  const authPayload = authResult.status === 'fulfilled' ? authResult.value : null

  const providersOk = Boolean(providersPayload && Array.isArray(providersPayload.providers))
  const statusOk = Boolean(statusPayload && Array.isArray(statusPayload.connections))
  const catalogOk = catalogResult.status === 'fulfilled'

  // providers 为空时沿用旧快照，再兜底注册表（历史行为：兜底仅作预览/旧网关）。
  const providerList = providersOk ? providersPayload?.providers : undefined
  const providers = providerList && providerList.length > 0
    ? providerList
    : previous?.providers ?? REGISTRY_FALLBACK

  // enabled 只有网关明确回 false 才关闭；任一路失败不会把已关闭改回启用。
  let enabled = previous?.enabled ?? true
  if (providersPayload?.enabled === false) enabled = false
  if (statusPayload?.enabled === false) enabled = false

  const connections = statusPayload ? statusPayload.connections : previous?.connections ?? []
  // 墓碑清单（新版网关）：键为 service:connectionName，凭据在但被关掉。
  // 老网关无此字段 → 视为空清单（而不是沿用旧值）。
  const rawDisconnected = statusPayload?.disconnected
  const disconnected: ReadonlySet<string> = statusPayload
    ? new Set(Array.isArray(rawDisconnected) ? rawDisconnected.map((entry) => `${entry.service}:${entry.connectionName}`) : [])
    : previous?.disconnected ?? new Set<string>()

  const oauthCatalog: ConnectorOauthCatalog = catalogOk
    ? catalogPayload ?? null
    : previous?.oauthCatalog ?? null

  const feishuAuth = authPayload?.feishu ?? previous?.feishuAuth ?? null

  return {
    providers,
    connections,
    disconnected,
    oauthCatalog,
    feishuAuth,
    enabled,
    hasApi: true,
    // 目录与状态都拿到真实响应才算可信；失败兜底留给视图重试，不写缓存。
    complete: providersOk && statusOk && catalogOk,
  }
}