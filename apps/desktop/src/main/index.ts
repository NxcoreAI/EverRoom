import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeTheme, protocol, shell, systemPreferences } from 'electron'
import type {
  ImportRoomDocumentInput,
  SaveRoomDocumentInput,
  StartDocumentOperationInput,
} from '@nxcore/agent-contract'

import type { CloudAccountStatus } from '../shared/sources'
import type { OpenConnectorExecutionInput } from '../shared/open-connector'
import { ConnectorRegistry } from './connectors/connector-registry'
import { LocalFolderConnector } from './connectors/local-folder-connector'
import { GitHubConnector, type GitHubConfig } from './connectors/github-connector'
import { GoogleDocsConnector, type GoogleDocsConfig } from './connectors/google-docs-connector'
import { NotionConnector, type NotionConfig } from './connectors/notion-connector'
import { LocalDataService } from './core/local-data-service'
import { CredentialStore } from './security/credential-store'
import { AccountKeyringService } from './security/account-keyring-service'
import { AgentGatewayBridge } from './gateway/agent-gateway-bridge'
import { AsrGatewayBridge } from './gateway/asr-gateway-bridge'
import { GatewaySupervisor } from './gateway/gateway-supervisor'
import { NangoSupervisor } from './gateway/nango-supervisor'
import { MemoryGatewayBridge } from './gateway/memory-gateway-bridge'
import { KnowledgeServiceSupervisor } from './knowledge/knowledge-supervisor'
import { MemoryCoreSupervisor } from './memory/memory-core-supervisor'
import type { KnowledgeAttachInput } from '../shared/knowledge'
import type { McpServersSnapshot } from '../shared/mcp'
import type { IngestPipelines } from '../shared/ingest'
import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
  MemoryDocumentRewriteInput,
  MemoryOnboardingInput,
} from '../shared/memory'
import { DocumentGatewayBridge } from './gateway/document-gateway-bridge'
import { KnowledgeGatewayBridge } from './gateway/knowledge-gateway-bridge'
import { McpGatewayBridge } from './gateway/mcp-gateway-bridge'
import { FilesGatewayBridge } from './gateway/files-gateway-bridge'
import { IngestGatewayBridge } from './gateway/ingest-gateway-bridge'
import { ContextRoomGatewayBridge } from './gateway/context-room-gateway-bridge'
import { ConnectorSyncGatewayBridge } from './gateway/connector-sync-gateway-bridge'
import { RealityGatewayBridge } from './gateway/reality-gateway-bridge'
import { PerceptionGatewayBridge } from './gateway/perception-gateway-bridge'
import { DiaryGatewayBridge } from './gateway/diary-gateway-bridge'
import { ConnectorGatewayBridge } from './gateway/connector-gateway-bridge'
import { RecordingStore } from './recording/recording-store'
import { isSaasRateLimitError, OIDC_CALLBACK_URL, SaasClient } from './cloud/saas-client'
import { AsrCoordinator } from './asr/asr-coordinator'
import {
  configureDesktopLogger,
  flushDesktopLogs,
  logDesktop,
  logLocalDesktop,
  logDocumentCursorCompletion,
} from './logging/desktop-logger'
import { configureSentry, syncSentryAccount } from './monitoring/sentry'
import { PrivateTranscriptionSyncService } from './transcription/private-transcription-sync'
import { TranscriptionProcessingCoordinator } from './transcription/processing-coordinator'
import { PrivateAudioSyncService } from './transcription/private-audio-sync'
import {
  captureCurrentWindow,
  createWindowScreenshotScheduler,
} from './screenshot/window-screenshot-service'
import { ScreenshotOutbox } from './screenshot/screenshot-outbox'
import { registerDocumentPdfExportHandler } from './document-pdf-export'
import { registerSystemClipboardHandler } from './system-clipboard'
import { installCrossOriginIsolation } from './cross-origin-isolation'
import { desktopText, setDesktopLocale } from './desktop-locale'
import {
  assertNoEmbeddedDocumentImages,
  DocumentAssetStore,
  DOCUMENT_ASSET_SCHEME,
} from './document-asset-store'
import { OoCliBridge } from './open-connector/oo-cli-bridge'
import {
  OpenConnectorSupervisor,
  type OpenConnectorConnection,
} from './open-connector/open-connector-supervisor'

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

protocol.registerSchemesAsPrivileged([{
  scheme: DOCUMENT_ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

const SOURCE_CHANNELS = {
  list: 'sources:list',
  listFiles: 'sources:list-files',
  listEvidence: 'sources:list-evidence',
  previewFile: 'sources:preview-file',
  searchEvidence: 'sources:search-evidence',
  changed: 'sources:changed',
  showFile: 'sources:show-file',
  addLocalFolder: 'sources:add-local-folder',
  addGitHub: 'sources:add-github',
  addGoogleDocs: 'sources:add-google-docs',
  addNotion: 'sources:add-notion',
  sync: 'sources:sync',
  setPaused: 'sources:set-paused',
  disconnect: 'sources:disconnect',
} as const

const GATEWAY_CHANNELS = {
  status: 'gateway:status',
} as const

const CONNECTOR_CHANNELS = {
  status: 'connector:status', startAuthorization: 'connector:start-authorization', authorizationStatus: 'connector:authorization-status', registerConnection: 'connector:register-connection', disableConnection: 'connector:disable-connection', purgeConnection: 'connector:purge-connection', triggerSync: 'connector:trigger-sync', cancelRun: 'connector:cancel-run', listScopes: 'connector:list-scopes', listRuns: 'connector:list-runs', listMail: 'connector:list-mail', listFailures: 'connector:list-failures', listDocuments: 'connector:list-documents', readDocument: 'connector:read-document', listRecords: 'connector:list-records', armFault: 'connector:arm-fault',
} as const
const OPEN_CONNECTOR_CHANNELS = {
  status: 'open-connector:status',
  execute: 'open-connector:execute',
  cancel: 'open-connector:cancel',
  openConsole: 'open-connector:open-console',
} as const

const CONNECTOR_SYNC_CHANNELS = {
  status: 'connector-sync:status',
  accounts: 'connector-sync:accounts',
  promptProfiles: 'connector-sync:prompt-profiles',
  jobs: 'connector-sync:jobs',
  createJob: 'connector-sync:create-job',
  updateJob: 'connector-sync:update-job',
  runJob: 'connector-sync:run-job',
  setJobPaused: 'connector-sync:set-job-paused',
  archiveJob: 'connector-sync:archive-job',
  runs: 'connector-sync:runs',
  quarantine: 'connector-sync:quarantine',
  data: 'connector-sync:data',
  record: 'connector-sync:record',
} as const

const CONTEXT_ROOM_CHANNELS = {
  list: 'context-rooms:list',
  create: 'context-rooms:create',
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
  submitPendingIntent: 'agent:submit-pending-intent',
  cancelRun: 'agent:cancel-run',
  subscribe: 'agent:subscribe',
  unsubscribe: 'agent:unsubscribe',
} as const

const CURSOR_COMPLETION_AGENT_CHANNELS = {
  createSession: 'cursor-completion-agent:create-session',
  deleteSession: 'cursor-completion-agent:delete-session',
  getEvents: 'cursor-completion-agent:get-events',
  startRun: 'cursor-completion-agent:start-run',
  cancelRun: 'cursor-completion-agent:cancel-run',
} as const

const DOCUMENT_CHANNELS = {
  list: 'documents:list',
  listTrash: 'documents:list-trash',
  get: 'documents:get',
  listBlocks: 'documents:list-blocks',
  listBlockBacklinks: 'documents:list-block-backlinks',
  listVersions: 'documents:list-versions',
  restoreVersion: 'documents:restore-version',
  resolveBlockReferences: 'documents:resolve-block-references',
  listOperations: 'documents:list-operations',
  startOperation: 'documents:start-operation',
  getOperation: 'documents:get-operation',
  executeOperationCommand: 'documents:execute-operation-command',
  storeImage: 'documents:store-image',
  import: 'documents:import',
  save: 'documents:save',
  delete: 'documents:delete',
  restore: 'documents:restore',
  deletePermanently: 'documents:delete-permanently',
  emptyTrash: 'documents:empty-trash',
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
  setImportant: 'reality:set-important',
  confirm: 'reality:confirm',
  discard: 'reality:discard',
  fail: 'reality:fail',
  readAudio: 'reality:read-audio',
  exportTranscript: 'reality:export-transcript',
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
  startOnboarding: 'memory:onboarding:start',
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
  importMarkdown: 'memory:import-markdown',
  pickMarkdownFiles: 'memory:pick-markdown-files',
  listDocuments: 'memory:documents:list',
  getDocument: 'memory:documents:get',
  deleteDocument: 'memory:documents:delete',
  atomicProvenance: 'memory:atomic-provenance',
  captureDocumentRewrite: 'memory:capture-document-rewrite',
} as const

const MCP_CHANNELS = {
  listServers: 'mcp:servers:list',
  saveServers: 'mcp:servers:save',
} as const

const KNOWLEDGE_CHANNELS = {
  listRooms: 'knowledge:rooms:list',
  getRoomContext: 'knowledge:rooms:context',
  upsertRoom: 'knowledge:rooms:upsert',
  deleteRoom: 'knowledge:rooms:delete',
  listWikiPages: 'knowledge:wiki:pages',
  readWikiPage: 'knowledge:wiki:page-read',
  listWikis: 'knowledge:wikis:list',
  getWikiGraph: 'knowledge:wiki:graph',
  listEntities: 'knowledge:entities:list',
  getEntity: 'knowledge:entities:get',
  promoteEntity: 'knowledge:entities:promote',
  mergeEntity: 'knowledge:entities:merge',
  listUnmatched: 'knowledge:unmatched:list',
  attachDoc: 'knowledge:docs:attach',
  listRecentDecisions: 'knowledge:decisions:list',
  revertDecision: 'knowledge:route:revert',
  pickAndUploadFiles: 'knowledge:files:pick-and-upload',
  listRoomFiles: 'knowledge:files:list',
  readFileMarkdown: 'knowledge:files:markdown',
  revealFile: 'knowledge:files:reveal',
} as const

const FILES_CHANNELS = {
  list: 'files:list',
  get: 'files:get',
  readMarkdown: 'files:read-markdown',
  readDataUrl: 'files:read-data-url',
  rename: 'files:rename',
  delete: 'files:delete',
  reveal: 'files:reveal',
  pickAndImport: 'files:pick-and-import',
} as const

const INGEST_CHANNELS = {
  listEvents: 'ingest:events:list',
} as const

const SCREEN_CAPTURE_CHANNELS = {
  captureCurrentWindow: 'screen-capture:capture-current-window',
  start: 'screen-capture:start',
  updateInterval: 'screen-capture:update-interval',
  stop: 'screen-capture:stop',
  status: 'screen-capture:status',
} as const

const PERCEPTION_CHANNELS = {
  settings: 'perception:settings',
  updateOnlineVlm: 'perception:update-online-vlm',
  nodes: 'perception:nodes',
  node: 'perception:node',
  retry: 'perception:retry',
  delete: 'perception:delete',
} as const

const DIARY_CHANNELS = {
  settings: 'diary:settings',
  updateSettings: 'diary:update-settings',
  generate: 'diary:generate',
  run: 'diary:run',
  activeRun: 'diary:active-run',
  days: 'diary:days',
  day: 'diary:day',
} as const

// 窗口先显示、服务后台初始化:所有 IPC 通道提前挂上路由,处理器注册前先等待就绪。
// IpcHandler 的 never 参数让任意签名的处理器都可直接注册。
type IpcHandler = (event: Electron.IpcMainInvokeEvent, ...args: never[]) => unknown
type StoredHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
type IpcHandlerGroup<TChannels extends Record<string, string>> = {
  [TKey in keyof TChannels]: IpcHandler
}
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

function handleGroup<TChannels extends Record<string, string>>(
  channels: TChannels,
  handlers: IpcHandlerGroup<TChannels>,
): void {
  for (const key of Object.keys(channels) as Array<keyof TChannels>) {
    handle(channels[key], handlers[key])
  }
}

function installIpcRouters(): void {
  const channelGroups = [
    SOURCE_CHANNELS,
    GATEWAY_CHANNELS,
    OPEN_CONNECTOR_CHANNELS,
    CONNECTOR_SYNC_CHANNELS,
    CONTEXT_ROOM_CHANNELS,
    AGENT_CHANNELS,
    CURSOR_COMPLETION_AGENT_CHANNELS,
    DOCUMENT_CHANNELS,
    ASR_CHANNELS,
    PRIVATE_AUDIO_CHANNELS,
    REALITY_CHANNELS,
    ACCOUNT_CHANNELS,
    TRANSCRIPTION_CHANNELS,
    MEMORY_CHANNELS,
    KNOWLEDGE_CHANNELS,
    MCP_CHANNELS,
    FILES_CHANNELS,
    INGEST_CHANNELS,
    SCREEN_CAPTURE_CHANNELS,
    PERCEPTION_CHANNELS,
    DIARY_CHANNELS,
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
let cursorCompletionSupervisor: GatewaySupervisor | null = null
let ooCliBridge: OoCliBridge | null = null
let openConnectorSupervisor: OpenConnectorSupervisor | null = null
let openConnectorConsoleWindow: BrowserWindow | null = null
let memoryCoreSupervisor: MemoryCoreSupervisor | null = null
let nangoSupervisor: NangoSupervisor | null = null
let knowledgeServiceSupervisor: KnowledgeServiceSupervisor | null = null
let agentGatewayBridge: AgentGatewayBridge | null = null
let cursorCompletionAgentBridge: AgentGatewayBridge | null = null
let documentGatewayBridge: DocumentGatewayBridge | null = null
let realityGatewayBridge: RealityGatewayBridge | null = null
let perceptionGatewayBridge: PerceptionGatewayBridge | null = null
let diaryGatewayBridge: DiaryGatewayBridge | null = null
let connectorGatewayBridge: ConnectorGatewayBridge | null = null
let recordingStore: RecordingStore | null = null
let privateAudioSync: PrivateAudioSyncService | null = null
let saasClient: SaasClient | null = null
let privateTranscriptionSync: PrivateTranscriptionSyncService | null = null
let transcriptionProcessingCoordinator: TranscriptionProcessingCoordinator | null = null
let shutdownStarted = false
const queuedProtocolUrls: string[] = []
let screenshotOutbox: ScreenshotOutbox | null = null
const captureAndQueueCurrentWindow = async () => {
  const result = await captureCurrentWindow()
  if (result.ok) await screenshotOutbox?.enqueue(result).catch(() => undefined)
  return result
}
const screenshotScheduler = createWindowScreenshotScheduler(captureAndQueueCurrentWindow)

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
ipcMain.on('app:set-locale', (_event, locale: unknown) => setDesktopLocale(locale))

function logRendererDiagnostic(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const value = input as { module?: unknown; level?: unknown; event?: unknown }
  if (value.module !== 'document-cursor-completion') return
  if (value.level !== 'info' && value.level !== 'warn' && value.level !== 'error') return
  if (!value.event || typeof value.event !== 'object' || Array.isArray(value.event)) return
  try {
    const serialized = JSON.stringify(value.event)
    if (serialized.length > 16_000) return
    logDocumentCursorCompletion(value.level, JSON.parse(serialized) as Record<string, unknown>)
  } catch {
    // Ignore malformed renderer diagnostics rather than affecting the editor.
  }
}

ipcMain.on('app:diagnostic-log', (_event, input: unknown) => logRendererDiagnostic(input))

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
    SOURCE_CHANNELS.previewFile,
    (_event, id: unknown, fileId: unknown) =>
      service.previewFile(requireSourceId(id), requireSourceId(fileId)),
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
      title: desktopText('dialog.chooseFolder.title'),
      buttonLabel: desktopText('dialog.chooseFolder.button'),
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
  handle(SOURCE_CHANNELS.addGoogleDocs, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的 Google Docs 配置。')
    const value = input as Partial<GoogleDocsConfig>
    if (!Array.isArray(value.documentIds) || value.documentIds.length < 1 || value.documentIds.length > 100) throw new Error('请至少提供一个 Google Docs 文档 ID。')
    if (typeof value.token !== 'string' || !value.token.trim()) throw new Error('Google Docs access token 不能为空。')
    const tokenCredentialKey = await credentials.set(value.token.trim())
    const config = { documentIds: value.documentIds.map((id) => String(id).trim()).filter(Boolean), tokenCredentialKey }
    return service.addConnection('google-docs', 'Google Docs', config)
  })
  handle(SOURCE_CHANNELS.addNotion, async (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的 Notion 配置。')
    const value = input as Partial<NotionConfig>
    if (!Array.isArray(value.pageIds) || value.pageIds.length < 1 || value.pageIds.length > 100) throw new Error('请至少提供一个 Notion 页面 ID。')
    if (typeof value.token !== 'string' || !value.token.trim()) throw new Error('Notion integration token 不能为空。')
    const tokenCredentialKey = await credentials.set(value.token.trim())
    const config = { pageIds: value.pageIds.map((id) => String(id).trim()).filter(Boolean), tokenCredentialKey }
    return service.addConnection('notion', 'Notion', config)
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

function registerConnectorHandlers(bridge: ConnectorGatewayBridge): void {
  ipcMain.handle(CONNECTOR_CHANNELS.status, () => bridge.status())
  ipcMain.handle(CONNECTOR_CHANNELS.startAuthorization, (_event, provider) => bridge.startAuthorization(provider))
  ipcMain.handle(CONNECTOR_CHANNELS.authorizationStatus, (_event, id) => bridge.authorizationStatus(id))
  ipcMain.handle(CONNECTOR_CHANNELS.registerConnection, (_event, input) => bridge.registerConnection(input))
  ipcMain.handle(CONNECTOR_CHANNELS.disableConnection, (_event, id) => bridge.disableConnection(id))
  ipcMain.handle(CONNECTOR_CHANNELS.purgeConnection, (_event, id) => bridge.purgeConnection(id))
  ipcMain.handle(CONNECTOR_CHANNELS.triggerSync, (_event, id, mode) => bridge.triggerSync(id, mode))
  ipcMain.handle(CONNECTOR_CHANNELS.cancelRun, (_event, id) => bridge.cancelRun(id))
  ipcMain.handle(CONNECTOR_CHANNELS.listScopes, (_event, connectionId) => bridge.scopes(connectionId))
  ipcMain.handle(CONNECTOR_CHANNELS.listRuns, (_event, connectionId) => bridge.runs(connectionId))
  ipcMain.handle(CONNECTOR_CHANNELS.listMail, (_event, query) => bridge.mail(query))
  ipcMain.handle(CONNECTOR_CHANNELS.listFailures, (_event, query) => bridge.failures(query))
  ipcMain.handle(CONNECTOR_CHANNELS.listDocuments, (_event, connectionId) => bridge.documents(connectionId))
  ipcMain.handle(CONNECTOR_CHANNELS.readDocument, (_event, connectionId, documentId) => bridge.document(connectionId, documentId))
  ipcMain.handle(CONNECTOR_CHANNELS.listRecords, (_event, connectionId, type) => bridge.records(connectionId, type))
  ipcMain.handle(CONNECTOR_CHANNELS.armFault, (_event, point) => {
    if (process.env.NXCORE_CONNECTOR_DEBUG_FAULTS !== '1') throw new Error('故障注入未启用。')
    return bridge.armFault(point)
  })
}
function resolveOoCliExecutable(): string {
  const configured = process.env.NXCORE_OO_CLI_PATH?.trim()
  if (configured) return configured
  const executableName = process.platform === 'win32' ? 'oo.exe' : 'oo'
  const packagedCandidates = [
    join(process.resourcesPath, 'oo', `${process.platform}-${process.arch}`, executableName),
    join(process.resourcesPath, 'oo', executableName),
    join(app.getAppPath(), 'build', 'oo', `${process.platform}-${process.arch}`, executableName),
  ]
  return packagedCandidates.find((candidate) => existsSync(candidate)) ?? 'oo'
}

function createOoCliBridge(connection: OpenConnectorConnection): OoCliBridge {
  const root = join(dataDirectory, 'open-connector')
  return new OoCliBridge({
    executable: resolveOoCliExecutable(),
    baseUrl: connection.baseUrl,
    runtimeToken: connection.runtimeToken,
    managed: connection.managed,
    gatewayPid: connection.pid,
    gatewayVersion: connection.version,
    configDirectory: join(root, 'oo-config'),
    dataDirectory: join(root, 'oo-data'),
  })
}

function attachOpenConnectorBridge(bridge: OoCliBridge): void {
  bridge.onCommand((frame) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('open-connector:event', frame)
    }
  })
}

function openConnectorExternalUrl(value: string): void {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.toString())
  } catch {
    // Ignore malformed or unsupported external navigation from the console.
  }
}

async function openConnectorManagementConsole(): Promise<void> {
  const connection = openConnectorSupervisor?.getConnection()
  if (!connection) throw new Error('OpenConnector 尚未就绪。')
  if (!connection.managed || !connection.adminToken) {
    await shell.openExternal(`${connection.baseUrl}/`)
    return
  }
  if (openConnectorConsoleWindow && !openConnectorConsoleWindow.isDestroyed()) {
    openConnectorConsoleWindow.show()
    openConnectorConsoleWindow.focus()
    return
  }
  const origin = new URL(connection.baseUrl).origin
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'OpenConnector 管理台',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: 'persist:everroom-open-connector-console',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  openConnectorConsoleWindow = window
  window.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => callback({
      requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${connection.adminToken}` },
    }),
  )
  window.webContents.setWindowOpenHandler(({ url }) => {
    openConnectorExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return
    event.preventDefault()
    openConnectorExternalUrl(url)
  })
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (openConnectorConsoleWindow === window) openConnectorConsoleWindow = null
  })
  await window.loadURL(`${connection.baseUrl}/`)
}

function registerOpenConnectorHandlers(): void {
  handle(OPEN_CONNECTOR_CHANNELS.status, () => {
    if (ooCliBridge) return ooCliBridge.status()
    const status = openConnectorSupervisor?.getStatus()
    return {
      baseUrl: status?.baseUrl ?? '',
      managed: status?.managed ?? true,
      gatewayPid: status?.pid ?? null,
      gatewayVersion: status?.version ?? null,
      gatewayState: status?.state === 'starting' || !status ? 'starting' : 'unreachable',
      gatewayMessage: status?.message ?? null,
      runtimeTokenConfigured: false,
      cliState: 'checking',
      cliVersion: null,
      cliPath: resolveOoCliExecutable(),
      cliMessage: null,
    }
  })
  handle(OPEN_CONNECTOR_CHANNELS.execute, (_event, input: unknown) => {
    if (!ooCliBridge) throw new Error('OpenConnector 尚未就绪。')
    if (!input || typeof input !== 'object') throw new Error('无效的 OpenConnector 命令。')
    return ooCliBridge.execute(input as OpenConnectorExecutionInput)
  })
  handle(OPEN_CONNECTOR_CHANNELS.cancel, (_event, requestId: unknown) => {
    if (!ooCliBridge) return false
    if (typeof requestId !== 'string') throw new Error('无效的命令请求标识。')
    return ooCliBridge.cancel(requestId)
  })
  handle(OPEN_CONNECTOR_CHANNELS.openConsole, () => openConnectorManagementConsole())
}

function registerContextRoomHandlers(bridge: ContextRoomGatewayBridge): void {
  handle(CONTEXT_ROOM_CHANNELS.list, () => bridge.list())
  handle(CONTEXT_ROOM_CHANNELS.create, (_event, input) => bridge.create(input))
  handle(CONTEXT_ROOM_CHANNELS.syncSnapshot, (_event, input) => bridge.syncSnapshot(input))
}

function registerConnectorSyncHandlers(bridge: ConnectorSyncGatewayBridge): void {
  handle(CONNECTOR_SYNC_CHANNELS.status, () => bridge.status())
  handle(CONNECTOR_SYNC_CHANNELS.accounts, () => bridge.accounts())
  handle(CONNECTOR_SYNC_CHANNELS.promptProfiles, () => bridge.promptProfiles())
  handle(CONNECTOR_SYNC_CHANNELS.jobs, () => bridge.jobs())
  handle(CONNECTOR_SYNC_CHANNELS.createJob, (_event, input) => bridge.createJob(input))
  handle(CONNECTOR_SYNC_CHANNELS.updateJob, (_event, id, input) => bridge.updateJob(id, input))
  handle(CONNECTOR_SYNC_CHANNELS.runJob, (_event, id) => bridge.runJob(id))
  handle(CONNECTOR_SYNC_CHANNELS.setJobPaused, (_event, id, paused, configVersion) =>
    bridge.setJobPaused(id, paused, configVersion))
  handle(CONNECTOR_SYNC_CHANNELS.archiveJob, (_event, id, configVersion) => bridge.archiveJob(id, configVersion))
  handle(CONNECTOR_SYNC_CHANNELS.runs, (_event, jobId) => bridge.runs(jobId))
  handle(CONNECTOR_SYNC_CHANNELS.quarantine, (_event, runId) => bridge.quarantine(runId))
  handle(CONNECTOR_SYNC_CHANNELS.data, (_event, query) => bridge.data(query))
  handle(CONNECTOR_SYNC_CHANNELS.record, (_event, id) => bridge.record(id))
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
  handle(AGENT_CHANNELS.submitPendingIntent, (_event, intentId, input) =>
    bridge.submitPendingIntent(intentId, input))
  handle(AGENT_CHANNELS.cancelRun, (_event, runId) => bridge.cancelRun(runId))
  handle(AGENT_CHANNELS.subscribe, (event, sessionId) => bridge.subscribe(event.sender, sessionId))
  handle(AGENT_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id))
}

function registerCursorCompletionAgentHandlers(bridge: AgentGatewayBridge): void {
  handleGroup(CURSOR_COMPLETION_AGENT_CHANNELS, {
    createSession: (_event, input) => bridge.createSession(input),
    deleteSession: (_event, sessionId) => bridge.deleteSession(sessionId),
    getEvents: (_event, sessionId, runId, afterSeq) =>
      bridge.getEvents(sessionId, runId, afterSeq),
    startRun: (_event, sessionId, input) => bridge.startRun(sessionId, input),
    cancelRun: (_event, runId) => bridge.cancelRun(runId),
  })
}

function registerDocumentHandlers(bridge: DocumentGatewayBridge, assets: DocumentAssetStore): void {
  handleGroup(DOCUMENT_CHANNELS, {
    list: (_event, roomId) => bridge.list(roomId),
    listTrash: (_event, roomId) => bridge.listTrash(roomId),
    get: (_event, documentId) => bridge.get(documentId),
    listBlocks: (_event, documentId) => bridge.listBlocks(documentId),
    listBlockBacklinks: (_event, documentId, blockId) =>
      bridge.listBlockBacklinks(documentId, blockId),
    listVersions: (_event, documentId) => bridge.listVersions(documentId),
    restoreVersion: (_event, documentId, version, baseVersion) =>
      bridge.restoreVersion(documentId, version, baseVersion),
    resolveBlockReferences: (_event, input) => bridge.resolveBlockReferences(input),
    listOperations: (_event, filters) => bridge.listOperations(filters),
    startOperation: (_event, input: StartDocumentOperationInput) => {
      assertNoEmbeddedDocumentImages(input)
      return bridge.startOperation(input)
    },
    getOperation: (_event, operationId) => bridge.getOperation(operationId),
    executeOperationCommand: (_event, operationId, input) =>
      bridge.executeOperationCommand(operationId, input),
    storeImage: (_event, documentId, input) => assets.storeImage(documentId, input),
    import: (_event, input: ImportRoomDocumentInput) => {
      assertNoEmbeddedDocumentImages(input?.contentJson)
      return bridge.import(input)
    },
    save: (_event, documentId, input: SaveRoomDocumentInput) => {
      assertNoEmbeddedDocumentImages(input?.contentJson)
      return bridge.save(documentId, input)
    },
    delete: (_event, documentId) => bridge.delete(documentId),
    restore: (_event, documentId) => bridge.restore(documentId),
    deletePermanently: async (_event, documentId) => {
      await bridge.deletePermanently(documentId)
      await assets.deleteDocument(documentId).catch((error) => {
        console.error('Failed to delete local document assets', { documentId, error })
      })
    },
    emptyTrash: async (_event, roomId) => {
      const trashed = await bridge.listTrash(roomId)
      await bridge.emptyTrash(roomId)
      await Promise.all(trashed.map((document) => assets.deleteDocument(document.id).catch((error) => {
        console.error('Failed to delete local document assets', { documentId: document.id, error })
      })))
    },
    subscribe: (event, roomId) => bridge.subscribe(event.sender, roomId),
    unsubscribe: (event, roomId) => bridge.unsubscribe(event.sender.id, roomId),
  })
}

function registerMcpHandlers(bridge: McpGatewayBridge): void {
  handle(MCP_CHANNELS.listServers, () => bridge.list())
  handle(MCP_CHANNELS.saveServers, (_event, servers: McpServersSnapshot['servers']) => bridge.save(servers))
}

function registerKnowledgeHandlers(bridge: KnowledgeGatewayBridge): void {
  handle(KNOWLEDGE_CHANNELS.listRooms, (_event, origin?: 'user' | 'auto') => bridge.listRooms(origin))
  handle(KNOWLEDGE_CHANNELS.getRoomContext, (_event, roomId: string) => bridge.getRoomContext(roomId))
  handle(KNOWLEDGE_CHANNELS.upsertRoom, (_event, input) => bridge.upsertRoom(input))
  handle(KNOWLEDGE_CHANNELS.deleteRoom, (_event, roomId) => bridge.deleteRoom(roomId))
  handle(KNOWLEDGE_CHANNELS.listWikiPages, (_event, roomId) => bridge.listWikiPages(roomId))
  handle(KNOWLEDGE_CHANNELS.readWikiPage, (_event, roomId, ref) => bridge.readWikiPage(roomId, ref))
  handle(KNOWLEDGE_CHANNELS.listWikis, () => bridge.listWikis())
  handle(KNOWLEDGE_CHANNELS.getWikiGraph, (_event, roomId: string) => bridge.getWikiGraph(roomId))
  handle(KNOWLEDGE_CHANNELS.listEntities, (_event, status: 'weak' | 'ready' | 'promoting' | 'room' | 'archived') =>
    bridge.listEntities(status))
  handle(KNOWLEDGE_CHANNELS.getEntity, (_event, entityId: string) => bridge.getEntity(entityId))
  handle(KNOWLEDGE_CHANNELS.promoteEntity, (_event, entityId: string) => bridge.promoteEntity(entityId))
  handle(KNOWLEDGE_CHANNELS.mergeEntity, (_event, fromId: string, targetId: string) =>
    bridge.mergeEntity(fromId, targetId))
  handle(KNOWLEDGE_CHANNELS.listUnmatched, () => bridge.listUnmatched())
  handle(KNOWLEDGE_CHANNELS.attachDoc, (_event, sourceKind: string, sourceId: string, input: KnowledgeAttachInput) =>
    bridge.attachDoc(sourceKind, sourceId, input))
  handle(KNOWLEDGE_CHANNELS.listRecentDecisions, (_event, limit?: number) =>
    bridge.listRecentDecisions(limit))
  handle(KNOWLEDGE_CHANNELS.revertDecision, (_event, decisionId) => bridge.revertDecision(decisionId))
  handle(KNOWLEDGE_CHANNELS.pickAndUploadFiles, () => bridge.pickAndUploadFiles())
  handle(KNOWLEDGE_CHANNELS.listRoomFiles, (_event, roomId: string) => bridge.listRoomFiles(roomId))
  handle(KNOWLEDGE_CHANNELS.readFileMarkdown, (_event, fileId: string) => bridge.readFileMarkdown(fileId))
  handle(KNOWLEDGE_CHANNELS.revealFile, (_event, fileId: string) => bridge.revealFile(fileId))
}

function registerFilesHandlers(bridge: FilesGatewayBridge): void {
  handle(FILES_CHANNELS.list, (_event, limit?: number, offset?: number) => bridge.list(limit, offset))
  handle(FILES_CHANNELS.get, (_event, fileId: string) => bridge.get(fileId))
  handle(FILES_CHANNELS.readMarkdown, (_event, fileId: string) => bridge.readMarkdown(fileId))
  handle(FILES_CHANNELS.readDataUrl, (_event, fileId: string) => bridge.readDataUrl(fileId))
  handle(FILES_CHANNELS.rename, (_event, fileId: string, displayName: string) =>
    bridge.rename(fileId, displayName))
  handle(FILES_CHANNELS.delete, (_event, fileId: string) => bridge.delete(fileId))
  handle(FILES_CHANNELS.reveal, (_event, fileId: string) => bridge.reveal(fileId))
  handle(
    FILES_CHANNELS.pickAndImport,
    (_event, options?: { pipelines?: IngestPipelines }) => bridge.pickAndImport(options),
  )
}

function registerIngestHandlers(bridge: IngestGatewayBridge): void {
  handle(
    INGEST_CHANNELS.listEvents,
    (_event, query: { limit?: number; offset?: number; sourceKind?: string; sourceId?: string }) =>
      bridge.listEvents(query),
  )
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
  handle(MEMORY_CHANNELS.startOnboarding, (_event, input: MemoryOnboardingInput) =>
    bridge.startOnboarding(input))
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
    MEMORY_CHANNELS.importMarkdown,
    (_event, input: { title: string; markdown: string; filename?: string }) =>
      bridge.importMarkdown(input),
  )
  handle(MEMORY_CHANNELS.pickMarkdownFiles, () => bridge.pickMarkdownFiles())
  handle(
    MEMORY_CHANNELS.listDocuments,
    (_event, limit?: number, offset?: number) => bridge.listDocuments(limit, offset),
  )
  handle(MEMORY_CHANNELS.getDocument, (_event, id: string) => bridge.getDocument(id))
  handle(MEMORY_CHANNELS.deleteDocument, (_event, id: string) => bridge.deleteDocument(id))
  handle(MEMORY_CHANNELS.atomicProvenance, (_event, id: string) => bridge.atomicProvenance(id))
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
  handle(REALITY_CHANNELS.setImportant, (_event, id, important) => bridge.setImportant(id, important))
  handle(REALITY_CHANNELS.confirm, (_event, id) => bridge.confirm(id))
  handle(REALITY_CHANNELS.discard, (_event, id) => bridge.discard(id))
  handle(REALITY_CHANNELS.fail, (_event, id, error) => bridge.fail(id, error))
  handle(REALITY_CHANNELS.readAudio, (_event, id) => bridge.readAudio(id))
  handle(REALITY_CHANNELS.exportTranscript, async (event, input: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || event.sender.isDestroyed()) throw new Error(desktopText('error.transcript.invalidSource'))
    if (!input || typeof input !== 'object' || typeof (input as { content?: unknown }).content !== 'string') {
      throw new Error(desktopText('error.transcript.invalidRequest'))
    }
    const defaultTranscriptName = desktopText('dialog.exportTranscript.defaultName')
    const rawName = typeof (input as { fileName?: unknown }).fileName === 'string' ? (input as { fileName: string }).fileName : `${defaultTranscriptName}.txt`
    const fileName = rawName.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180) || defaultTranscriptName
    const selection = await dialog.showSaveDialog(owner, {
      title: desktopText('dialog.exportTranscript.title'),
      defaultPath: fileName.toLowerCase().endsWith('.txt') ? fileName : `${fileName}.txt`,
      buttonLabel: desktopText('dialog.exportTranscript.button'),
      filters: [{ name: desktopText('dialog.exportTranscript.textFile'), extensions: ['txt'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    })
    if (selection.canceled || !selection.filePath) return { canceled: true }
    await writeFile(selection.filePath, (input as { content: string }).content, 'utf8')
    return { canceled: false, filePath: selection.filePath }
  })
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
      return { ok: false, code: 'window-unavailable', message: desktopText('error.screenshot.invalidSource') }
    }
    return captureAndQueueCurrentWindow()
  })
  handle(SCREEN_CAPTURE_CHANNELS.start, async (event, intervalMs: unknown) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    const status = await screenshotScheduler.start(typeof intervalMs === 'number' ? intervalMs : NaN)
    await perceptionGatewayBridge?.updateCapture({ enabled: true, intervalMs: status.intervalMs }).catch(() => undefined)
    return status
  })
  handle(SCREEN_CAPTURE_CHANNELS.updateInterval, async (event, intervalMs: unknown) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    const status = screenshotScheduler.updateInterval(typeof intervalMs === 'number' ? intervalMs : NaN)
    await perceptionGatewayBridge?.updateCapture({ intervalMs: status.intervalMs }).catch(() => undefined)
    return status
  })
  handle(SCREEN_CAPTURE_CHANNELS.stop, async (event) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    const status = screenshotScheduler.stop()
    await perceptionGatewayBridge?.updateCapture({ enabled: false }).catch(() => undefined)
    return status
  })
  handle(SCREEN_CAPTURE_CHANNELS.status, (event) => {
    if (!isAuthorized(event)) return screenshotScheduler.getStatus()
    return screenshotScheduler.getStatus()
  })
}

function registerPerceptionAndDiaryHandlers(): void {
  handle(PERCEPTION_CHANNELS.settings, () => {
    if (!perceptionGatewayBridge) throw new Error('现实感知服务尚未就绪。')
    return perceptionGatewayBridge.getSettings()
  })
  handle(PERCEPTION_CHANNELS.updateOnlineVlm, (_event, enabled: unknown, configVersion: unknown) => {
    if (!perceptionGatewayBridge || typeof enabled !== 'boolean' || typeof configVersion !== 'number') {
      throw new Error('感知设置参数无效。')
    }
    return perceptionGatewayBridge.updateOnlineVlm(enabled, configVersion)
  })
  handle(PERCEPTION_CHANNELS.nodes, (_event, query: unknown) => {
    if (!perceptionGatewayBridge) throw new Error('现实感知服务尚未就绪。')
    return perceptionGatewayBridge.listNodes(query && typeof query === 'object' ? query as never : {})
  })
  handle(PERCEPTION_CHANNELS.node, (_event, id: unknown) => {
    if (!perceptionGatewayBridge || typeof id !== 'string') throw new Error('感知节点参数无效。')
    return perceptionGatewayBridge.getNode(id)
  })
  handle(PERCEPTION_CHANNELS.retry, (_event, id: unknown) => {
    if (!perceptionGatewayBridge || typeof id !== 'string') throw new Error('感知节点参数无效。')
    return perceptionGatewayBridge.retryNode(id)
  })
  handle(PERCEPTION_CHANNELS.delete, (_event, id: unknown, deleteAssets: unknown) => {
    if (!perceptionGatewayBridge || typeof id !== 'string') throw new Error('感知节点参数无效。')
    return perceptionGatewayBridge.deleteNode(id, deleteAssets === true)
  })
  handle(DIARY_CHANNELS.settings, () => {
    if (!diaryGatewayBridge) throw new Error('日记服务尚未就绪。')
    return diaryGatewayBridge.settings()
  })
  handle(DIARY_CHANNELS.updateSettings, (_event, input: unknown) => {
    if (!diaryGatewayBridge || !input || typeof input !== 'object') throw new Error('日记设置参数无效。')
    return diaryGatewayBridge.updateSettings(input as Parameters<DiaryGatewayBridge['updateSettings']>[0])
  })
  handle(DIARY_CHANNELS.generate, async (_event, date: unknown) => {
    if (!diaryGatewayBridge || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('日记日期参数无效。')
    }
    logLocalDesktop('diary', 'info', { event: 'diary.generate.requested', date })
    try {
      const result = await diaryGatewayBridge.generate(date)
      logLocalDesktop('diary', 'info', { event: 'diary.generate.accepted', date, runId: result.runId })
      return result
    } catch (error) {
      logLocalDesktop('diary', 'error', {
        event: 'diary.generate.rejected',
        date,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })
  handle(DIARY_CHANNELS.run, (_event, id: unknown) => {
    if (!diaryGatewayBridge || typeof id !== 'string' || id.length < 1 || id.length > 100) {
      throw new Error('日记运行参数无效。')
    }
    return diaryGatewayBridge.run(id)
  })
  handle(DIARY_CHANNELS.activeRun, () => {
    if (!diaryGatewayBridge) throw new Error('日记服务尚未就绪。')
    return diaryGatewayBridge.activeRun()
  })
  handle(DIARY_CHANNELS.days, (_event, start: unknown, end: unknown) => {
    if (!diaryGatewayBridge || typeof start !== 'string' || typeof end !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new Error('日记日期范围参数无效。')
    }
    return diaryGatewayBridge.days(start, end)
  })
  handle(DIARY_CHANNELS.day, (_event, date: unknown) => {
    if (!diaryGatewayBridge || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('日记日期参数无效。')
    }
    return diaryGatewayBridge.day(date)
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

  installCrossOriginIsolation(window.webContents.session, process.env.ELECTRON_RENDERER_URL)

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
  const documentAssets = new DocumentAssetStore(join(dataDirectory, 'document-assets'))
  await documentAssets.initialize().catch((error) => {
    console.error('Failed to initialize local document assets', error)
  })
  screenshotOutbox = new ScreenshotOutbox(
    join(dataDirectory, 'perception', 'screenshot-outbox.json'),
    () => gatewaySupervisor,
  )
  await screenshotOutbox.initialize()
  protocol.handle(DOCUMENT_ASSET_SCHEME, (request) => documentAssets.response(request.url))
  installIpcRouters()
  registerSystemClipboardHandler()
  registerGatewayHandlers()
  registerOpenConnectorHandlers()
  createWindow()
  try {
    openConnectorSupervisor = new OpenConnectorSupervisor(join(dataDirectory, 'open-connector'))
    const openConnector = await openConnectorSupervisor.start().catch((error) => {
      console.error('Managed OpenConnector failed to start; connector tools stay disabled.', error)
      return null
    })
    if (openConnector) {
      ooCliBridge = createOoCliBridge(openConnector)
      attachOpenConnectorBridge(ooCliBridge)
    }
    // 先拉起/探测 MemoryCore(独立可复用),再把连接信息注入 gateway 的记忆配置,
    // 让队友拉代码后无需手工部署即可使用记忆功能。
    memoryCoreSupervisor = new MemoryCoreSupervisor(dataDirectory)
    const memoryCore = await memoryCoreSupervisor.start().catch((error) => {
      console.error('Managed MemoryCore failed to start; memory stays disabled.', error)
      return null
    })
    // 数据同步用的 Nango 实例与 gateway 一并拉起(外部配置了 URL 时自动跳过)。
    nangoSupervisor = new NangoSupervisor()
    const nango = await nangoSupervisor.start().catch((error) => {
      console.error('Managed Nango failed to start; connectors stay disabled.', error)
      return null
    })
    // Knowledge Service(Wiki)与 MemoryCore 同款托管;失败仅禁用 wiki 工具,不阻塞启动。
    knowledgeServiceSupervisor = new KnowledgeServiceSupervisor(dataDirectory)
    const knowledge = await knowledgeServiceSupervisor.start().catch((error) => {
      console.error('Managed Knowledge service failed to start; wiki tools stay disabled.', error)
      return null
    })
    gatewaySupervisor = new GatewaySupervisor(
      dataDirectory,
      {
        ...(ooCliBridge ? ooCliBridge.environment() : {}),
        ...(ooCliBridge ? { NXCORE_CONNECTOR_AGENT_MODE: 'local' } : {}),
        ...(ooCliBridge ? { NXCORE_CONNECTOR_SYNC_ENABLED: 'true' } : {}),
        ...(memoryCore
          ? {
            NXCORE_MEMORY_ENABLED: 'true',
            NXCORE_MEMORY_BASE_URL: memoryCore.baseUrl,
            NXCORE_MEMORY_API_KEY: memoryCore.apiKey,
          }
          : {}),
        // gateway 配置要求 URL 和 SECRET 成对出现;secret 沿用工作区 .env 里的 NXCORE_NANGO_SECRET。
        ...((nango && process.env.NXCORE_NANGO_SECRET?.trim())
          ? { NXCORE_NANGO_URL: nango.baseUrl }
          : {}),
        ...(knowledge
          ? {
            NXCORE_KNOWLEDGE_ENABLED: 'true',
            NXCORE_KNOWLEDGE_BASE_URL: knowledge.baseUrl,
            NXCORE_KNOWLEDGE_SERVICE_ID: knowledge.serviceId,
            NXCORE_KNOWLEDGE_TEAM_ID: knowledge.teamId,
            // Room 级 wiki 模式（docs/room-wiki-plan.md）：wiki 由 gateway 按
            // Room 懒创建并随会话解析，桌面端不再注入全局 wiki_id。
            NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: 'true',
          }
          : {}),
      },
    )
    const gateway = await gatewaySupervisor.start()
    console.info(`NxCore Gateway ready at ${gateway.baseUrl} (pid=${gateway.pid})`)
    void screenshotOutbox.flush()
    perceptionGatewayBridge = new PerceptionGatewayBridge(gatewaySupervisor)
    diaryGatewayBridge = new DiaryGatewayBridge(gatewaySupervisor)
    registerPerceptionAndDiaryHandlers()
    const perceptionSettings = await perceptionGatewayBridge.getSettings().catch(() => null)
    if (perceptionSettings?.captureEnabled) {
      await screenshotScheduler.start(perceptionSettings.captureIntervalSeconds * 1_000)
    } else if (perceptionSettings) {
      // Keep the local scheduler's interval in sync even while capture is off.
      // Otherwise the settings page falls back to the five-minute default and
      // enabling capture later overwrites a saved custom interval.
      screenshotScheduler.updateInterval(perceptionSettings.captureIntervalSeconds * 1_000)
    }
    cursorCompletionSupervisor = new GatewaySupervisor(
      join(dataDirectory, 'cursor-completion-service'),
      { NXCORE_MEMORY_ENABLED: 'false' },
      {
        devScript: 'dev:cursor-completion',
        packagedEntry: 'cursor-completion-serve.js',
        logLabel: 'cursor-completion',
        devPortEnvironment: 'NXCORE_CURSOR_COMPLETION_DEV_PORT',
      },
    )
    registerContextRoomHandlers(new ContextRoomGatewayBridge(gatewaySupervisor))
    registerConnectorSyncHandlers(new ConnectorSyncGatewayBridge(gatewaySupervisor))
    realityGatewayBridge = new RealityGatewayBridge(gatewaySupervisor)
    registerRealityHandlers(realityGatewayBridge)
    connectorGatewayBridge = new ConnectorGatewayBridge(gatewaySupervisor, (url) => shell.openExternal(url))
    registerConnectorHandlers(connectorGatewayBridge)
    agentGatewayBridge = new AgentGatewayBridge(gatewaySupervisor)
    registerAgentHandlers(agentGatewayBridge)
    cursorCompletionAgentBridge = new AgentGatewayBridge(cursorCompletionSupervisor)
    registerCursorCompletionAgentHandlers(cursorCompletionAgentBridge)
    registerMemoryHandlers(new MemoryGatewayBridge(gatewaySupervisor))
    documentGatewayBridge = new DocumentGatewayBridge(gatewaySupervisor)
    registerDocumentHandlers(documentGatewayBridge, documentAssets)
    registerDocumentPdfExportHandler()
    registerKnowledgeHandlers(new KnowledgeGatewayBridge(gatewaySupervisor))
    registerMcpHandlers(new McpGatewayBridge(gatewaySupervisor))
    registerFilesHandlers(new FilesGatewayBridge(gatewaySupervisor))
    registerIngestHandlers(new IngestGatewayBridge(gatewaySupervisor))
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
      .register(new GoogleDocsConnector((key) => credentials.get(key)))
      .register(new NotionConnector((key) => credentials.get(key)))
    localDataService = new LocalDataService(dataDirectory, connectors)
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
    cursorCompletionAgentBridge?.dispose()
    cursorCompletionAgentBridge = null
    documentGatewayBridge?.dispose()
    documentGatewayBridge = null
    realityGatewayBridge?.dispose()
    realityGatewayBridge = null
    perceptionGatewayBridge = null
    diaryGatewayBridge = null
    connectorGatewayBridge = null
    await recordingStore?.dispose()
    recordingStore = null
    await gatewaySupervisor?.shutdown()
    gatewaySupervisor = null
    await cursorCompletionSupervisor?.shutdown()
    cursorCompletionSupervisor = null
    await memoryCoreSupervisor?.shutdown()
    memoryCoreSupervisor = null
    await knowledgeServiceSupervisor?.shutdown()
    knowledgeServiceSupervisor = null
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
  const connectorCli = ooCliBridge
  const connectorRuntime = openConnectorSupervisor
  const connectorConsole = openConnectorConsoleWindow
  const cursorCompletion = cursorCompletionSupervisor
  const memoryCore = memoryCoreSupervisor
  const nango = nangoSupervisor
  const knowledgeService = knowledgeServiceSupervisor
  const agentBridge = agentGatewayBridge
  const cursorCompletionBridge = cursorCompletionAgentBridge
  const documentBridge = documentGatewayBridge
  const realityBridge = realityGatewayBridge
  const recordings = recordingStore
  const pendingScreenshots = screenshotOutbox
  const cloud = saasClient
  localDataService = null
  gatewaySupervisor = null
  ooCliBridge = null
  openConnectorSupervisor = null
  openConnectorConsoleWindow = null
  cursorCompletionSupervisor = null
  memoryCoreSupervisor = null
  nangoSupervisor = null
  knowledgeServiceSupervisor = null
  agentGatewayBridge = null
  cursorCompletionAgentBridge = null
  documentGatewayBridge = null
  realityGatewayBridge = null
  perceptionGatewayBridge = null
  diaryGatewayBridge = null
  connectorGatewayBridge = null
  recordingStore = null
  saasClient = null
  screenshotOutbox = null
  screenshotScheduler.stop()
  if (connectorConsole && !connectorConsole.isDestroyed()) connectorConsole.destroy()
  connectorCli?.shutdown()
  agentBridge?.dispose()
  cursorCompletionBridge?.dispose()
  documentBridge?.dispose()
  realityBridge?.dispose()
  cloud?.cancelOidcLogin('EverRoom 正在退出。')
  void Promise.allSettled([
    service?.shutdown(),
    recordings?.dispose(),
    pendingScreenshots?.dispose(),
    gateway?.shutdown(),
    connectorRuntime?.shutdown(),
    cursorCompletion?.shutdown(),
    memoryCore?.shutdown(),
    nango?.shutdown(),
    knowledgeService?.shutdown(),
  ]).then(() => flushDesktopLogs()).finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
