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
  ipcMain.handle(SOURCE_CHANNELS.list, () => service.listSources())
  ipcMain.handle(SOURCE_CHANNELS.listFiles, (_event, id: unknown) =>
    service.listFiles(requireSourceId(id)),
  )
  ipcMain.handle(
    SOURCE_CHANNELS.listEvidence,
    (_event, id: unknown, fileId: unknown) =>
      service.listEvidence(requireSourceId(id), requireSourceId(fileId)),
  )
  ipcMain.handle(
    SOURCE_CHANNELS.searchEvidence,
    (_event, query: unknown, id: unknown) => {
      const sourceId = id === undefined ? null : requireSourceId(id)
      return service.searchEvidence(requireSearchQuery(query), sourceId)
    },
  )
  ipcMain.handle(
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

  ipcMain.handle(SOURCE_CHANNELS.addLocalFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要连接的文件夹',
      buttonLabel: '连接文件夹',
      properties: ['openDirectory', 'createDirectory'],
    })
    const rootPath = result.filePaths[0]
    return result.canceled || !rootPath ? null : service.addLocalFolder(rootPath)
  })
  ipcMain.handle(SOURCE_CHANNELS.addGitHub, async (_event, input: unknown) => {
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

  ipcMain.handle(SOURCE_CHANNELS.sync, (_event, id: unknown) => service.sync(requireSourceId(id)))
  ipcMain.handle(
    SOURCE_CHANNELS.setPaused,
    (_event, id: unknown, paused: unknown) => {
      if (typeof paused !== 'boolean') throw new Error('无效的暂停状态。')
      return service.setPaused(requireSourceId(id), paused)
    },
  )
  ipcMain.handle(
    SOURCE_CHANNELS.disconnect,
    (_event, id: unknown, deleteLocalData: unknown) => {
      if (typeof deleteLocalData !== 'boolean') throw new Error('无效的清理选项。')
      return service.disconnect(requireSourceId(id), deleteLocalData)
    },
  )
}

function registerGatewayHandlers(supervisor: GatewaySupervisor): void {
  ipcMain.handle(GATEWAY_CHANNELS.status, () => supervisor.getStatus())
}

function registerContextRoomHandlers(bridge: ContextRoomGatewayBridge): void {
  ipcMain.handle(CONTEXT_ROOM_CHANNELS.list, () => bridge.list())
  ipcMain.handle(CONTEXT_ROOM_CHANNELS.syncSnapshot, (_event, input) => bridge.syncSnapshot(input))
}

function registerAgentHandlers(bridge: AgentGatewayBridge): void {
  ipcMain.handle(AGENT_CHANNELS.listSessions, (_event, pageLabel, roomId) => bridge.listSessions(pageLabel, roomId))
  ipcMain.handle(AGENT_CHANNELS.createSession, (_event, input) => bridge.createSession(input))
  ipcMain.handle(AGENT_CHANNELS.createSessionLink, (_event, input) => bridge.createSessionLink(input))
  ipcMain.handle(AGENT_CHANNELS.listSessionLinks, (_event, sessionId) => bridge.listSessionLinks(sessionId))
  ipcMain.handle(AGENT_CHANNELS.markSessionLinkReturned, (_event, linkId) => bridge.markSessionLinkReturned(linkId))
  ipcMain.handle(AGENT_CHANNELS.updateSession, (_event, sessionId, input) => bridge.updateSession(sessionId, input))
  ipcMain.handle(AGENT_CHANNELS.deleteSession, (_event, sessionId) => bridge.deleteSession(sessionId))
  ipcMain.handle(AGENT_CHANNELS.getSession, (_event, sessionId) => bridge.getSession(sessionId))
  ipcMain.handle(AGENT_CHANNELS.getEvents, (_event, sessionId, runId, afterSeq) =>
    bridge.getEvents(sessionId, runId, afterSeq))
  ipcMain.handle(AGENT_CHANNELS.startRun, (_event, sessionId, input) => bridge.startRun(sessionId, input))
  ipcMain.handle(AGENT_CHANNELS.cancelRun, (_event, runId) => bridge.cancelRun(runId))
  ipcMain.handle(AGENT_CHANNELS.subscribe, (event, sessionId) => bridge.subscribe(event.sender, sessionId))
  ipcMain.handle(AGENT_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id))
}

function registerDocumentHandlers(bridge: DocumentGatewayBridge): void {
  ipcMain.handle(DOCUMENT_CHANNELS.list, (_event, roomId) => bridge.list(roomId))
  ipcMain.handle(DOCUMENT_CHANNELS.listTrash, (_event, roomId) => bridge.listTrash(roomId))
  ipcMain.handle(DOCUMENT_CHANNELS.get, (_event, documentId) => bridge.get(documentId))
  ipcMain.handle(DOCUMENT_CHANNELS.import, (_event, input) => bridge.import(input))
  ipcMain.handle(DOCUMENT_CHANNELS.save, (_event, documentId, input) => bridge.save(documentId, input))
  ipcMain.handle(DOCUMENT_CHANNELS.delete, (_event, documentId) => bridge.delete(documentId))
  ipcMain.handle(DOCUMENT_CHANNELS.restore, (_event, documentId) => bridge.restore(documentId))
  ipcMain.handle(DOCUMENT_CHANNELS.deletePermanently, (_event, documentId) =>
    bridge.deletePermanently(documentId))
  ipcMain.handle(DOCUMENT_CHANNELS.emptyTrash, (_event, roomId) => bridge.emptyTrash(roomId))
  ipcMain.handle(DOCUMENT_CHANNELS.acknowledge, (_event, transactionId, input) =>
    bridge.acknowledge(transactionId, input))
  ipcMain.handle(DOCUMENT_CHANNELS.subscribe, (event, roomId) => bridge.subscribe(event.sender, roomId))
  ipcMain.handle(DOCUMENT_CHANNELS.unsubscribe, (event, roomId) => bridge.unsubscribe(event.sender.id, roomId))
}

function registerAsrHandlers(store: RecordingStore, coordinator: AsrCoordinator): void {
  ipcMain.handle(ASR_CHANNELS.requestMicrophoneAccess, async () => {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'denied' || status === 'restricted') return false
    return systemPreferences.askForMediaAccess('microphone')
  })
  ipcMain.handle(ASR_CHANNELS.openMicrophoneSettings, () => {
    if (process.platform !== 'darwin') throw new Error('麦克风隐私设置仅适用于 macOS。')
    return shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    )
  })
  ipcMain.handle(ASR_CHANNELS.openSystemAudioSettings, () => {
    if (process.platform !== 'darwin') throw new Error('系统音频录制设置仅适用于 macOS。')
    return shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    )
  })
  ipcMain.handle(ASR_CHANNELS.beginRecording, (_event, mimeType) => store.begin(mimeType))
  ipcMain.handle(ASR_CHANNELS.appendRecording, (_event, id, chunk) => store.append(id, chunk))
  ipcMain.handle(ASR_CHANNELS.finishRecording, (_event, id) => store.finish(id))
  ipcMain.handle(ASR_CHANNELS.cancelRecording, (_event, id) => store.cancel(id))
  ipcMain.handle(ASR_CHANNELS.createJob, (_event, input) => rateLimitAware(() => coordinator.createJob(input)))
  ipcMain.handle(ASR_CHANNELS.getJob, (_event, id) => rateLimitAware(() => coordinator.getJob(id)))
}

function registerPrivateAudioHandlers(service: PrivateAudioSyncService): void {
  ipcMain.handle(PRIVATE_AUDIO_CHANNELS.list, (_event, cursor?: number) => rateLimitAware(() => service.list(cursor ?? 0)))
  ipcMain.handle(PRIVATE_AUDIO_CHANNELS.download, (_event, assetId: string, outputPath: string) => rateLimitAware(() => service.downloadById(assetId, outputPath)))
  ipcMain.handle(PRIVATE_AUDIO_CHANNELS.read, (_event, assetId: string) => rateLimitAware(() => service.read(assetId)))
}

function registerMemoryHandlers(bridge: MemoryGatewayBridge): void {
  ipcMain.handle(MEMORY_CHANNELS.overview, () => bridge.overview())
  ipcMain.handle(MEMORY_CHANNELS.listAtomic, (_event, options: MemoryAtomicListOptions) =>
    bridge.listAtomic(options))
  ipcMain.handle(MEMORY_CHANNELS.searchAtomic, (_event, query: string, limit?: number) =>
    bridge.searchAtomic(query, limit))
  ipcMain.handle(
    MEMORY_CHANNELS.updateAtomic,
    (_event, id: string, content: string, background?: string) =>
      bridge.updateAtomic(id, content, background),
  )
  ipcMain.handle(MEMORY_CHANNELS.deleteAtomic, (_event, ids: string[]) => bridge.deleteAtomic(ids))
  ipcMain.handle(MEMORY_CHANNELS.listScenarios, (_event, pathPrefix?: string) =>
    bridge.listScenarios(pathPrefix))
  ipcMain.handle(MEMORY_CHANNELS.readScenario, (_event, path: string) => bridge.readScenario(path))
  ipcMain.handle(MEMORY_CHANNELS.readCore, () => bridge.readCore())
  ipcMain.handle(MEMORY_CHANNELS.writeCore, (_event, content: string) => bridge.writeCore(content))
  ipcMain.handle(
    MEMORY_CHANNELS.listConversations,
    (_event, options: MemoryConversationListOptions) => bridge.listConversations(options),
  )
  ipcMain.handle(
    MEMORY_CHANNELS.searchConversations,
    (_event, query: string, limit?: number, sessionId?: string) =>
      bridge.searchConversations(query, limit, sessionId),
  )
  ipcMain.handle(
    MEMORY_CHANNELS.deleteConversations,
    (_event, target: { sessionIds?: string[]; messageIds?: string[] }) =>
      bridge.deleteConversations(target),
  )
  ipcMain.handle(
    MEMORY_CHANNELS.captureDocumentRewrite,
    (_event, input: MemoryDocumentRewriteInput) => bridge.captureDocumentRewrite(input),
  )
}

function registerRealityHandlers(bridge: RealityGatewayBridge): void {
  ipcMain.handle(REALITY_CHANNELS.listEvents, (_event, filters) => bridge.listEvents(filters))
  ipcMain.handle(REALITY_CHANNELS.getEvent, (_event, id) => bridge.getEvent(id))
  ipcMain.handle(REALITY_CHANNELS.createEvent, (_event, input) => bridge.createEvent(input))
  ipcMain.handle(REALITY_CHANNELS.finishCapture, (_event, id, input) => bridge.finishCapture(id, input))
  ipcMain.handle(REALITY_CHANNELS.updateTranscript, (_event, id, input) => bridge.updateTranscript(id, input))
  ipcMain.handle(REALITY_CHANNELS.addMarker, (_event, id, input) => bridge.addMarker(id, input))
  ipcMain.handle(REALITY_CHANNELS.confirm, (_event, id) => bridge.confirm(id))
  ipcMain.handle(REALITY_CHANNELS.discard, (_event, id) => bridge.discard(id))
  ipcMain.handle(REALITY_CHANNELS.fail, (_event, id, error) => bridge.fail(id, error))
  ipcMain.handle(REALITY_CHANNELS.readAudio, (_event, id) => bridge.readAudio(id))
  ipcMain.handle(REALITY_CHANNELS.subscribe, (event) => bridge.subscribe(event.sender))
  ipcMain.handle(REALITY_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id))
}

async function syncAccountMonitoring(status: Promise<CloudAccountStatus>): Promise<CloudAccountStatus> {
  const account = await status
  syncSentryAccount(account)
  return account
}

function registerAccountHandlers(client: SaasClient): void {
  ipcMain.handle(ACCOUNT_CHANNELS.status, (_event, refreshSubscription?: unknown) => rateLimitAware(() => syncAccountMonitoring(client.status(refreshSubscription === true))))
  ipcMain.handle(ACCOUNT_CHANNELS.devices, () => rateLimitAware(() => client.listDevices()))
  ipcMain.handle(ACCOUNT_CHANNELS.login, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的登录信息。')
    const value = input as { identifier?: unknown; password?: unknown }
    if (typeof value.identifier !== 'string' || typeof value.password !== 'string') {
      throw new Error('请输入账号和密码。')
    }
    const identifier = value.identifier
    const password = value.password
    return rateLimitAware(() => syncAccountMonitoring(client.login(identifier, password)))
  })
  ipcMain.handle(ACCOUNT_CHANNELS.oidcLogin, (_event, provider: unknown) => {
    if (provider !== 'apple' && provider !== 'google') throw new Error('不支持的登录方式。')
    return rateLimitAware(() => syncAccountMonitoring(client.loginWithOidc(provider)))
  })
  ipcMain.handle(ACCOUNT_CHANNELS.oidcCancel, () => client.cancelOidcLogin())
  ipcMain.handle(ACCOUNT_CHANNELS.logout, () => rateLimitAware(() => syncAccountMonitoring(client.logout())))
}

function registerPrivateTranscriptionHandlers(sync: PrivateTranscriptionSyncService): void {
  ipcMain.handle(ACCOUNT_CHANNELS.keyringStatus, () => rateLimitAware(() => sync.keyringStatus()))
  ipcMain.handle(ACCOUNT_CHANNELS.createPairingSession, () => rateLimitAware(() => sync.createPairingSession()))
  ipcMain.handle(ACCOUNT_CHANNELS.getPairingSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的配对会话。')
    return rateLimitAware(() => sync.getPairingSession(id))
  })
  ipcMain.handle(ACCOUNT_CHANNELS.approvePairingSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的配对会话。')
    return rateLimitAware(() => sync.approvePairingSession(id))
  })
  ipcMain.handle(TRANSCRIPTION_CHANNELS.syncPrivate, () => rateLimitAware(() => sync.sync()))
  ipcMain.handle(TRANSCRIPTION_CHANNELS.listPrivate, () => sync.list())
  ipcMain.handle(TRANSCRIPTION_CHANNELS.listTags, () => rateLimitAware(() => sync.listTags()))
  ipcMain.handle(TRANSCRIPTION_CHANNELS.replaceSummaryTags, (_event, summaryRecordId, tags) =>
    rateLimitAware(() => sync.replaceSummaryTags(summaryRecordId, tags)))
  ipcMain.handle(TRANSCRIPTION_CHANNELS.renameTag, (_event, tagId, label) =>
    rateLimitAware(() => sync.renameTag(tagId, label)))
  ipcMain.handle(TRANSCRIPTION_CHANNELS.mergeTag, (_event, targetTagId, sourceTagId) =>
    rateLimitAware(() => sync.mergeTag(targetTagId, sourceTagId)))
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
    trafficLightPosition: { x: 14, y: 7 },
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
    registerGatewayHandlers(gatewaySupervisor)
    registerContextRoomHandlers(new ContextRoomGatewayBridge(gatewaySupervisor))
    realityGatewayBridge = new RealityGatewayBridge(gatewaySupervisor)
    registerRealityHandlers(realityGatewayBridge)
    agentGatewayBridge = new AgentGatewayBridge(gatewaySupervisor)
    registerAgentHandlers(agentGatewayBridge)
    registerMemoryHandlers(new MemoryGatewayBridge(gatewaySupervisor))
    documentGatewayBridge = new DocumentGatewayBridge(gatewaySupervisor)
    registerDocumentHandlers(documentGatewayBridge)
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

    const connectors = new ConnectorRegistry()
      .register(new LocalFolderConnector())
      .register(new GitHubConnector((key) => credentials.get(key)))
    localDataService = new LocalDataService(
      dataDirectory,
      connectors,
    )
    await localDataService.initialize()
    registerSourceHandlers(localDataService, credentials)
    createWindow()
  } catch (error) {
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
