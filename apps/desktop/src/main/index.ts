import { join } from 'node:path'

import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeTheme, shell } from 'electron'

import { ConnectorRegistry } from './connectors/connector-registry'
import { LocalFolderConnector } from './connectors/local-folder-connector'
import { GitHubConnector, type GitHubConfig } from './connectors/github-connector'
import { LocalDataService } from './core/local-data-service'
import { CredentialStore } from './security/credential-store'
import { AgentGatewayBridge } from './gateway/agent-gateway-bridge'
import { AsrGatewayBridge } from './gateway/asr-gateway-bridge'
import { GatewaySupervisor } from './gateway/gateway-supervisor'
import { MemoryGatewayBridge } from './gateway/memory-gateway-bridge'
import { KnowledgeServiceSupervisor } from './knowledge/knowledge-supervisor'
import { MemoryCoreSupervisor } from './memory/memory-core-supervisor'
import type { KnowledgeAttachInput } from '../shared/knowledge'
import type {
  MemoryAtomicListOptions,
  MemoryConversationListOptions,
} from '../shared/memory'
import { DocumentGatewayBridge } from './gateway/document-gateway-bridge'
import { KnowledgeGatewayBridge } from './gateway/knowledge-gateway-bridge'
import { RealityGatewayBridge } from './gateway/reality-gateway-bridge'
import { RecordingStore } from './recording/recording-store'
import { OIDC_CALLBACK_URL, SaasClient } from './cloud/saas-client'
import { AsrCoordinator } from './asr/asr-coordinator'
import { configureDesktopLogger, flushDesktopLogs, logDesktop } from './logging/desktop-logger'

const APP_NAME = 'EverRoom'

const appDataDirectory = app.getPath('appData')
const dataDirectory = join(appDataDirectory, APP_NAME)

app.setPath('userData', dataDirectory)
app.setName(APP_NAME)
configureDesktopLogger(dataDirectory)
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

const AGENT_CHANNELS = {
  listSessions: 'agent:list-sessions',
  createSession: 'agent:create-session',
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
  get: 'documents:get',
  import: 'documents:import',
  save: 'documents:save',
  delete: 'documents:delete',
  acknowledge: 'documents:acknowledge',
  subscribe: 'documents:subscribe',
  unsubscribe: 'documents:unsubscribe',
} as const

const ASR_CHANNELS = {
  openSystemAudioSettings: 'asr:open-system-audio-settings',
  beginRecording: 'asr:begin-recording',
  appendRecording: 'asr:append-recording',
  finishRecording: 'asr:finish-recording',
  cancelRecording: 'asr:cancel-recording',
  createJob: 'asr:create-job',
  getJob: 'asr:get-job',
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
  login: 'account:login',
  oidcLogin: 'account:oidc-login',
  oidcCancel: 'account:oidc-cancel',
  logout: 'account:logout',
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
} as const

const KNOWLEDGE_CHANNELS = {
  listRooms: 'knowledge:rooms:list',
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

let localDataService: LocalDataService | null = null
let gatewaySupervisor: GatewaySupervisor | null = null
let memoryCoreSupervisor: MemoryCoreSupervisor | null = null
let knowledgeServiceSupervisor: KnowledgeServiceSupervisor | null = null
let agentGatewayBridge: AgentGatewayBridge | null = null
let documentGatewayBridge: DocumentGatewayBridge | null = null
let realityGatewayBridge: RealityGatewayBridge | null = null
let recordingStore: RecordingStore | null = null
let saasClient: SaasClient | null = null
let shutdownStarted = false
const queuedProtocolUrls: string[] = []

function logRendererRequestError(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const value = input as { channel?: unknown; message?: unknown }
  if (typeof value.channel !== 'string' || typeof value.message !== 'string') return
  const channel = value.channel.slice(0, 120)
  const message = value.message.slice(0, 2_000)
  logDesktop('renderer', 'error', { event: 'renderer.request.error', channel, message })
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

function registerAgentHandlers(bridge: AgentGatewayBridge): void {
  ipcMain.handle(AGENT_CHANNELS.listSessions, (_event, pageLabel, roomId) => bridge.listSessions(pageLabel, roomId))
  ipcMain.handle(AGENT_CHANNELS.createSession, (_event, input) => bridge.createSession(input))
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
  ipcMain.handle(DOCUMENT_CHANNELS.get, (_event, documentId) => bridge.get(documentId))
  ipcMain.handle(DOCUMENT_CHANNELS.import, (_event, input) => bridge.import(input))
  ipcMain.handle(DOCUMENT_CHANNELS.save, (_event, documentId, input) => bridge.save(documentId, input))
  ipcMain.handle(DOCUMENT_CHANNELS.delete, (_event, documentId) => bridge.delete(documentId))
  ipcMain.handle(DOCUMENT_CHANNELS.acknowledge, (_event, transactionId, input) =>
    bridge.acknowledge(transactionId, input))
  ipcMain.handle(DOCUMENT_CHANNELS.subscribe, (event, roomId) => bridge.subscribe(event.sender, roomId))
  ipcMain.handle(DOCUMENT_CHANNELS.unsubscribe, (event, roomId) => bridge.unsubscribe(event.sender.id, roomId))
}

function registerKnowledgeHandlers(bridge: KnowledgeGatewayBridge): void {
  ipcMain.handle(KNOWLEDGE_CHANNELS.listRooms, (_event, origin?: 'user' | 'auto') => bridge.listRooms(origin))
  ipcMain.handle(KNOWLEDGE_CHANNELS.upsertRoom, (_event, input) => bridge.upsertRoom(input))
  ipcMain.handle(KNOWLEDGE_CHANNELS.deleteRoom, (_event, roomId) => bridge.deleteRoom(roomId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.listWikiPages, (_event, roomId) => bridge.listWikiPages(roomId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.readWikiPage, (_event, roomId, ref) => bridge.readWikiPage(roomId, ref))
  ipcMain.handle(KNOWLEDGE_CHANNELS.listWikis, () => bridge.listWikis())
  ipcMain.handle(KNOWLEDGE_CHANNELS.getWikiGraph, (_event, roomId: string) => bridge.getWikiGraph(roomId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.listEntities, (_event, status: 'weak' | 'ready' | 'promoting' | 'room' | 'archived') =>
    bridge.listEntities(status))
  ipcMain.handle(KNOWLEDGE_CHANNELS.getEntity, (_event, entityId: string) => bridge.getEntity(entityId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.promoteEntity, (_event, entityId: string) => bridge.promoteEntity(entityId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.mergeEntity, (_event, fromId: string, targetId: string) =>
    bridge.mergeEntity(fromId, targetId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.listUnmatched, () => bridge.listUnmatched())
  ipcMain.handle(KNOWLEDGE_CHANNELS.attachDoc, (_event, sourceKind: string, sourceId: string, input: KnowledgeAttachInput) =>
    bridge.attachDoc(sourceKind, sourceId, input))
  ipcMain.handle(KNOWLEDGE_CHANNELS.listRecentDecisions, (_event, limit?: number) =>
    bridge.listRecentDecisions(limit))
  ipcMain.handle(KNOWLEDGE_CHANNELS.revertDecision, (_event, decisionId) => bridge.revertDecision(decisionId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.pickAndUploadFiles, () => bridge.pickAndUploadFiles())
  ipcMain.handle(KNOWLEDGE_CHANNELS.listRoomFiles, (_event, roomId: string) => bridge.listRoomFiles(roomId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.readFileMarkdown, (_event, fileId: string) => bridge.readFileMarkdown(fileId))
  ipcMain.handle(KNOWLEDGE_CHANNELS.revealFile, (_event, fileId: string) => bridge.revealFile(fileId))
}

function registerAsrHandlers(store: RecordingStore, coordinator: AsrCoordinator): void {
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
  ipcMain.handle(ASR_CHANNELS.createJob, (_event, input) => coordinator.createJob(input))
  ipcMain.handle(ASR_CHANNELS.getJob, (_event, id) => coordinator.getJob(id))
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

function registerAccountHandlers(client: SaasClient): void {
  ipcMain.handle(ACCOUNT_CHANNELS.status, () => client.status())
  ipcMain.handle(ACCOUNT_CHANNELS.login, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的登录信息。')
    const value = input as { identifier?: unknown; password?: unknown }
    if (typeof value.identifier !== 'string' || typeof value.password !== 'string') {
      throw new Error('请输入账号和密码。')
    }
    return client.login(value.identifier, value.password)
  })
  ipcMain.handle(ACCOUNT_CHANNELS.oidcLogin, (_event, provider: unknown) => {
    if (provider !== 'apple' && provider !== 'google') throw new Error('不支持的登录方式。')
    return client.loginWithOidc(provider)
  })
  ipcMain.handle(ACCOUNT_CHANNELS.oidcCancel, () => client.cancelOidcLogin())
  ipcMain.handle(ACCOUNT_CHANNELS.logout, () => client.logout())
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
    app.setAsDefaultProtocolClient('everroom', process.execPath, [process.argv[1]])
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
    // Knowledge Service(Wiki)与 MemoryCore 同款托管;失败仅禁用 wiki 工具,不阻塞启动。
    knowledgeServiceSupervisor = new KnowledgeServiceSupervisor(dataDirectory)
    const knowledge = await knowledgeServiceSupervisor.start().catch((error) => {
      console.error('Managed Knowledge service failed to start; wiki tools stay disabled.', error)
      return null
    })
    gatewaySupervisor = new GatewaySupervisor(
      dataDirectory,
      {
        ...(memoryCore
          ? {
            NXCORE_MEMORY_ENABLED: 'true',
            NXCORE_MEMORY_BASE_URL: memoryCore.baseUrl,
            NXCORE_MEMORY_API_KEY: memoryCore.apiKey,
          }
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
    registerGatewayHandlers(gatewaySupervisor)
    realityGatewayBridge = new RealityGatewayBridge(gatewaySupervisor)
    registerRealityHandlers(realityGatewayBridge)
    agentGatewayBridge = new AgentGatewayBridge(gatewaySupervisor)
    registerAgentHandlers(agentGatewayBridge)
    registerMemoryHandlers(new MemoryGatewayBridge(gatewaySupervisor))
    documentGatewayBridge = new DocumentGatewayBridge(gatewaySupervisor)
    registerDocumentHandlers(documentGatewayBridge)
    registerKnowledgeHandlers(new KnowledgeGatewayBridge(gatewaySupervisor))
    const credentials = new CredentialStore(join(app.getPath('userData'), 'credentials.json'))
    await credentials.initialize()
    const recordingsDirectory=join(dataDirectory,'recordings')
    recordingStore = new RecordingStore(recordingsDirectory)
    saasClient=new SaasClient(credentials,app,recordingsDirectory,(url)=>shell.openExternal(url))
    void saasClient.initialize()
    if (process.platform !== 'darwin') {
      const startupProtocolUrl = process.argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL))
      if (startupProtocolUrl) queuedProtocolUrls.push(startupProtocolUrl)
    }
    for (const url of queuedProtocolUrls.splice(0)) saasClient.handleOidcCallback(url)
    registerAccountHandlers(saasClient)
    registerAsrHandlers(recordingStore,new AsrCoordinator(new AsrGatewayBridge(gatewaySupervisor),saasClient,realityGatewayBridge))

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
  const memoryCore = memoryCoreSupervisor
  const knowledgeService = knowledgeServiceSupervisor
  const agentBridge = agentGatewayBridge
  const documentBridge = documentGatewayBridge
  const realityBridge = realityGatewayBridge
  const recordings = recordingStore
  const cloud = saasClient
  localDataService = null
  gatewaySupervisor = null
  memoryCoreSupervisor = null
  knowledgeServiceSupervisor = null
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
    knowledgeService?.shutdown(),
  ]).then(() => flushDesktopLogs()).finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
