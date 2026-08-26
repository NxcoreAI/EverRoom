import '@sentry/electron/preload'

import { contextBridge, ipcRenderer, webUtils } from 'electron'

import type { KnowledgeAttachInput, KnowledgeEntityStatus } from '../shared/knowledge'
import type {
  CreateContextRoomInput,
  SaveContextRoomSnapshotInput,
} from '@nxcore/agent-contract'
import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
  MemoryDocumentRewriteInput,
  MemoryOnboardingInput,
} from '../shared/memory'
import type { IngestPipelines } from '../shared/ingest'
import type { McpServersSnapshot } from '../shared/mcp'
import type { DesktopRequestError, NxcoreDesktopApi } from '../shared/sources'
import type { BrowserExtensionMessage, BrowserExtensionStatus } from '../shared/browser-extension'
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
    startAuthorization: (provider) => invoke('nango-connector:start-authorization', provider),
    authorizationStatus: (id) => invoke('nango-connector:authorization-status', id),
    registerConnection: (input) => invoke('nango-connector:register-connection', input),
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
  },
  account: {
    status: (options) => options?.quiet ? invokeQuietly('account:status', false) : invoke('account:status', true),
    devices: (options) => options?.quiet ? invokeQuietly('account:devices') : invoke('account:devices'),
    login: (input) => invoke('account:login', input),
    loginWithOidc: (provider) => invoke('account:oidc-login', provider),
    cancelOidcLogin: () => invoke('account:oidc-cancel'),
    logout: () => invoke('account:logout'),
    keyringStatus: (options) => options?.quiet ? invokeQuietly('account:keyring-status') : invoke('account:keyring-status'),
    createPairingSession: () => invoke('account:create-pairing-session'),
    getPairingSession: (id, options) => options?.quiet ? invokeQuietly('account:get-pairing-session', id) : invoke('account:get-pairing-session', id),
    approvePairingSession: (id) => invoke('account:approve-pairing-session', id),
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
    searchAtomic: (query: string, limit?: number) => invoke('memory:search-atomic', query, limit),
    updateAtomic: (id: string, content: string, background?: string) =>
      invoke('memory:update-atomic', id, content, background),
    deleteAtomic: (ids: string[]) => invoke('memory:delete-atomic', ids),
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
  knowledge: {
    listRooms: (origin) => invoke('knowledge:rooms:list', origin),
    getRoomContext: (roomId) => invoke('knowledge:rooms:context', roomId),
    upsertRoom: (input) => invoke('knowledge:rooms:upsert', input),
    deleteRoom: (roomId) => invoke('knowledge:rooms:delete', roomId),
    listWikiPages: (roomId) => invoke('knowledge:wiki:pages', roomId),
    readWikiPage: (roomId, ref) => invoke('knowledge:wiki:page-read', roomId, ref),
    listWikis: () => invoke('knowledge:wikis:list'),
    getWikiGraph: (roomId) => invoke('knowledge:wiki:graph', roomId),
  listEntities: (status: KnowledgeEntityStatus) => invoke('knowledge:entities:list', status),
    getEntity: (entityId: string) => invoke('knowledge:entities:get', entityId),
  promoteEntity: (entityId: string) => invoke('knowledge:entities:promote', entityId),
    suppressEntity: (entityId: string) => invoke('knowledge:entities:suppress', entityId),
    restoreSuppressedEntity: (entityId: string) => invoke('knowledge:entities:restore', entityId),
    mergeEntity: (fromId: string, targetId: string) => invoke('knowledge:entities:merge', fromId, targetId),
    listUnmatched: () => invoke('knowledge:unmatched:list'),
    attachDoc: (sourceKind: string, sourceId: string, input: KnowledgeAttachInput) =>
      invoke('knowledge:docs:attach', sourceKind, sourceId, input),
    listRecentDecisions: (limit) => invoke('knowledge:decisions:list', limit),
    revertDecision: (decisionId) => invoke('knowledge:route:revert', decisionId),
    listRoomFiles: (roomId: string) => invoke('knowledge:files:list', roomId),
    readFileMarkdown: (fileId: string) => invoke('knowledge:files:markdown', fileId),
    revealFile: (fileId: string) => invoke('knowledge:files:reveal', fileId),
  },
  files: {
    list: (limit?: number, offset?: number) => invoke('files:list', limit, offset),
    listClipCaptures: (limit?: number, offset?: number) => invoke('files:clipper-captures:list', limit, offset),
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
    openOriginal: (fileId: string) => invoke('files:open-original', fileId),
    pickAndImport: (options?: { pipelines?: IngestPipelines; roomId?: string }) =>
      invoke('files:pick-and-import', options),
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
