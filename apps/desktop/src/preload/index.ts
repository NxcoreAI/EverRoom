import '@sentry/electron/preload'

import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { KnowledgeAttachInput, KnowledgeEntityStatus } from '../shared/knowledge'
import type {
  CreateContextRoomInput,
  RoomDuplicateCheckInput,
  RoomDuplicateCandidateStatus,
  SaveContextRoomSnapshotInput,
} from '@nxcore/agent-contract'
import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
  MemoryDocumentRewriteInput,
  MemoryOnboardingInput,
  MemoryRoomMemoriesPageDto,
} from '../shared/memory'
import type { IngestPipelines } from '../shared/ingest'
import type { McpServersSnapshot } from '../shared/mcp'
import type { CloudAccountStatus, DesktopRequestError, NxcoreDesktopApi, RoomAgentSelectionRewriteInput } from '../shared/sources'
import type { BrowserExtensionMessage, BrowserExtensionStatus } from '../shared/browser-extension'
import { isCursorCompletionAgentErrorPayload } from '../shared/cursor-completion'
import { DESKTOP_PAGE_MODE_ENV, resolveDesktopPageMode } from '../shared/page-mode'
import {
  isDesktopLocale,
  translateDesktopMessage,
  type DesktopLocale,
} from '../shared/i18n/desktop'

const requestErrorListeners = new Set<(error: DesktopRequestError) => void>()
let pendingRequestError: DesktopRequestError | null = null
let currentLocale: DesktopLocale = 'zh-CN'

function desktopText(key: Parameters<typeof translateDesktopMessage>[1]): string {
  return translateDesktopMessage(currentLocale, key)
}

function isRateLimitMessage(message: string): boolean {
  return message === translateDesktopMessage('zh-CN', 'error.rateLimited.message')
    || message === translateDesktopMessage('en-US', 'error.rateLimited.message')
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
  if (/memory/i.test(channel)) return desktopText('error.network.memory')
  if (/knowledge|wiki/i.test(channel)) return desktopText('error.network.knowledge')
  if (/document/i.test(channel)) return desktopText('error.network.document')
  if (/source|file/i.test(channel)) return desktopText('error.network.files')
  if (/nango|connector/i.test(channel)) return desktopText('error.network.connectors')
  return channel ? channel.replace(/^[^:]+:/, '').replace(/[-_]/g, ' ') : desktopText('error.network.service')
}

function networkErrorDetail(channel: string, error: unknown): Pick<DesktopRequestError, 'title' | 'message'> | null {
  const raw = error instanceof Error ? error.message : String(error)
  if (!/fetch failed|failed to fetch|network error|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i.test(raw)) return null
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
  return { channel, severity: 'error', message }
}

function reportRequestError(detail: DesktopRequestError): void {
  ipcRenderer.send('app:request-error', detail)
  if (requestErrorListeners.size === 0) pendingRequestError = detail
  else for (const listener of requestErrorListeners) listener(detail)
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
  try {
    const result = await ipcRenderer.invoke(channel, ...args) as T
    const notice = rateLimitNotice(result)
    if (!notice) return result
    notice.channel = channel
    reportRequestError(notice)
    throw new Error(notice.message)
  } catch (error) {
    if (error instanceof Error && isRateLimitMessage(error.message)) throw error
    const detail = requestError(channel, error)
    reportRequestError(detail)
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
  pageMode: resolveDesktopPageMode(process.env[DESKTOP_PAGE_MODE_ENV]),
  app: {
    clearUserData: () => ipcRenderer.invoke('app:clear-user-data'),
  },
  office: {
    testAvailable: Boolean(process.env.ELECTRON_RENDERER_URL),
    setActiveInstance: (id) => ipcRenderer.invoke('office:instance:set-active', id),
    closeInstance: (id) => ipcRenderer.invoke('office:instance:close', id),
    setWorkspaceBounds: (bounds) => ipcRenderer.send('office:workspace-bounds', bounds),
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
        listener(pendingRequestError)
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
  browserExtension: {
    status: () => invokeQuietly<BrowserExtensionStatus>('browser-extension:status'),
    install: () => invoke<BrowserExtensionStatus>('browser-extension:install'),
    openDirectory: () => invoke('browser-extension:open-directory'),
    openBrowserPage: () => invoke('browser-extension:open-browser-page'),
    createPairing: () => invoke<BrowserExtensionStatus>('browser-extension:create-pairing'),
    revoke: () => invoke<BrowserExtensionStatus>('browser-extension:revoke'),
    onStatus: (listener: (status: BrowserExtensionStatus) => void) => {
      const handleStatus = (_event: Electron.IpcRendererEvent, status: BrowserExtensionStatus) => listener(status)
      ipcRenderer.on('browser-extension:status', handleStatus)
      return () => ipcRenderer.removeListener('browser-extension:status', handleStatus)
    },
    onMessage: (listener: (message: BrowserExtensionMessage) => void) => {
      const handleMessage = (_event: Electron.IpcRendererEvent, message: BrowserExtensionMessage) => listener(message)
      ipcRenderer.on('browser-extension:message', handleMessage)
      return () => ipcRenderer.removeListener('browser-extension:message', handleMessage)
    },
  },
  nangoConnector: {
    runtimeStatus: () => invokeQuietly('nango-connector:runtime-status'),
    status: () => invoke('nango-connector:status'),
    providers: () => invoke('nango-connector:providers'),
    startAuthorization: (provider) => invoke('nango-connector:start-authorization', provider),
    authorizationStatus: (id) => invoke('nango-connector:authorization-status', id),
    registerConnection: (input) => invoke('nango-connector:register-connection', input),
    createWebcalSubscription: (url) => invoke('nango-connector:create-webcal-subscription', url),
    disableConnection: (id) => invoke('nango-connector:disable-connection', id),
    enableConnection: (id) => invoke('nango-connector:enable-connection', id),
    purgeConnection: (id) => invoke('nango-connector:purge-connection', id),
    triggerSync: (id, mode) => invoke('nango-connector:trigger-sync', id, mode),
    cancelRun: (id) => invoke('nango-connector:cancel-run', id),
    scopes: (connectionId) => invoke('nango-connector:list-scopes', connectionId),
    runs: (connectionId) => invoke('nango-connector:list-runs', connectionId),
    mail: (query) => invoke('nango-connector:list-mail', query),
    documents: (connectionId) => invoke('nango-connector:list-documents', connectionId),
    document: (connectionId, documentId) => invoke('nango-connector:read-document', connectionId, documentId),
    records: (connectionId, type) => invoke('nango-connector:list-records', connectionId, type),
  },
  cliConnector: {
    status: () => invokeQuietly('cli-connector:status'),
    execute: (input) => invokeQuietly('cli-connector:execute', input),
    cancel: (requestId) => invokeQuietly('cli-connector:cancel', requestId),
    openConsole: () => invokeQuietly('cli-connector:open-console'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('cli-connector:event', handleEvent)
      return () => ipcRenderer.removeListener('cli-connector:event', handleEvent)
    },
  },
  agentAuth: {
    status: () => invokeQuietly('agent-auth:status'),
    start: (input) => invoke('agent-auth:start', input),
    resume: (challengeId) => invokeQuietly('agent-auth:resume', challengeId),
    cancel: (challengeId) => invokeQuietly('agent-auth:cancel', challengeId),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('agent-auth:event', handleEvent)
      return () => ipcRenderer.removeListener('agent-auth:event', handleEvent)
    },
  },
  externalDocuments: {
    importSearch: (provider, query) => invoke('external-documents:import-search', provider, query),
    importPreview: (provider, remoteDocumentId) => invoke('external-documents:import-preview', provider, remoteDocumentId),
    importCommit: (input) => invoke('external-documents:import-commit', input),
    importRun: (runId) => invokeQuietly('external-documents:import-run', runId),
    cancelImportRun: (runId) => invoke('external-documents:cancel-import-run', runId),
    importHistory: (roomId, documentId) => invokeQuietly('external-documents:import-history', roomId, documentId),
    checkExternalUpdate: (roomId, documentId) => invoke('external-documents:check-external-update', roomId, documentId),
    applyCandidate: (roomImportId) => invoke('external-documents:apply-candidate', roomImportId),
    createExport: (input) => invoke('external-documents:create-export', input),
    getExport: (exportId) => invokeQuietly('external-documents:get-export', exportId),
    confirmExport: (exportId) => invoke('external-documents:confirm-export', exportId),
    retryExport: (exportId) => invoke('external-documents:retry-export', exportId),
    cancelExport: (exportId) => invoke('external-documents:cancel-export', exportId),
    listExports: (documentId) => invokeQuietly('external-documents:list-exports', documentId),
    importDiff: (roomImportId) => invoke('external-documents:import-diff', roomImportId),
    searchExportTargets: (provider, query) => invoke('external-documents:search-export-targets', provider, query),
  },
  cliConnectorSync: {
    status: () => invokeQuietly('cli-connector-sync:status'),
    accounts: () => invokeQuietly('cli-connector-sync:accounts'),
    promptProfiles: () => invokeQuietly('cli-connector-sync:prompt-profiles'),
    jobs: () => invokeQuietly('cli-connector-sync:jobs'),
    createJob: (input) => invokeQuietly('cli-connector-sync:create-job', input),
    updateJob: (id, input) => invokeQuietly('cli-connector-sync:update-job', id, input),
    runJob: (id) => invokeQuietly('cli-connector-sync:run-job', id),
    setJobPaused: (id, paused, configVersion) =>
      invokeQuietly('cli-connector-sync:set-job-paused', id, paused, configVersion),
    archiveJob: (id, configVersion) => invokeQuietly('cli-connector-sync:archive-job', id, configVersion),
    runs: (jobId) => invokeQuietly('cli-connector-sync:runs', jobId),
    quarantine: (runId) => invokeQuietly('cli-connector-sync:quarantine', runId),
    data: (query) => invokeQuietly('cli-connector-sync:data', query),
    record: (id) => invokeQuietly('cli-connector-sync:record', id),
    ingestRecords: (recordIds) => invokeQuietly('cli-connector-sync:ingest-records', recordIds),
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
  screenCapture: {
    captureCurrentWindow: () => invoke('screen-capture:capture-current-window'),
    start: (intervalMs: number) => invoke('screen-capture:start', intervalMs),
    updateInterval: (intervalMs: number) => invoke('screen-capture:update-interval', intervalMs),
    stop: () => invoke('screen-capture:stop'),
    status: () => invoke('screen-capture:status'),
    perceptionSettings: () => invoke('perception:settings'),
    updateOnlineVlm: (enabled, configVersion) => invoke('perception:update-online-vlm', enabled, configVersion),
    listPerceptionNodes: (query) => invokeQuietly('perception:nodes', query),
    getPerceptionNode: (id) => invokeQuietly('perception:node', id),
    retryPerceptionNode: (id) => invoke('perception:retry', id),
    deletePerceptionNode: (id, deleteAssets) => invoke('perception:delete', id, deleteAssets),
  },
  diary: {
    settings: () => invoke('diary:settings'),
    updateSettings: (input) => invoke('diary:update-settings', input),
    generate: (date) => invoke('diary:generate', date),
    run: (id) => invoke('diary:run', id),
    activeRun: () => invokeQuietly('diary:active-run'),
    days: (start, end) => invoke('diary:days', start, end),
    day: (date) => invoke('diary:day', date),
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
  contextRooms: {
    list: () => invokeQuietly('context-rooms:list'),
    create: (input: CreateContextRoomInput) => invokeQuietly('context-rooms:create', input),
    syncSnapshot: (input: SaveContextRoomSnapshotInput) =>
      invokeQuietly('context-rooms:sync-snapshot', input),
    checkDuplicates: (input: RoomDuplicateCheckInput) => invokeQuietly('context-rooms:check-duplicates', input),
    listDuplicateCandidates: (status?: RoomDuplicateCandidateStatus) =>
      invokeQuietly('context-rooms:list-duplicate-candidates', status),
    updateDuplicateCandidate: (id: string, status: 'related' | 'distinct') =>
      invokeQuietly('context-rooms:update-duplicate-candidate', id, status),
    previewMerge: (sourceAId: string, sourceBId: string) =>
      invokeQuietly('context-rooms:preview-merge', sourceAId, sourceBId),
    startMerge: (input: { sourceAId: string; sourceBId: string; title: string; kind?: string; previewHash: string; idempotencyKey: string; wait?: boolean }) =>
      invokeQuietly('context-rooms:start-merge', input),
    suggestMergeNames: (input: { sourceAId: string; sourceBId: string; responseLanguage?: string }) =>
      invokeQuietly('context-rooms:suggest-merge-names', input),
    checkRoomDuplicates: (roomId: string) => invokeQuietly('context-rooms:check-room-duplicates', roomId),
    getMergeOperation: (id: string) => invokeQuietly('context-rooms:get-merge-operation', id),
    retryMerge: (id: string) => invokeQuietly('context-rooms:retry-merge', id),
    cancelMerge: (id: string) => invokeQuietly('context-rooms:cancel-merge', id),
    dispatchSelectionRewrite: (input: RoomAgentSelectionRewriteInput) =>
      invokeQuietly('context-rooms:dispatch-selection-rewrite', input),
    getSubagentInvocation: (invocationId: string) =>
      invokeQuietly('context-rooms:get-subagent-invocation', invocationId),
    cancelSubagentInvocation: (invocationId: string) =>
      invokeQuietly('context-rooms:cancel-subagent-invocation', invocationId),
    refreshBrief: (roomId: string) => invokeQuietly('context-rooms:refresh-brief', roomId),
    promoteMemoryItem: (roomId: string, itemId: string) =>
      invokeQuietly('context-rooms:promote-memory-item', roomId, itemId),
    overview: (roomId: string) => invokeQuietly('context-rooms:overview', roomId),
    refreshOverview: (roomId: string) => invokeQuietly('context-rooms:refresh-overview', roomId),
    listMails: (roomId: string) => invokeQuietly('context-rooms:list-mails', roomId),
    readMail: (roomId: string, sourceId: string) => invokeQuietly('context-rooms:read-mail', roomId, sourceId),
    roomEntities: (roomId: string) => invokeQuietly('context-rooms:room-entities', roomId),
    completeLocalAction: (roomId: string, actionId: string, completed?: boolean) =>
      invokeQuietly('context-rooms:complete-local-action', roomId, actionId, completed),
  },
  account: {
    status: (options) => options?.quiet ? invokeQuietly('account:status', false) : invoke('account:status', true),
    devices: (options) => options?.quiet ? invokeQuietly('account:devices') : invoke('account:devices'),
    login: (input) => invoke('account:login', input),
    validateInvitationCode: (invitationCode) => invokeQuietly('account:invitation-code-validate', invitationCode),
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
    refreshSaas: () => invoke('runtime-config:refresh-saas'),
    clearSaas: () => invoke('runtime-config:clear-saas'),
    selectSource: (source: 'user' | 'saas' | 'default') => invoke('runtime-config:select-source', source),
    test: () => invoke('runtime-config:test'),
  },
  asr: {
    requestMicrophoneAccess: () => invoke('asr:request-microphone-access'),
    getMicrophoneAccessStatus: () => invoke('asr:get-microphone-access-status'),
    openMicrophoneSettings: () => invoke('asr:open-microphone-settings'),
    openSystemAudioSettings: () => invoke('asr:open-system-audio-settings'),
    beginRecording: (mimeType) => invoke('asr:begin-recording', mimeType),
    appendRecording: (id, chunk) => invoke('asr:append-recording', id, chunk),
    finishRecording: (id) => invoke('asr:finish-recording', id),
    cancelRecording: (id) => invoke('asr:cancel-recording', id),
    createJob: (input) => invoke('asr:create-job', input),
    getJob: (id) => invoke('asr:get-job', id),
  },
  privateAudio: {
    list: (cursor?: number) => invoke('private-audio:list', cursor ?? 0),
    download: (assetId: string, outputPath: string) => invoke('private-audio:download', assetId, outputPath),
    read: (assetId: string) => invoke('private-audio:read', assetId),
  },
  transcriptions: {
    syncPrivate: (options) => options?.quiet ? invokeQuietly('transcription:sync-private') : invoke('transcription:sync-private'),
    onSyncCompleted: (listener) => {
      const handle = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (!value || typeof value !== 'object' || typeof (value as { completedAt?: unknown }).completedAt !== 'string') return
        listener(value as { completedAt: string })
      }
      ipcRenderer.on('transcription:sync-completed', handle)
      return () => ipcRenderer.removeListener('transcription:sync-completed', handle)
    },
    listPrivate: () => invoke('transcription:list-private'),
    listTags: () => invoke('transcription:list-tags'),
    replaceSummaryTags: (summaryRecordId, tags) => invoke('transcription:replace-summary-tags', summaryRecordId, tags),
    renameTag: (tagId, label) => invoke('transcription:rename-tag', tagId, label),
    mergeTag: (targetTagId, sourceTagId) => invoke('transcription:merge-tag', targetTagId, sourceTagId),
  },
  memory: {
    overview: () => invoke('memory:overview'),
    startOnboarding: (input: MemoryOnboardingInput) => invoke('memory:onboarding:start', input),
    /** 引导结束通知（fire-and-forget）：解除主进程云端同步延迟。 */
    onboardingFinished: () => { ipcRenderer.send('memory:onboarding-finished') },
    listAtomic: (options: MemoryAtomicListOptions) => invoke('memory:list-atomic', options),
    listRoomMemories: (roomId: string): Promise<MemoryRoomMemoriesPageDto> =>
      invoke('memory:list-room-memories', roomId),
    searchAtomic: (query: string, limit?: number) => invoke('memory:search-atomic', query, limit),
    updateAtomic: (id: string, content: string, background?: string) =>
      invoke('memory:update-atomic', id, content, background),
    deleteAtomic: (ids: string[]) => invoke('memory:delete-atomic', ids),
    /** 指派/清除原子记忆的 Room 归属（roomId=null 清除）；snapshot 为绑定时的记忆快照。 */
    setAtomicRoom: (
      id: string,
      roomId: string | null,
      snapshot?: { content: string; type: string; memoryUpdatedAt: string },
    ) => invoke('memory:set-atomic-room', id, roomId, snapshot),
    listScenarios: (pathPrefix?: string) => invoke('memory:list-scenarios', pathPrefix),
    readScenario: (path: string) => invoke('memory:read-scenario', path),
    readCore: () => invoke('memory:read-core'),
    writeCore: (content: string) => invoke('memory:write-core', content),
    listConversations: (options: MemoryConversationListOptions) =>
      invoke('memory:list-conversations', options),
    searchConversations: (query: string, limit?: number, sessionId?: string) =>
      invoke('memory:search-conversations', query, limit, sessionId),
    deleteConversations: (target: { sessionIds?: string[]; messageIds?: string[] }) =>
      invoke('memory:delete-conversations', target),
    importMarkdown: (input: { title: string; markdown: string; filename?: string }) =>
      invoke('memory:import-markdown', input),
    pickMarkdownFiles: () => invoke('memory:pick-markdown-files'),
    listDocuments: (limit?: number, offset?: number) =>
      invoke('memory:documents:list', limit, offset),
    getDocument: (id: string) => invoke('memory:documents:get', id),
    deleteDocument: (id: string) => invoke('memory:documents:delete', id),
    atomicProvenance: (id: string) => invoke('memory:atomic-provenance', id),
    captureDocumentRewrite: (input: MemoryDocumentRewriteInput) =>
      invoke('memory:capture-document-rewrite', input),
  },
  reality: {
    listEvents: (filters) => invoke('reality:list-events', filters),
    getEvent: (id) => invoke('reality:get-event', id),
    createEvent: (input) => invoke('reality:create-event', input),
    finishCapture: (id, input) => invoke('reality:finish-capture', id, input),
    updateTranscript: (id, input) => invoke('reality:update-transcript', id, input),
    addMarker: (id, input) => invoke('reality:add-marker', id, input),
    setImportant: (id, important) => invoke('reality:set-important', id, important),
    confirm: (id) => invoke('reality:confirm', id),
    discard: (id) => invoke('reality:discard', id),
    fail: (id, error) => invoke('reality:fail', id, error),
    readAudio: (id) => invoke('reality:read-audio', id),
    exportTranscript: (input) => invoke('reality:export-transcript', input),
    subscribe: () => invoke('reality:subscribe'),
    unsubscribe: () => invoke('reality:unsubscribe'),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('reality:event', handleEvent)
      return () => ipcRenderer.removeListener('reality:event', handleEvent)
    },
  },
  agent: {
    discoverLocalAgents: () => invokeQuietly('agent:discover-local-agents'),
    importLocalAgentHistory: (agentId: string) => invoke('agent:import-local-agent-history', agentId),
    bindLocalAgentWorkspace: (agentId: string, sessionId: string) => invoke('agent:bind-local-agent-workspace', agentId, sessionId),
    getStatus: () => invokeQuietly('agent:get-status'),
    getUsage: (range) => invoke('agent:get-usage', range),
    listSessions: (pageLabel, roomId) => invoke('agent:list-sessions', pageLabel, roomId),
    createSession: (input) => invoke('agent:create-session', input),
    createSessionLink: (input) => invoke('agent:create-session-link', input),
    listSessionLinks: (sessionId) => invoke('agent:list-session-links', sessionId),
    markSessionLinkReturned: (linkId) => invoke('agent:mark-session-link-returned', linkId),
    updateSession: (sessionId, input) => invoke('agent:update-session', sessionId, input),
    deleteSession: (sessionId) => invoke('agent:delete-session', sessionId),
    getSession: (sessionId) => invoke('agent:get-session', sessionId),
    getEvents: (sessionId, runId, afterSeq) =>
      invoke('agent:get-events', sessionId, runId, afterSeq),
    startRun: (sessionId, input) => invoke('agent:start-run', sessionId, input),
    submitPendingIntent: (intentId, input) =>
      invokeQuietly('agent:submit-pending-intent', intentId, input),
    cancelRun: (runId) => invoke('agent:cancel-run', runId),
    resolveApproval: (approvalId, decision) => invoke('agent:resolve-approval', approvalId, decision),
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
  documents: {
    list: (roomId) => invoke('documents:list', roomId),
    listTrash: (roomId) => invoke('documents:list-trash', roomId),
    get: (documentId) => invoke('documents:get', documentId),
    listBlocks: (documentId) => invoke('documents:list-blocks', documentId),
    listBlockBacklinks: (documentId, blockId) => invoke('documents:list-block-backlinks', documentId, blockId),
    listVersions: (documentId, options) => invoke('documents:list-versions', documentId, options),
    getVersionSnapshot: (documentId, version) => invoke('documents:get-version-snapshot', documentId, version),
    getDiff: (documentId, fromVersion, toVersion) => invoke('documents:get-diff', documentId, fromVersion, toVersion),
    versionChangeSummary: (documentId, version) => invoke('documents:version-change-summary', documentId, version),
    listDocumentComments: (documentId) => invoke('documents:list-document-comments', documentId),
    createDocumentComment: (documentId, input) => invoke('documents:create-document-comment', documentId, input),
    resolveDocumentComment: (documentId, commentId, resolved) => invoke('documents:resolve-document-comment', documentId, commentId, resolved),
    deleteDocumentComment: (documentId, commentId) => invoke('documents:delete-document-comment', documentId, commentId),
    restoreVersion: (documentId, version, baseVersion) =>
      invoke('documents:restore-version', documentId, version, baseVersion),
    resolveBlockReferences: (input) => invoke('documents:resolve-block-references', input),
    listOperations: (filters) => invokeQuietly('documents:list-operations', filters),
    startOperation: (input) => invokeQuietly('documents:start-operation', input),
    getOperation: (operationId, context) => invokeQuietly('documents:get-operation', operationId, context),
    executeOperationCommand: (operationId, input) =>
      invokeQuietly('documents:execute-operation-command', operationId, input),
    storeImage: (documentId, input) => invoke('documents:store-image', documentId, input),
    import: (input) => invoke('documents:import', input),
    save: (documentId, input) => invoke('documents:save', documentId, input),
    delete: (documentId) => invoke('documents:delete', documentId),
    restore: (documentId) => invoke('documents:restore', documentId),
    deletePermanently: (documentId) => invoke('documents:delete-permanently', documentId),
    emptyTrash: (roomId) => invoke('documents:empty-trash', roomId),
    exportPdf: (input) => invoke('documents:export-pdf', input),
    subscribe: (roomId) => invoke('documents:subscribe', roomId),
    unsubscribe: (roomId) => invoke('documents:unsubscribe', roomId),
    onEvent: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, frame: Parameters<typeof listener>[0]) => {
        listener(frame)
      }
      ipcRenderer.on('documents:event', handleEvent)
      return () => ipcRenderer.removeListener('documents:event', handleEvent)
    },
    onOperationChanged: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, operationId: string) => {
        listener(operationId)
      }
      ipcRenderer.on('documents:operation-changed', handleEvent)
      return () => ipcRenderer.removeListener('documents:operation-changed', handleEvent)
    },
    onReady: (listener) => {
      const handleEvent = (_event: Electron.IpcRendererEvent, roomId: string) => {
        listener(roomId)
      }
      ipcRenderer.on('documents:ready', handleEvent)
      return () => ipcRenderer.removeListener('documents:ready', handleEvent)
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
    pickAndMount: () => invoke('obsidian:pick-and-mount'),
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
  knowledge: {
    listRooms: (origin) => invoke('knowledge:rooms:list', origin),
    getRoomContext: (roomId) => invoke('knowledge:rooms:context', roomId),
    upsertRoom: (input) => invoke('knowledge:rooms:upsert', input),
    deleteRoom: (roomId) => invoke('knowledge:rooms:delete', roomId),
    getRoomGraph: (visibility) => invoke('knowledge:room-graph:get', visibility),
    getRoomRelations: (roomId, visibility) => invoke('knowledge:room-relations:list', roomId, visibility),
    getRoomRelationEvidence: (relationId, offset, limit) =>
      invoke('knowledge:room-relations:evidence', relationId, offset, limit),
    createRoomRelation: (input) => invoke('knowledge:room-relations:create', input),
    updateRoomRelation: (relationId, input) => invoke('knowledge:room-relations:update', relationId, input),
    removeManualRoomRelation: (relationId) => invoke('knowledge:room-relations:remove-manual', relationId),
    listWikiPages: (roomId) => invoke('knowledge:wiki:pages', roomId),
    readWikiPage: (roomId, ref) => invoke('knowledge:wiki:page-read', roomId, ref),
    listWikis: () => invoke('knowledge:wikis:list'),
    getWikiGraph: (roomId) => invoke('knowledge:wiki:graph', roomId),
  listEntities: (status: KnowledgeEntityStatus) => invoke('knowledge:entities:list', status),
    getEntity: (entityId: string) => invoke('knowledge:entities:get', entityId),
  promoteEntity: (entityId: string, options?: { forceNew?: boolean }) => invoke('knowledge:entities:promote', entityId, options),
    promoteEntities: (entityIds: string[]) => invoke('knowledge:entities:promote-batch', entityIds),
    suppressEntity: (entityId: string) => invoke('knowledge:entities:suppress', entityId),
    suppressEntities: (entityIds: string[]) => invoke('knowledge:entities:suppress-batch', entityIds),
    restoreSuppressedEntity: (entityId: string) => invoke('knowledge:entities:restore', entityId),
    mergeEntity: (fromId: string, targetId: string) => invoke('knowledge:entities:merge', fromId, targetId),
    listUnmatched: () => invoke('knowledge:unmatched:list'),
    attachDoc: (sourceKind: string, sourceId: string, input: KnowledgeAttachInput) =>
      invoke('knowledge:docs:attach', sourceKind, sourceId, input),
    listRecentDecisions: (limit) => invoke('knowledge:decisions:list', limit),
    routeStatus: (sourceIds) => invoke('knowledge:route:status', sourceIds),
    proposeRooms: (input: { description: string; fileEntryIds: string[] }) =>
      invoke('knowledge:rooms:propose', input),
    revertDecision: (decisionId) => invoke('knowledge:route:revert', decisionId),
    getPreferences: (): Promise<import('../shared/knowledge').KnowledgePreferencesDto> =>
      invoke('knowledge:preferences:get'),
    updatePreferenceContent: (content: string): Promise<import('../shared/knowledge').KnowledgePreferencesDto> =>
      invoke('knowledge:preferences:user-content', content),
    updatePreferenceSettings: (input: { learningEnabled?: boolean; injectionEnabled?: boolean }): Promise<import('../shared/knowledge').KnowledgePreferencesDto> =>
      invoke('knowledge:preferences:settings', input),
    refreshPreferences: (): Promise<import('../shared/knowledge').KnowledgePreferencesDto> =>
      invoke('knowledge:preferences:refresh'),
    listRoomFiles: (roomId: string) => invoke('knowledge:files:list', roomId),
    readFileMarkdown: (fileId: string) => invoke('knowledge:files:markdown', fileId),
    revealFile: (fileId: string) => invoke('knowledge:files:reveal', fileId),
    openFile: (fileId: string) => invoke('knowledge:files:open', fileId),
  },
  files: {
    list: (limit?: number, offset?: number) => invoke('files:list', limit, offset),
    listClipCaptures: (input) => invoke('files:clipper-captures:list', input),
    setClipCaptureFavorite: (captureId, favorite) => invoke('files:clipper-captures:favorite', captureId, favorite),
    getClipCaptureDetail: (captureId: string) => invoke('files:clipper-captures:detail', captureId),
    get: (fileId: string) => invoke('files:get', fileId),
    readMarkdown: (fileId: string, options?: { waitMs?: number; pollMs?: number }) =>
      invoke('files:read-markdown', fileId, options),
    readDataUrl: (fileId: string) => invokeQuietly('files:read-data-url', fileId),
    getClipCapture: (fileId: string) => invoke('files:clipper-capture:get', fileId),
    rename: (fileId: string, displayName: string) => invoke('files:rename', fileId, displayName),
    pinClusterTitle: (clusterId: string, sharedTitle: string) =>
      invoke('files:pin-cluster-title', clusterId, sharedTitle),
    delete: (fileId: string) => invoke('files:delete', fileId),
    reveal: (fileId: string) => invoke('files:reveal', fileId),
    openOriginal: (fileId: string, originalName?: string, contentHash?: string) =>
      invoke('files:open-original', fileId, originalName, contentHash),
    pickAndImport: (options?: { pipelines?: IngestPipelines; roomId?: string }) =>
      invoke('files:pick-and-import', options),
    /** 仅选择：返回文件/文件夹路径，不导入（创建 Room 弹窗暂存用）。 */
    pickPaths: () => invoke<string[]>('files:pick-paths'),
    /** 提交后的一次性导入：把暂存路径交给统一导入链路。 */
    importPaths: (paths: string[], options?: { pipelines?: IngestPipelines; roomId?: string }) =>
      invoke('files:import-paths-once', paths, options),
    importDropped: (files: File[], options?: { pipelines?: IngestPipelines; roomId?: string }) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return invoke('files:import-paths-once', paths, options)
    },
    importAgentAttachments: (files: File[]) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      return invoke('files:import-agent-attachments', paths)
    },
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
  },
  ingest: {
    listEvents: (query: {
      limit?: number
      offset?: number
      sourceKind?: string
      sourceId?: string
    }) => invoke('ingest:events:list', query),
    getFilterRules: () => invoke('ingest:filter-rules:get'),
    updateFilterPreference: (content: string) =>
      invoke('ingest:filter-rules:update-preference', content),
    reinstateEvent: (eventId: string) => invoke('ingest:events:reinstate', eventId),
    getEventContent: (eventId: string) => invoke('ingest:events:content', eventId),
  },
}

contextBridge.exposeInMainWorld('nxcore', api)
