import '@sentry/electron/preload'

import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type {
  AgentAccessCreateInput,
  AgentAccessExampleQueryDto,
  AgentAccessInstallOutcomeDto,
  AgentAccessSelftestDto,
  AgentAccessSettingsDto,
  AgentAccessUninstallOutcomeDto,
  AgentAccessUpdateInput,
  AgentConnectionDto,
} from '../shared/agent-access'
import type {
  AgentDebugAgentResponse,
  AgentDebugAgentsResponse,
  AgentDebugUsageResponse,
} from '../shared/agent-debug'
import type {
  AgentAttachmentReference,
  CreatePlanItemInput,
  MovePlanItemInput,
  PlanBatchInput,
  PlanChangePayload,
  PlanItemListQuery,
  UpdatePlanItemInput,
} from '@nxcore/agent-contract'
import type {
  SearchItemType,
  SearchMessageContextDto,
  SearchPageDto,
  SearchRequestDto,
  SearchScopeDto,
} from '../shared/search'
import type { IngestPipelines } from '../shared/ingest'
import type { McpServersSnapshot } from '../shared/mcp'
import type { OfficeAgentAskEvent, OfficeAgentFileEvent, OfficeAskAnchor, OfficeAskQueueActionEvent, OsOpenedDocument } from '../shared/office'
import type { SlidesPageImagesStatus } from '../shared/slides'
import { OIDC_LOGIN_CANCELLED_MESSAGE, OFFICE_PREVIEW_REQUEST_CHANNEL, type AiRelayKeeperEventType, type CloudAccountStatus, type DesktopRequestError, type NxcoreDesktopApi, type OfficePreviewKind, type OfficePreviewRequest, type SubagentSelectionRewriteInput } from '../shared/sources'
import { isCursorCompletionAgentErrorPayload } from '../shared/cursor-completion'
import {
  isDesktopLocale,
  translateDesktopMessage,
  type DesktopLocale,
} from '../shared/i18n/desktop'

const requestErrorListeners = new Set<(error: DesktopRequestError) => void>()
let pendingRequestError: DesktopRequestError | null = null
let pendingRequestErrorAt = 0
/** 无监听者（AppErrorDialog 未挂载，如登录页阶段）时错误的暂存时效：
 * 只重放挂载间隙内的新鲜错误；陈年错误（登录页积压的登录超时等用户
 * 早已知情并处理过）不该在进入应用后突然弹出。 */
const PENDING_REQUEST_ERROR_TTL_MS = 10_000
let currentLocale: DesktopLocale = 'zh-CN'

function desktopText(key: Parameters<typeof translateDesktopMessage>[1]): string {
  return translateDesktopMessage(currentLocale, key)
}

function isRateLimitMessage(message: string): boolean {
  return message === translateDesktopMessage('zh-CN', 'error.rateLimited.message')
    || message === translateDesktopMessage('en-US', 'error.rateLimited.message')
}

function isQuotaMessage(message: string): boolean {
  return message === translateDesktopMessage('zh-CN', 'error.quota.message')
    || message === translateDesktopMessage('en-US', 'error.quota.message')
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return desktopText('error.requestFailed')
  const message = error.message
    .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z][A-Za-z0-9]*Error|Error):\s*/, '')
    .replace(/^Error:\s*/, '')
  return isRateLimitMessage(message) ? desktopText('error.rateLimited.message') : message
}

function networkOperation(channel: string): string {
  if (/agent.*session|session.*agent/i.test(channel)) return desktopText('error.network.agentSessions')
  if (/runtime-config/i.test(channel)) return desktopText('error.network.runtimeConfig')
  if (/gateway.*status/i.test(channel)) return desktopText('error.network.gatewayStatus')
  if (/knowledge|wiki/i.test(channel)) return desktopText('error.network.knowledge')
  if (/document/i.test(channel)) return desktopText('error.network.document')
  if (/source|file/i.test(channel)) return desktopText('error.network.files')
  if (/nango|connector/i.test(channel)) return desktopText('error.network.connectors')
  return channel ? channel.replace(/^[^:]+:/, '').replace(/[-_]/g, ' ') : desktopText('error.network.service')
}

function networkErrorDetail(channel: string, error: unknown): Pick<DesktopRequestError, 'title' | 'message'> | null {
  const raw = error instanceof Error ? error.message : String(error)
  // 带 [code] 前缀的结构化网关错误说明本地网关已应答，其文本里可能含上游的
  // "fetch failed"，不能据此判定本地网关断连（桥接层错误码前缀约定）。
  if (/^\[[a-z][a-z0-9_]*\]/.test(raw)) return null
  // timeout of 10000ms exceeded：gateway 忙碌（ingest 高峰同步写卡事件循环）时
  // loopback axios 客户端（reality bridge / supervisor 健康探活）的响应超时原话，
  // 与 ECONNRESET 同属可自愈的瞬断——issue #181。
  if (!/fetch failed|failed to fetch|network error|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout of 10000ms exceeded/i.test(raw)) return null
  return {
    title: desktopText('error.network.title'),
    message: desktopText('error.network.message')
      .replace('{operation}', networkOperation(channel))
      .replace('{channel}', channel || 'unknown'),
  }
}

function requestError(channel: string, error: unknown): DesktopRequestError {
  const network = networkErrorDetail(channel, error)
  if (network) return { channel, severity: 'error', ...network }
  const message = errorMessage(error)
  if (isRateLimitMessage(message)) {
    return { channel, severity: 'notice', title: desktopText('error.rateLimited.title'), message }
  }
  if (isQuotaMessage(message)) {
    return { channel, severity: 'error', title: desktopText('error.quota.title'), message }
  }
  return { channel, severity: 'error', message }
}

function reportRequestError(detail: DesktopRequestError): void {
  ipcRenderer.send('app:request-error', detail)
  if (requestErrorListeners.size === 0) {
    pendingRequestError = detail
    pendingRequestErrorAt = Date.now()
  } else for (const listener of requestErrorListeners) listener(detail)
}

function rateLimitNotice(value: unknown): DesktopRequestError | null {
  if (!value || typeof value !== 'object') return null
  const result = value as { __everroomRateLimited?: unknown; message?: unknown }
  if (result.__everroomRateLimited !== true || typeof result.message !== 'string') return null
  return {
    channel: '',
    severity: 'notice',
    title: desktopText('error.rateLimited.title'),
    message: desktopText('error.rateLimited.message'),
  }
}

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invokeWithRecovery<T>(channel, args, 0)
}

/** 网关重启窗口期各桥接层经 getConnection() 抛出的"尚未就绪"——同样可自愈。 */
function isGatewayNotReady(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error)
  return /尚未就绪|not ready/i.test(raw)
}

/**
 * 网关瞬断（进程崩溃/重启）自愈：网络类失败或"尚未就绪"先让主进程拉起/恢复
 * gateway 连接（in-flight 去重，风暴时只触发一次恢复），成功后重试原请求一次；
 * 仍失败才走原有错误弹窗——把"永久弹窗等用户手动重启"变成"短暂等待后自愈"
 * （issue #179）。
 */
async function invokeWithRecovery<T>(channel: string, args: unknown[], attempt: number): Promise<T> {
  try {
    const result = await ipcRenderer.invoke(channel, ...args) as T
    const notice = rateLimitNotice(result)
    if (!notice) return result
    notice.channel = channel
    reportRequestError(notice)
    throw new Error(notice.message)
  } catch (error) {
    if (error instanceof Error && isRateLimitMessage(error.message)) throw error
    if (attempt === 0 && (networkErrorDetail(channel, error) || isGatewayNotReady(error))) {
      try {
        const recovered = await ipcRenderer.invoke('gateway:recover') as { ok: boolean } | undefined
        if (recovered?.ok) return await invokeWithRecovery<T>(channel, args, 1)
      } catch {
        // 恢复通道自身失败：走原始错误路径。
      }
    }
    const detail = requestError(channel, error)
    // 用户主动取消 OIDC 登录是预期结局而非故障：不进全局错误上报，
    // 原样抛回调用方由登录页静默收场（renderer 按 message 哨兵识别）。
    if (detail.message !== OIDC_LOGIN_CANCELLED_MESSAGE) reportRequestError(detail)
    throw new Error(detail.message)
  }
}

async function invokeQuietly<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    const result = await ipcRenderer.invoke(channel, ...args) as T
    // 补全通道的预期失败以哨兵 payload 跨 IPC（避免 Electron 对 reject 打 ERROR 级
    // console 噪音），这里还原成普通 Error——渲染端分类/重试逻辑不变。
    if (isCursorCompletionAgentErrorPayload(result)) {
      throw new Error(result.__cursorCompletionAgentError)
    }
    const notice = rateLimitNotice(result)
    if (!notice) return result
    throw new Error(notice.message)
  } catch (error) {
    throw new Error(errorMessage(error))
  }
}

const api: NxcoreDesktopApi = {
  platform: process.platform,
  app: {
    clearUserData: () => ipcRenderer.invoke('app:clear-user-data'),
  },
  updater: {
    getStatus: () => ipcRenderer.invoke('update:get-status'),
    checkNow: () => ipcRenderer.invoke('update:check-now'),
    onProgress: (listener) => {
      ipcRenderer.on('update:progress', (_event, progress) => listener(progress))
      return () => ipcRenderer.removeAllListeners('update:progress')
    },
    onDownloaded: (listener) => {
      ipcRenderer.on('update:downloaded', (_event, info) => listener(info))
      return () => ipcRenderer.removeAllListeners('update:downloaded')
    },
    onError: (listener) => {
      ipcRenderer.on('update:error', (_event, payload) => listener(payload))
      return () => ipcRenderer.removeAllListeners('update:error')
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getState: () => ipcRenderer.invoke('window:get-state'),
    onMaximizedChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean) => listener(maximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => ipcRenderer.removeListener('window:maximized-changed', handler)
    },
  },
  appearance: {
    setTheme: (theme) => ipcRenderer.invoke('appearance:set-theme', theme),
  },
  office: {
    setActiveInstance: (id) => ipcRenderer.invoke('office:instance:set-active', id),
    closeInstance: (id) => ipcRenderer.invoke('office:instance:close', id),
    /**
     * 干净画布：隐藏/显示 Word 编辑器操作区（Ribbon/状态栏/标尺/导航）。
     * fileId 省略 = 当前焦点 Word 页签；hidden 省略 = 切换。
     */
    toggleChrome: (input?: { fileId?: string; hidden?: boolean }) =>
      ipcRenderer.invoke('office:chrome-toggle', input ?? {}),
    /** Doc 生成流程原型：真实走 genoffice 管线生成 docx 并入库，返回 fileId。 */
    generateDocxPrototype: (input) => ipcRenderer.invoke('office:generate-docx-prototype', input),
    setWorkspaceBounds: (bounds) => ipcRenderer.send('office:workspace-bounds', bounds),
    /** Agent 生成 Office 文件的进度/完成事件（完成带 fileId 用于自动打开预览）。 */
    onAgentFile: (listener: (event: OfficeAgentFileEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: OfficeAgentFileEvent) => listener(payload)
      ipcRenderer.on('office:agent-file', handler)
      return () => ipcRenderer.removeListener('office:agent-file', handler)
    },
    /** 批注队列快照：渲染层（队列事实）→ 主进程 → 对应文件的编辑器视图（文档内锚点）。 */
    syncAskQueue: (input: { fileId: string; items: Array<{
      id: string
      instruction: string
      excerpt?: string
      /** 各格式自己的定位字段（Word 块索引 / Excel 区域 / PPT 元素 / PDF 页面 quads）。 */
      anchor?: OfficeAskAnchor
    }> }) => ipcRenderer.send('office:ask-queue-sync', input),
    /** 文档内批注面板动作（全部发送 / 移除 / 改写一条）→ 渲染层队列事实。 */
    onAskQueueAction: (listener: (event: OfficeAskQueueActionEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: OfficeAskQueueActionEvent) => listener(payload)
      ipcRenderer.on('office:ask-queue-action', handler)
      return () => ipcRenderer.removeListener('office:ask-queue-action', handler)
    },
    /** slides「AI 修改」弹层转发事件（切到对应 Room 并自动发送注入消息）。 */
    onAgentAsk: (listener: (event: OfficeAgentAskEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: OfficeAgentAskEvent) => listener(payload)
      ipcRenderer.on('office:agent-ask', handler)
      return () => ipcRenderer.removeListener('office:agent-ask', handler)
    },
    /** Agent 改写后实例被重开：重新挂一次视口，把新原生视图的矩形上报给主进程。 */
    onInstanceReloaded: (listener: (event: { id: string; kind: OfficePreviewKind }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { id: string; kind: OfficePreviewKind }) => listener(payload)
      ipcRenderer.on('office:instance-reloaded', handler)
      return () => ipcRenderer.removeListener('office:instance-reloaded', handler)
    },
    /**
     * 主进程主动打开的预览实例（排版面板 👁 预览模版原文件等）：
     * 实例已在主进程建好，渲染端只需开顶栏标签并激活——不接这条事件，
     * 原生视图会一直隐藏，用户看到的就是「点了预览没反应」。
     */
    onPreviewRequest: (listener: (request: OfficePreviewRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: OfficePreviewRequest) => listener(payload)
      ipcRenderer.on(OFFICE_PREVIEW_REQUEST_CHANNEL, handler)
      return () => ipcRenderer.removeListener(OFFICE_PREVIEW_REQUEST_CHANNEL, handler)
    },
  },
  locale: {
    system: ipcRenderer.sendSync('app:get-system-locale-sync') as string,
    getSystem: () => ipcRenderer.invoke('app:get-system-locale'),
    set: (locale) => {
      if (!isDesktopLocale(locale)) return
      currentLocale = locale
      ipcRenderer.send('app:set-locale', locale)
    },
  },
  clipboard: {
    writeText: (text) => invokeQuietly('system-clipboard:write-text', text),
  },
  errors: {
    onRequestError: (listener) => {
      requestErrorListeners.add(listener)
      if (pendingRequestError) {
        if (Date.now() - pendingRequestErrorAt <= PENDING_REQUEST_ERROR_TTL_MS) listener(pendingRequestError)
        pendingRequestError = null
      }
      return () => requestErrorListeners.delete(listener)
    },
    report: reportRequestError,
  },
  diagnostics: {
    log: (input) => ipcRenderer.send('app:diagnostic-log', input),
  },
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
  },
  migrations: {
    discover: () => invokeQuietly('migrations:discover'),
    chooseOpenClaw: () => invoke('migrations:choose-openclaw'),
    importOpenClaw: (id) => invoke('migrations:import-openclaw', id),
    localAgentSources: (provider) => invokeQuietly('migrations:local-agent-sources', provider),
    chooseLocalAgentDirectory: (provider) => invoke('migrations:choose-local-agent-directory', provider),
    importLocalAgentMigration: (provider, id) => invoke('migrations:import-local-agent-migration', provider, id),
    importNotionZip: () => invoke('migrations:import-notion-zip'),
    importCherry: (id?: string) => invoke('migrations:import-cherry', id),
    setCherrySync: (sourceId: string, active: boolean) => invoke('migrations:set-cherry-sync', sourceId, active),
    exportCherry: (sourceId: string) => invoke<string | null>('migrations:export-cherry', sourceId),
    sources: () => invokeQuietly('migrations:sources'),
    runs: (sourceId) => invokeQuietly('migrations:runs', sourceId),
    cancel: (runId) => invoke('migrations:cancel', runId),
    retry: (runId) => invoke('migrations:retry', runId),
    reimport: (sourceId) => invoke('migrations:reimport', sourceId),
    clear: (sourceId) => invoke('migrations:clear', sourceId),
    conversations: (query) => invokeQuietly('migrations:conversations', query),
    preview: (id) => invokeQuietly('migrations:preview', id),
    onProgress: (listener) => {
      const handle = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value)
      ipcRenderer.on('migrations:progress', handle)
      return () => ipcRenderer.removeListener('migrations:progress', handle)
    },
  },
  nangoConnector: {
    status: () => invoke('nango-connector:status'),
    providers: () => invoke('nango-connector:providers'),
    oauthConfigs: () => invokeQuietly<Array<{ provider: string; displayName: string | null; iconUrl: string | null }> | string[] | null>('nango-connector:oauth-configs'),
    startAuthorization: (provider) => invoke('nango-connector:start-authorization', provider),
    authorizationStatus: (id) => invoke('nango-connector:authorization-status', id),
    remoteAccount: (provider) => invoke('nango-connector:remote-account', provider),
    purgeConnection: (id) => invoke('nango-connector:purge-connection', id),
    reconnectConnection: (id) => invoke('nango-connector:reconnect-connection', id),
  },
  cliConnector: {
    // 通道名与主进程 OPEN_CONNECTOR_CHANNELS 对齐（open-connector:*；统一改名前的
    // cli-connector:* 在主进程无注册，调用会报 No handler registered）。
    status: () => invokeQuietly('open-connector:status'),
    execute: (input) => invokeQuietly('open-connector:execute', input),
    cancel: (requestId) => invokeQuietly('open-connector:cancel', requestId),
    openConsole: () => invokeQuietly('open-connector:open-console'),
    /** 发起 provider OAuth（本地直调运行时 / SaaS 代发起），返回授权页 URL 并由主进程打开。 */
    startAuthorization: (service: string) => invokeQuietly('open-connector:start-authorization', service),
    mode: () => invokeQuietly('open-connector:mode'),
    setMode: (mode: 'saas' | 'local') => invokeQuietly('open-connector:set-mode', mode),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('open-connector:event', handleEvent)
      return () => ipcRenderer.removeListener('open-connector:event', handleEvent)
    },
  },
  agentAuth: {
    status: () => invokeQuietly('agent-auth:status'),
    start: (input) => invoke('agent-auth:start', input),
    resume: (challengeId) => invokeQuietly('agent-auth:resume', challengeId),
    cancel: (challengeId) => invokeQuietly('agent-auth:cancel', challengeId),
    disconnect: (provider: 'feishu') => invoke('agent-auth:disconnect', provider),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('agent-auth:event', handleEvent)
      return () => ipcRenderer.removeListener('agent-auth:event', handleEvent)
    },
  },
  mcp: {
    listServers: () => invoke('mcp:servers:list'),
    saveServers: (servers) => invoke('mcp:servers:save', servers),
  },
  externalCalls: {
    listPolicies: (query) => invokeQuietly('external-calls:policies:list', query),
    savePolicy: (input) => invoke('external-calls:policies:save', input),
    deletePolicy: (id) => invoke('external-calls:policies:delete', id),
    listUsage: (query) => invokeQuietly('external-calls:usage:list', query),
    listAudits: (query) => invokeQuietly('external-calls:audits:list', query),
  },
  writingStyle: {
    profile: () => invoke('writing-style:get'),
    settings: () => invoke('writing-style:get-settings'),
    updateSettings: (input) => invoke('writing-style:update-settings', input),
    userContent: () => invoke('writing-style:get-user-content'),
    replaceUserContent: (content) => invoke('writing-style:replace-user-content', content),
    regenerateUserContent: () => invoke('writing-style:regenerate-user-content'),
    recompute: () => invoke('writing-style:recompute'),
    backfill: () => invoke('writing-style:backfill'),
    corpus: () => invoke('writing-style:list-corpus'),
    setExclusion: (documentId, excluded) => invoke('writing-style:set-exclusion', documentId, excluded),
    insights: () => invoke('writing-style:list-insights'),
    snoozeInsight: (insightId) => invoke('writing-style:snooze-insight', insightId),
    confirmInsight: (insightId) => invoke('writing-style:confirm-insight', insightId),
    reportCompletionFeedback: (input) => invoke('writing-style:completion-feedback', input),
  },
  agentSchedules: {
    list: () => invoke('agent-scheduler:list'),
    create: (input) => invoke('agent-scheduler:create', input),
    update: (id, input) => invoke('agent-scheduler:update', id, input),
    remove: (id) => invoke('agent-scheduler:remove', id),
    runNow: (id) => invoke('agent-scheduler:run-now', id),
  },
  agentAccess: {
    listConnections: () => invokeQuietly<{ connections: AgentConnectionDto[] }>('agent-access:list-connections'),
    createConnection: (input: AgentAccessCreateInput) =>
      invoke<{ connection: AgentConnectionDto; token: string }>('agent-access:create-connection', input),
    updateConnection: (id: string, input: AgentAccessUpdateInput) =>
      invoke<{ connection: AgentConnectionDto }>('agent-access:update-connection', id, input),
    revokeConnection: (id: string) => invoke<{ connection: AgentConnectionDto }>('agent-access:revoke-connection', id),
    rotateToken: (id: string) => invoke<{ connection: AgentConnectionDto; token: string }>('agent-access:rotate-token', id),
    submissions: (id: string) =>
      invokeQuietly<{ submissions: Array<Record<string, unknown>> }>('agent-access:submissions', id),
    events: (id: string) =>
      invokeQuietly<{ events: Array<Record<string, unknown>> }>('agent-access:events', id),
    selftest: (id: string) => invoke<AgentAccessSelftestDto>('agent-access:selftest', id),
    exampleQuery: (id: string, query?: string) =>
      invoke<AgentAccessExampleQueryDto>('agent-access:example-query', id, query),
    install: (connectionId: string, target: string, token: string) =>
      invoke<{ outcome: AgentAccessInstallOutcomeDto; plan: { url: string; notes: string[] } }>(
        'agent-access:install',
        connectionId,
        target,
        token,
      ),
    uninstall: (target: string) => invoke<AgentAccessUninstallOutcomeDto>('agent-access:uninstall', target),
    settingsGet: () => invoke<AgentAccessSettingsDto>('agent-access:settings-get'),
    setFixedPort: (port: number | null) =>
      invoke<{ fixedPort: number | null; needsRestart: boolean }>('agent-access:settings-set-fixed-port', port),
    restartGateway: () => invoke<{ baseUrl: string }>('agent-access:restart-gateway'),
  },
  memory: {
    listEntries: (input?: { limit?: number; scope?: string }) =>
      invokeQuietly('memory:list-entries', input ?? {}),
    getProfile: (input?: { limit?: number }) =>
      invokeQuietly('memory:get-profile', input ?? {}),
  },
  // 主页「今日洞察」：静默调用——卡片自己渲染空态/失败态，不弹全局错误。
  workspaceInsight: {
    get: (workspaceId: string, options?: { force?: boolean }) =>
      invoke('workspace-insight:get', workspaceId, options) as Promise<import('../shared/sources').WorkspaceInsightDto>,
  },
  journal: {
    today: () => invokeQuietly('journal:today'),
    refresh: () => invokeQuietly('journal:refresh'),
  },
  // 工作空间「计划」：读写走普通 invoke（失败要能被看板接住并回滚）。
  plan: {
    list: (query: PlanItemListQuery) => invoke('plan:list', query),
    create: (input: CreatePlanItemInput) => invoke('plan:create', input),
    get: (itemId: string) => invoke('plan:get', itemId),
    update: (itemId: string, input: UpdatePlanItemInput) => invoke('plan:update', itemId, input),
    move: (itemId: string, input: MovePlanItemInput) => invoke('plan:move', itemId, input),
    release: (itemId: string, reason: string) => invoke('plan:release', itemId, reason),
    assign: (itemId: string, agentId?: string) => invoke('plan:assign', itemId, agentId),
    remove: (itemId: string) => invoke('plan:remove', itemId),
    events: (itemId: string) => invoke('plan:events', itemId),
    claimPackage: (itemId: string) => invoke('plan:claim-package', itemId),
    batch: (input: PlanBatchInput) => invoke('plan:batch', input),
    subscribe: (workspaceId: string) => invoke('plan:subscribe', workspaceId),
    unsubscribe: (workspaceId?: string) => invoke('plan:unsubscribe', workspaceId),
    onChanged: (listener: (payload: PlanChangePayload) => void) => {
      const handleChange = (_event: Electron.IpcRendererEvent, payload: PlanChangePayload) => listener(payload)
      ipcRenderer.on('plan:changed', handleChange)
      return () => ipcRenderer.removeListener('plan:changed', handleChange)
    },
  },
  agentDebug: {
    // 调试面板是只读查询：quiet 调用（不弹全局错误、不做 gateway recovery 重试），
    // 失败文本由面板自己以一行弱化文字展示。
    listAgents: () => invokeQuietly<AgentDebugAgentsResponse>('agent-debug:list-agents'),
    getAgent: (id: string) => invokeQuietly<AgentDebugAgentResponse>('agent-debug:get-agent', id),
    listUsage: (id: string, limit?: number) =>
      invokeQuietly<AgentDebugUsageResponse>('agent-debug:list-usage', id, limit),
    // 打开独立调试窗口（单例）。窗口的生命周期由主进程持有，渲染层只触发。
    openWindow: () => invoke<void>('agent-debug:open-window'),
  },
  slides: {
    /** 配图过目卡轮询：后台逐张生成期间按草稿文档拉最新会话快照。 */
    pageImagesStatus: (documentId: string) =>
      invokeQuietly<SlidesPageImagesStatus | null>('slides:page-images-status', documentId),
  },
  subagents: {
    getSubagentInvocation: (invocationId: string) =>
      invokeQuietly('subagents:get-invocation', invocationId),
    cancelSubagentInvocation: (invocationId: string) =>
      invokeQuietly('subagents:cancel-invocation', invocationId),
    listRunSubagentInvocations: (rootRunId: string) =>
      invokeQuietly('subagents:list-run-invocations', rootRunId),
    listSubagentInvocationEvents: (invocationId: string, afterSeq = 0) =>
      invokeQuietly('subagents:list-invocation-events', invocationId, afterSeq),
  },
  account: {
    status: (options) => options?.quiet ? invokeQuietly('account:status', false) : invoke('account:status', true),
    devices: (options) => options?.quiet ? invokeQuietly('account:devices') : invoke('account:devices'),
    login: (input) => invoke('account:login', input),
    validateInvitationCode: (invitationCode) => invokeQuietly('account:invitation-code-validate', invitationCode),
    redeemInvitationCode: (invitationCode) => invokeQuietly('account:invitation-code-redeem', invitationCode),
    loginWithOidc: (provider, invitationCode) => invoke('account:oidc-login', { provider, invitationCode }),
    cancelOidcLogin: () => invoke('account:oidc-cancel'),
    logout: () => invoke('account:logout'),
    keyringStatus: (options) => options?.quiet ? invokeQuietly('account:keyring-status') : invoke('account:keyring-status'),
    createPairingSession: () => invoke('account:create-pairing-session'),
    getPairingSession: (id, options) => options?.quiet ? invokeQuietly('account:get-pairing-session', id) : invoke('account:get-pairing-session', id),
    approvePairingSession: (id) => invoke('account:approve-pairing-session', id),
    // 扫码登录：renderer 不传 token，只传可选 session id；桌面交换凭证不离开主进程。
    createQrLoginSession: () => invoke('account:qr-login-create'),
    getQrLoginStatus: (sessionId?: string) => invokeQuietly('account:qr-login-status', sessionId),
    exchangeQrLoginSession: (sessionId?: string) => invoke('account:qr-login-exchange', sessionId),
    cancelQrLoginSession: (sessionId?: string) => invoke('account:qr-login-cancel', sessionId),
    replaceDeviceAdmission: (input: { admissionToken: string; replaceDeviceId: string }) => invoke('account:device-admission-replace', input),
    dismissDeviceAdmission: () => invoke('account:device-admission-dismiss'),
    onAdmissionRequired: (listener: (status: CloudAccountStatus) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, status: CloudAccountStatus) => listener(status)
      ipcRenderer.on('account:admission-required', handle)
      return () => ipcRenderer.removeListener('account:admission-required', handle)
    },
  },
  aiRelay: {
    status: () => invokeQuietly('ai-relay:status'),
    verdict: () => invokeQuietly('ai-relay:verdict'),
    onEvent: (listener: (event: { type: AiRelayKeeperEventType }) => void) => {
      const handle = (_event: Electron.IpcRendererEvent, value: unknown) => {
        const eventType = value && typeof value === 'object' ? (value as { type?: unknown }).type : null
        if (eventType !== 'quota-exhausted' && eventType !== 'session-activated') return
        listener({ type: eventType })
      }
      for (const channel of ['ai-relay:quota-exhausted', 'ai-relay:session-activated']) {
        ipcRenderer.on(channel, handle)
      }
      return () => {
        for (const channel of ['ai-relay:quota-exhausted', 'ai-relay:session-activated']) {
          ipcRenderer.removeListener(channel, handle)
        }
      }
    },
  },
  notifications: {
    preferences: () => invokeQuietly('notifications:preferences'),
    updatePreferences: (input) => invoke('notifications:update-preferences', input),
    cloudSessions: (deviceId) => invokeQuietly('notifications:cloud-sessions', deviceId),
    cloudMessages: (deviceId, sessionId, before) => invokeQuietly('notifications:cloud-messages', deviceId, sessionId, before),
    onOpenTarget: (listener) => {
      const handle = (_event: Electron.IpcRendererEvent, target: Parameters<typeof listener>[0]) => listener(target)
      ipcRenderer.on('notifications:open-target', handle)
      ipcRenderer.send('notifications:renderer-ready')
      return () => ipcRenderer.removeListener('notifications:open-target', handle)
    },
  },
  runtimeConfig: {
    get: () => invoke('runtime-config:get'),
    saveUser: (input: unknown) => invoke('runtime-config:save-user', input),
    clearUser: () => invoke('runtime-config:clear-user'),
    relayReady: () => invoke('runtime-config:relay-ready'),
    selectSource: (source: 'user' | 'default') => invoke('runtime-config:select-source', source),
    test: () => invoke('runtime-config:test'),
  },
  permissions: {
    /** OS 麦克风授权状态（本地 TCC 查询，不经网关）。属本地系统能力而非网关调用。 */
    getMicrophoneAccessStatus: () => invoke('permissions:microphone-access-status'),
    /** 弹出系统麦克风授权请求（本地 TCC，不经网关）。 */
    requestMicrophoneAccess: () => invoke('permissions:request-microphone-access'),
    /** 打开系统「麦克风」隐私设置页。 */
    openMicrophoneSettings: () => invoke('permissions:open-microphone-settings'),
  },
  search: {
    invoke: (request: SearchRequestDto): Promise<SearchPageDto> => invoke('search:invoke', request),
    status: (): Promise<SearchScopeDto> => invoke('search:status'),
    prioritize: (itemType: SearchItemType, refId: string): Promise<{ ok: boolean }> =>
      invoke('search:prioritize', itemType, refId),
    messageContext: (messageId: string, before?: number, after?: number): Promise<SearchMessageContextDto> =>
      invoke('search:message-context', messageId, before, after),
  },
  agent: {
    discoverLocalAgents: () => invokeQuietly('agent:discover-local-agents'),
    checkLocalAgentAdapters: (agentIds: string[]) => invokeQuietly('agent:check-local-agent-adapters', agentIds),
    installLocalAgentAdapter: (agentId: string) => invoke('agent:install-local-agent-adapter', agentId),
    importLocalAgentHistory: (agentId: string) => invoke('agent:import-local-agent-history', agentId),
    bindLocalAgentWorkspace: (agentId: string, sessionId: string) => invoke('agent:bind-local-agent-workspace', agentId, sessionId),
    getStatus: () => invokeQuietly('agent:get-status'),
    getDefinition: (agentId: string) => invokeQuietly('agent:get-definition', agentId),
    listSkills: () => invokeQuietly('agent:list-skills'),
    getSkill: (skillId: string) => invokeQuietly('agent:get-skill', skillId),
    setSkillEnabled: (skillId: string, enabled: boolean) =>
      invoke('agent:set-skill-enabled', skillId, enabled),
    createSkill: (input) => invoke('agent:create-skill', input),
    importSkillDirectory: (sourceDirectory: string) => invoke('agent:import-skill-directory', sourceDirectory),
    pickSkillDirectory: () => invokeQuietly('agent:pick-skill-directory'),
    deleteSkill: (skillId: string) => invoke('agent:delete-skill', skillId),
    getUsage: (range) => invoke('agent:get-usage', range),
    /** 「+ → 挂载目录」：系统选择框选本地目录，取消返回 null。 */
    pickMountDirectory: () => invoke<string | null>('agent:pick-mount-directory'),
    listSessions: (pageLabel, roomId, workspaceId) => invoke('agent:list-sessions', pageLabel, roomId, workspaceId),
    createSession: (input) => invoke('agent:create-session', input),
    createSessionLink: (input) => invoke('agent:create-session-link', input),
    listSessionLinks: (sessionId) => invoke('agent:list-session-links', sessionId),
    markSessionLinkReturned: (linkId) => invoke('agent:mark-session-link-returned', linkId),
    updateSession: (sessionId, input) => invoke('agent:update-session', sessionId, input),
    generateSessionTitle: (input) => invoke('agent:generate-session-title', input),
    suggestConversationPrompt: (input) => invoke('agent:suggest-conversation-prompt', input),
    suggestStarterPrompts: (input) => invoke('agent:suggest-starter-prompts', input),
    deleteSession: (sessionId) => invoke('agent:delete-session', sessionId),
    getSession: (sessionId) => invoke('agent:get-session', sessionId),
    getEvents: (sessionId, runId, afterSeq) =>
      invoke('agent:get-events', sessionId, runId, afterSeq),
    getLocalAgentDispatch: (sessionId, taskId) =>
      invoke('agent:get-local-agent-dispatch', sessionId, taskId),
    startRun: (sessionId, input) => invoke('agent:start-run', sessionId, input),
    submitPendingIntent: (intentId, input) =>
      invokeQuietly('agent:submit-pending-intent', intentId, input),
    cancelRun: (runId) => invoke('agent:cancel-run', runId),
    resolveApproval: (approvalId, decision, feedback) => invoke('agent:resolve-approval', approvalId, decision, feedback),
    getPermissionMode: (sessionId) => invoke('agent:get-permission-mode', sessionId),
    setPermissionMode: (sessionId, mode) => invoke('agent:set-permission-mode', sessionId, mode),
    setThinkingLevel: (sessionId, level) => invoke('agent:set-thinking-level', sessionId, level),
    subscribe: (sessionId) => invoke('agent:subscribe', sessionId),
    unsubscribe: () => invoke('agent:unsubscribe'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('agent:event', handleEvent)
      return () => ipcRenderer.removeListener('agent:event', handleEvent)
    },
  },
  workspace: {
    list: () => invoke('workspace:list'),
    create: (input) => invoke('workspace:create', input),
    update: (workspaceId, input) => invoke('workspace:update', workspaceId, input),
    /** 概览「动态」：按 (at, id) 游标分页的派生事件流（runs + 文件库 + 计划）。 */
    activities: (workspaceId: string, query?: { limit?: number; beforeAt?: string; beforeId?: string }) =>
      invoke('workspace:activities', workspaceId, query ?? {}),
    remove: (workspaceId) => invoke('workspace:remove', workspaceId),
    pickDirectory: () => invoke('workspace:pick-directory'),
    /** 新建弹窗的默认落点预览（`<dataDir>/Workspace/<slug>`）。 */
    defaultRoot: (name: string) => invoke('workspace:default-root', name),
    /** 判定目录是否为项目空间（读 `.everoffice/space.json`）。 */
    detect: (dir: string) => invoke('workspace:detect', dir),
    /** 扫容器根，发现未注册/失效的项目空间。 */
    discover: () => invoke('workspace:discover'),
    /** 接管已有目录（复制品传 reassignSpaceId=true 另立身份）。 */
    adopt: (input: { dir: string; name?: string; reassignSpaceId?: boolean }) =>
      invoke('workspace:adopt', input),
    /** 搬移空间目录。 */
    relocate: (workspaceId: string, dir: string) => invoke('workspace:relocate', workspaceId, dir),
    /** 空间目录快照（路径 + 健康）；未绑定目录时抛错，调用方按空态处理。 */
    layout: (workspaceId: string) => invoke('workspace:layout', workspaceId),
    /** 幂等修复：补缺失目录 / 补缺失标记。 */
    repair: (workspaceId: string) => invoke('workspace:repair', workspaceId),
    /** 在访达里选中某个目录。 */
    reveal: (dir: string) => invoke('workspace:reveal', dir),
    /** 资料库对账：盘上删了→missing、回来了→恢复、多了→入库。 */
    reconcileLibrary: (workspaceId: string) => invoke('workspace:library-reconcile', workspaceId),
    /** 存量懒回填：把只在对象库里的老条目落到空间 Library。 */
    backfillLibrary: (workspaceId: string, limit?: number) =>
      invoke('workspace:library-backfill', workspaceId, limit),
    /** 空间缓存占用（tmp / derived / objects）。 */
    cacheStats: (workspaceId: string) => invoke('workspace:cache-stats', workspaceId),
    /** 缓存回收（tmp/derived 按龄、objects 按引用、回收站 30 天）。 */
    gcCache: (workspaceId: string) => invoke('workspace:cache-gc', workspaceId),
    /** `.tmp/` 只读清单（临时文件入口，不入资料库索引）。 */
    scratchFiles: (workspaceId: string) => invoke('workspace:cache-scratch', workspaceId),
  },
  cursorCompletionAgent: {
    createSession: (input) => invokeQuietly('cursor-completion-agent:create-session', input),
    deleteSession: (sessionId) =>
      invokeQuietly('cursor-completion-agent:delete-session', sessionId),
    getEvents: (sessionId, runId, afterSeq) =>
      invokeQuietly('cursor-completion-agent:get-events', sessionId, runId, afterSeq),
    startRun: (sessionId, input) =>
      invokeQuietly('cursor-completion-agent:start-run', sessionId, input),
    cancelRun: (runId) => invokeQuietly('cursor-completion-agent:cancel-run', runId),
    subscribe: (sessionId) => invokeQuietly('cursor-completion-agent:subscribe', sessionId),
    unsubscribe: () => invokeQuietly('cursor-completion-agent:unsubscribe'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('cursor-completion-agent:event', handleEvent)
      return () => ipcRenderer.removeListener('cursor-completion-agent:event', handleEvent)
    },
  },
  sources: {
    list: () => invoke('sources:list'),
    listFiles: (id) => invoke('sources:list-files', id),
    listEvidence: (id, fileId) => invoke('sources:list-evidence', id, fileId),
    previewFile: (id, fileId) => invoke('sources:preview-file', id, fileId),
    searchEvidence: (query, id) => invoke('sources:search-evidence', query, id),
    onChanged: (listener) => {
      const handleChanged = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => {
        listener(payload)
      }
      ipcRenderer.on('sources:changed', handleChanged)
      return () => ipcRenderer.removeListener('sources:changed', handleChanged)
    },
    showFile: (id, fileId) => invoke('sources:show-file', id, fileId),
    addLocalFolder: () => invoke('sources:add-local-folder'),
    listDefaultLocalFolders: () => invoke('sources:list-default-local-folders'),
    connectDefaultLocalFolders: (folders) => invoke('sources:connect-default-local-folders', folders),
    addGitHub: (input) => invoke('sources:add-github', input),
    addGoogleDocs: (input) => invoke('sources:add-google-docs', input),
    addNotion: (input) => invoke('sources:add-notion', input),
    sync: (id) => invoke('sources:sync', id),
    setPaused: (id, paused) => invoke('sources:set-paused', id, paused),
    disconnect: (id, deleteLocalData) =>
      invoke('sources:disconnect', id, deleteLocalData),
  },
  obsidian: {
    discover: () => invoke('obsidian:discover'),
    pickCandidate: () => invoke('obsidian:pick-candidate'),
    importCandidate: (candidateId, target) => invoke('obsidian:import-candidate', candidateId, target),
    list: () => invoke('obsidian:list'),
    tree: (vaultId) => invoke('obsidian:tree', vaultId),
    readNote: (vaultId, resourceId) => invoke('obsidian:read-note', vaultId, resourceId),
    saveNote: (vaultId, resourceId, markdown, expectedSourceHash) =>
      invoke('obsidian:save-note', vaultId, resourceId, markdown, expectedSourceHash),
    createNote: (vaultId, relativePath, markdown) =>
      invoke('obsidian:create-note', vaultId, relativePath, markdown),
    moveNote: (vaultId, resourceId, relativePath, expectedSourceHash) =>
      invoke('obsidian:move-note', vaultId, resourceId, relativePath, expectedSourceHash),
    trashNote: (vaultId, resourceId, expectedSourceHash) =>
      invoke('obsidian:trash-note', vaultId, resourceId, expectedSourceHash),
    addAttachment: (vaultId, noteRelativePath) =>
      invoke('obsidian:add-attachment', vaultId, noteRelativePath),
    rescan: (vaultId) => invoke('obsidian:rescan', vaultId),
    disconnect: (vaultId) => invoke('obsidian:disconnect', vaultId),
    onChanged: (listener) => {
      const handleChanged = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('obsidian:changed', handleChanged)
      return () => ipcRenderer.removeListener('obsidian:changed', handleChanged)
    },
    onDiscoveryChanged: (listener) => {
      const handleChanged = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('obsidian:discovery-changed', handleChanged)
      return () => ipcRenderer.removeListener('obsidian:discovery-changed', handleChanged)
    },
  },
  files: {
    list: (limit?: number, offset?: number, options?: { workspaceId?: string }) =>
      invoke('files:list', limit, offset, options),
    catalogEntry: (fileId: string) => invoke('files:catalog-entry', fileId),
    get: (fileId: string) => invoke('files:get', fileId),
    readMarkdown: (fileId: string, options?: { waitMs?: number; pollMs?: number }) =>
      invoke('files:read-markdown', fileId, options),
    readDataUrl: (fileId: string) => invokeQuietly('files:read-data-url', fileId),
    rename: (fileId: string, displayName: string) => invoke('files:rename', fileId, displayName),
    delete: (fileId: string) => invoke('files:delete', fileId),
    reveal: (fileId: string) => invoke('files:reveal', fileId),
    exportReveal: (fileId: string, originalName: string) =>
      invoke('files:export-reveal', fileId, originalName),
    openOriginal: (
      fileId: string,
      originalName?: string,
      contentHash?: string,
      options?: { editable?: boolean; roomId?: string; workspaceId?: string },
    ) =>
      invoke('files:open-original', fileId, originalName, contentHash, options),
    pickAndImport: (options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }) =>
      invoke('files:pick-and-import', options),
    /** 仅选择：返回文件/文件夹路径，不导入（创建 Room 弹窗暂存用）。 */
    pickPaths: () => invoke<string[]>('files:pick-paths'),
    /** 提交后的一次性导入：把暂存路径交给统一导入链路。 */
    importPaths: (paths: string[], options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }) =>
      invoke('files:import-paths-once', paths, options),
    importDropped: (files: File[], options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return invoke('files:import-paths-once', paths, options)
    },
    importArtifacts: (files: File[], roomId: string, workspaceId?: string) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return invoke('files:import-artifacts', paths, roomId, workspaceId)
    },
    importAgentAttachments: (files: File[]) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return invoke('files:import-agent-attachments', paths)
    },
    /** 「+ → 导入文件」：系统选择框直选文件并导入为对话附件（取消返回空数组）。 */
    pickAgentAttachments: () => invoke<AgentAttachmentReference[]>('files:pick-agent-attachments'),
    onImportProgress: (listener) => {
      const handleProgress = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress)
      ipcRenderer.on('files:import-progress', handleProgress)
      return () => ipcRenderer.removeListener('files:import-progress', handleProgress)
    },
    listHighRiskReviews: () => invoke('files:high-risk-reviews:list'),
    resolveHighRiskReview: (id: string, accepted: boolean) =>
      invoke('files:high-risk-reviews:resolve', id, accepted),
    onHighRiskReviewsChanged: (listener) => {
      const handleChanged = () => listener()
      ipcRenderer.on('files:high-risk-reviews:changed', handleChanged)
      return () => ipcRenderer.removeListener('files:high-risk-reviews:changed', handleChanged)
    },
    // 系统文件管理器（访达「打开方式」/ 资源管理器双击）打开文档：主进程导入后交回渲染层开预览。
    onOpenFromOs: (listener: (document: OsOpenedDocument) => void) => {
      const handleOpen = (_event: Electron.IpcRendererEvent, document: OsOpenedDocument) => listener(document)
      ipcRenderer.on('files:open-from-os', handleOpen)
      return () => ipcRenderer.removeListener('files:open-from-os', handleOpen)
    },
    takePendingOsOpen: () => invoke('files:take-pending-os-open'),
  },
  thesisFormat: {
    listCards: (workspaceId: string): Promise<Array<{
      id: string
      sourceName: string
      sourceFileEntryId: string | null
      updatedAt: string
      card: Record<string, unknown>
    }>> => invoke('thesis-format:cards:list', workspaceId),
    setFromLibrary: (workspaceId: string, fileEntryId: string) =>
      invoke('thesis-format:parse:library', workspaceId, fileEntryId),
    pickAndSet: (workspaceId: string, options?: { wordOnly?: boolean }): Promise<{ canceled: boolean; cardId: string; sourceName: string; factGaps?: string[] }> =>
      invoke('thesis-format:parse:pick', workspaceId, options),
    /** 工作台拖拽上传：直接把字节交给网关解析成格式卡（不落盘、不进文件库）。 */
    parseUpload: (workspaceId: string, name: string, bytes: ArrayBuffer) =>
      invoke('thesis-format:parse:upload', workspaceId, name, bytes),
    /** 彻底删除模版：模版文件 + 格式卡（先删文件含级联清理，再删卡）。 */
    deleteTemplate: (workspaceId: string, cardId: string) =>
      invoke('thesis-format:template:delete', workspaceId, cardId),
    reformat: (
      workspaceId: string,
      fileEntryId: string,
      cardId?: string,
      options?: {
        keepLogo?: boolean
        keepHeaderFooter?: boolean
        headingMapping?: { chapter?: number; section?: number; subsection?: number }
      },
    ) => invoke('thesis-format:reformat', workspaceId, fileEntryId, cardId, options),
    /** 任务化排版：立即返回 jobId，用 reformatStatus 轮询阶段进度。 */
    reformatStart: (
      workspaceId: string,
      fileEntryId: string,
      cardId?: string,
      options?: {
        keepLogo?: boolean
        keepHeaderFooter?: boolean
        headingMapping?: { chapter?: number; section?: number; subsection?: number }
      },
    ) => invoke('thesis-format:reformat:start', workspaceId, fileEntryId, cardId, options),
    reformatStatus: (jobId: string) => invoke('thesis-format:reformat:status', jobId),
    /** 导出 PDF（内置渲染引擎；老运行时回退 LibreOffice，两者都不可用才返回 { unavailable: true }）。 */
    exportPdf: (workspaceId: string, fileEntryId: string) =>
      invoke('thesis-format:export:pdf', fileEntryId),
    removeCard: (workspaceId: string, cardId: string) =>
      invoke('thesis-format:cards:remove', workspaceId, cardId),
    onCardChanged: (listener: () => void) => {
      const handler = () => listener()
      ipcRenderer.on('thesis-format:card-changed', handler)
      return () => ipcRenderer.removeListener('thesis-format:card-changed', handler)
    },
  },
}

contextBridge.exposeInMainWorld('nxcore', api)

// everoffice UI 迁移：office-proto 原型的 GenOffice 编辑器桥（window.desktop）。
// 通道由 src/main/genoffice/bridge.ts 注册，独立于上面的 office:instance:* 体系。
contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  office: {
    open: (request: { fileId: string; title: string; spec: unknown }) =>
      ipcRenderer.invoke('office:open', request) as Promise<{ ok: boolean; error?: string }>,
    activate: (fileId: string | null) => ipcRenderer.invoke('office:activate', fileId) as Promise<boolean>,
    close: (fileId: string) => ipcRenderer.invoke('office:close', fileId) as Promise<boolean>,
    dirty: (fileId: string) => ipcRenderer.invoke('office:dirty', fileId) as Promise<boolean>,
    sendBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('office:bounds', bounds),
    pickMaterials: () =>
      ipcRenderer.invoke('office:pick-materials') as Promise<Array<{ name: string; size: number }>>,
  },
})
