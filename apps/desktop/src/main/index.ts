import { join } from 'node:path'

import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeTheme, shell, systemPreferences } from 'electron'

import type { CloudAccountStatus } from '../shared/sources'
import { ConnectorRegistry } from './connectors/connector-registry'
import { LocalFolderConnector } from './connectors/local-folder-connector'
import { GitHubConnector, type GitHubConfig } from './connectors/github-connector'
import { LocalDataService } from './core/local-data-service'
import { CredentialStore } from './security/credential-store'
import { AccountKeyringService } from './security/account-keyring-service'
import { AgentGatewayBridge } from './gateway/agent-gateway-bridge'
import { AsrGatewayBridge } from './gateway/asr-gateway-bridge'
import { GatewaySupervisor } from './gateway/gateway-supervisor'
import { MemoryGatewayBridge } from './gateway/memory-gateway-bridge'
import { MemoryCoreSupervisor } from './memory/memory-core-supervisor'
import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
  MemoryDocumentRewriteInput,
} from '../shared/memory'
import { DocumentGatewayBridge } from './gateway/document-gateway-bridge'
import { ContextRoomGatewayBridge } from './gateway/context-room-gateway-bridge'
import { RealityGatewayBridge } from './gateway/reality-gateway-bridge'
import { RecordingStore } from './recording/recording-store'
import { isSaasRateLimitError, OIDC_CALLBACK_URL, SaasClient } from './cloud/saas-client'
import { AsrCoordinator } from './asr/asr-coordinator'
import { configureDesktopLogger, flushDesktopLogs, logDesktop } from './logging/desktop-logger'
import { configureSentry, syncSentryAccount } from './monitoring/sentry'
import { PrivateTranscriptionSyncService } from './transcription/private-transcription-sync'
import { TranscriptionProcessingCoordinator } from './transcription/processing-coordinator'
import { PrivateAudioSyncService } from './transcription/private-audio-sync'
import {
  captureCurrentWindow,
  createWindowScreenshotScheduler,
} from './screenshot/window-screenshot-service'
import { registerDocumentPdfExportHandler } from './document-pdf-export'

const APP_NAME = 'EverRoom'

interface IpcRateLimitNotice {
  __everroomRateLimited: true
  message: string
}

async function rateLimitAware<T>(operation: () => Promise<T>): Promise<T | IpcRateLimitNotice> {
  try {
    return await operation()
  } catch (error) {
    if (!isSaasRateLimitError(error)) throw error
    return { __everroomRateLimited: true, message: error.message }
  }
}

const appDataDirectory = app.getPath('appData')
const dataDirectory = join(appDataDirectory, APP_NAME)

app.setPath('userData', dataDirectory)
app.setName(APP_NAME)
configureDesktopLogger(dataDirectory)
configureSentry(app.getVersion(), app.isPackaged)
if (process.platform === 'darwin') process.title = APP_NAME

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

const SOURCE_CHANNELS = {
  list: 'sources:list',
  listFiles: 'sources:list-files',
  listEvidence: 'sources:list-evidence',
  searchEvidence: 'sources:search-evidence',
  changed: 'sources:changed',
  showFile: 'sources:show-file',
  addLocalFolder: 'sources:add-local-folder',
  addGitHub: 'sources:add-github',
  sync: 'sources:sync',
  setPaused: 'sources:set-paused',
  disconnect: 'sources:disconnect',
} as const

const GATEWAY_CHANNELS = {
  status: 'gateway:status',
} as const

const CONTEXT_ROOM_CHANNELS = {
  list: 'context-rooms:list',
  syncSnapshot: 'context-rooms:sync-snapshot',
} as const

const AGENT_CHANNELS = {
  listSessions: 'agent:list-sessions',
  createSession: 'agent:create-session',
  createSessionLink: 'agent:create-session-link',
  listSessionLinks: 'agent:list-session-links',
  markSessionLinkReturned: 'agent:mark-session-link-returned',
  updateSession: 'agent:update-session',
  deleteSession: 'agent:delete-session',
  getSession: 'agent:get-session',
  getEvents: 'agent:get-events',
  startRun: 'agent:start-run',
  cancelRun: 'agent:cancel-run',
  subscribe: 'agent:subscribe',
  unsubscribe: 'agent:unsubscribe',
} as const

const DOCUMENT_CHANNELS = {
  list: 'documents:list',
  listTrash: 'documents:list-trash',
  get: 'documents:get',
  listBlocks: 'documents:list-blocks',
  resolveBlockReferences: 'documents:resolve-block-references',
  listPatches: 'documents:list-patches',
  getPatch: 'documents:get-patch',
  applyPatch: 'documents:apply-patch',
  rejectPatch: 'documents:reject-patch',
  acceptContinuationBlock: 'documents:accept-continuation-block',
  rejectContinuationBlock: 'documents:reject-continuation-block',
  closeContinuation: 'documents:close-continuation',
  import: 'documents:import',
  save: 'documents:save',
  delete: 'documents:delete',
  restore: 'documents:restore',
  deletePermanently: 'documents:delete-permanently',
  emptyTrash: 'documents:empty-trash',
  acknowledge: 'documents:acknowledge',
  subscribe: 'documents:subscribe',
  unsubscribe: 'documents:unsubscribe',
} as const

const ASR_CHANNELS = {
  requestMicrophoneAccess: 'asr:request-microphone-access',
  openMicrophoneSettings: 'asr:open-microphone-settings',
  openSystemAudioSettings: 'asr:open-system-audio-settings',
  beginRecording: 'asr:begin-recording',
  appendRecording: 'asr:append-recording',
  finishRecording: 'asr:finish-recording',
  cancelRecording: 'asr:cancel-recording',
  createJob: 'asr:create-job',
  getJob: 'asr:get-job',
} as const
const PRIVATE_AUDIO_CHANNELS = {
  list: 'private-audio:list',
  download: 'private-audio:download',
  read: 'private-audio:read',
} as const

const REALITY_CHANNELS = {
  listEvents: 'reality:list-events',
  getEvent: 'reality:get-event',
  createEvent: 'reality:create-event',
  finishCapture: 'reality:finish-capture',
  updateTranscript: 'reality:update-transcript',
  addMarker: 'reality:add-marker',
  confirm: 'reality:confirm',
  discard: 'reality:discard',
  fail: 'reality:fail',
  readAudio: 'reality:read-audio',
  subscribe: 'reality:subscribe',
  unsubscribe: 'reality:unsubscribe',
} as const

const ACCOUNT_CHANNELS = {
  status: 'account:status',
  devices: 'account:devices',
  login: 'account:login',
  oidcLogin: 'account:oidc-login',
  oidcCancel: 'account:oidc-cancel',
  logout: 'account:logout',
  keyringStatus: 'account:keyring-status',
  createPairingSession: 'account:create-pairing-session',
  getPairingSession: 'account:get-pairing-session',
  approvePairingSession: 'account:approve-pairing-session',
} as const

const TRANSCRIPTION_CHANNELS = {
  syncPrivate: 'transcription:sync-private',
  listPrivate: 'transcription:list-private',
  listTags: 'transcription:list-tags',
  replaceSummaryTags: 'transcription:replace-summary-tags',
  renameTag: 'transcription:rename-tag',
  mergeTag: 'transcription:merge-tag',
} as const

const MEMORY_CHANNELS = {
  overview: 'memory:overview',
  listAtomic: 'memory:list-atomic',
  searchAtomic: 'memory:search-atomic',
  updateAtomic: 'memory:update-atomic',
  deleteAtomic: 'memory:delete-atomic',
  listScenarios: 'memory:list-scenarios',
  readScenario: 'memory:read-scenario',
  readCore: 'memory:read-core',
  writeCore: 'memory:write-core',
  listConversations: 'memory:list-conversations',
  searchConversations: 'memory:search-conversations',
  deleteConversations: 'memory:delete-conversations',
  captureDocumentRewrite: 'memory:capture-document-rewrite',
} as const

const SCREEN_CAPTURE_CHANNELS = {
  captureCurrentWindow: 'screen-capture:capture-current-window',
  start: 'screen-capture:start',
  updateInterval: 'screen-capture:update-interval',
  stop: 'screen-capture:stop',
  status: 'screen-capture:status',
} as const

// 窗口先显示、服务后台初始化:所有 IPC 通道提前挂上路由,处理器注册前先等待就绪。
// IpcHandler 的 never 参数让任意签名的处理器都可直接注册。
type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown
type StoredHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
const handlerRegistry = new Map<string, StoredHandler>()
let resolveServicesReady: (() => void) | null = null
let rejectServicesReady: ((error: Error) => void) | null = null
const servicesReady = new Promise<void>((resolve, reject) => {
  resolveServicesReady = resolve
  rejectServicesReady = reject
})
servicesReady.catch(() => {
  // 初始化失败的传播由启动流程负责;这里只吞掉无调用方时的未处理拒绝。
})

function handle(channel: string, handler: IpcHandler): void {
  handlerRegistry.set(channel, handler as StoredHandler)
}

function installIpcRouters(): void {
  const channelGroups = [
    SOURCE_CHANNELS,
    GATEWAY_CHANNELS,
    CONTEXT_ROOM_CHANNELS,
    AGENT_CHANNELS,
    DOCUMENT_CHANNELS,
    ASR_CHANNELS,
    PRIVATE_AUDIO_CHANNELS,
    REALITY_CHANNELS,
    ACCOUNT_CHANNELS,
    TRANSCRIPTION_CHANNELS,
    MEMORY_CHANNELS,
    SCREEN_CAPTURE_CHANNELS,
  ]
  for (const group of channelGroups) {
    for (const channel of Object.values(group)) {
      ipcMain.handle(channel, (event, ...args: unknown[]) => {
        const handler = handlerRegistry.get(channel)
        if (handler) return handler(event, ...args)
        return servicesReady.then(() => {
          const ready = handlerRegistry.get(channel)
          if (!ready) throw new Error(`服务尚未提供 ${channel}。`)
          return ready(event, ...args)
        })
      })
    }
  }
}

let localDataService: LocalDataService | null = null
let gatewaySupervisor: GatewaySupervisor | null = null
let memoryCoreSupervisor: MemoryCoreSupervisor | null = null
let agentGatewayBridge: AgentGatewayBridge | null = null
let documentGatewayBridge: DocumentGatewayBridge | null = null
let realityGatewayBridge: RealityGatewayBridge | null = null
let recordingStore: RecordingStore | null = null
let privateAudioSync: PrivateAudioSyncService | null = null
let saasClient: SaasClient | null = null
let privateTranscriptionSync: PrivateTranscriptionSyncService | null = null
let transcriptionProcessingCoordinator: TranscriptionProcessingCoordinator | null = null
let shutdownStarted = false
const queuedProtocolUrls: string[] = []
const screenshotScheduler = createWindowScreenshotScheduler()

function logRendererRequestError(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const value = input as { channel?: unknown; message?: unknown; severity?: unknown }
  if (typeof value.channel !== 'string' || typeof value.message !== 'string') return
  const channel = value.channel.slice(0, 120)
  const message = value.message.slice(0, 2_000)
  const notice = value.severity === 'notice'
  logDesktop('renderer', notice ? 'warn' : 'error', { event: notice ? 'renderer.request.notice' : 'renderer.request.error', channel, message })
}

ipcMain.on('app:request-error', (_event, input: unknown) => logRendererRequestError(input))

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function handleProtocolUrl(url: string): void {
  if (!url.startsWith(OIDC_CALLBACK_URL)) return
  if (saasClient) saasClient.handleOidcCallback(url)
  else queuedProtocolUrls.push(url)
  focusMainWindow()
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleProtocolUrl(url)
})

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    const protocolUrl = argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL))
    if (protocolUrl) handleProtocolUrl(protocolUrl)
    else focusMainWindow()
  })
}

function requireSourceId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    throw new Error('无效的数据源标识。')
  }
  return value
}

function requireSearchQuery(value: unknown): string {
  if (typeof value !== 'string') throw new Error('无效的搜索内容。')
  const query = value.trim()
  if (query.length < 1 || query.length > 200) throw new Error('请输入 1 到 200 个字符。')
  return query
}

function registerSourceHandlers(service: LocalDataService, credentials: CredentialStore): void {
  service.onChanged((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(SOURCE_CHANNELS.changed, event)
    }
  })
  handle(SOURCE_CHANNELS.list, () => service.listSources())
  handle(SOURCE_CHANNELS.listFiles, (_event, id: unknown) =>
    service.listFiles(requireSourceId(id)),
  )
  handle(
    SOURCE_CHANNELS.listEvidence,
    (_event, id: unknown, fileId: unknown) =>
      service.listEvidence(requireSourceId(id), requireSourceId(fileId)),
  )
  handle(
    SOURCE_CHANNELS.searchEvidence,
    (_event, query: unknown, id: unknown) => {
      const sourceId = id === undefined ? null : requireSourceId(id)
      return service.searchEvidence(requireSearchQuery(query), sourceId)
    },
  )
  handle(
    SOURCE_CHANNELS.showFile,
    (_event, id: unknown, fileId: unknown) => {
      const location = service.getSourceItemLocation(
        requireSourceId(id),
        requireSourceId(fileId),
      )
      if (location.kind === 'local') shell.showItemInFolder(location.value)
      else void shell.openExternal(location.value)
    },
  )

  handle(SOURCE_CHANNELS.addLocalFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要连接的文件夹',
      buttonLabel: '连接文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    const rootPath = result.filePaths[0]
    return result.canceled || !rootPath ? null : service.addLocalFolder(rootPath)
  })
  handle(SOURCE_CHANNELS.addGitHub, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的 GitHub 配置。')
    const value = input as Partial<GitHubConfig> & { token?: unknown }
    if (typeof value.repository !== 'string' || !value.repository.trim()) throw new Error('请输入 GitHub 仓库。')
    if (value.token !== undefined && typeof value.token !== 'string') throw new Error('GitHub Token 格式无效。')
    const tokenCredentialKey = value.token?.trim() ? await credentials.set(value.token.trim()) : undefined
    const config: GitHubConfig = {
      repository: value.repository.trim(),
      branch: typeof value.branch === 'string' && value.branch.trim() ? value.branch.trim() : undefined,
      syncIssues: value.syncIssues !== false,
      tokenCredentialKey,
    }
    return service.addConnection('github', config.repository, config)
  })

  handle(SOURCE_CHANNELS.sync, (_event, id: unknown) => service.sync(requireSourceId(id)))
  handle(
    SOURCE_CHANNELS.setPaused,
    (_event, id: unknown, paused: unknown) => {
      if (typeof paused !== 'boolean') throw new Error('无效的暂停状态。')
      return service.setPaused(requireSourceId(id), paused)
    },
  )
  handle(
    SOURCE_CHANNELS.disconnect,
    (_event, id: unknown, deleteLocalData: unknown) => {
      if (typeof deleteLocalData !== 'boolean') throw new Error('无效的清理选项。')
      return service.disconnect(requireSourceId(id), deleteLocalData)
    },
  )
}

// 窗口先显示,服务在后台初始化;supervisor 尚未创建时视为启动中。
function registerGatewayHandlers(): void {
  handle(GATEWAY_CHANNELS.status, () =>
    gatewaySupervisor
      ? gatewaySupervisor.getStatus()
      : { state: 'starting', pid: null, baseUrl: null, version: null, message: null })
}

function registerContextRoomHandlers(bridge: ContextRoomGatewayBridge): void {
  handle(CONTEXT_ROOM_CHANNELS.list, () => bridge.list())
  handle(CONTEXT_ROOM_CHANNELS.syncSnapshot, (_event, input) => bridge.syncSnapshot(input))
}

function registerAgentHandlers(bridge: AgentGatewayBridge): void {
  handle(AGENT_CHANNELS.listSessions, (_event, pageLabel, roomId) => bridge.listSessions(pageLabel, roomId))
  handle(AGENT_CHANNELS.createSession, (_event, input) => bridge.createSession(input))
  handle(AGENT_CHANNELS.createSessionLink, (_event, input) => bridge.createSessionLink(input))
  handle(AGENT_CHANNELS.listSessionLinks, (_event, sessionId) => bridge.listSessionLinks(sessionId))
  handle(AGENT_CHANNELS.markSessionLinkReturned, (_event, linkId) => bridge.markSessionLinkReturned(linkId))
  handle(AGENT_CHANNELS.updateSession, (_event, sessionId, input) => bridge.updateSession(sessionId, input))
  handle(AGENT_CHANNELS.deleteSession, (_event, sessionId) => bridge.deleteSession(sessionId))
  handle(AGENT_CHANNELS.getSession, (_event, sessionId) => bridge.getSession(sessionId))
  handle(AGENT_CHANNELS.getEvents, (_event, sessionId, runId, afterSeq) =>
    bridge.getEvents(sessionId, runId, afterSeq))
  handle(AGENT_CHANNELS.startRun, (_event, sessionId, input) => bridge.startRun(sessionId, input))
  handle(AGENT_CHANNELS.cancelRun, (_event, runId) => bridge.cancelRun(runId))
  handle(AGENT_CHANNELS.subscribe, (event, sessionId) => bridge.subscribe(event.sender, sessionId))
  handle(AGENT_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id))
}

function registerDocumentHandlers(bridge: DocumentGatewayBridge): void {
  handle(DOCUMENT_CHANNELS.list, (_event, roomId) => bridge.list(roomId))
  handle(DOCUMENT_CHANNELS.listTrash, (_event, roomId) => bridge.listTrash(roomId))
  handle(DOCUMENT_CHANNELS.get, (_event, documentId) => bridge.get(documentId))
  handle(DOCUMENT_CHANNELS.listBlocks, (_event, documentId) => bridge.listBlocks(documentId))
  handle(DOCUMENT_CHANNELS.resolveBlockReferences, (_event, input) =>
    bridge.resolveBlockReferences(input))
  handle(DOCUMENT_CHANNELS.listPatches, (_event, documentId, status) =>
    bridge.listPatches(documentId, status))
  handle(DOCUMENT_CHANNELS.getPatch, (_event, patchId) => bridge.getPatch(patchId))
  handle(DOCUMENT_CHANNELS.applyPatch, (_event, patchId, input) => bridge.applyPatch(patchId, input))
  handle(DOCUMENT_CHANNELS.rejectPatch, (_event, patchId) => bridge.rejectPatch(patchId))
  handle(DOCUMENT_CHANNELS.acceptContinuationBlock, (_event, patchId, input) =>
    bridge.acceptContinuationBlock(patchId, input))
  handle(DOCUMENT_CHANNELS.rejectContinuationBlock, (_event, patchId, input) =>
    bridge.rejectContinuationBlock(patchId, input))
  handle(DOCUMENT_CHANNELS.closeContinuation, (_event, patchId) =>
    bridge.closeContinuation(patchId))
  handle(DOCUMENT_CHANNELS.import, (_event, input) => bridge.import(input))
  handle(DOCUMENT_CHANNELS.save, (_event, documentId, input) => bridge.save(documentId, input))
  handle(DOCUMENT_CHANNELS.delete, (_event, documentId) => bridge.delete(documentId))
  handle(DOCUMENT_CHANNELS.restore, (_event, documentId) => bridge.restore(documentId))
  handle(DOCUMENT_CHANNELS.deletePermanently, (_event, documentId) =>
    bridge.deletePermanently(documentId))
  handle(DOCUMENT_CHANNELS.emptyTrash, (_event, roomId) => bridge.emptyTrash(roomId))
  handle(DOCUMENT_CHANNELS.acknowledge, (_event, transactionId, input) =>
    bridge.acknowledge(transactionId, input))
  handle(DOCUMENT_CHANNELS.subscribe, (event, roomId) => bridge.subscribe(event.sender, roomId))
  handle(DOCUMENT_CHANNELS.unsubscribe, (event, roomId) => bridge.unsubscribe(event.sender.id, roomId))
}

function registerAsrHandlers(store: RecordingStore, coordinator: AsrCoordinator): void {
  handle(ASR_CHANNELS.requestMicrophoneAccess, async () => {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'denied' || status === 'restricted') return false
    return systemPreferences.askForMediaAccess('microphone')
  })
  handle(ASR_CHANNELS.openMicrophoneSettings, () => {
    if (process.platform !== 'darwin') throw new Error('麦克风隐私设置仅适用于 macOS。')
    return shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    )
  })
  handle(ASR_CHANNELS.openSystemAudioSettings, () => {
    if (process.platform !== 'darwin') throw new Error('系统音频录制设置仅适用于 macOS。')
    return shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    )
  })
  handle(ASR_CHANNELS.beginRecording, (_event, mimeType) => store.begin(mimeType))
  handle(ASR_CHANNELS.appendRecording, (_event, id, chunk) => store.append(id, chunk))
  handle(ASR_CHANNELS.finishRecording, (_event, id) => store.finish(id))
  handle(ASR_CHANNELS.cancelRecording, (_event, id) => store.cancel(id))
  handle(ASR_CHANNELS.createJob, (_event, input) => rateLimitAware(() => coordinator.createJob(input)))
  handle(ASR_CHANNELS.getJob, (_event, id) => rateLimitAware(() => coordinator.getJob(id)))
}

function registerPrivateAudioHandlers(service: PrivateAudioSyncService): void {
  handle(PRIVATE_AUDIO_CHANNELS.list, (_event, cursor?: number) => rateLimitAware(() => service.list(cursor ?? 0)))
  handle(PRIVATE_AUDIO_CHANNELS.download, (_event, assetId: string, outputPath: string) => rateLimitAware(() => service.downloadById(assetId, outputPath)))
  handle(PRIVATE_AUDIO_CHANNELS.read, (_event, assetId: string) => rateLimitAware(() => service.read(assetId)))
}

function registerMemoryHandlers(bridge: MemoryGatewayBridge): void {
  handle(MEMORY_CHANNELS.overview, () => bridge.overview())
  handle(MEMORY_CHANNELS.listAtomic, (_event, options: MemoryAtomicListOptions) =>
    bridge.listAtomic(options))
  handle(MEMORY_CHANNELS.searchAtomic, (_event, query: string, limit?: number) =>
    bridge.searchAtomic(query, limit))
  handle(
    MEMORY_CHANNELS.updateAtomic,
    (_event, id: string, content: string, background?: string) =>
      bridge.updateAtomic(id, content, background),
  )
  handle(MEMORY_CHANNELS.deleteAtomic, (_event, ids: string[]) => bridge.deleteAtomic(ids))
  handle(MEMORY_CHANNELS.listScenarios, (_event, pathPrefix?: string) =>
    bridge.listScenarios(pathPrefix))
  handle(MEMORY_CHANNELS.readScenario, (_event, path: string) => bridge.readScenario(path))
  handle(MEMORY_CHANNELS.readCore, () => bridge.readCore())
  handle(MEMORY_CHANNELS.writeCore, (_event, content: string) => bridge.writeCore(content))
  handle(
    MEMORY_CHANNELS.listConversations,
    (_event, options: MemoryConversationListOptions) => bridge.listConversations(options),
  )
  handle(
    MEMORY_CHANNELS.searchConversations,
    (_event, query: string, limit?: number, sessionId?: string) =>
      bridge.searchConversations(query, limit, sessionId),
  )
  handle(
    MEMORY_CHANNELS.deleteConversations,
    (_event, target: { sessionIds?: string[]; messageIds?: string[] }) =>
      bridge.deleteConversations(target),
  )
  handle(
    MEMORY_CHANNELS.captureDocumentRewrite,
    (_event, input: MemoryDocumentRewriteInput) => bridge.captureDocumentRewrite(input),
  )
}

function registerRealityHandlers(bridge: RealityGatewayBridge): void {
  handle(REALITY_CHANNELS.listEvents, (_event, filters) => bridge.listEvents(filters))
  handle(REALITY_CHANNELS.getEvent, (_event, id) => bridge.getEvent(id))
  handle(REALITY_CHANNELS.createEvent, (_event, input) => bridge.createEvent(input))
  handle(REALITY_CHANNELS.finishCapture, (_event, id, input) => bridge.finishCapture(id, input))
  handle(REALITY_CHANNELS.updateTranscript, (_event, id, input) => bridge.updateTranscript(id, input))
  handle(REALITY_CHANNELS.addMarker, (_event, id, input) => bridge.addMarker(id, input))
  handle(REALITY_CHANNELS.confirm, (_event, id) => bridge.confirm(id))
  handle(REALITY_CHANNELS.discard, (_event, id) => bridge.discard(id))
  handle(REALITY_CHANNELS.fail, (_event, id, error) => bridge.fail(id, error))
  handle(REALITY_CHANNELS.readAudio, (_event, id) => bridge.readAudio(id))
  handle(REALITY_CHANNELS.subscribe, (event) => bridge.subscribe(event.sender))
  handle(REALITY_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id))
}

async function syncAccountMonitoring(status: Promise<CloudAccountStatus>): Promise<CloudAccountStatus> {
  const account = await status
  syncSentryAccount(account)
  return account
}

function registerAccountHandlers(client: SaasClient): void {
  handle(ACCOUNT_CHANNELS.status, (_event, refreshSubscription?: unknown) => rateLimitAware(() => syncAccountMonitoring(client.status(refreshSubscription === true))))
  handle(ACCOUNT_CHANNELS.devices, () => rateLimitAware(() => client.listDevices()))
  handle(ACCOUNT_CHANNELS.login, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的登录信息。')
    const value = input as { identifier?: unknown; password?: unknown }
    if (typeof value.identifier !== 'string' || typeof value.password !== 'string') {
      throw new Error('请输入账号和密码。')
    }
    const identifier = value.identifier
    const password = value.password
    return rateLimitAware(() => syncAccountMonitoring(client.login(identifier, password)))
  })
  handle(ACCOUNT_CHANNELS.oidcLogin, (_event, provider: unknown) => {
    if (provider !== 'apple' && provider !== 'google') throw new Error('不支持的登录方式。')
    return rateLimitAware(() => syncAccountMonitoring(client.loginWithOidc(provider)))
  })
  handle(ACCOUNT_CHANNELS.oidcCancel, () => client.cancelOidcLogin())
  handle(ACCOUNT_CHANNELS.logout, () => rateLimitAware(() => syncAccountMonitoring(client.logout())))
}

function registerPrivateTranscriptionHandlers(sync: PrivateTranscriptionSyncService): void {
  handle(ACCOUNT_CHANNELS.keyringStatus, () => rateLimitAware(() => sync.keyringStatus()))
  handle(ACCOUNT_CHANNELS.createPairingSession, () => rateLimitAware(() => sync.createPairingSession()))
  handle(ACCOUNT_CHANNELS.getPairingSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的配对会话。')
    return rateLimitAware(() => sync.getPairingSession(id))
  })
  handle(ACCOUNT_CHANNELS.approvePairingSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的配对会话。')
    return rateLimitAware(() => sync.approvePairingSession(id))
  })
  handle(TRANSCRIPTION_CHANNELS.syncPrivate, () => rateLimitAware(() => sync.sync()))
  handle(TRANSCRIPTION_CHANNELS.listPrivate, () => sync.list())
  handle(TRANSCRIPTION_CHANNELS.listTags, () => rateLimitAware(() => sync.listTags()))
  handle(TRANSCRIPTION_CHANNELS.replaceSummaryTags, (_event, summaryRecordId, tags) =>
    rateLimitAware(() => sync.replaceSummaryTags(summaryRecordId, tags)))
  handle(TRANSCRIPTION_CHANNELS.renameTag, (_event, tagId, label) =>
    rateLimitAware(() => sync.renameTag(tagId, label)))
  handle(TRANSCRIPTION_CHANNELS.mergeTag, (_event, targetTagId, sourceTagId) =>
    rateLimitAware(() => sync.mergeTag(targetTagId, sourceTagId)))
}

function registerScreenCaptureHandlers(): void {
  const isAuthorized = (event: Electron.IpcMainInvokeEvent): boolean => {
    const window = BrowserWindow.getAllWindows()[0]
    return Boolean(
      window &&
      !window.isDestroyed() &&
      !window.webContents.isDestroyed() &&
      event.sender === window.webContents,
    )
  }

  handle(SCREEN_CAPTURE_CHANNELS.captureCurrentWindow, async (event) => {
    if (!isAuthorized(event)) {
      return { ok: false, code: 'window-unavailable', message: '无法验证截图请求来源。' }
    }
    return captureCurrentWindow()
  })
  handle(SCREEN_CAPTURE_CHANNELS.start, async (event, intervalMs: unknown) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    return screenshotScheduler.start(typeof intervalMs === 'number' ? intervalMs : NaN)
  })
  handle(SCREEN_CAPTURE_CHANNELS.updateInterval, async (event, intervalMs: unknown) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    return screenshotScheduler.updateInterval(typeof intervalMs === 'number' ? intervalMs : NaN)
  })
  handle(SCREEN_CAPTURE_CHANNELS.stop, (event) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    return screenshotScheduler.stop()
  })
  handle(SCREEN_CAPTURE_CHANNELS.status, (event) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    return screenshotScheduler.getStatus()
  })
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Everroom',
    backgroundColor: '#f5f5f5',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 17 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load preload script: ${preloadPath}`, error)
  })
  window.webContents.session.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    return permission === 'media' && details.mediaType === 'audio'
  })
  window.webContents.session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== 'media' || !('mediaTypes' in details)) {
      callback(false)
      return
    }
    callback(details.mediaTypes?.includes('audio') ?? false)
  })
  if (process.platform === 'darwin') {
    window.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
      const respond = (streams: Parameters<typeof callback>[0]) => {
        try {
          callback(streams)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.info(`macOS system audio capture request ended: ${message}`)
        }
      }
      if (
        request.frame !== window.webContents.mainFrame
        || !request.audioRequested
        || !request.videoRequested
      ) {
        respond({})
        return
      }
      try {
        void desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        }).then(
          (sources) => {
            const source = sources[0]
            if (!source || window.isDestroyed()) respond({})
            else respond({ video: source, audio: 'loopback' })
          },
          (error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.info(`macOS system audio capture permission was not granted: ${message}`)
            respond({})
          },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.info(`macOS system audio capture permission was not granted: ${message}`)
        respond({})
      }
    })
  }
  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  nativeTheme.themeSource = 'light'
  if (process.defaultApp && process.argv[1] && process.platform !== 'darwin') {
    app.setAsDefaultProtocolClient('everroom', process.execPath, [app.getAppPath()])
  } else {
    app.setAsDefaultProtocolClient('everroom')
  }
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
  }
  // 窗口先显示,Gateway 等服务在后台初始化,状态由左下角 Gateway 指示器呈现。
  installIpcRouters()
  registerGatewayHandlers()
  createWindow()
  try {
    // 先拉起/探测 MemoryCore(独立可复用),再把连接信息注入 gateway 的记忆配置,
    // 让队友拉代码后无需手工部署即可使用记忆功能。
    memoryCoreSupervisor = new MemoryCoreSupervisor(dataDirectory)
    const memoryCore = await memoryCoreSupervisor.start().catch((error) => {
      console.error('Managed MemoryCore failed to start; memory stays disabled.', error)
      return null
    })
    gatewaySupervisor = new GatewaySupervisor(
      dataDirectory,
      memoryCore
        ? {
          NXCORE_MEMORY_ENABLED: 'true',
          NXCORE_MEMORY_BASE_URL: memoryCore.baseUrl,
          NXCORE_MEMORY_API_KEY: memoryCore.apiKey,
        }
        : {},
    )
    const gateway = await gatewaySupervisor.start()
    console.info(`NxCore Gateway ready at ${gateway.baseUrl} (pid=${gateway.pid})`)
    registerContextRoomHandlers(new ContextRoomGatewayBridge(gatewaySupervisor))
    realityGatewayBridge = new RealityGatewayBridge(gatewaySupervisor)
    registerRealityHandlers(realityGatewayBridge)
    agentGatewayBridge = new AgentGatewayBridge(gatewaySupervisor)
    registerAgentHandlers(agentGatewayBridge)
    registerMemoryHandlers(new MemoryGatewayBridge(gatewaySupervisor))
    documentGatewayBridge = new DocumentGatewayBridge(gatewaySupervisor)
    registerDocumentHandlers(documentGatewayBridge)
    registerDocumentPdfExportHandler()
    const credentials = new CredentialStore(join(app.getPath('userData'), 'credentials.json'))
    await credentials.initialize()
    const recordingsDirectory=join(dataDirectory,'recordings')
    recordingStore = new RecordingStore(recordingsDirectory)
    saasClient=new SaasClient(credentials,app,recordingsDirectory,(url)=>shell.openExternal(url))
    void saasClient.initialize()
    const keyring = new AccountKeyringService(join(dataDirectory, 'account-keyring.json'))
    privateAudioSync = new PrivateAudioSyncService(saasClient, keyring, recordingsDirectory, join(dataDirectory, 'private-audio-sync.json'))
    void privateAudioSync.drainPending().catch(() => undefined)
    privateTranscriptionSync = new PrivateTranscriptionSyncService(
      join(dataDirectory, 'private-transcription-sync.json'),
      saasClient,
      keyring,
      realityGatewayBridge,
    )
    await privateTranscriptionSync.initialize()
    privateAudioSync.setEventResolver((recordingId) => privateTranscriptionSync!.eventIdForSegment(recordingId))
    void privateTranscriptionSync.materializeCached().catch((error) => {
      console.warn('Unable to import cached private transcriptions into Reality.', error)
    })
    transcriptionProcessingCoordinator = new TranscriptionProcessingCoordinator(
      join(dataDirectory, 'transcription-processing-state.json'),
      saasClient,
      keyring,
      agentGatewayBridge,
      privateTranscriptionSync,
    )
    await transcriptionProcessingCoordinator.initialize()
    transcriptionProcessingCoordinator.start()
    if (process.platform !== 'darwin') {
      const startupProtocolUrl = process.argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL))
      if (startupProtocolUrl) queuedProtocolUrls.push(startupProtocolUrl)
    }
    for (const url of queuedProtocolUrls.splice(0)) saasClient.handleOidcCallback(url)
    registerAccountHandlers(saasClient)
    registerPrivateTranscriptionHandlers(privateTranscriptionSync)
    registerAsrHandlers(recordingStore,new AsrCoordinator(new AsrGatewayBridge(gatewaySupervisor),saasClient,realityGatewayBridge,privateAudioSync,privateTranscriptionSync))
    registerPrivateAudioHandlers(privateAudioSync)
    registerScreenCaptureHandlers()

    const connectors = new ConnectorRegistry()
      .register(new LocalFolderConnector())
      .register(new GitHubConnector((key) => credentials.get(key)))
    localDataService = new LocalDataService(
      dataDirectory,
      connectors,
    )
    await localDataService.initialize()
    registerSourceHandlers(localDataService, credentials)
    resolveServicesReady?.()
  } catch (error) {
    rejectServicesReady?.(error instanceof Error ? error : new Error(String(error)))
    const service = localDataService
    localDataService = null
    await service?.shutdown()
    agentGatewayBridge?.dispose()
    agentGatewayBridge = null
    documentGatewayBridge?.dispose()
    documentGatewayBridge = null
    realityGatewayBridge?.dispose()
    realityGatewayBridge = null
    await recordingStore?.dispose()
    recordingStore = null
    await gatewaySupervisor?.shutdown()
    gatewaySupervisor = null
    await memoryCoreSupervisor?.shutdown()
    memoryCoreSupervisor = null
    console.error('Failed to initialize Everroom desktop services', error)
    app.quit()
    return
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', (event) => {
  if (shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  const service = localDataService
  const gateway = gatewaySupervisor
  const memoryCore = memoryCoreSupervisor
  const agentBridge = agentGatewayBridge
  const documentBridge = documentGatewayBridge
  const realityBridge = realityGatewayBridge
  const recordings = recordingStore
  const cloud = saasClient
  localDataService = null
  gatewaySupervisor = null
  memoryCoreSupervisor = null
  agentGatewayBridge = null
  documentGatewayBridge = null
  realityGatewayBridge = null
  recordingStore = null
  saasClient = null
  screenshotScheduler.stop()
  agentBridge?.dispose()
  documentBridge?.dispose()
  realityBridge?.dispose()
  cloud?.cancelOidcLogin('EverRoom 正在退出。')
  void Promise.allSettled([
    service?.shutdown(),
    recordings?.dispose(),
    gateway?.shutdown(),
    memoryCore?.shutdown(),
  ]).then(() => flushDesktopLogs()).finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
