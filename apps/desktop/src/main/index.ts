import { createReadStream, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, parse, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { existsSync, accessSync, constants as fsConstants } from 'node:fs'
import { access } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { loadEnvFile } from 'node:process'

import { app, BrowserWindow, dialog, ipcMain, Notification, protocol, session, shell, systemPreferences } from 'electron'
import type {
  CreateAgentWorkspaceInput,
  ImportRoomDocumentInput,
  DocumentOperationCommandInput,
  LocalAgentInvocationTarget,
  LocalAcpAdapterSpawn,
  SaveRoomDocumentInput,
  StartAgentRunInput,
  StartDocumentOperationInput,
  UpdateAgentWorkspaceInput,
} from '@nxcore/agent-contract'

import type { AccountKeyringStatus, CloudAccountStatus, DefaultLocalFolder, DefaultLocalFolderConnectionResult, SubagentSelectionRewriteInput } from '../shared/sources'
import { applyNativeTheme, appearanceWindowBackground, isAppearanceThemeId, readAppearanceTheme, writeAppearanceTheme } from './appearance-store'
import type { SearchItemType, SearchRequestDto } from '../shared/search'
import type { RuntimeConfigSnapshot } from '../shared/sources'
import { officePreviewKindForFileName, type OfficePreviewKind } from '../shared/sources'
import { CURSOR_COMPLETION_AGENT_ERROR_KEY } from '../shared/cursor-completion'
import type { OpenConnectorExecutionInput } from '../shared/open-connector'
import { ConnectorRegistry } from './connectors/connector-registry'
import { LocalFolderConnector } from './connectors/local-folder-connector'
import { GitHubConnector, type GitHubConfig } from './connectors/github-connector'
import { GoogleDocsConnector, type GoogleDocsConfig } from './connectors/google-docs-connector'
import { NotionConnector, type NotionConfig } from './connectors/notion-connector'
import { LocalDataService } from './core/local-data-service'
import { LOCAL_AUTO_SCAN_EXTENSIONS } from './file-format-policy'
import { HighRiskImportCoordinator } from './high-risk-import-coordinator'
import { CredentialStore } from './security/credential-store'
import { AccountKeyringService } from './security/account-keyring-service'
import { AgentGatewayBridge } from './gateway/agent-gateway-bridge'
import { GatewaySupervisor } from './gateway/gateway-supervisor'
import { AgentAccessSettingsStore, isValidFixedPort } from './agent-access/settings-store'
import { AgentAccessInstaller } from './agent-access/installer'
import { AgentAccessGatewayBridge } from './gateway/agent-access-gateway-bridge'
import { AgentDebugGatewayBridge } from './gateway/agent-debug-gateway-bridge'
import { cleanupStaleProcessRecords, installExitCleanupHook } from './process-cleanup'
import { startDesktopUpdater } from './updater'
import { RuntimeConfigBridge } from './gateway/runtime-config-bridge'
import { cursorCompletionEnvFromConfig } from './gateway/cursor-completion-env'
import { SearchGatewayBridge } from './gateway/search-gateway-bridge'
import type { McpServersMutation } from '../shared/mcp'
import type { ExternalCallPolicyInput, ExternalCallQuery } from '../shared/external-calls'
import type { IngestPipelines } from '../shared/ingest'
import { DocumentGatewayBridge } from './gateway/document-gateway-bridge'
import { McpGatewayBridge } from './gateway/mcp-gateway-bridge'
import { ExternalCallsGatewayBridge } from './gateway/external-calls-gateway-bridge'
import { cleanupLegacyGatewaySecretKey } from './security/gateway-secret-key'
import { FilesGatewayBridge } from './gateway/files-gateway-bridge'
import { ThesisFormatGatewayBridge } from './gateway/thesis-format-gateway-bridge'
import { SubagentGatewayBridge } from './gateway/subagent-gateway-bridge'
import { SlidesGatewayBridge } from './gateway/slides-gateway-bridge'
import { WritingStyleGatewayBridge } from './gateway/writing-style-gateway-bridge'
import { AgentSchedulerGatewayBridge } from './gateway/agent-scheduler-gateway-bridge'
import { ConnectorGatewayBridge } from './gateway/connector-gateway-bridge'
import { SaasConnectorBridge } from './gateway/saas-connector-bridge'
import { isSaasRateLimitError, OIDC_CALLBACK_URL, SaasClient, type ConnectorOoSession, type OidcCallbackOutcome } from './cloud/saas-client'
import { AgentStatusReporter } from './cloud/agent-status-reporter'
import { SessionLeaseKeeper } from './cloud/session-lease-keeper'
import { AiRelayKeeper, type AiRelayKeeperEvent } from './cloud/ai-relay-keeper'
import { RemoteAgentCommandClient } from './cloud/remote-agent-command-client'
import { AgentNotificationBridgeServer } from './cloud/agent-notification-bridge'
import {
  OfficeBridgeServer,
  type OfficeAgentToolsRequest,
  type OfficeExportPdfRequest,
  type OfficeExportPdfResult,
} from './gateway/office-bridge'
import type { OfficeAgentFileEvent, OsOpenedDocument } from '../shared/office'
import type { AgentAskForwardEvent } from './office/office-generation'
import { generateDocxFromHtml } from './office/office-generation'
import { createEverroomMaterialResolver } from './office/office-material-resolver'
import { openDocumentFromSystem as runSystemOpen, OsOpenQueue, osOpenPathsFromArgv } from './office/os-open'
import { MacosPushNotificationService } from './cloud/macos-push-notifications'
import { parseAgentNotificationTarget, type AgentNotificationTarget, type NotificationPreferences } from '../shared/notifications'
import {
  configureDesktopLogger,
  flushDesktopLogs,
  logDesktop,
  logLocalDesktop,
  logDocumentCursorCompletion,
} from './logging/desktop-logger'
import { configureSentry, isSentryRemoteDebugEnabled, syncSentryAccount } from './monitoring/sentry'
import { registerDocumentPdfExportHandler } from './document-pdf-export'
import { registerSystemClipboardHandler } from './system-clipboard'
import { installCrossOriginIsolation } from './cross-origin-isolation'
import { desktopText, setDesktopLocale } from './desktop-locale'
import {
  assertNoEmbeddedDocumentImages,
  DocumentAssetStore,
  DOCUMENT_ASSET_SCHEME,
} from './document-asset-store'
import { OoCliBridge } from '@nxcore/desktop-connector-host/oo-cli-bridge'
import { createConnectorModeStore } from '@nxcore/desktop-connector-host/connector-mode-store'
import {
  OpenConnectorSupervisor,
  type OpenConnectorConnection,
} from '@nxcore/desktop-connector-host/open-connector-supervisor'
import { LarkAuthRunner } from './agent-auth/lark-auth-runner'
import { AgentAuthController } from './agent-auth/controller'
import { createLarkCliRuntime, type LarkCliRuntime } from './runtime/lark-cli-runtime'
import { ExternalDocumentsGatewayBridge } from './gateway/external-documents-gateway-bridge'
import { startDocumentAssetBridge, type DocumentAssetBridge } from './document-asset-bridge'
import { NtnAuthRunner } from './agent-auth/ntn-auth-runner'
import { createAgentAuthPersistence } from './agent-auth/persistence'
import type {
  AgentAuthEnvironmentStatus,
  AgentAuthStartInput,
  DesktopAgentAuthChallenge,
} from '../shared/agent-auth'
import { OBSIDIAN_VAULT_ASSET_SCHEME, type ObsidianImportResult, type ObsidianImportTarget } from '../shared/obsidian'
import { ObsidianVaultService } from './obsidian/obsidian-vault-service'
import { pushDocumentSaveToVault, trashDocumentInVault } from './obsidian/vault-document-sync'
import { createLocalAgentDiscovery, isSafeLocalAgentPath, probeLocalAgentAcpAdapter } from './local-agents/discovery'
import { installLocalAgentAcpAdapter, resolveLocalAcpAdapterSpawn } from './local-agents/adapter-install'
import { bundledAcpAdaptersRoot, bundledNpmCliPath, localAgentAdaptersRoot } from './local-agents/local-agent-paths'
import { LocalAgentWorkspaceBindingStore } from './local-agents/workspace-binding-store'
import type { LocalAgentInstallation, LocalAgentWorkspaceBinding } from '../shared/local-agents'
import { MigrationsGatewayBridge } from './gateway/migrations-gateway-bridge'
import { MigrationCoordinator } from './migrations/coordinator'
import { OfficePreviewRegistry, type AgentArtifactFailureReason } from './office/office-preview-registry'
import { notifyPreviewRequested, previewRequestFromOpenResult } from './office/preview-request'
import { convertOfficeFileToPdf } from './office/legacy-convert'
import { OfficeBridge as GenofficeProtoBridge } from './genoffice/bridge'

const APP_NAME = 'EverRoom'

// 调试用：EVERROOM_CDP=<port> 时开远程调试口，便于 Playwright/CDP 直连截图
// （GenOffice 是 WebContentsView，宿主页截图看不到它）。
if (process.env.EVERROOM_CDP) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.EVERROOM_CDP)
}

/** everoffice UI 迁移：office-proto 原型的 GenOffice 视图桥（window.desktop.office）。
 *  与 OfficePreviewRegistry（真实文档体系）并存，各自管理自己的原生视图实例。 */
let genofficeProtoBridge: GenofficeProtoBridge | null = null

function loadPackagedEnvironment(): void {
  if (!app.isPackaged) return
  try {
    const values = JSON.parse(readFileSync(join(process.resourcesPath, 'packaged-env.json'), 'utf8')) as Record<string, unknown>
    for (const [name, value] of Object.entries(values)) {
      if (typeof value === 'string' && !process.env[name]) process.env[name] = value
    }
  } catch (error) {
    console.warn('Packaged environment file unavailable; using process environment.', error)
  }
}

loadPackagedEnvironment()

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
const defaultDataDirectory = join(appDataDirectory, APP_NAME)
const envFilePath = process.env.NXCORE_ENV_FILE?.trim() || join(defaultDataDirectory, '.env')
if (existsSync(envFilePath)) loadEnvFile(envFilePath)
const dataDirectory = process.env.NXCORE_DATA_DIR?.trim() || defaultDataDirectory
const resolvedDataDirectory = resolve(dataDirectory)

app.setPath('userData', dataDirectory)
app.setName(APP_NAME)
if (app.isPackaged) {
  const esbuildExecutable = process.platform === 'win32' ? 'esbuild.exe' : join('bin', 'esbuild')
  process.env.ESBUILD_BINARY_PATH = join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    `${process.platform}-${process.arch}`,
    esbuildExecutable,
  )
}
configureDesktopLogger(dataDirectory)
configureSentry(app.getVersion(), app.isPackaged)
if (process.platform === 'darwin') process.title = APP_NAME

protocol.registerSchemesAsPrivileged([
  {
    scheme: DOCUMENT_ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: OBSIDIAN_VAULT_ASSET_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    // 网关素材按内容哈希寻址（slides 素材图、风格卡候选/演示页图共用）。
    scheme: 'everroom-material',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
])

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
  listDefaultLocalFolders: 'sources:list-default-local-folders',
  connectDefaultLocalFolders: 'sources:connect-default-local-folders',
  addGitHub: 'sources:add-github',
  addGoogleDocs: 'sources:add-google-docs',
  addNotion: 'sources:add-notion',
  sync: 'sources:sync',
  setPaused: 'sources:set-paused',
  disconnect: 'sources:disconnect',
} as const

const OBSIDIAN_CHANNELS = {
  discover: 'obsidian:discover',
  pickCandidate: 'obsidian:pick-candidate',
  importCandidate: 'obsidian:import-candidate',
  discoveryChanged: 'obsidian:discovery-changed',
  list: 'obsidian:list',
  tree: 'obsidian:tree',
  readNote: 'obsidian:read-note',
  saveNote: 'obsidian:save-note',
  createNote: 'obsidian:create-note',
  moveNote: 'obsidian:move-note',
  trashNote: 'obsidian:trash-note',
  addAttachment: 'obsidian:add-attachment',
  rescan: 'obsidian:rescan',
  disconnect: 'obsidian:disconnect',
  changed: 'obsidian:changed',
} as const

const GATEWAY_CHANNELS = {
  status: 'gateway:status',
} as const
const MIGRATION_CHANNELS = {
  discover: 'migrations:discover', chooseOpenClaw: 'migrations:choose-openclaw', importOpenClaw: 'migrations:import-openclaw',
  localAgentSources: 'migrations:local-agent-sources', chooseLocalAgentDirectory: 'migrations:choose-local-agent-directory', importLocalAgentMigration: 'migrations:import-local-agent-migration',
  importCherry: 'migrations:import-cherry', setCherrySync: 'migrations:set-cherry-sync', exportCherry: 'migrations:export-cherry',
  importNotionZip: 'migrations:import-notion-zip', sources: 'migrations:sources', runs: 'migrations:runs', cancel: 'migrations:cancel',
  retry: 'migrations:retry', reimport: 'migrations:reimport', clear: 'migrations:clear', conversations: 'migrations:conversations',
  preview: 'migrations:preview', progress: 'migrations:progress',
} as const
const RUNTIME_CONFIG_CHANNELS = {
  get: 'runtime-config:get',
  saveUser: 'runtime-config:save-user',
  clearUser: 'runtime-config:clear-user',
  relayReady: 'runtime-config:relay-ready',
  selectSource: 'runtime-config:select-source',
  test: 'runtime-config:test',
} as const

const CONNECTOR_CHANNELS = {
  status: 'nango-connector:status',
  providers: 'nango-connector:providers',
  oauthConfigs: 'nango-connector:oauth-configs',
  startAuthorization: 'nango-connector:start-authorization',
  authorizationStatus: 'nango-connector:authorization-status',
  remoteAccount: 'nango-connector:remote-account',
  purgeConnection: 'nango-connector:purge-connection',
  reconnectConnection: 'nango-connector:reconnect-connection',
} as const
const OPEN_CONNECTOR_CHANNELS = {
  status: 'open-connector:status',
  execute: 'open-connector:execute',
  cancel: 'open-connector:cancel',
  openConsole: 'open-connector:open-console',
  mode: 'open-connector:mode',
  setMode: 'open-connector:set-mode',
  startAuthorization: 'open-connector:start-authorization',
} as const

const AGENT_AUTH_CHANNELS = {
  status: 'agent-auth:status',
  start: 'agent-auth:start',
  resume: 'agent-auth:resume',
  cancel: 'agent-auth:cancel',
  disconnect: 'agent-auth:disconnect',
} as const

const EXTERNAL_DOCUMENT_CHANNELS = {
  importSearch: 'external-documents:import-search',
  importList: 'external-documents:import-list',
  importBatch: 'external-documents:import-batch',
  importBatchStatus: 'external-documents:import-batch-status',
  activeImportBatch: 'external-documents:active-import-batch',
  cancelImportBatch: 'external-documents:cancel-import-batch',
  importPreview: 'external-documents:import-preview',
  importCommit: 'external-documents:import-commit',
  importRun: 'external-documents:import-run',
  cancelImportRun: 'external-documents:cancel-import-run',
  importHistory: 'external-documents:import-history',
  checkExternalUpdate: 'external-documents:check-external-update',
  applyCandidate: 'external-documents:apply-candidate',
  createExport: 'external-documents:create-export',
  getExport: 'external-documents:get-export',
  confirmExport: 'external-documents:confirm-export',
  retryExport: 'external-documents:retry-export',
  cancelExport: 'external-documents:cancel-export',
  listExports: 'external-documents:list-exports',
  importDiff: 'external-documents:import-diff',
  importStructuredDiff: 'external-documents:import-structured-diff',
  searchExportTargets: 'external-documents:search-export-targets',
} as const

// 子代理调用（划词改写 + 调用树/事件轮询）：Context Room 删除后仅剩这些活通道。
const SUBAGENT_CHANNELS = {
  dispatchSelectionRewrite: 'subagents:dispatch-selection-rewrite',
  getInvocation: 'subagents:get-invocation',
  cancelInvocation: 'subagents:cancel-invocation',
  listRunInvocations: 'subagents:list-run-invocations',
  listInvocationEvents: 'subagents:list-invocation-events',
} as const

const AGENT_CHANNELS = {
  discoverLocalAgents: 'agent:discover-local-agents',
  checkLocalAgentAdapters: 'agent:check-local-agent-adapters',
  installLocalAgentAdapter: 'agent:install-local-agent-adapter',
  importLocalAgentHistory: 'agent:import-local-agent-history',
  bindLocalAgentWorkspace: 'agent:bind-local-agent-workspace',
  getStatus: 'agent:get-status',
  getUsage: 'agent:get-usage',
  // 工作区（Workspace）：会话的组织容器，由 gateway agent_workspaces 表承载。
  workspaceList: 'workspace:list',
  workspaceCreate: 'workspace:create',
  workspaceUpdate: 'workspace:update',
  workspaceRemove: 'workspace:remove',
  workspacePickDirectory: 'workspace:pick-directory',
  listSessions: 'agent:list-sessions',
  createSession: 'agent:create-session',
  createSessionLink: 'agent:create-session-link',
  listSessionLinks: 'agent:list-session-links',
  markSessionLinkReturned: 'agent:mark-session-link-returned',
  updateSession: 'agent:update-session',
  generateSessionTitle: 'agent:generate-session-title',
  suggestConversationPrompt: 'agent:suggest-conversation-prompt',
  suggestStarterPrompts: 'agent:suggest-starter-prompts',
  deleteSession: 'agent:delete-session',
  getSession: 'agent:get-session',
  getEvents: 'agent:get-events',
  getLocalAgentDispatch: 'agent:get-local-agent-dispatch',
  startRun: 'agent:start-run',
  submitPendingIntent: 'agent:submit-pending-intent',
  cancelRun: 'agent:cancel-run',
  resolveApproval: 'agent:resolve-approval',
  getPermissionMode: 'agent:get-permission-mode',
  setPermissionMode: 'agent:set-permission-mode',
  setThinkingLevel: 'agent:set-thinking-level',
  subscribe: 'agent:subscribe',
  unsubscribe: 'agent:unsubscribe',
} as const

const CURSOR_COMPLETION_AGENT_CHANNELS = {
  createSession: 'cursor-completion-agent:create-session',
  deleteSession: 'cursor-completion-agent:delete-session',
  getEvents: 'cursor-completion-agent:get-events',
  startRun: 'cursor-completion-agent:start-run',
  cancelRun: 'cursor-completion-agent:cancel-run',
  subscribe: 'cursor-completion-agent:subscribe',
  unsubscribe: 'cursor-completion-agent:unsubscribe',
} as const

const DOCUMENT_CHANNELS = {
  list: 'documents:list',
  listTrash: 'documents:list-trash',
  get: 'documents:get',
  listBlocks: 'documents:list-blocks',
  listBlockBacklinks: 'documents:list-block-backlinks',
  listVersions: 'documents:list-versions',
  getVersionSnapshot: 'documents:get-version-snapshot',
  getDiff: 'documents:get-diff',
  versionChangeSummary: 'documents:version-change-summary',
  listDocumentComments: 'documents:list-document-comments',
  createDocumentComment: 'documents:create-document-comment',
  resolveDocumentComment: 'documents:resolve-document-comment',
  deleteDocumentComment: 'documents:delete-document-comment',
  getOverview: 'documents:get-overview',
  generateOverview: 'documents:generate-overview',
  getSectionPreview: 'documents:get-section-preview',
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
  move: 'documents:move',
  moveMany: 'documents:move-many',
  restore: 'documents:restore',
  deletePermanently: 'documents:delete-permanently',
  emptyTrash: 'documents:empty-trash',
  subscribe: 'documents:subscribe',
  unsubscribe: 'documents:unsubscribe',
} as const

// 系统隐私授权（本地 TCC 查询，不经网关）：只有麦克风 onboarding 还需要。
const PERMISSION_CHANNELS = {
  requestMicrophoneAccess: 'permissions:request-microphone-access',
  getMicrophoneAccessStatus: 'permissions:microphone-access-status',
  openMicrophoneSettings: 'permissions:open-microphone-settings',
} as const

const ACCOUNT_CHANNELS = {
  status: 'account:status',
  devices: 'account:devices',
  login: 'account:login',
  oidcLogin: 'account:oidc-login',
  invitationCodeValidate: 'account:invitation-code-validate',
  invitationCodeRedeem: 'account:invitation-code-redeem',
  oidcCancel: 'account:oidc-cancel',
  logout: 'account:logout',
  keyringStatus: 'account:keyring-status',
  createPairingSession: 'account:create-pairing-session',
  getPairingSession: 'account:get-pairing-session',
  approvePairingSession: 'account:approve-pairing-session',
  /** 扫码登录：renderer 只传可选 session id，桌面交换凭证不离开主进程。 */
  qrLoginCreate: 'account:qr-login-create',
  qrLoginStatus: 'account:qr-login-status',
  qrLoginExchange: 'account:qr-login-exchange',
  qrLoginCancel: 'account:qr-login-cancel',
  deviceAdmissionReplace: 'account:device-admission-replace',
  deviceAdmissionDismiss: 'account:device-admission-dismiss',
  /** 中转额度视图：必须挂在被路由的分组里——handle() 只写注册表，
   *  通道不在 channelGroups 中就不会安装 ipcMain.handle（引入提交漏了这行，
   *  已登录开设置页每次都报 No handler registered）。 */
  aiRelayStatus: 'ai-relay:status',
  /** SaaS 权威额度判定（402/403 后置 true）：启动闸门用它区分「额度耗尽」
   *  与「服务未就绪」，keeper 未起/未判定返回 false。 */
  aiRelayVerdict: 'ai-relay:verdict',
} as const

const SEARCH_CHANNELS = {
  invoke: 'search:invoke',
  status: 'search:status',
  prioritize: 'search:prioritize',
  messageContext: 'search:message-context',
} as const

const MCP_CHANNELS = {
  listServers: 'mcp:servers:list',
  saveServers: 'mcp:servers:save',
} as const

const EXTERNAL_CALL_CHANNELS = {
  listPolicies: 'external-calls:policies:list',
  savePolicy: 'external-calls:policies:save',
  deletePolicy: 'external-calls:policies:delete',
  listUsage: 'external-calls:usage:list',
  listAudits: 'external-calls:audits:list',
} as const

const FILES_CHANNELS = {
  list: 'files:list',
  catalogEntry: 'files:catalog-entry',
  get: 'files:get',
  readMarkdown: 'files:read-markdown',
  readDataUrl: 'files:read-data-url',
  rename: 'files:rename',
  delete: 'files:delete',
  reveal: 'files:reveal',
  exportReveal: 'files:export-reveal',
  openOriginal: 'files:open-original',
  pickAndImport: 'files:pick-and-import',
  pickPaths: 'files:pick-paths',
  importPathsOnce: 'files:import-paths-once',
  importArtifacts: 'files:import-artifacts',
  importAgentAttachments: 'files:import-agent-attachments',
  importProgress: 'files:import-progress',
  listHighRiskReviews: 'files:high-risk-reviews:list',
  resolveHighRiskReview: 'files:high-risk-reviews:resolve',
  highRiskReviewsChanged: 'files:high-risk-reviews:changed',
  /** 系统文件管理器打开文档 → 渲染层（push，非 invoke）。 */
  openFromOs: 'files:open-from-os',
  /** 冷启动竞态兜底：渲染层启动时取走暂存的系统打开请求。 */
  takePendingOsOpen: 'files:take-pending-os-open',
} as const

const THESIS_FORMAT_CHANNELS = {
  listCards: 'thesis-format:cards:list',
  parseFromLibrary: 'thesis-format:parse:library',
  pickAndParse: 'thesis-format:parse:pick',
  parseUpload: 'thesis-format:parse:upload',
  removeCard: 'thesis-format:cards:remove',
  deleteTemplate: 'thesis-format:template:delete',
  reformat: 'thesis-format:reformat',
  reformatStart: 'thesis-format:reformat:start',
  reformatStatus: 'thesis-format:reformat:status',
  exportPdf: 'thesis-format:export:pdf',
  cardChanged: 'thesis-format:card-changed',
} as const

/** slides 配图过目卡：后台逐张生成期间的会话快照轮询。 */
const SLIDES_CHANNELS = {
  pageImagesStatus: 'slides:page-images-status',
} as const

const WRITING_STYLE_CHANNELS = {
  profile: 'writing-style:get',
  settings: 'writing-style:get-settings',
  updateSettings: 'writing-style:update-settings',
  userContent: 'writing-style:get-user-content',
  replaceUserContent: 'writing-style:replace-user-content',
  regenerateUserContent: 'writing-style:regenerate-user-content',
  recompute: 'writing-style:recompute',
  backfill: 'writing-style:backfill',
  corpus: 'writing-style:list-corpus',
  setExclusion: 'writing-style:set-exclusion',
  insights: 'writing-style:list-insights',
  snoozeInsight: 'writing-style:snooze-insight',
  confirmInsight: 'writing-style:confirm-insight',
  completionFeedback: 'writing-style:completion-feedback',
} as const

const AGENT_SCHEDULER_CHANNELS = {
  list: 'agent-scheduler:list',
  create: 'agent-scheduler:create',
  update: 'agent-scheduler:update',
  remove: 'agent-scheduler:remove',
  runNow: 'agent-scheduler:run-now',
} as const

// 外部 Agent 访问（PRD 第 7 章）：连接管理/自检/示例查询/安装代写/调试数据 +
// 桌面侧固定端口设置与网关重启（安装到外部工具的配置依赖稳定地址）。
const AGENT_ACCESS_CHANNELS = {
  listConnections: 'agent-access:list-connections',
  createConnection: 'agent-access:create-connection',
  updateConnection: 'agent-access:update-connection',
  revokeConnection: 'agent-access:revoke-connection',
  rotateToken: 'agent-access:rotate-token',
  submissions: 'agent-access:submissions',
  events: 'agent-access:events',
  selftest: 'agent-access:selftest',
  exampleQuery: 'agent-access:example-query',
  install: 'agent-access:install',
  uninstall: 'agent-access:uninstall',
  settingsGet: 'agent-access:settings-get',
  settingsSetFixedPort: 'agent-access:settings-set-fixed-port',
  restartGateway: 'agent-access:restart-gateway',
} as const

// Agent 调试面板（docs/design/agent-debug-panel.zh-CN.md）：只读的 Agent 上下文检查器，
// 数据来自网关 /v1/agent-debug/*（运行时 describe() 的实际装配结果）。
// 面板是独立窗口（独立渲染入口 debug.html），从 Agent 页的「调试」按钮打开。
const AGENT_DEBUG_CHANNELS = {
  listAgents: 'agent-debug:list-agents',
  getAgent: 'agent-debug:get-agent',
  listUsage: 'agent-debug:list-usage',
  openWindow: 'agent-debug:open-window',
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
    OBSIDIAN_CHANNELS,
    GATEWAY_CHANNELS,
    RUNTIME_CONFIG_CHANNELS,
    OPEN_CONNECTOR_CHANNELS,
    AGENT_AUTH_CHANNELS,
    EXTERNAL_DOCUMENT_CHANNELS,
    SUBAGENT_CHANNELS,
    AGENT_CHANNELS,
    CURSOR_COMPLETION_AGENT_CHANNELS,
    DOCUMENT_CHANNELS,
    PERMISSION_CHANNELS,
    ACCOUNT_CHANNELS,
    SEARCH_CHANNELS,
    MCP_CHANNELS,
    EXTERNAL_CALL_CHANNELS,
    FILES_CHANNELS,
    MIGRATION_CHANNELS,
    AGENT_SCHEDULER_CHANNELS,
    AGENT_ACCESS_CHANNELS,
    AGENT_DEBUG_CHANNELS,
    WRITING_STYLE_CHANNELS,
    SLIDES_CHANNELS,
    THESIS_FORMAT_CHANNELS,
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
let obsidianVaultService: ObsidianVaultService | null = null
let gatewaySupervisor: GatewaySupervisor | null = null
let agentAccessSettingsStore: AgentAccessSettingsStore | null = null
/** 系统代理探测结果（app 启动时求值一次，supervisor getter 每次 respawn 读取）。 */
let gatewayProxyEnv: Record<string, string> = {}
/** gateway:recover 的 in-flight 去重（网络失败风暴时并发请求只触发一次恢复）。 */
let gatewayRecoverInFlight: Promise<{ ok: boolean; reason?: 'not-started' | 'recover-failed' }> | null = null
let runtimeConfigBridge: RuntimeConfigBridge | null = null
/**
 * 网关就绪信号：启动期的 runtime-config 查询只等它，不等全量服务初始化
 * （servicesReady = 网关 + 连接器/本地数据等全部就绪）。否则登录态下
 * 会话恢复、连接器初始化都会被算进启动闪屏，把网关启动的并行收益吃掉。
 */
let resolveGatewayReady: (() => void) | null = null
let rejectGatewayReady: ((error: Error) => void) | null = null
const gatewayReady = new Promise<void>((resolve, reject) => {
  resolveGatewayReady = resolve
  rejectGatewayReady = reject
})
gatewayReady.catch(() => { /* 失败由 gate 的重试路径收口 */ })
let cursorCompletionSupervisor: GatewaySupervisor | null = null
let ooCliBridge: OoCliBridge | null = null
/** OpenConnector 控制台地址（local=本地运行时；SaaS=oo 会话 baseUrl）；bridge 未建时为 null。 */
let connectorConsoleBaseUrl: string | null = null
let agentAuthController: AgentAuthController | null = null
let documentAssetBridge: DocumentAssetBridge | null = null
let openConnectorSupervisor: OpenConnectorSupervisor | null = null
let connectorModeStoreRef: ReturnType<typeof createConnectorModeStore> | null = null
const activeConnectorModeStore = () => connectorModeStoreRef
// SaaS 连接层（connector-mode = 'saas'）：oo 会话由登录后向 SaaS 换取
// （POST /app/connectors/oo/token → {baseUrl, token}），客户端直连 oo 数据面。
let connectorOoGatewayEnv: Record<string, string> = {}
let connectorOoAppliedEnvJson = '{}'
let connectorOoSessionCache: { userId: string; session: ConnectorOoSession | null } | null = null
let connectorOoUserId: string | null = null
let saasConnectorBridge: SaasConnectorBridge | null = null
let openConnectorConsoleWindow: BrowserWindow | null = null
// Agent 调试面板的独立窗口（单例：重复点击聚焦已开窗口，不重复创建）。
let agentDebugWindow: BrowserWindow | null = null
let agentGatewayBridge: AgentGatewayBridge | null = null
let cursorCompletionAgentBridge: AgentGatewayBridge | null = null
let documentGatewayBridge: DocumentGatewayBridge | null = null
let writingStyleGatewayBridge: WritingStyleGatewayBridge | null = null
let agentSchedulerGatewayBridge: AgentSchedulerGatewayBridge | null = null
let agentAccessGatewayBridge: AgentAccessGatewayBridge | null = null
let agentDebugGatewayBridge: AgentDebugGatewayBridge | null = null
let agentAccessInstaller: AgentAccessInstaller | null = null
let connectorGatewayBridge: ConnectorGatewayBridge | null = null
let migrationCoordinator: MigrationCoordinator | null = null
let saasClient: SaasClient | null = null
let agentStatusReporter: AgentStatusReporter | null = null
let sessionLeaseKeeper: SessionLeaseKeeper | null = null
let aiRelayKeeper: AiRelayKeeper | null = null
let remoteAgentCommandClient: RemoteAgentCommandClient | null = null
let agentNotificationBridgeServer: AgentNotificationBridgeServer | null = null
let officeBridgeServer: OfficeBridgeServer | null = null
/** Agent 生成文档入库用的长驻 FilesGatewayBridge（启动流程 L3662 实例就位后赋值）。 */
let officeFilesBridge: FilesGatewayBridge | null = null
let macosPushNotifications: MacosPushNotificationService | null = null
let pendingAgentNotificationTarget: AgentNotificationTarget | null = null
let shutdownStarted = false
let clearUserDataOnQuit = false
const officePreviewRegistry = new OfficePreviewRegistry(
  8_000,
  // everroom-material:// 素材回源：文件桥惰性取（网关启动后才赋值），每次调用现建（闭包零成本）。
  () => createEverroomMaterialResolver(() => officeFilesBridge),
)
/** 论文格式网关桥：网关就绪后赋值；pick 直传共用同一实例。 */
let thesisFormatBridgeRef: ThesisFormatGatewayBridge | null = null

/** 系统文件管理器派发的打开请求：先排队，等文件桥就绪后串行导入 + 打开。 */
const osOpenQueue = new OsOpenQueue()
/** 最近一条尚未被渲染层消费的系统打开请求（冷启动竞态兜底，取走即清空）。 */
let pendingOsOpen: OsOpenedDocument | null = null
/** 访达直接打开的文件：fileId → 磁盘原路径；保存后把工作副本写回它。 */
const osOpenedWriteBackPaths = new Map<string, string>()

/** office:agent-file 事件扇出到所有渲染窗口（生成进度/完成 + 编辑回填结果共用通道）。 */
function broadcastOfficeAgentFileEvent(event: OfficeAgentFileEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('office:agent-file', event)
  }
}

/** office:agent-ask 扇出：slides「AI 修改」弹层转发 → 渲染层注入对应 Room 对话框。 */
function broadcastAgentAskEvent(event: AgentAskForwardEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('office:agent-ask', event)
  }
}

const queuedProtocolUrls: string[] = []

function sendPendingAgentNotificationTarget(): void {
  const target = pendingAgentNotificationTarget
  const window = BrowserWindow.getAllWindows()[0]
  if (!target || !window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isLoadingMainFrame()) return
  pendingAgentNotificationTarget = null
  window.webContents.send('notifications:open-target', target)
}

function openAgentNotificationTarget(target: AgentNotificationTarget): void {
  pendingAgentNotificationTarget = target
  let window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) {
    window = createWindow()
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  sendPendingAgentNotificationTarget()
}

/** 把系统打开请求送到渲染层：页面尚未加载完就等首帧，避免事件丢失。 */
function sendOsOpenToRenderer(document: OsOpenedDocument): void {
  pendingOsOpen = document
  let window = BrowserWindow.getAllWindows()[0]
  if (!window || window.isDestroyed()) {
    // macOS 关窗不退出应用：系统打开文档时要把主窗口重建出来（与 focusMainWindow 同策略）。
    window = createWindow()
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  // TEMP DIAG：访达打开链路（查完删除）。
  logDesktop('office', 'info', {
    event: 'office.diag.os-open.send',
    fileId: document.fileId,
    originalName: document.originalName,
    windowVisible: window.isVisible(),
    windowFocused: window.isFocused(),
    loadingMainFrame: window.webContents.isLoadingMainFrame(),
  })
  const target = window.webContents
  if (target.isLoadingMainFrame()) {
    target.once('did-finish-load', () => {
      if (!window.isDestroyed() && !target.isDestroyed()) target.send(FILES_CHANNELS.openFromOs, document)
    })
    return
  }
  target.send(FILES_CHANNELS.openFromOs, document)
}

/** 系统打开失败：走原生错误框（渲染层可能停在别的页面，页内 toast 容易被漏看）。 */
function showOsOpenFailure(name: string, detail: string): void {
  const options = {
    type: 'warning' as const,
    title: desktopText('dialog.openDocument.title'),
    message: desktopText('dialog.openDocument.message', { name }),
    detail,
    buttons: ['好'],
    defaultId: 0,
  }
  const window = BrowserWindow.getAllWindows()[0]
  if (window && !window.isDestroyed()) void dialog.showMessageBox(window, options)
  else void dialog.showMessageBox(options)
}

/**
 * 访达/资源管理器里打开一个 Word/Excel/PPT：先入文件库（同路径重开命中同一
 * entry，版本级去重），再交给渲染层用内嵌 Office 预览打开。
 * 旧版 .doc/.xls/.ppt 的转换失败由各视图管理器回退系统默认应用。
 */
/** 导入偶发失败（连接被并发扫描打断 / 网关刚重启）时的重试判定。 */
function isTransientOsImportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Bad Request|文件上传失败（5\d\d）|ECONNRESET|fetch failed|socket hang up/i.test(message)
}

async function openDocumentFromSystem(filePath: string): Promise<void> {
  await runSystemOpen(filePath, {
    importFile: async (path) => {
      const bridge = officeFilesBridge
      if (!bridge) return null
      // 已作为「本地文件夹」来源入库且内容没变：直接复用条目打开，不重复上传。
      // 大文件（上百 MB 的 Excel/PPT）尤其需要，避免每次访达打开都整包上传。
      try {
        const known = await bridge.lookupSourcePath(path, await hashFileBytes(path))
        if (known) {
          return { fileId: known.fileId, filename: known.originalName, error: null, skippedReason: null }
        }
      } catch (error) {
        console.warn('[os-open] source lookup skipped', error)
      }
      try {
        return (await bridge.importPathsOnce([path]))[0] ?? null
      } catch (error) {
        // 网关偶发拒绝（连接复用与后台扫描撞在一起）：等一拍重试一次再报错。
        if (!isTransientOsImportError(error)) throw error
        console.warn('[os-open] import failed; retrying once', error)
        await new Promise((resolve) => setTimeout(resolve, 600))
        return (await bridge.importPathsOnce([path]))[0] ?? null
      }
    },
    open: (document) => {
      // 记下磁盘原路径：保存后除回填库内版本，还要写回外部的这份文件。
      osOpenedWriteBackPaths.set(document.fileId, filePath)
      sendOsOpenToRenderer(document)
    },
    fail: (name, failure) => {
      const detail = failure.kind === 'service_unavailable'
        ? desktopText('dialog.openDocument.serviceUnavailable')
        : failure.kind === 'unsupported_format'
          ? desktopText('dialog.openDocument.unsupportedFormat')
          : failure.message || desktopText('dialog.openDocument.unknownError')
      showOsOpenFailure(name, detail)
    },
  })
}

app.on('ready', (_event, launchInfo) => {
  const target = parseAgentNotificationTarget(launchInfo)
  if (target) pendingAgentNotificationTarget = target
})

ipcMain.on('notifications:renderer-ready', () => sendPendingAgentNotificationTarget())

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
const getSystemLocale = (): string => app.getSystemLocale()
ipcMain.on('app:get-system-locale-sync', (event) => {
  event.returnValue = getSystemLocale()
})
ipcMain.handle('app:get-system-locale', () => getSystemLocale())
ipcMain.handle('app:clear-user-data', () => {
  const target = parse(resolvedDataDirectory)
  if (resolvedDataDirectory === target.root || resolvedDataDirectory === resolve(appDataDirectory) || resolvedDataDirectory === resolve(process.cwd())) {
    throw new Error('Refusing to clear an unsafe application data path.')
  }
  clearUserDataOnQuit = true
  app.quit()
})
ipcMain.on('app:set-locale', (_event, locale: unknown) => setDesktopLocale(locale))

// Windows 自绘标题栏的窗口控制（macOS 用系统红绿灯按钮，不经过这里）。
ipcMain.handle('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.handle('window:toggle-maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  if (window.isMaximized()) window.unmaximize()
  else window.maximize()
})
ipcMain.handle('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
ipcMain.handle('window:get-state', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  return { maximized: window?.isMaximized() ?? false }
})

/** 全局外观：渲染端切换主题时镜像到主进程（窗口底色 + 原生主题）。 */
ipcMain.handle('appearance:set-theme', (_event, theme: unknown) => {
  if (isAppearanceThemeId(theme)) writeAppearanceTheme(theme)
})

function logRendererDiagnostic(input: unknown): void {
  if (!input || typeof input !== 'object') return
  const value = input as { module?: unknown; level?: unknown; event?: unknown }
  if (value.module !== 'document-cursor-completion' && value.module !== 'context-room-overview'
    && value.module !== 'block-index-mark' && value.module !== 'document-focus') return
  if (value.level !== 'info' && value.level !== 'warn' && value.level !== 'error') return
  if (!value.event || typeof value.event !== 'object' || Array.isArray(value.event)) return
  try {
    const serialized = JSON.stringify(value.event)
    if (serialized.length > 16_000) return
    const event = JSON.parse(serialized) as Record<string, unknown>
    if (value.module === 'document-cursor-completion') logDocumentCursorCompletion(value.level, event)
    else logLocalDesktop(value.module, value.level, event)
  } catch {
    // Ignore malformed renderer diagnostics rather than affecting the editor.
  }
}

ipcMain.on('app:diagnostic-log', (_event, input: unknown) => logRendererDiagnostic(input))

ipcMain.handle('office:instance:set-active', (event, id: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) throw new Error('EverRoom 主窗口不可用。')
  if (id !== null && typeof id !== 'string') return false
  // TEMP DIAG：渲染端激活请求是否命中实例（查完删除）。
  const active = officePreviewRegistry.setActive(id === null ? null : id)
  logDesktop('office', 'info', { event: 'office.diag.ipc.set-active', id, active })
  return active
})

ipcMain.handle('office:instance:close', async (event, id: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) throw new Error('EverRoom 主窗口不可用。')
  if (typeof id !== 'string') return false
  // false = 可编辑实例在脏关闭守卫里被取消：渲染层保留标签不卸载。
  return officePreviewRegistry.close(id)
})

/**
 * 干净画布：宿主侧隐藏/显示 Word 编辑器的操作区（Ribbon/状态栏/标尺/导航）。
 * input = { fileId?, hidden? }；fileId 省略 = 当前焦点 Word 页签，hidden 省略 = 切换。
 */
ipcMain.handle('office:chrome-toggle', (event, input: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || window.isDestroyed()) throw new Error('EverRoom 主窗口不可用。')
  const value = (input ?? {}) as { fileId?: unknown; hidden?: unknown }
  const fileId = typeof value.fileId === 'string' && value.fileId ? value.fileId : 'active'
  const hidden = typeof value.hidden === 'boolean' ? value.hidden : undefined
  return officePreviewRegistry.setDocsChromeHidden(fileId, hidden)
})

// Doc 生成流程原型：渲染端把定稿 HTML 送 genoffice 管线生成 .docx 并入库。
ipcMain.handle('office:generate-docx-prototype', async (_event, input: unknown) => {
  const value = input as { title?: unknown; html?: unknown }
  if (typeof value?.title !== 'string' || typeof value?.html !== 'string') {
    throw new Error('生成请求缺少 title 或 html。')
  }
  if (!officeFilesBridge) throw new Error('文件服务尚未就绪，请稍后重试。')
  const generated = await generateDocxFromHtml({ title: value.title, html: value.html })
  const originalName = `${generated.title}.docx`
  try {
    const accepted = await officeFilesBridge.importAgentGeneratedFile({
      filePath: generated.filePath,
      originalName,
      sourceKey: `prototype:docx:${randomUUID()}`,
    })
    return { fileEntryId: accepted.fileEntryId, originalName }
  } finally {
    await rm(generated.filePath, { force: true }).catch(() => undefined)
  }
})

function focusMainWindow(): void {
  const window = BrowserWindow.getAllWindows()[0]
  // 窗口已销毁（如 before-quit 异步清理挂起后用户再点图标）：重建窗口，
  // 否则第二实例退出 + 第一实例无窗 = 点图标零反应（issue #179）。
  if (!window || window.isDestroyed()) {
    void createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function handleProtocolUrl(url: string): void {
  if (!url.startsWith(OIDC_CALLBACK_URL)) return
  let outcome: OidcCallbackOutcome = 'unrelated'
  if (saasClient) outcome = saasClient.handleOidcCallback(url)
  else queuedProtocolUrls.push(url)
  focusMainWindow()
  if (outcome === 'no-login-in-progress') notifyLoginCallbackDropped()
}

/**
 * 浏览器授权已完成，但主进程已没有对应的登录（等待超时/应用重启过）：
 * 授权码无处可用，明确告知用户重新发起登录，不再静默丢弃后让用户停在登录页。
 */
function notifyLoginCallbackDropped(): void {
  const options = {
    type: 'warning' as const,
    title: 'EverRoom 登录',
    message: '浏览器授权已完成，但应用内没有正在进行的登录。',
    detail: '登录等待可能已超时或应用重启过，请回到登录页重新点击登录。',
    buttons: ['好'],
    defaultId: 0,
  }
  const window = BrowserWindow.getAllWindows()[0]
  if (window && !window.isDestroyed()) void dialog.showMessageBox(window, options)
  else void dialog.showMessageBox(options)
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  handleProtocolUrl(url)
})

// 访达双击/「打开方式」→ EverRoom：open-file 可能在 ready 之前派发，先入队，
// 等文件桥就绪（启动链装处理器）再串行导入并打开内嵌预览。
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  osOpenQueue.push(...osOpenPathsFromArgv([filePath]))
})

// Windows/Linux 双击文档时系统把路径写进 argv（冷启动与第二实例都走这里）。
osOpenQueue.push(...osOpenPathsFromArgv(process.argv))

if (hasSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    const protocolUrl = argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL))
    if (protocolUrl) handleProtocolUrl(protocolUrl)
    const documentPaths = osOpenPathsFromArgv(argv)
    if (documentPaths.length > 0) {
      focusMainWindow()
      osOpenQueue.push(...documentPaths)
      return
    }
    if (!protocolUrl) focusMainWindow()
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

function registerObsidianHandlers(service: ObsidianVaultService): void {
  const cleanupRemovedVault = async (event: {
    vaultId: string
    roomId: string
    mountMode: 'dedicated' | 'embedded' | 'memory'
    sourceType: 'obsidian-vault' | 'local-directory'
    projectionFileIds: string[]
    memoryProjectionFileIds: string[]
  }, attemptsRemaining = 120): Promise<void> => {
    if (!gatewaySupervisor) {
      if (attemptsRemaining > 0) {
        const timer = setTimeout(() => {
          void cleanupRemovedVault(event, attemptsRemaining - 1)
        }, 1_000)
        timer.unref()
      }
      return
    }
    const files = new FilesGatewayBridge(gatewaySupervisor)
    const fileIds = new Set([...event.projectionFileIds, ...event.memoryProjectionFileIds])
    for (const fileId of fileIds) await files.delete(fileId).catch(() => undefined)
    await new DocumentGatewayBridge(gatewaySupervisor).removeExternalProjections(event.vaultId, undefined, event.sourceType).catch(() => undefined)
  }
  const syncMemoryVault = async (vaultId: string) => {
    if (!gatewaySupervisor) return []
    const vault = service.list().find((item) => item.id === vaultId)
    if (!vault || !vault.memoryEnabled) return []
    const bridge = new FilesGatewayBridge(gatewaySupervisor)
    const resources = (await service.tree(vaultId)).resources
    const outcomes = await bridge.importObsidianProject({
      rootPath: service.vaultRootPath(vaultId),
      projectId: vault.id,
      projectName: vault.name,
      pipelines: { room: false, wiki: false, memory: true },
      resourceIdsByRelativePath: Object.fromEntries(resources.map((resource) => [resource.relativePath, resource.id])),
    })
    for (const outcome of outcomes) {
      if (outcome.fileId) await service.setMemoryProjectionFileId(vaultId, outcome.filename, outcome.fileId)
    }
    // vault 图片的视觉库注册由网关导入链路完成（VLM 描述在 file.ingest 内生成，
    // 结果直接落 visual_nodes），桌面端不再补注册。
    for (const fileId of service.takeRemovedMemoryProjectionFileIds(vaultId)) {
      await bridge.delete(fileId).catch(() => undefined)
    }
    return outcomes
  }
  const projectRoomVault = async (vaultId: string, changedResourceIds?: string[]) => {
    if (!gatewaySupervisor) return
    const vault = service.list().find((item) => item.id === vaultId)
    if (!vault || vault.mountMode === 'memory') return
    const bridge = new FilesGatewayBridge(gatewaySupervisor)
    const documents = new DocumentGatewayBridge(gatewaySupervisor)
    const changedIds = changedResourceIds ? new Set(changedResourceIds) : null
    const notes = service.projectionNotes(vaultId)
      .filter((note) => !changedIds || changedIds.has(note.resourceId))
    for (const note of notes) {
      await bridge.projectVaultNote(note).then(async (result) => {
        await service.setProjectionFileId(vaultId, note.resourceId, result.fileEntryId)
      }).catch((error) => {
        console.warn('Unable to project Obsidian note', { vaultId, relativePath: note.relativePath, error })
      })
      await service.readNote(vaultId, note.resourceId).then(async (snapshot) => {
        const projected = await documents.syncExternalProjection({
          sourceKind: vault.sourceType,
          sourceId: vaultId,
          resourceId: note.resourceId,
          roomId: note.roomId,
          relativePath: note.relativePath,
          sourceHash: snapshot.sourceHash,
          title: basename(note.relativePath, extname(note.relativePath)),
          markdown: snapshot.markdown,
        })
        await service.setProjectionDocumentId(vaultId, note.resourceId, projected.documentId)
      }).catch((error) => {
        console.warn('Unable to sync Obsidian document projection', { vaultId, relativePath: note.relativePath, error })
      })
    }
    for (const fileId of service.takeRemovedProjectionFileIds(vaultId)) {
      await bridge.delete(fileId).catch(() => undefined)
    }
    for (const documentId of service.takeRemovedProjectionDocumentIds(vaultId)) {
      await documents.removeExternalDocumentProjection(documentId).catch(() => undefined)
    }
  }
  const mountAsNewRoom = async (rootPath: string, registryId: string | null) => {
    if (!gatewaySupervisor) throw new Error('本地服务尚未就绪。')
    const vault = await service.mount(rootPath, undefined, 'dedicated', registryId)
    await projectRoomVault(vault.id)
    return vault
  }
  service.onChanged((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(OBSIDIAN_CHANNELS.changed, event)
    }
    const vault = service.list().find((item) => item.id === event.vaultId)
    if (vault?.memoryEnabled) void syncMemoryVault(event.vaultId)
    if (vault && vault.mountMode !== 'memory') void projectRoomVault(event.vaultId, event.changedResourceIds)
  })
  service.onRemoved(async (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(OBSIDIAN_CHANNELS.changed, event)
    }
    await cleanupRemovedVault(event)
  })
  service.onDiscoveryChanged((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(OBSIDIAN_CHANNELS.discoveryChanged, event)
    }
    void localDataService?.rescanLocalFolders()
  })
  for (const vault of service.list()) {
    if (vault.memoryEnabled) void syncMemoryVault(vault.id)
    if (vault.mountMode !== 'memory') void projectRoomVault(vault.id)
  }
  handle(OBSIDIAN_CHANNELS.discover, () => service.discover())
  handle(OBSIDIAN_CHANNELS.pickCandidate, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择目录',
      buttonLabel: '添加到列表',
      properties: ['openDirectory'],
    }
    const selection = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const rootPath = selection.filePaths[0]
    return selection.canceled || !rootPath ? null : service.registerCandidate(rootPath)
  })
  handle(OBSIDIAN_CHANNELS.importCandidate, async (
    _event,
    candidateId: string,
    target: ObsidianImportTarget,
  ): Promise<ObsidianImportResult> => {
    if (!gatewaySupervisor) throw new Error('本地服务尚未就绪。')
    const rootPath = service.candidatePath(candidateId)
    const registryId = service.candidateRegistryId(candidateId)
    const candidate = await service.registerCandidate(rootPath)
    if (target.kind === 'new-room') {
      const vault = await mountAsNewRoom(rootPath, registryId)
      return { kind: 'new-room', vault }
    }
    if (target.kind === 'room') {
      if (typeof target.roomId !== 'string' || !target.roomId.trim()) throw new Error('请选择目标 Room。')
      const vault = await service.mount(rootPath, target.roomId, 'embedded', registryId)
      await projectRoomVault(vault.id)
      return { kind: 'room' as const, vault }
    }
    const vault = await service.mount(rootPath, undefined, 'memory', registryId)
    const outcomes = await syncMemoryVault(vault.id)
    if (registryId && target.enableRegistryAutoImport !== false) await service.setRegisteredVaultAutoImport(true)
    return {
      kind: 'memory' as const,
      projectName: candidate.name,
      total: outcomes.length,
      succeeded: outcomes.filter((outcome) => !outcome.error).length,
      failed: outcomes.filter((outcome) => Boolean(outcome.error)).length,
    }
  })
  handle(OBSIDIAN_CHANNELS.list, () => service.list())
  handle(OBSIDIAN_CHANNELS.rescan, async (_event, vaultId: string) => service.rescan(vaultId))
  handle(OBSIDIAN_CHANNELS.tree, (_event, vaultId: string) => service.tree(vaultId))
  handle(OBSIDIAN_CHANNELS.readNote, (_event, vaultId: string, resourceId: string) =>
    service.readNote(vaultId, resourceId))
  handle(OBSIDIAN_CHANNELS.saveNote, (_event, vaultId: string, resourceId: string, markdown: string, expectedSourceHash: string) =>
    service.saveNote(vaultId, resourceId, markdown, expectedSourceHash))
  handle(OBSIDIAN_CHANNELS.createNote, (_event, vaultId: string, relativePath: string, markdown?: string) =>
    service.createNote(vaultId, relativePath, markdown))
  handle(OBSIDIAN_CHANNELS.moveNote, (_event, vaultId: string, resourceId: string, relativePath: string, expectedSourceHash: string) =>
    service.moveNote(vaultId, resourceId, relativePath, expectedSourceHash))
  handle(OBSIDIAN_CHANNELS.trashNote, (_event, vaultId: string, resourceId: string, expectedSourceHash: string) =>
    service.trashNote(vaultId, resourceId, expectedSourceHash))
  handle(OBSIDIAN_CHANNELS.addAttachment, async (event, vaultId: string, noteRelativePath?: string) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '添加 Vault 附件',
      buttonLabel: '添加',
      properties: ['openFile'],
      filters: [{ name: '图片与 PDF', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf'] }],
    }
    const selection = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const sourcePath = selection.filePaths[0]
    return selection.canceled || !sourcePath ? null : service.addAttachment(vaultId, sourcePath, noteRelativePath)
  })
  handle(OBSIDIAN_CHANNELS.disconnect, async (_event, vaultId: string) => {
    await service.disconnect(vaultId)
  })
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

  const showFolderDialog = (
    event: Electron.IpcMainInvokeEvent,
    options: Electron.OpenDialogOptions,
  ) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    if (parent && !parent.isDestroyed()) return dialog.showOpenDialog(parent, options)
    return dialog.showOpenDialog(options)
  }

  handle(SOURCE_CHANNELS.addLocalFolder, async (event) => {
    const result = await showFolderDialog(event, {
      title: desktopText('dialog.chooseFolder.title'),
      buttonLabel: desktopText('dialog.chooseFolder.button'),
      properties: ['openDirectory', 'createDirectory'],
    })
    const rootPath = result.filePaths[0]
    return result.canceled || !rootPath ? null : service.addLocalFolder(rootPath)
  })
  handle(SOURCE_CHANNELS.listDefaultLocalFolders, () => {
    const sources = service.listSources().filter((source) => source.kind === 'local-folder')
    const normalize = (value: string) => value.replace(/[\\/]+$/, '').toLowerCase()
    return (['documents', 'desktop'] as const).map((folder) => {
      const expected = normalize(app.getPath(folder))
      return {
        folder,
        connected: sources.some((source) => {
          if (source.status === 'disconnected' || normalize(source.rootPath) !== expected) return false
          try { accessSync(source.rootPath, fsConstants.R_OK); return true } catch { return false }
        }),
      }
    })
  })
  handle(SOURCE_CHANNELS.connectDefaultLocalFolders, async (_event, folders: unknown) => {
    if (!Array.isArray(folders)) throw new Error('无效的默认文件夹配置。')
    if (folders.some((folder) => folder !== 'documents' && folder !== 'desktop')) {
      throw new Error('无效的默认文件夹配置。')
    }
    const selected = [...new Set(folders as DefaultLocalFolder[])]
    const results: DefaultLocalFolderConnectionResult[] = []
    for (const folder of selected) {
      try {
        const rootPath = app.getPath(folder)
        // Accessing the protected default directory is what lets macOS show
        // its privacy prompt. Only custom folders use the folder picker above.
        await access(rootPath, fsConstants.R_OK)
        await service.addLocalFolder(rootPath)
        results.push({ folder, connected: true })
      } catch (error) {
        results.push({ folder, connected: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
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

  // 渲染端网络类失败后的自愈入口：拉起/恢复 gateway 连接后由 preload 重试原请求。
  // in-flight 去重防止并发失败风暴触发重复重启。
  ipcMain.handle('gateway:recover', () => {
    if (!gatewaySupervisor) return { ok: false, reason: 'not-started' as const }
    if (!gatewayRecoverInFlight) {
      gatewayRecoverInFlight = gatewaySupervisor.ensureConnection()
        .then(() => ({ ok: true as const }))
        .catch((error: unknown) => {
          console.error('[gateway] 网络失败后自动恢复连接未成功：', error)
          return { ok: false as const, reason: 'recover-failed' as const }
        })
        .finally(() => {
          gatewayRecoverInFlight = null
        })
    }
    return gatewayRecoverInFlight
  })
}

function registerRuntimeConfigHandlers(): void {
  handle(RUNTIME_CONFIG_CHANNELS.get, async () => {
    await gatewayReady
    return runtimeConfigBridge?.get()
  })
  handle(RUNTIME_CONFIG_CHANNELS.saveUser, async (_event, input: unknown) => {
    const snapshot = await runtimeConfigBridge?.saveUser(input)
    if (snapshot) void syncManagedChildProcesses(snapshot)
    return runtimeConfigBridge?.get()
  })
  handle(RUNTIME_CONFIG_CHANNELS.clearUser, async () => {
    const snapshot = await runtimeConfigBridge?.clearUser()
    if (snapshot) void syncManagedChildProcesses(snapshot)
    return runtimeConfigBridge?.get()
  })
  // 登录 gate 放行前的中转就绪闸：触发一次令牌签发（幂等，keeper 20min
  // 周期外的主力路径），随后轮询快照直至 primary 四要素齐（gateway 在
  // 会话 PUT 内同步完成槽位重写），~15s 超时后返回末次快照由 gate 兜底。
  handle(RUNTIME_CONFIG_CHANNELS.relayReady, async () => {
    await aiRelayKeeper?.renewNow().catch(() => undefined)
    const deadline = Date.now() + 15_000
    for (;;) {
      const snapshot = await runtimeConfigBridge?.get().catch(() => null)
      if (snapshot?.primaryConfigured || Date.now() >= deadline) return snapshot ?? null
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  })
  handle(RUNTIME_CONFIG_CHANNELS.test, () => runtimeConfigBridge?.test())
  handle(RUNTIME_CONFIG_CHANNELS.selectSource, async (_event, source: unknown) => {
    if (source !== 'user' && source !== 'default') throw new Error('无效的运行时配置来源。')
    const snapshot = await runtimeConfigBridge?.selectSource(source)
    if (snapshot) void syncManagedChildProcesses(snapshot)
    return runtimeConfigBridge?.get()
  })
}

/** 补全服务子进程的 AI env 缓存：spawn 时经 getter 求值（惰性），配置变更时更新。 */
let cursorCompletionAiEnv: Record<string, string> = {}
let cursorCompletionAiEnvApplied: string = JSON.stringify({})

/**
 * runtime config 变更后同步补全服务子进程的 AI env：算新 env → 变化才动作。
 * 已拉起的实例带旧 env——shutdown 后由下一次 renderer 请求惰性重生（带新 env）；
 * 飞行中的补全流被杀是接受的取舍（秒级操作）。未拉起则只更新缓存。
 */
async function syncCursorCompletionEnvironment(snapshot: RuntimeConfigSnapshot): Promise<void> {
  try {
    const nextEnv = cursorCompletionEnvFromConfig(snapshot.config)
    const nextJson = JSON.stringify(nextEnv)
    cursorCompletionAiEnv = nextEnv
    if (nextJson === cursorCompletionAiEnvApplied) return
    cursorCompletionAiEnvApplied = nextJson
    if (cursorCompletionSupervisor?.isRunning()) await cursorCompletionSupervisor.shutdown()
    console.info(`[cursor-completion] ai env ${Object.keys(nextEnv).length ? 'updated' : 'cleared'} (instance will respawn on demand)`)
  } catch (error) {
    console.error('[cursor-completion] failed to sync ai env:', error)
  }
}

/**
 * 托管子进程（补全服务）的 runtime config 同步总入口。
 * 所有 runtime config 变更路径（IPC 保存/清除、SaaS 下发、source 切换、
 * 启动一次性 sync）统一走这里，避免再出现绕过某条子进程的路径。
 * 整体串行化：并发触发（登录时 SaaS 恢复 + account watch 同秒各来一次）
 * 排队执行，避免重复重启竞态。
 */
let managedChildSyncQueue: Promise<void> = Promise.resolve()

async function syncManagedChildProcesses(snapshot: RuntimeConfigSnapshot): Promise<void> {
  const run = managedChildSyncQueue.then(async () => {
    // 子进程 env 派生需要真密钥；调用方传入的 snapshot 来自 IPC/save 响应，
    // 是脱敏版（渲染层安全边界）。排队执行时 gateway 里已是最新配置，这里
    // 统一取未脱敏 snapshot；取失败回退脱敏版——env helper 会把掩码视为
    // 缺失，子进程明确报「未配置」而非静默 401。
    let secrets = snapshot
    try {
      secrets = await runtimeConfigBridge?.getSecrets() ?? snapshot
    } catch (error) {
      console.warn('[managed-children] unredacted runtime config unavailable; falling back to redacted snapshot:', error instanceof Error ? error.message : error)
    }
    await syncCursorCompletionEnvironment(secrets)
  })
  managedChildSyncQueue = run.catch(() => undefined)
  return run
}

function registerConnectorHandlers(bridge: ConnectorGatewayBridge): void {
  ipcMain.handle(CONNECTOR_CHANNELS.status, () => bridge.status())
  ipcMain.handle(CONNECTOR_CHANNELS.providers, () => bridge.providers())
  // saas 连接层返回 SaaS 已配置 OAuth 的 provider 名单（新版带 SaaS 图标 URL 明细；
  // 旧连接层无明细方法时回落纯名单），local 模式返回 null（渲染层回落注册表）。
  ipcMain.handle(CONNECTOR_CHANNELS.oauthConfigs, async () => {
    const detailed = await bridge.configuredProvidersDetailed().catch(() => null)
    if (detailed) return detailed
    return bridge.configuredProviders().catch(() => null)
  })
  ipcMain.handle(CONNECTOR_CHANNELS.startAuthorization, (_event, provider) => bridge.startAuthorization(provider))
  ipcMain.handle(CONNECTOR_CHANNELS.authorizationStatus, (_event, id) => bridge.authorizationStatus(id))
  ipcMain.handle(CONNECTOR_CHANNELS.remoteAccount, (_event, provider) => bridge.remoteAccount(provider))
  // 断开：Gateway 写本地墓碑（远端 oo 凭据保留），查询/执行层按墓碑过滤。
  ipcMain.handle(CONNECTOR_CHANNELS.purgeConnection, (_event, id) => bridge.purgeConnection(id))
  // 重新开启：移除墓碑（oo 凭据一直在），连接回到可见/可查询状态。
  ipcMain.handle(CONNECTOR_CHANNELS.reconnectConnection, (_event, id) => bridge.reconnectConnection(id))
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

/** lark-cli 运行时（内置优先 + 应用私有 HOME 隔离），首次使用时解析并缓存。 */
let larkCliRuntime: LarkCliRuntime | null = null
function getLarkCliRuntime(): LarkCliRuntime {
  if (!larkCliRuntime) {
    larkCliRuntime = createLarkCliRuntime({
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
      homeDirectory: join(resolvedDataDirectory, 'lark-cli', 'home'),
    })
    // 内置二进制随应用安装/卸载；系统兜底只在内置缺失时发生（见 runtime 模块）。
    console.info(
      `[lark-cli] ${larkCliRuntime.source}: ${larkCliRuntime.executable}`
      + ` (${larkCliRuntime.version ?? 'version unknown'}); home=${larkCliRuntime.homeDirectory}`,
    )
  }
  return larkCliRuntime
}

/** ntn（Notion 官方 CLI）随包分发，当前仅 macOS 支持 Notion 导出；其余平台返回 null。 */
function resolveNtnCliExecutable(): string | null {
  const configured = process.env.NXCORE_NTN_CLI_PATH?.trim()
  if (configured) return configured
  if (process.platform !== 'darwin') return null
  const packagedCandidates = [
    join(process.resourcesPath, 'ntn', `${process.platform}-${process.arch}`, 'ntn'),
    join(app.getAppPath(), 'build', 'ntn', `${process.platform}-${process.arch}`, 'ntn'),
  ]
  return packagedCandidates.find((candidate) => existsSync(candidate)) ?? null
}

function createOoCliBridge(connection: OpenConnectorConnection): OoCliBridge {
  const root = join(dataDirectory, 'open-connector')
  // 控制台兜底地址：SaaS 模式没有 supervisor，openConsole 用它打开 SaaS 侧控制台。
  connectorConsoleBaseUrl = connection.baseUrl
  return new OoCliBridge({
    executable: resolveOoCliExecutable(),
    baseUrl: connection.baseUrl,
    runtimeToken: connection.runtimeToken,
    ...(connection.adminToken ? { adminToken: connection.adminToken } : {}),
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

// ---- SaaS 连接层（connector-mode = 'saas'）----
// 登录 EverRoom 后从 SaaS 换取 oo 用户会话（SaaS 代发并登记用户 runtime token），
// 桌面与 gateway 均持该 token 直连 oo 数据面；连接层不再经 SaaS 转发。
let connectorOoLoginSeen = false

/** 按 userId 去重换取 oo 会话；成功才缓存，失败返回 null 并由下次账号事件重试。 */
async function fetchConnectorOoSession(userId: string): Promise<ConnectorOoSession | null> {
  if (connectorOoSessionCache?.userId === userId) return connectorOoSessionCache.session
  const session = await saasClient?.connectorOoSession().catch((error: unknown) => {
    console.warn('[connector-mode] obtaining oo session from EverRoomSass failed:', error instanceof Error ? error.message : error)
    return null
  }) ?? null
  connectorOoSessionCache = session ? { userId, session } : null
  return session
}

/**
 * 应用 oo 会话：重建直连 oo 的 bridge；gateway 侧走两条路——
 * 运行中：热推送（PUT/DELETE /v1/connector-session，gateway 原地 patch
 * 连接配置并热重载 agent 工具，不重启进程）；启动期调用时 gateway 未起，
 * env 在首次 spawn 生效（extraEnvironment 每次启动求值）。
 */
async function applyConnectorOoSession(session: ConnectorOoSession | null): Promise<void> {
  ooCliBridge?.shutdown()
  ooCliBridge = session
    ? createOoCliBridge({ baseUrl: session.baseUrl, runtimeToken: session.token, managed: false, pid: null, version: null })
    : null
  if (!session) connectorConsoleBaseUrl = null
  if (ooCliBridge) attachOpenConnectorBridge(ooCliBridge)
  if (!session) connectorOoSessionCache = null
  connectorOoGatewayEnv = session
    ? {
      NXCORE_CLI_CONNECTOR_URL: session.baseUrl,
      NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN: session.token,
      NXCORE_CLI_CONNECTOR_MANAGED: 'false',
    }
    : {}
  const nextJson = JSON.stringify(connectorOoGatewayEnv)
  if (nextJson === connectorOoAppliedEnvJson) return
  connectorOoAppliedEnvJson = nextJson
  const supervisor = gatewaySupervisor
  if (!supervisor?.isRunning()) {
    // 启动期：env 随首次 spawn 生效；连接列表/查询都实时读 oo，无需对账任务。
    return
  }
  // 运行中热推送，不再重启 gateway：重启窗口会把登录瞬间的 refresh-saas
  // 等在途请求报成「正在停止」，已成功的登录被渲染层显示为登录失败。
  try {
    const applied = await connectorGatewayBridge?.applyConnectorSession(
      session ? { baseUrl: session.baseUrl, runtimeToken: session.token } : null,
    )
    console.info(`[connector-mode] oo session applied to gateway (configured=${String(applied?.configured ?? false)})`)
  } catch (error) {
    console.error('[connector-mode] applying oo session to gateway failed:', error)
  }
}

/**
 * 连接注册对账：oo 租户里已有、而 gateway 注册表（连接器列表/scope/同步的
 * 数据源）缺失的连接，补调 register。覆盖两类缺口——重启前完成的授权
 * （pending 表不跨重启）与注册时 gateway 暂不可达的授权。只对注册表认识的
 * provider 补注册（oo 的公共 no_auth 应用不在其中，不产生噪音连接）。
 *
 * 用户主动 purge 过的 provider 有墓碑（远端凭据仍在），对账跳过不复活——
 * 重连由数据源页弹窗显式选择（使用旧账号免授权复活 / 切换其他账号重新授权）。
 */
function openExternalUrl(value: string): void {  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') void shell.openExternal(url.toString())
  } catch {
    // 忽略格式非法或协议不受支持的外部导航（仅放行 http/https）。
  }
}

async function openConnectorManagementConsole(): Promise<void> {
  const connection = openConnectorSupervisor?.getConnection()
  // SaaS 模式不拉本地 supervisor：回退到 oo 会话 bridge 记录的 baseUrl（浏览器
  // 打开 SaaS 侧控制台）；两者皆无（未登录/运行时未起）才视为未就绪。
  const fallbackBaseUrl = connection?.baseUrl ?? connectorConsoleBaseUrl
  if (!fallbackBaseUrl) throw new Error('OpenConnector 尚未就绪（未登录 SaaS 或本地运行时未启动）。')
  if (!connection?.managed || !connection?.adminToken) {
    await shell.openExternal(`${fallbackBaseUrl}/`)
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
    openExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin === origin) return
    event.preventDefault()
    openExternalUrl(url)
  })
  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (openConnectorConsoleWindow === window) openConnectorConsoleWindow = null
  })
  await window.loadURL(`${connection.baseUrl}/`)
}

function registerOpenConnectorHandlers(): void {
  handle(OPEN_CONNECTOR_CHANNELS.mode, async () => activeConnectorModeStore()?.read() ?? { mode: 'saas', switchedAt: null })
  handle(OPEN_CONNECTOR_CHANNELS.setMode, async (_event, mode: unknown) => {
    const store = activeConnectorModeStore()
    if (!store) throw new Error('connector mode store unavailable')
    const next = mode === 'local' ? 'local' as const : mode === 'saas' ? 'saas' as const : null
    if (!next) throw new Error('invalid connector mode')
    return store.write(next)
  })
  handle(OPEN_CONNECTOR_CHANNELS.status, async () => {
    if (ooCliBridge) return ooCliBridge.status()
    const mode = (await activeConnectorModeStore()?.read())?.mode ?? 'saas'
    if (mode === 'saas') {
      // SaaS 连接层尚未拿到 oo 会话（未登录 / SaaS 暂不可达）：
      // 给出可读状态，避免永远停在 'starting' 的假态。
      return {
        baseUrl: connectorOoSessionCache?.session?.baseUrl ?? '',
        managed: false,
        gatewayPid: null,
        gatewayVersion: null,
        gatewayState: 'unreachable' as const,
        gatewayMessage: connectorOoLoginSeen
          ? '云端连接层暂不可用，请稍后重试。'
          : '登录 EverRoom 后将自动连接云端连接层。',
        runtimeTokenConfigured: false,
        cliState: 'checking' as const,
        cliVersion: null,
        cliPath: resolveOoCliExecutable(),
        cliMessage: null,
      }
    }
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
  // 一键发起 provider OAuth：本地模式直调运行时（adminToken）；SaaS 模式由
  // SaaS 代发起（桌面只持 runtime token，admin 面在服务端）。返回授权页并在
  // 系统浏览器打开；完成后由调用方轮询连接状态感知新连接。
  handle(OPEN_CONNECTOR_CHANNELS.startAuthorization, async (_event, service: unknown) => {
    if (typeof service !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(service)) {
      throw new Error('无效的服务标识。')
    }
    let authorizationUrl: string | null = null
    const connection = openConnectorSupervisor?.getConnection()
    if (connection?.managed && connection.adminToken) {
      const response = await fetch(new URL('/api/oauth/authorizations', connection.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.adminToken}` },
        body: JSON.stringify({ service }),
        signal: AbortSignal.timeout(20_000),
      })
      const payload = await response.json().catch(() => null) as {
        authorizationUrl?: unknown
        error?: { code?: unknown } | null
      } | null
      if (!response.ok || typeof payload?.authorizationUrl !== 'string') {
        // 飞书等 provider 走"用户自建应用"模式：先在控制台配 OAuth client 才能发起。
        if (payload?.error?.code === 'oauth_client_config_required') {
          throw new Error(
            `尚未配置 ${service} 的应用凭据（OAuth client）。请在连接器管理中为 ${service} 填入自建应用的 App ID/Secret，`
            + `并把回调地址 ${new URL('/oauth/callback', connection.baseUrl).toString()} 加入该应用的重定向 URL 白名单后重试。`,
          )
        }
        throw new Error(`OpenConnector 授权发起失败（HTTP ${String(response.status)}）。`)
      }
      authorizationUrl = payload.authorizationUrl
    } else {
      const client = saasClient
      if (!client) throw new Error('尚未登录 SaaS，无法发起授权；请先登录或切换本地连接器模式。')
      try {
        authorizationUrl = (await client.startConnectorAuthorization(service)).authorizationUrl
      } catch (error) {
        throw new Error(
          `SaaS 代发起 ${service} 授权失败（${error instanceof Error ? error.message : String(error)}）。`
          + '该平台可能尚未在 SaaS 侧开放；可切换本地连接器模式并使用自建应用凭据。',
        )
      }
    }
    const url = new URL(authorizationUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('授权地址协议不受支持。')
    await shell.openExternal(url.toString())
    return { authorizationUrl: url.toString() }
  })
}

function registerAgentAuthHandlers(): void {
  handle(AGENT_AUTH_CHANNELS.status, () => {
    if (!agentAuthController) {
      const runtime = getLarkCliRuntime()
      return {
        feishu: {
          cliState: 'missing' as const,
          cliPath: runtime.executable,
          cliSource: runtime.source,
          cliVersion: runtime.version,
          appConfigured: null,
          userAuthorized: null,
          userName: null,
          message: '授权控制器尚未就绪。',
        },
        activeChallenge: null,
      }
    }
    return agentAuthController.status()
  })
  handle(AGENT_AUTH_CHANNELS.start, (_event, input: unknown) => {
    if (!agentAuthController) throw new Error('授权控制器尚未就绪。')
    const value = input as AgentAuthStartInput
    if (!value || typeof value !== 'object') throw new Error('无效的授权请求。')
    if (value.provider !== 'feishu' && value.provider !== 'notion') throw new Error('provider 只支持 feishu 或 notion。')
    if (value.phase !== undefined && value.phase !== 'app_setup' && value.phase !== 'user_auth') throw new Error('phase 只支持 app_setup 或 user_auth。')
    return agentAuthController.start({
      provider: value.provider,
      phase: value.phase,
      exportRunId: typeof value.exportRunId === 'string' && value.exportRunId.trim()
        ? value.exportRunId.trim()
        : undefined,
    }) as Promise<DesktopAgentAuthChallenge>
  })
  handle(AGENT_AUTH_CHANNELS.disconnect, (_event, provider: unknown) => {
    if (!agentAuthController) throw new Error('授权控制器尚未就绪。')
    if (provider !== 'feishu') throw new Error('断开目前仅支持飞书。')
    return agentAuthController.disconnect('feishu') as Promise<AgentAuthEnvironmentStatus>
  })
  handle(AGENT_AUTH_CHANNELS.resume, (_event, challengeId: unknown) => {
    if (!agentAuthController) throw new Error('授权控制器尚未就绪。')
    if (typeof challengeId !== 'string' || !challengeId.trim()) throw new Error('无效的授权流程标识。')
    return agentAuthController.resume(challengeId.trim())
  })
  handle(AGENT_AUTH_CHANNELS.cancel, (_event, challengeId: unknown) => {
    if (!agentAuthController) return null
    if (challengeId !== undefined && typeof challengeId !== 'string') throw new Error('无效的授权流程标识。')
    return agentAuthController.cancel(typeof challengeId === 'string' ? challengeId : undefined)
  })
}

function registerExternalDocumentHandlers(bridge: ExternalDocumentsGatewayBridge): void {
  handle(EXTERNAL_DOCUMENT_CHANNELS.importSearch, (_event, provider: unknown, query: unknown) => {
    if (typeof provider !== 'string' || typeof query !== 'string') throw new Error('无效的导入搜索请求。')
    return bridge.importSearch(provider as 'feishu' | 'notion', query)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importList, (_event, provider: unknown, connectionName: unknown, cachedOnly: unknown, mode: unknown) => {
    if (typeof provider !== 'string') throw new Error('无效的文档列举请求。')
    if (connectionName !== undefined && typeof connectionName !== 'string') throw new Error('无效的连接名。')
    if (cachedOnly !== undefined && typeof cachedOnly !== 'boolean') throw new Error('无效的缓存参数。')
    if (mode !== undefined && mode !== 'full' && mode !== 'delta') throw new Error('无效的列举模式。')
    return bridge.importList(provider as 'feishu' | 'notion', connectionName, cachedOnly, mode as 'full' | 'delta' | undefined)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importBatch, (_event, input: unknown) => bridge.importBatch(input as never))
  handle(EXTERNAL_DOCUMENT_CHANNELS.importBatchStatus, (_event, batchId: unknown) => {
    if (typeof batchId !== 'string') throw new Error('无效的批量导入标识。')
    return bridge.importBatchStatus(batchId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.activeImportBatch, (_event, provider: unknown, connectionName: unknown) => {
    if (typeof provider !== 'string') throw new Error('无效的文档来源。')
    if (connectionName !== undefined && typeof connectionName !== 'string') throw new Error('无效的连接名。')
    return bridge.activeImportBatch(provider as 'feishu' | 'notion', connectionName)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.cancelImportBatch, (_event, batchId: unknown) => {
    if (typeof batchId !== 'string') throw new Error('无效的批量导入标识。')
    return bridge.cancelImportBatch(batchId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importPreview, (_event, provider: unknown, remoteDocumentId: unknown) => {
    if (typeof provider !== 'string' || typeof remoteDocumentId !== 'string') throw new Error('无效的导入预览请求。')
    return bridge.importPreview(provider as 'feishu' | 'notion', remoteDocumentId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importCommit, (_event, input: unknown) => bridge.importCommit(input as never))
  handle(EXTERNAL_DOCUMENT_CHANNELS.importRun, (_event, runId: unknown) => {
    if (typeof runId !== 'string') throw new Error('无效的导入任务标识。')
    return bridge.importRun(runId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.cancelImportRun, (_event, runId: unknown) => {
    if (typeof runId !== 'string') throw new Error('无效的导入任务标识。')
    return bridge.cancelImportRun(runId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importHistory, (_event, documentId: unknown) => {
    if (typeof documentId !== 'string') throw new Error('无效的文档标识。')
    return bridge.importHistory(documentId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.checkExternalUpdate, (_event, documentId: unknown) => {
    if (typeof documentId !== 'string') throw new Error('无效的文档标识。')
    return bridge.checkExternalUpdate(documentId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importStructuredDiff, (_event, roomImportId: unknown) => {
    if (typeof roomImportId !== 'string') throw new Error('无效的导入关联标识。')
    return bridge.importStructuredDiff(roomImportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.applyCandidate, (_event, roomImportId: unknown) => {
    if (typeof roomImportId !== 'string') throw new Error('无效的导入关联标识。')
    return bridge.applyCandidate(roomImportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.createExport, (_event, input: unknown) => bridge.createExport(input as never))
  handle(EXTERNAL_DOCUMENT_CHANNELS.getExport, (_event, exportId: unknown) => {
    if (typeof exportId !== 'string') throw new Error('无效的导出任务标识。')
    return bridge.getExport(exportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.confirmExport, (_event, exportId: unknown) => {
    if (typeof exportId !== 'string') throw new Error('无效的导出任务标识。')
    return bridge.confirmExport(exportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.retryExport, (_event, exportId: unknown) => {
    if (typeof exportId !== 'string') throw new Error('无效的导出任务标识。')
    return bridge.retryExport(exportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.cancelExport, (_event, exportId: unknown) => {
    if (typeof exportId !== 'string') throw new Error('无效的导出任务标识。')
    return bridge.cancelExport(exportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.importDiff, (_event, roomImportId: unknown) => {
    if (typeof roomImportId !== 'string') throw new Error('无效的导入关联标识。')
    return bridge.importDiff(roomImportId)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.searchExportTargets, (_event, provider: unknown, query: unknown) => {
    if (typeof provider !== 'string' || typeof query !== 'string') throw new Error('无效的目标搜索请求。')
    return bridge.searchExportTargets(provider as 'feishu' | 'notion', query)
  })
  handle(EXTERNAL_DOCUMENT_CHANNELS.listExports, (_event, documentId: unknown) => {
    if (documentId !== undefined && typeof documentId !== 'string') throw new Error('无效的文档标识。')
    return bridge.listExports(typeof documentId === 'string' ? documentId : undefined)
  })
}

function registerSubagentHandlers(bridge: SubagentGatewayBridge): void {
  handle(SUBAGENT_CHANNELS.dispatchSelectionRewrite, (_event, input: SubagentSelectionRewriteInput) =>
    bridge.dispatchSelectionRewrite(input))
  handle(SUBAGENT_CHANNELS.getInvocation, (_event, invocationId: string) =>
    bridge.getSubagentInvocation(invocationId))
  handle(SUBAGENT_CHANNELS.cancelInvocation, (_event, invocationId: string) =>
    bridge.cancelSubagentInvocation(invocationId))
  handle(SUBAGENT_CHANNELS.listRunInvocations, (_event, rootRunId: string) =>
    bridge.listRunSubagentInvocations(rootRunId))
  handle(SUBAGENT_CHANNELS.listInvocationEvents, (_event, invocationId: string, afterSeq = 0) =>
    bridge.listSubagentInvocationEvents(invocationId, afterSeq))
}

function registerMigrationHandlers(coordinator: MigrationCoordinator): void {
  handle(MIGRATION_CHANNELS.discover, () => coordinator.discover())
  handle(MIGRATION_CHANNELS.chooseOpenClaw, () => coordinator.chooseOpenClaw())
  handle(MIGRATION_CHANNELS.importOpenClaw, (_event, id?: string) => coordinator.importOpenClaw(id))
  handle(MIGRATION_CHANNELS.localAgentSources, (_event, provider: 'codex' | 'claude') => coordinator.localAgentSources(provider))
  handle(MIGRATION_CHANNELS.chooseLocalAgentDirectory, (_event, provider: 'codex' | 'claude') => coordinator.chooseLocalAgentDirectory(provider))
  handle(MIGRATION_CHANNELS.importLocalAgentMigration, (_event, provider: 'codex' | 'claude', id?: string) => coordinator.importLocalAgentMigration(provider, id))
  handle(MIGRATION_CHANNELS.importNotionZip, () => coordinator.importNotionZip())
  handle(MIGRATION_CHANNELS.importCherry, (_event, id?: string) => coordinator.importCherry(id))
  handle(MIGRATION_CHANNELS.setCherrySync, (_event, sourceId: string, active: boolean) => coordinator.setCherrySync(sourceId, active))
  handle(MIGRATION_CHANNELS.exportCherry, (_event, sourceId: string) => coordinator.exportCherryConversations(sourceId))
  handle(MIGRATION_CHANNELS.sources, () => coordinator.sources())
  handle(MIGRATION_CHANNELS.runs, (_event, sourceId?: string) => coordinator.runs(sourceId))
  handle(MIGRATION_CHANNELS.cancel, (_event, runId: string) => coordinator.cancel(runId))
  handle(MIGRATION_CHANNELS.retry, (_event, runId: string) => coordinator.retry(runId))
  handle(MIGRATION_CHANNELS.reimport, (_event, sourceId: string) => coordinator.reimport(sourceId))
  handle(MIGRATION_CHANNELS.clear, (_event, sourceId: string) => coordinator.clear(sourceId))
  handle(MIGRATION_CHANNELS.conversations, (_event, input) => new MigrationsGatewayBridge(gatewaySupervisor!).conversations(input))
  handle(MIGRATION_CHANNELS.preview, (_event, id: string) => new MigrationsGatewayBridge(gatewaySupervisor!).preview(id))
  coordinator.onProgress((progress) => BrowserWindow.getAllWindows().forEach((window) => window.webContents.send(MIGRATION_CHANNELS.progress, progress)))
}

function registerAgentHandlers(bridge: AgentGatewayBridge, migrationCoordinator: MigrationCoordinator): void {
  const localAgentDiscovery = createLocalAgentDiscovery({ adaptersRoot: localAgentAdaptersRoot(), bundledRoot: bundledAcpAdaptersRoot() })
  let localAgents: LocalAgentInstallation[] = []
  // 派发 target 的适配器 spawn 覆盖缓存（登录 shell PATH 探测较慢，命中后复用；
  // 安装/复检/重扫后失效）。
  const adapterSpawnCache = new Map<string, LocalAcpAdapterSpawn | null>()
  const invalidateAdapterSpawnCache = () => adapterSpawnCache.clear()
  const workspaceBindings = new Map<string, LocalAgentWorkspaceBinding>()
  const workspaceBindingStore = new LocalAgentWorkspaceBindingStore(
    join(app.getPath('userData'), 'local-agent-workspaces.json'),
    join(app.getPath('userData'), 'backups'),
  )
  const unboundSessionRoot = (sessionId: string) => join(
    app.getPath('userData'),
    'local-agent-sandboxes',
    createHash('sha256').update(sessionId).digest('hex'),
  )
  const unboundWorkspaceRoot = (agentId: string, sessionId: string) => {
    const agentKey = createHash('sha256').update(agentId).digest('hex')
    return join(unboundSessionRoot(sessionId), agentKey)
  }
  const scanLocalAgents = async () => {
    localAgents = await localAgentDiscovery.scan()
    invalidateAdapterSpawnCache()
    return localAgents
  }
  // id 形如 `provider:/path`。CLI 路径会漂移（版本管理器换版本、旧会话缓存的
  // multishell 路径等），精确 id 未命中时按 provider 兜底，避免 @ 引用失效。
  const findLocalAgent = (id: string) =>
    localAgents.find((agent) => agent.id === id)
    ?? localAgents.find((agent) => id.startsWith(`${agent.provider}:`))
  handle(AGENT_CHANNELS.discoverLocalAgents, scanLocalAgents)
  handle(AGENT_CHANNELS.checkLocalAgentAdapters, async (_event, agentIds: string[]) => {
    const wanted = [...new Set((agentIds ?? []).filter((id) => typeof id === 'string' && id))]
    if (!wanted.length) return []
    if (wanted.some((id) => !findLocalAgent(id))) {
      await scanLocalAgents()
    }
    invalidateAdapterSpawnCache()
    const targets = wanted
      .map((id) => findLocalAgent(id))
      .filter((agent): agent is LocalAgentInstallation => Boolean(agent?.invocationSupported))
    return Promise.all(targets.map(async (agent) => ({
      agentId: agent.id,
      provider: agent.provider,
      displayName: agent.displayName,
      adapter: await probeLocalAgentAcpAdapter(agent, { adaptersRoot: localAgentAdaptersRoot(), bundledRoot: bundledAcpAdaptersRoot() }),
    })))
  })
  handle(AGENT_CHANNELS.installLocalAgentAdapter, async (_event, agentId: string) => {
    const id = typeof agentId === 'string' ? agentId : ''
    let installation = findLocalAgent(id)
    if (!installation) {
      await scanLocalAgents()
      installation = findLocalAgent(id)
    }
    if (!installation?.invocationSupported) {
      throw new Error('选择的本机 Agent 当前不可调用。')
    }
    const result = await installLocalAgentAcpAdapter(installation, {
      adaptersRoot: localAgentAdaptersRoot(),
      bundledRoot: bundledAcpAdaptersRoot(),
      npmCliPath: bundledNpmCliPath(),
      proxyEnv: await detectSystemProxyEnvironment(),
    })
    invalidateAdapterSpawnCache()
    return result
  })
  handle(AGENT_CHANNELS.bindLocalAgentWorkspace, async (event, agentId: string, sessionId: string) => {
    if (!findLocalAgent(agentId)?.invocationSupported) {
      await scanLocalAgents()
    }
    if (!findLocalAgent(agentId)?.invocationSupported) {
      throw new Error('选择的本机 Agent 当前不可调用。')
    }
    let existing = [...workspaceBindings.values()].find((binding) => (
      binding.agentId === agentId && binding.sessionId === sessionId
    ))
    if (!existing) {
      const stored = await workspaceBindingStore.find(agentId, sessionId)
      if (stored) {
        existing = { ...stored, token: randomUUID() }
        workspaceBindings.set(existing.token, existing)
      }
    }
    if (existing) return existing
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择 Agent 工作区',
      buttonLabel: '授权并使用此目录',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    const rootPath = result.filePaths[0]
    if (result.canceled || !rootPath) return null
    const stored = await workspaceBindingStore.save({
      agentId,
      sessionId,
      rootPath,
      permissionProfile: 'workspace_write',
    })
    const binding: LocalAgentWorkspaceBinding = {
      ...stored,
      token: randomUUID(),
    }
    workspaceBindings.set(binding.token, binding)
    return binding
  })
  handle(AGENT_CHANNELS.importLocalAgentHistory, async (_event, agentId: string) => {
    let installation = localAgents.find((agent) => agent.id === agentId)
    if (!installation) {
      await scanLocalAgents()
      installation = localAgents.find((agent) => agent.id === agentId)
    }
    if (!installation?.historyAvailable) throw new Error('未找到该本机 Agent 的聊天记录。')
    return migrationCoordinator.importLocalAgentHistory(installation)
  })
  handle(AGENT_CHANNELS.getStatus, () => bridge.getStatus())
  handle(AGENT_CHANNELS.getUsage, (_event, range) => bridge.getUsage(range))
  handle(AGENT_CHANNELS.workspaceList, () => bridge.listWorkspaces())
  handle(AGENT_CHANNELS.workspaceCreate, (_event, input: CreateAgentWorkspaceInput) =>
    bridge.createWorkspace(input))
  handle(AGENT_CHANNELS.workspaceUpdate, (_event, workspaceId: string, input: UpdateAgentWorkspaceInput) =>
    bridge.updateWorkspace(workspaceId, input))
  handle(AGENT_CHANNELS.workspaceRemove, (_event, workspaceId: string) =>
    bridge.deleteWorkspace(workspaceId))
  handle(AGENT_CHANNELS.workspacePickDirectory, async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择工作区目录',
      buttonLabel: '使用此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })
  handle(AGENT_CHANNELS.listSessions, (_event, pageLabel, roomId) => bridge.listSessions(pageLabel, roomId))
  handle(AGENT_CHANNELS.createSession, (_event, input) => bridge.createSession(input))
  handle(AGENT_CHANNELS.createSessionLink, (_event, input) => bridge.createSessionLink(input))
  handle(AGENT_CHANNELS.listSessionLinks, (_event, sessionId) => bridge.listSessionLinks(sessionId))
  handle(AGENT_CHANNELS.markSessionLinkReturned, (_event, linkId) => bridge.markSessionLinkReturned(linkId))
  handle(AGENT_CHANNELS.updateSession, (_event, sessionId, input) => bridge.updateSession(sessionId, input))
  handle(AGENT_CHANNELS.generateSessionTitle, (_event, input) => bridge.generateSessionTitle(input))
  handle(AGENT_CHANNELS.suggestConversationPrompt, (_event, input) => bridge.suggestConversationPrompt(input))
  handle(AGENT_CHANNELS.suggestStarterPrompts, (_event, input) => bridge.suggestStarterPrompts(input))
  handle(AGENT_CHANNELS.deleteSession, async (_event, sessionId) => {
    await bridge.deleteSession(sessionId)
    await workspaceBindingStore.removeSession(sessionId)
    await rm(unboundSessionRoot(sessionId), { recursive: true, force: true })
    for (const [token, binding] of workspaceBindings) {
      if (binding.sessionId === sessionId) workspaceBindings.delete(token)
    }
  })
  handle(AGENT_CHANNELS.getSession, (_event, sessionId) => bridge.getSession(sessionId))
  handle(AGENT_CHANNELS.getEvents, (_event, sessionId, runId, afterSeq) =>
    bridge.getEvents(sessionId, runId, afterSeq))
  handle(AGENT_CHANNELS.getLocalAgentDispatch, (_event, sessionId, taskId) =>
    bridge.getLocalAgentDispatch(sessionId, taskId))
  handle(AGENT_CHANNELS.startRun, async (_event, sessionId, input) => {
    const request = input as StartAgentRunInput
    // 本机 Agent 的 invocation target 一律由 main 进程从本机发现结果重建
    // （渲染端传入的 localAgent 被丢弃），workspace 授权与沙箱兜底逻辑两路共用。
    const resolveLocalAgentTarget = async (
      targetSessionId: string,
      agentId: string,
      workspaceBindingToken?: string,
    ): Promise<LocalAgentInvocationTarget> => {
      let installation = findLocalAgent(agentId)
      if (!installation) {
        await scanLocalAgents()
        installation = findLocalAgent(agentId)
      }
      if (!installation?.callable || !installation.invocationSupported || !installation.executablePath) {
        throw new Error('选择的本机 Agent 当前不可调用。请重新扫描或检查安装。')
      }
      if (!isSafeLocalAgentPath(installation.executablePath)) {
        throw new Error('本机 Agent 的可执行文件路径无效。')
      }
      const binding = workspaceBindingToken
        ? workspaceBindings.get(workspaceBindingToken)
        : null
      if (workspaceBindingToken
        && (!binding || binding.agentId !== installation.id || binding.sessionId !== targetSessionId)) {
        throw new Error('Agent 工作区授权已失效，请重新选择。')
      }
      const storedBinding = binding ?? await workspaceBindingStore.find(installation.id, targetSessionId)
      const validatedBinding = storedBinding
        ? await workspaceBindingStore.validate(storedBinding)
        : null
      const workingDirectory = validatedBinding?.rootPath
        ?? unboundWorkspaceRoot(installation.id, targetSessionId)
      await mkdir(workingDirectory, { recursive: true })
      // gateway 继承 GUI 瘦 PATH，bare bin 名常常解析不到——把桌面端（登录 shell
      // 合并 PATH + 私有安装/内置目录）解析出的绝对路径 spawn 覆盖随 target 下发。
      if (!adapterSpawnCache.has(installation.provider)) {
        adapterSpawnCache.set(
          installation.provider,
          await resolveLocalAcpAdapterSpawn(installation, { adaptersRoot: localAgentAdaptersRoot(), bundledRoot: bundledAcpAdaptersRoot() })
            .catch(() => null),
        )
      }
      return {
        id: installation.id,
        provider: installation.provider,
        displayName: installation.displayName,
        executablePath: installation.executablePath,
        workingDirectory,
        permissionProfile: validatedBinding?.permissionProfile ?? 'inspect',
        card: installation.card,
        acpAdapter: adapterSpawnCache.get(installation.provider) ?? null,
      }
    }
    const referencedLocalAgentIds = request.context?.referencedLocalAgentIds ?? []
    if (!request.targetAgentId || request.targetAgentId === 'main') {
      const { localAgent: _discarded, ...safeRequest } = request
      return bridge.startRun(sessionId, {
        ...safeRequest,
        ...(request.targetAgentId === 'main' ? { targetAgentId: 'main' } : {}),
        ...(referencedLocalAgentIds.length
          ? {
              referencedLocalAgents: await Promise.all(referencedLocalAgentIds.map((agentId) =>
                resolveLocalAgentTarget(sessionId, agentId, request.workspaceBindingToken))),
            }
          : {}),
      })
    }
    return bridge.startRun(sessionId, {
      ...request,
      localAgent: await resolveLocalAgentTarget(sessionId, request.targetAgentId, request.workspaceBindingToken),
    })
  })
  handle(AGENT_CHANNELS.submitPendingIntent, (_event, intentId, input) =>
    bridge.submitPendingIntent(intentId, input))
  handle(AGENT_CHANNELS.cancelRun, (_event, runId) => bridge.cancelRun(runId))
  handle(AGENT_CHANNELS.resolveApproval, (_event, approvalId, decision, feedback) =>
    bridge.resolveApproval(approvalId, decision, feedback))
  handle(AGENT_CHANNELS.getPermissionMode, (_event, sessionId) => bridge.getPermissionMode(sessionId))
  handle(AGENT_CHANNELS.setPermissionMode, (_event, sessionId, mode) => bridge.setPermissionMode(sessionId, mode))
  handle(AGENT_CHANNELS.setThinkingLevel, (_event, sessionId, level) =>
    bridge.setThinkingLevel(sessionId, level))
  handle(AGENT_CHANNELS.subscribe, (event, sessionId) => bridge.subscribe(event.sender, sessionId))
  handle(AGENT_CHANNELS.unsubscribe, (event) => bridge.unsubscribe(event.sender.id))
}

function registerCursorCompletionAgentHandlers(bridge: AgentGatewayBridge): void {
  // 预期失败（409 session_busy、网络瞬断等）以哨兵 payload 返回而非 reject：
  // 渲染端会分类重试，每次 reject 都会被 Electron 记成一条 ERROR 级 console 噪音。
  const quiet = <Args extends unknown[]>(
    handler: (event: Electron.IpcMainInvokeEvent, ...args: Args) => unknown,
  ) => async (event: Electron.IpcMainInvokeEvent, ...args: Args) => {
    try {
      return await handler(event, ...args)
    } catch (error) {
      return {
        [CURSOR_COMPLETION_AGENT_ERROR_KEY]: error instanceof Error ? error.message : String(error),
      }
    }
  }
  handleGroup(CURSOR_COMPLETION_AGENT_CHANNELS, {
    createSession: quiet((_event, input) => bridge.createSession(input)),
    deleteSession: quiet((_event, sessionId) => bridge.deleteSession(sessionId)),
    getEvents: quiet((_event, sessionId, runId, afterSeq) =>
      bridge.getEvents(sessionId, runId, afterSeq)),
    startRun: quiet((_event, sessionId, input) => bridge.startRun(sessionId, input)),
    cancelRun: quiet((_event, runId) => bridge.cancelRun(runId)),
    subscribe: quiet((event, sessionId) => bridge.subscribe(event.sender, sessionId)),
    unsubscribe: quiet((event) => bridge.unsubscribe(event.sender.id)),
  })
}

function registerDocumentHandlers(
  bridge: DocumentGatewayBridge,
  assets: DocumentAssetStore,
  vaults?: ObsidianVaultService | null,
): void {
  // 挂载目录笔记的写回依赖（见 vault-document-sync）：序列化走网关、回滚走投影 PUT。
  const vaultSyncDeps = vaults ? {
    vaults,
    documentMarkdown: (documentId: string) => bridge.documentMarkdown(documentId),
    revertDocumentToDisk: async (input: {
      documentId: string
      vaultId: string
      resourceId: string
      relativePath: string
      sourceHash: string
      title: string
      markdown: string
    }) => {
      const vault = vaults.list().find((item) => item.id === input.vaultId)
      if (!vault) throw new Error(`Vault room not found for ${input.vaultId}`)
      await bridge.syncExternalProjection({
        sourceKind: vault.sourceType,
        sourceId: input.vaultId,
        resourceId: input.resourceId,
        roomId: vault.roomId,
        relativePath: input.relativePath,
        sourceHash: input.sourceHash,
        title: input.title,
        markdown: input.markdown,
      })
    },
  } : null
  handleGroup(DOCUMENT_CHANNELS, {
    list: (_event, roomId) => bridge.list(roomId),
    listTrash: (_event, roomId) => bridge.listTrash(roomId),
    get: (_event, documentId) => bridge.get(documentId),
    listBlocks: (_event, documentId) => bridge.listBlocks(documentId),
    listBlockBacklinks: (_event, documentId, blockId) =>
      bridge.listBlockBacklinks(documentId, blockId),
    listVersions: (_event, documentId, options) => bridge.listVersions(documentId, options),
    getVersionSnapshot: (_event, documentId, version) => bridge.getVersionSnapshot(documentId, version),
    getDiff: (_event, documentId, fromVersion, toVersion) => bridge.getDiff(documentId, fromVersion, toVersion),
    versionChangeSummary: (_event, documentId, version) => bridge.versionChangeSummary(documentId, version),
    listDocumentComments: (_event, documentId) => bridge.listDocumentComments(documentId),
    createDocumentComment: (_event, documentId, input) => bridge.createDocumentComment(documentId, input),
    resolveDocumentComment: (_event, documentId, commentId, resolved) => bridge.resolveDocumentComment(documentId, commentId, resolved),
    deleteDocumentComment: (_event, documentId, commentId) => bridge.deleteDocumentComment(documentId, commentId),
    getOverview: (_event, documentId) => bridge.getDocumentOverview(documentId),
    generateOverview: (_event, documentId) => bridge.generateDocumentOverview(documentId),
    getSectionPreview: (_event, documentId, input) => bridge.getSectionPreview(documentId, input),
    restoreVersion: (_event, documentId, version, baseVersion) =>
      bridge.restoreVersion(documentId, version, baseVersion),
    resolveBlockReferences: (_event, input) => bridge.resolveBlockReferences(input),
    listOperations: (_event, filters) => bridge.listOperations(filters),
    startOperation: (_event, input: StartDocumentOperationInput) => {
      assertNoEmbeddedDocumentImages(input)
      return bridge.startOperation(input)
    },
    getOperation: (_event, operationId, context) => bridge.getOperation(operationId, context),
    executeOperationCommand: async (_event, operationId: string, input: DocumentOperationCommandInput) => {
      if (!vaults || (input.type !== 'review.apply' && input.type !== 'item.accept')) {
        return bridge.executeOperationCommand(operationId, input)
      }
      const operation = await bridge.getOperation(operationId, input.context)
      const note = operation.documentId ? vaults.noteForDocument(operation.documentId) : null
      if (!note || !input.context) return bridge.executeOperationCommand(operationId, input)
      const prepared = await bridge.prepareExternalPatch({ operationId, command: input })
      const current = await vaults.readNote(note.vaultId, note.resourceId)
      let resultingSourceHash = current.sourceHash
      if (current.sourceHash === prepared.expectedSourceHash) {
        const saved = await vaults.saveNoteForAgent(
          note.vaultId,
          note.resourceId,
          prepared.markdown,
          prepared.expectedSourceHash,
        )
        if (saved.status === 'conflict') {
          throw new Error('VAULT_SOURCE_CONFLICT: Obsidian 已修改该笔记，请比较磁盘版本后重新审阅。')
        }
        resultingSourceHash = saved.snapshot.sourceHash
      } else if (current.markdown !== prepared.markdown) {
        throw new Error('VAULT_SOURCE_CONFLICT: Obsidian 已修改该笔记，请比较磁盘版本后重新审阅。')
      }
      const completed = await bridge.completeExternalPatch({
        preparationId: prepared.preparationId,
        resultingSourceHash,
        context: input.context,
      })
      vaults.notifyChanged(note.vaultId)
      return completed
    },
    storeImage: (_event, documentId, input) => assets.storeImage(documentId, input),
    import: (_event, input: ImportRoomDocumentInput) => {
      assertNoEmbeddedDocumentImages(input?.contentJson)
      return bridge.import(input)
    },
    save: async (_event, documentId, input: SaveRoomDocumentInput) => {
      assertNoEmbeddedDocumentImages(input?.contentJson)
      // 挂载目录的笔记：网关保存成功后写回原文件（文件是事实源）。
      // vault 未绑定/离线时跳过写回；文件被外部改过则回滚文档并报冲突（编辑器保留草稿）。
      if (vaultSyncDeps && vaultSyncDeps.vaults.noteForDocument(documentId)) {
        const previous = await bridge.get(documentId).catch(() => null)
        const updated = await bridge.save(documentId, input)
        await pushDocumentSaveToVault(vaultSyncDeps, {
          documentId,
          previousTitle: previous?.title,
          nextTitle: updated.title,
        })
        return updated
      }
      return bridge.save(documentId, input)
    },
    delete: async (_event, documentId) => {
      const deleted = await bridge.delete(documentId)
      if (vaultSyncDeps) await trashDocumentInVault(vaultSyncDeps, documentId)
      return deleted
    },
    move: (_event, documentId, fromRoomId, roomId) => bridge.move(documentId, fromRoomId, roomId),
    moveMany: (_event, documentIds, fromRoomId, roomId) => bridge.moveMany(documentIds, fromRoomId, roomId),
    restore: (_event, documentId) => bridge.restore(documentId),
    deletePermanently: async (_event, documentId) => {
      if (vaultSyncDeps) await trashDocumentInVault(vaultSyncDeps, documentId)
      await bridge.deletePermanently(documentId)
      await assets.deleteDocument(documentId).catch((error) => {
        console.error('Failed to delete local document assets', { documentId, error })
      })
    },
    emptyTrash: async (_event, roomId: string | null | undefined) => {
      const trashed = await bridge.listTrash(roomId)
      await bridge.emptyTrash(roomId)
      await Promise.all(trashed.map((document) => assets.deleteDocument(document.id).catch((error) => {
        console.error('Failed to delete local document assets', { documentId: document.id, error })
      })))
    },
    subscribe: (event, roomId: string | null | undefined) => bridge.subscribe(event.sender, roomId),
    unsubscribe: (event, roomId: string | null | undefined) => bridge.unsubscribe(event.sender.id, roomId ?? undefined),
  })
}

function registerMcpHandlers(bridge: McpGatewayBridge): void {
  handle(MCP_CHANNELS.listServers, () => bridge.list())
  handle(MCP_CHANNELS.saveServers, (_event, servers: McpServersMutation) => bridge.save(servers))
}

function registerExternalCallHandlers(bridge: ExternalCallsGatewayBridge): void {
  handle(EXTERNAL_CALL_CHANNELS.listPolicies, (_event, query?: ExternalCallQuery) => bridge.listPolicies(query))
  handle(EXTERNAL_CALL_CHANNELS.savePolicy, (_event, input: ExternalCallPolicyInput) => bridge.savePolicy(input))
  handle(EXTERNAL_CALL_CHANNELS.deletePolicy, (_event, id: string) => bridge.deletePolicy(id))
  handle(EXTERNAL_CALL_CHANNELS.listUsage, (_event, query?: ExternalCallQuery) => bridge.listUsage(query))
  handle(EXTERNAL_CALL_CHANNELS.listAudits, (_event, query?: ExternalCallQuery) => bridge.listAudits(query))
}

/** 本体字节的 sha256（流式；与网关 fileBlobs.contentHash 同算法），预览实例的内容指纹。 */
async function hashFileBytes(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** 磁盘选择模版直传（zip/docx/doc/pdf；zip 不进文件库）。用户取消返回 canceled:true。 */
/**
 * 上一次选择但**尚未解析**的模版（同名冲突时暂存，等用户点「替换原文件」）。
 * 只按工作区记一份：同一时刻用户不可能在同一空间同时上传两份模版。
 */
const pendingTemplatePick = new Map<string, string>()

/**
 * 拖拽直传的模版字节缓存：这类卡片没有资料区文件条目，预览时先落到临时文件
 * 再导入资料区（按内容去重，重复预览不会产生重复文件）后打开真预览。
 */
const uploadedTemplateBytes = new Map<string, { name: string; bytes: Uint8Array }>()

/** files 桥的模块级引用（模版导入资料区要用；bridge 初始化时赋值）。 */
let filesGatewayBridgeRef: {
  importPathsOnce: (
    paths: string[],
    options?: { roomId?: string; workspaceId?: string },
  ) => Promise<Array<{ fileId: string | null }>>
  list?: (
    limit?: number,
    offset?: number,
    options?: { workspaceId?: string },
  ) => Promise<{ items: unknown[]; total: number }>
} | null = null

async function pickThesisTemplateFromDisk(
  workspaceId: string,
  options?: { wordOnly?: boolean; overwrite?: boolean },
): Promise<{
  canceled: boolean
  cardId: string
  sourceName: string
  factGaps?: string[]
  /** true = 同名模版已存在，尚未解析；UI 弹「替换 / 取消」二选一。 */
  duplicate?: boolean
}> {
  const thesisBridgeForPick = thesisFormatBridgeRef
  if (!thesisBridgeForPick) return { canceled: true, cardId: '', sourceName: '', factGaps: [] }

  // 「替换原文件」：直接解析上次暂存的那份，不再弹选择框
  if (options?.overwrite) {
    const pending = pendingTemplatePick.get(workspaceId)
    if (!pending) return { canceled: true, cardId: '', sourceName: '', factGaps: [] }
    pendingTemplatePick.delete(workspaceId)
    const fileEntryId = await importTemplateFileIntoLibrary(workspaceId, pending)
    return { canceled: false, ...await thesisBridgeForPick.parseFromDisk(workspaceId, pending, fileEntryId) }
  }

  const picked = await dialog.showOpenDialog({
    title: options?.wordOnly ? '选择论文模版（Word）' : '选择论文格式模版',
    properties: ['openFile'],
    // 产物区「排版工具」只收 Word：管理员模版也多是 .docx，给更窄的选择面降低误选。
    filters: options?.wordOnly
      ? [{ name: 'Word 文档', extensions: ['docx'] }]
      : [{ name: '论文格式模版', extensions: ['zip', 'docx', 'doc', 'dotx', 'pdf'] }],
  })
  const filePath = picked.filePaths[0]
  if (!filePath) return { canceled: true, cardId: '', sourceName: '', factGaps: [] }

  // 重名校验：同名模版已存在就先问用户，别直接覆盖（解析要几分钟，覆盖了没法撤回）
  const sourceName = basename(filePath)
  const cards = await thesisBridgeForPick.listCards(workspaceId).catch(() => [])
  const clash = cards.find((card) => card.sourceName.trim().toLowerCase() === sourceName.trim().toLowerCase())
  if (clash) {
    pendingTemplatePick.set(workspaceId, filePath)
    return { canceled: false, cardId: clash.id, sourceName, duplicate: true }
  }
  // 先导入资料区（按内容去重）：卡片因此持有真实文件条目 —— 预览能打开原文件、
  // 删除能级联清文件、日后也能「从资料区重新解析」。
  const fileEntryId = await importTemplateFileIntoLibrary(workspaceId, filePath)
  return { canceled: false, ...await thesisBridgeForPick.parseFromDisk(workspaceId, filePath, fileEntryId) }
}

/**
 * 把模版文件导入资料区并返回文件条目 id（失败返回 null，不阻断解析）。
 * 导入走既有 ingest 管道（内容哈希去重）：同一个模版重复导入不会产生第二份文件。
 */
/**
 * 按文件名在资料区找文件（老卡片自愈用）：仅在唯一同名时采用，避免张冠李戴。
 */
async function findLibraryFileByName(
  name: string | undefined,
  workspaceId: string,
): Promise<string | null> {
  if (!name) return null
  try {
    const catalog = await filesGatewayBridgeRef?.list?.(200, 0, { workspaceId })
    const items = (catalog?.items ?? []) as Array<{ id?: string; originalName?: string }>
    const hits = items.filter((item) => item.originalName === name && item.id)
    return hits.length === 1 ? (hits[0]!.id as string) : null
  } catch {
    return null
  }
}

async function importTemplateBytesIntoLibrary(
  workspaceId: string,
  name: string,
  bytes: Uint8Array,
): Promise<string | null> {
  try {
    const tempDir = join(app.getPath('temp'), 'everroom-thesis-import')
    await mkdir(tempDir, { recursive: true })
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_') || '模版.docx'
    const tempPath = join(tempDir, `${Date.now()}-${safeName}`)
    await writeFile(tempPath, bytes)
    return await importTemplateFileIntoLibrary(workspaceId, tempPath)
  } catch (error) {
    console.warn('模版字节导入资料区失败（不影响解析）:', error instanceof Error ? error.message : String(error))
    return null
  }
}

async function importTemplateFileIntoLibrary(workspaceId: string, filePath: string): Promise<string | null> {
  try {
    const imported = await filesGatewayBridgeRef?.importPathsOnce([filePath], { workspaceId })
    return imported?.map((entry) => entry.fileId).find((id): id is string => Boolean(id)) ?? null
  } catch (error) {
    console.warn('模版导入资料区失败（不影响解析）:', error instanceof Error ? error.message : String(error))
    return null
  }
}

function registerThesisFormatHandlers(
  bridge: ThesisFormatGatewayBridge,
  registry: OfficePreviewRegistry,
  files: FilesGatewayBridge,
): void {
  const cardChanged = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(THESIS_FORMAT_CHANNELS.cardChanged)
    }
    registry.notifyThesisCardsChanged()
  }
  handle(THESIS_FORMAT_CHANNELS.listCards, (_event, workspaceId: string) => bridge.listCards(workspaceId))
  handle(THESIS_FORMAT_CHANNELS.parseFromLibrary, async (_event, workspaceId: string, fileEntryId: string) => {
    const meta = await bridge.parseFromLibrary(workspaceId, fileEntryId)
    cardChanged()
    return meta
  })
  handle(THESIS_FORMAT_CHANNELS.pickAndParse, async (
    _event,
    workspaceId: string,
    options?: { wordOnly?: boolean; overwrite?: boolean },
  ) => {
    const meta = await pickThesisTemplateFromDisk(workspaceId, options)
    if (!meta.canceled) cardChanged()
    return meta
  })
  handle(THESIS_FORMAT_CHANNELS.removeCard, async (_event, workspaceId: string, cardId: string) => {
    await bridge.removeCard(workspaceId, cardId)
    cardChanged()
  })
  /**
   * 彻底删除一份模版：**先删模版文件再删格式卡**。
   * 「只删卡」会把模版文件留在资料区，用户看到的就是"删了还残留"。
   * 文件删除走 /v1/files/:id（硬删 + 级联清理），失败不阻断删卡。
   * 模版文件导入当前文档所属工作区：卡片与文件始终同空间，跨空间互不可见。
   */
  handle(THESIS_FORMAT_CHANNELS.parseUpload, async (_event, workspaceId: string, name: string, bytes: ArrayBuffer) => {
    const data = new Uint8Array(bytes)
    // 先落盘导入资料区（内容去重）→ 卡片关联真实文件，预览/删除级联才成立
    const fileEntryId = await importTemplateBytesIntoLibrary(workspaceId, name, data)
    const meta = await bridge.parseFromBytes(workspaceId, name, data, fileEntryId)
    if (meta.cardId) {
      uploadedTemplateBytes.set(meta.cardId, { name, bytes: data })
      if (uploadedTemplateBytes.size > 8) {
        const oldest = uploadedTemplateBytes.keys().next().value
        if (oldest) uploadedTemplateBytes.delete(oldest)
      }
    }
    cardChanged()
    return meta
  })
  handle(THESIS_FORMAT_CHANNELS.deleteTemplate, async (_event, workspaceId: string, cardId: string) => {
    const cards = await bridge.listCards(workspaceId)
    const card = cards.find((entry) => entry.id === cardId)
    let fileDeleted = false
    if (card?.sourceFileEntryId) {
      try {
        const result = await files.delete(card.sourceFileEntryId)
        fileDeleted = result.deleted
      } catch (error) {
        // 文件可能早已被删：记日志继续删卡，接口照常返回
        console.warn('[thesis] 删除模版文件失败（继续删卡）：', error instanceof Error ? error.message : String(error))
      }
    }
    await bridge.removeCard(workspaceId, cardId)
    cardChanged()
    return { fileDeleted, hadFile: Boolean(card?.sourceFileEntryId) }
  })
  handle(THESIS_FORMAT_CHANNELS.reformatStart, async (
    _event,
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: Parameters<typeof bridge.reformat>[3],
  ) => {
    // 提交失败（卡片已删、跨空间、网关 4xx/超时）必须留痕：面板只会显示一行
    // 翻译后的提示，事后无法从记录里判断卡在哪一段。
    const startedAt = Date.now()
    console.info('[thesis] 提交排版作业', { workspaceId, fileEntryId, cardId: cardId ?? null })
    try {
      return await bridge.startReformatJob(workspaceId, fileEntryId, cardId, options)
    } catch (error) {
      console.warn('[thesis] 排版作业提交失败', {
        workspaceId, fileEntryId, cardId: cardId ?? null,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })
  handle(THESIS_FORMAT_CHANNELS.reformatStatus, (_event, jobId: string) => bridge.reformatJobStatus(jobId))
  /** 导出 PDF：LibreOffice 转换 → ~/Downloads/EverRoom/，并定位到文件。 */
  handle(THESIS_FORMAT_CHANNELS.exportPdf, async (_event, fileEntryId: string) => {
    const storagePath = await files.storagePath(fileEntryId)
    const entry = await files.catalogEntry(fileEntryId)
    const outcome = await convertOfficeFileToPdf(
      storagePath,
      entry.originalName,
      join(app.getPath('downloads'), 'EverRoom'),
    )
    if ('unavailable' in outcome) return { unavailable: true as const }
    shell.showItemInFolder(outcome.pdfPath)
    return { unavailable: false as const, path: outcome.pdfPath }
  })
  handle(THESIS_FORMAT_CHANNELS.reformat, async (
    _event,
    workspaceId: string,
    fileEntryId: string,
    cardId?: string,
    options?: Parameters<typeof bridge.reformat>[3],
  ) => {
    const startedAt = Date.now()
    try {
      const result = await bridge.reformat(workspaceId, fileEntryId, cardId, options)
      console.info('[thesis] 同步排版完成', { workspaceId, fileEntryId, elapsedMs: Date.now() - startedAt })
      return result
    } catch (error) {
      console.warn('[thesis] 同步排版失败', {
        workspaceId, fileEntryId, cardId: cardId ?? null,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  })
}

/**
 * 应用内 Office 预览：文件页「打开」与论文面板「预览模板」共用同一条路。
 * 不依赖具体 IPC 事件（面板的宿主钩子拿不到 event）——目标窗口取第一个存活的
 * 主窗口；同一 fileId 复用预览实例，内容变化原地重建。
 */
async function openFileInAppPreview(
  bridge: FilesGatewayBridge,
  fileId: string,
  originalName: string,
  options?: {
    contentHash?: string
    editable?: boolean
    roomId?: string
    workspaceId?: string
    focusWindow?: boolean
  },
): Promise<{ openedWith: 'office' | 'external'; instanceId?: string; kind?: OfficePreviewKind; title?: string }> {
  const extension = extname(originalName).toLowerCase()
  const legacy = extension === '.doc' || extension === '.xls' || extension === '.ppt'
  if (officePreviewKindForFileName(originalName) === null) {
    await bridge.openOriginal(fileId)
    return { openedWith: 'external' }
  }

  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null
  if (!window) throw new Error('EverRoom 主窗口不可用。')
  if (options?.focusWindow) {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  const storagePath = await bridge.storagePath(fileId)
  const effectiveHash = options?.contentHash ?? await hashFileBytes(storagePath)
  // 归属工作区：调用方显式给的优先；否则按目录条目回查（资料库/产物库入口都靠它）。
  // 回查失败（老条目不在 catalog）→ null：编辑保存回填不带归属（网关对未传归属的
  // 重导入保留条目原值），预览实例按默认工作区兜底，不阻断打开。
  let workspaceId: string | null = options?.workspaceId ?? null
  if (!workspaceId) {
    try {
      const entry = await bridge.catalogEntry(fileId)
      workspaceId = entry?.workspaceId?.trim() || null
    } catch {
      workspaceId = null
    }
  }
  let descriptor
  try {
    descriptor = await officePreviewRegistry.open(window, {
      id: fileId,
      contentHash: effectiveHash,
      originalName,
      storagePath,
      ...(options?.editable ? { editable: true } : {}),
      ...(options?.roomId ? { roomId: options.roomId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    })
  } catch (error) {
    if (!legacy) throw error
    logDesktop('office', 'warn', {
      event: 'office.legacy-preview-conversion-failed',
      originalName,
      message: error instanceof Error ? error.message : String(error),
    })
    await bridge.openOriginal(fileId)
    return { openedWith: 'external' }
  }
  return { openedWith: 'office' as const, instanceId: descriptor.id, kind: descriptor.kind, title: descriptor.title }
}

function registerFilesHandlers(
  bridge: FilesGatewayBridge,
  highRiskImports: HighRiskImportCoordinator,
): void {
  highRiskImports.onChanged(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(FILES_CHANNELS.highRiskReviewsChanged)
    }
  })
  handle(FILES_CHANNELS.list, (_event, limit?: number, offset?: number, options?: { workspaceId?: unknown }) =>
    bridge.list(limit, offset, typeof options?.workspaceId === 'string' && options.workspaceId
      ? { workspaceId: options.workspaceId }
      : undefined))
  handle(FILES_CHANNELS.catalogEntry, (_event, fileId: string) => bridge.catalogEntry(fileId))
  handle(FILES_CHANNELS.get, (_event, fileId: string) => bridge.get(fileId))
  handle(
    FILES_CHANNELS.readMarkdown,
    (_event, fileId: string, options?: { waitMs?: number; pollMs?: number }) => bridge.readMarkdown(fileId, options),
  )
  handle(FILES_CHANNELS.readDataUrl, (_event, fileId: string) => bridge.readDataUrl(fileId))
  handle(FILES_CHANNELS.rename, (_event, fileId: string, displayName: string) =>
    bridge.rename(fileId, displayName))
  handle(FILES_CHANNELS.delete, (_event, fileId: string) => bridge.delete(fileId))
  handle(FILES_CHANNELS.reveal, (_event, fileId: string) => bridge.reveal(fileId))
  handle(FILES_CHANNELS.exportReveal, (_event, fileId: string, originalName: string) =>
    bridge.exportReveal(fileId, originalName))
  handle(FILES_CHANNELS.openOriginal, async (
    _event,
    fileId: string,
    originalName?: string,
    contentHash?: string,
    options?: { editable?: unknown; roomId?: unknown; workspaceId?: unknown; focusWindow?: unknown },
  ) => {
    if (!originalName) {
      await bridge.openOriginal(fileId)
      return { openedWith: 'external' as const }
    }
    return openFileInAppPreview(bridge, fileId, originalName, {
      ...(contentHash ? { contentHash } : {}),
      ...(options?.editable === true ? { editable: true } : {}),
      ...(typeof options?.roomId === 'string' && options.roomId ? { roomId: options.roomId } : {}),
      ...(typeof options?.workspaceId === 'string' && options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options?.focusWindow === true ? { focusWindow: true } : {}),
    })
  })
  bridge.onImportProgress((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(FILES_CHANNELS.importProgress, event)
    }
  })
  handle(
    FILES_CHANNELS.pickAndImport,
    (_event, options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }) =>
      bridge.pickAndImport(options),
  )
  handle(FILES_CHANNELS.pickPaths, () => bridge.pickImportPaths())
  handle(
    FILES_CHANNELS.importPathsOnce,
    (_event, paths: string[], options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }) =>
      bridge.importPathsOnce(paths, options),
  )
  handle(
    FILES_CHANNELS.importArtifacts,
    (_event, paths: string[], roomId: string, workspaceId?: string) => {
      if (typeof roomId !== 'string' || !roomId) throw new Error('缺少目标 Room。')
      if (!Array.isArray(paths)) throw new Error('无效的导入请求。')
      return bridge.importArtifactFiles(
        paths.filter((path: unknown): path is string => typeof path === 'string'),
        roomId,
        ...(typeof workspaceId === 'string' && workspaceId ? [workspaceId] : []),
      )
    },
  )
  handle(
    FILES_CHANNELS.importAgentAttachments,
    (_event, paths: string[]) => bridge.importAgentAttachments(paths),
  )
  handle(FILES_CHANNELS.listHighRiskReviews, () => ({ items: highRiskImports.list() }))
  handle(
    FILES_CHANNELS.resolveHighRiskReview,
    (_event, id: unknown, accepted: unknown) => {
      if (typeof id !== 'string' || id.length < 1 || id.length > 100 || typeof accepted !== 'boolean') {
        throw new Error('无效的文件确认请求。')
      }
      return highRiskImports.resolve(id, accepted)
    },
  )
  // 冷启动竞态兜底：系统打开事件可能早于渲染层挂载监听，暂存一份供启动时取走。
  handle(FILES_CHANNELS.takePendingOsOpen, () => {
    const pending = pendingOsOpen
    pendingOsOpen = null
    return pending
  })
}

function registerPermissionHandlers(): void {
  handle(PERMISSION_CHANNELS.requestMicrophoneAccess, async () => {
    if (process.platform !== 'darwin') return true
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return true
    if (status === 'denied' || status === 'restricted') return false
    return systemPreferences.askForMediaAccess('microphone')
  })
  handle(PERMISSION_CHANNELS.getMicrophoneAccessStatus, () => {
    if (process.platform !== 'darwin') return 'granted' as const
    return systemPreferences.getMediaAccessStatus('microphone')
  })
  handle(PERMISSION_CHANNELS.openMicrophoneSettings, () => {
    if (process.platform !== 'darwin') throw new Error('麦克风隐私设置仅适用于 macOS。')
    return shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    )
  })
}

function registerSearchHandlers(bridge: SearchGatewayBridge): void {
  handle(SEARCH_CHANNELS.invoke, (_event, request: SearchRequestDto) =>
    bridge.invoke(request))
  handle(SEARCH_CHANNELS.status, () => bridge.status())
  handle(
    SEARCH_CHANNELS.prioritize,
    (_event, itemType: SearchItemType, refId: string) =>
      bridge.prioritize(itemType, refId),
  )
  handle(
    SEARCH_CHANNELS.messageContext,
    (_event, messageId: string, before?: number, after?: number) =>
      bridge.messageContext(messageId, before, after),
  )
}

async function syncAccountMonitoring(status: Promise<CloudAccountStatus>): Promise<CloudAccountStatus> {
  const account = await status
  syncSentryAccount(account)
  return account
}

/**
 * 探测系统 HTTP 代理并转成 gateway 子进程环境变量。Chromium 网络栈（渲染层
 * 与桌面主进程 net.fetch）自动遵循系统/PAC 代理；gateway 是纯 Node 进程，
 * 必须显式注入。只认 PROXY/HTTPS 条目（SOCKS 对 undici EnvHttpProxyAgent
 * 不可用，直接跳过避免半残配置）；DIRECT / 探测失败返回空对象，行为不变。
 */
async function detectSystemProxyEnvironment(): Promise<Record<string, string>> {
  try {
    const rules = await session.defaultSession.resolveProxy('https://r.nxcore.ai')
    const match = /(?:^|;\s*)(?:PROXY|HTTPS)\s+([^\s;]+)/i.exec(rules)
    if (!match?.[1]) return {}
    const endpoint = match[1].trim()
    const proxyUrl = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`
    const noProxy = 'localhost,127.0.0.1,::1'
    return {
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      NO_PROXY: noProxy,
      https_proxy: proxyUrl,
      http_proxy: proxyUrl,
      no_proxy: noProxy,
    }
  } catch (error) {
    console.warn('System proxy detection failed; gateway will connect directly.', error)
    return {}
  }
}

function registerAccountHandlers(
  client: SaasClient,
  onAccountChanged?: (account: CloudAccountStatus, context?: { explicitLogout?: boolean }) => void,
  beforeLogout?: () => Promise<void>,
): void {
  handle(ACCOUNT_CHANNELS.status, (_event, refreshSubscription?: unknown) => rateLimitAware(async () => {
    const account = await syncAccountMonitoring(client.status(refreshSubscription === true))
    onAccountChanged?.(account)
    return account
  }))
  handle(ACCOUNT_CHANNELS.devices, () => rateLimitAware(() => client.listDevices()))
  handle(ACCOUNT_CHANNELS.login, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的登录信息。')
    const value = input as { identifier?: unknown; password?: unknown }
    if (typeof value.identifier !== 'string' || typeof value.password !== 'string') {
      throw new Error('请输入账号和密码。')
    }
    const identifier = value.identifier
    const password = value.password
    return rateLimitAware(async () => {
      const account = await syncAccountMonitoring(client.login(identifier, password))
      onAccountChanged?.(account)
      return account
    })
  })
  handle(ACCOUNT_CHANNELS.invitationCodeValidate, (_event, invitationCode: unknown) => {
    if (typeof invitationCode !== 'string') throw new Error('无效的邀请码。')
    return rateLimitAware(() => client.validateInvitationCode(invitationCode))
  })
  handle(ACCOUNT_CHANNELS.invitationCodeRedeem, (_event, invitationCode: unknown) => {
    if (typeof invitationCode !== 'string') throw new Error('无效的邀请码。')
    return rateLimitAware(() => client.redeemInvitationCode(invitationCode))
  })
  handle(ACCOUNT_CHANNELS.oidcLogin, (_event, input: unknown) => {
    const value=typeof input==='string'?{provider:input}:input&&typeof input==='object'?input as {provider?:unknown;invitationCode?:unknown}:{}
    const provider=value.provider
    if (provider !== 'apple' && provider !== 'google') throw new Error('不支持的登录方式。')
    if (value.invitationCode !== undefined && typeof value.invitationCode !== 'string') throw new Error('无效的邀请码。')
    const invitationCode=typeof value.invitationCode==='string'?value.invitationCode:undefined
    return rateLimitAware(async () => {
      const account = await syncAccountMonitoring(client.loginWithOidc(provider,invitationCode))
      onAccountChanged?.(account)
      return account
    })
  })
  handle(ACCOUNT_CHANNELS.oidcCancel, () => client.cancelOidcLogin())
  handle(ACCOUNT_CHANNELS.qrLoginCreate, () => rateLimitAware(async () => client.createQrLoginSession()))
  handle(ACCOUNT_CHANNELS.qrLoginStatus, (_event, sessionId?: unknown) => {
    if (sessionId !== undefined && typeof sessionId !== 'string') throw new Error('无效的扫码会话。')
    return rateLimitAware(() => client.getQrLoginStatus(sessionId))
  })
  handle(ACCOUNT_CHANNELS.qrLoginExchange, (_event, sessionId?: unknown) => {
    if (sessionId !== undefined && typeof sessionId !== 'string') throw new Error('无效的扫码会话。')
    return rateLimitAware(async () => {
      const account = await syncAccountMonitoring(client.exchangeQrLoginSession(sessionId))
      onAccountChanged?.(account)
      return account
    })
  })
  handle(ACCOUNT_CHANNELS.qrLoginCancel, (_event, sessionId?: unknown) => {
    if (sessionId !== undefined && typeof sessionId !== 'string') throw new Error('无效的扫码会话。')
    return rateLimitAware(() => client.cancelQrLoginSession(sessionId))
  })
  handle(ACCOUNT_CHANNELS.deviceAdmissionReplace, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('无效的设备准入请求。')
    const value = input as { admissionToken?: unknown; replaceDeviceId?: unknown }
    if (typeof value.admissionToken !== 'string' || typeof value.replaceDeviceId !== 'string') {
      throw new Error('无效的设备准入请求。')
    }
    const admissionToken = value.admissionToken
    const replaceDeviceId = value.replaceDeviceId
    return rateLimitAware(async () => {
      const account = await syncAccountMonitoring(client.replaceDeviceAdmission(admissionToken, replaceDeviceId))
      onAccountChanged?.(account)
      return account
    })
  })
  handle(ACCOUNT_CHANNELS.deviceAdmissionDismiss, () => {
    client.clearAdmissionChallenge()
    return { dismissed: true }
  })
  handle(ACCOUNT_CHANNELS.logout, () => rateLimitAware(async () => {
    await beforeLogout?.()
    const connection = gatewaySupervisor?.isRunning() ? gatewaySupervisor.getConnection() : null
    if (connection) {
      await fetch(`${connection.baseUrl}/v1/security/secrets/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.token}` },
      }).catch(() => undefined)
    }
    const account = await syncAccountMonitoring(client.logout())
    onAccountChanged?.(account, { explicitLogout: true })
    return account
  }))
}

function registerNotificationHandlers(client: SaasClient): void {
  handle('notifications:preferences', () => rateLimitAware(() => client.notificationPreferences()))
  handle('notifications:update-preferences', (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid notification preferences')
    const value = input as Partial<NotificationPreferences>
    if ([value.enabled, value.iosEnabled, value.macosEnabled].some((item) => item !== undefined && typeof item !== 'boolean')) {
      throw new Error('Invalid notification preferences')
    }
    return rateLimitAware(() => client.updateNotificationPreferences(value))
  })
  handle('notifications:cloud-sessions', (_event, deviceId: unknown) => {
    if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('Invalid notification device')
    return rateLimitAware(() => client.listCloudAgentSessions(deviceId))
  })
  handle('notifications:cloud-messages', (_event, deviceId: unknown, sessionId: unknown, before: unknown) => {
    if (typeof deviceId !== 'string' || !deviceId.trim() || typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('Invalid notification session')
    }
    if (before !== undefined && typeof before !== 'string') throw new Error('Invalid notification cursor')
    return rateLimitAware(() => client.listCloudAgentSessionMessages(deviceId, sessionId, before))
  })
}

/**
 * 账号钥匙串/设备配对通道：原本挂在转写同步服务上，转写子系统删除后
 * 直接落在 AccountKeyringService + SaaS 客户端上，配对页行为保持不变。
 */
function registerAccountKeyringHandlers(client: SaasClient, keyring: AccountKeyringService): void {
  handle(ACCOUNT_CHANNELS.keyringStatus, () => rateLimitAware(async (): Promise<AccountKeyringStatus> => {
    const account = await client.status()
    if (!account.authenticated || !account.user) {
      return {
        enabled: false,
        reason: '请先登录 EverRoom。',
        initialized: false,
        umkId: null,
        activeVersion: null,
        deviceStatus: 'unregistered',
        verificationCode: null,
      }
    }
    return {
      enabled: true,
      initialized: false,
      umkId: null,
      activeVersion: null,
      deviceStatus: 'ready',
      verificationCode: null,
    }
  }))
  handle(ACCOUNT_CHANNELS.createPairingSession, () => rateLimitAware(async () => {
    const account = await client.status()
    const userId = account.authenticated ? account.user?.id : null
    if (!account.user || !userId) throw new Error('请先登录 EverRoom。')
    return keyring.createPairingSession(client, userId)
  }))
  handle(ACCOUNT_CHANNELS.getPairingSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的配对会话。')
    return rateLimitAware(() => client.getPairingSession(id))
  })
  handle(ACCOUNT_CHANNELS.approvePairingSession, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('无效的配对会话。')
    return rateLimitAware(async () => {
      const account = await client.status()
      const userId = account.authenticated ? account.user?.id : null
      if (!account.user || !userId) throw new Error('请先登录 EverRoom。')
      return keyring.approvePairingSession(client, userId, id)
    })
  })
}

function registerAgentSchedulerHandlers(): void {
  handle(AGENT_SCHEDULER_CHANNELS.list, () => {
    if (!agentSchedulerGatewayBridge) throw new Error('Agent 定时任务服务尚未就绪。')
    return agentSchedulerGatewayBridge.list()
  })
  handle(AGENT_SCHEDULER_CHANNELS.create, (_event, input: unknown) => {
    if (!agentSchedulerGatewayBridge || !input || typeof input !== 'object') throw new Error('Agent 定时任务参数无效。')
    return agentSchedulerGatewayBridge.create(input as never)
  })
  handle(AGENT_SCHEDULER_CHANNELS.update, (_event, id: unknown, input: unknown) => {
    if (!agentSchedulerGatewayBridge || typeof id !== 'string' || !input || typeof input !== 'object') throw new Error('Agent 定时任务参数无效。')
    return agentSchedulerGatewayBridge.update(id, input as never)
  })
  handle(AGENT_SCHEDULER_CHANNELS.runNow, (_event, id: unknown) => {
    if (!agentSchedulerGatewayBridge || typeof id !== 'string') throw new Error('Agent 定时任务参数无效。')
    return agentSchedulerGatewayBridge.runNow(id)
  })
  handle(AGENT_SCHEDULER_CHANNELS.remove, (_event, id: unknown) => {
    if (!agentSchedulerGatewayBridge || typeof id !== 'string') throw new Error('Agent 定时任务参数无效。')
    return agentSchedulerGatewayBridge.remove(id)
  })
}

function registerWritingStyleHandlers(): void {
  handle(WRITING_STYLE_CHANNELS.profile, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.profile()
  })
  handle(WRITING_STYLE_CHANNELS.settings, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.settings()
  })
  handle(WRITING_STYLE_CHANNELS.updateSettings, (_event, input: unknown) => {
    if (!writingStyleGatewayBridge || !input || typeof input !== 'object') throw new Error('写作风格设置参数无效。')
    return writingStyleGatewayBridge.updateSettings(input as { completionEnabled?: boolean; generationEnabled?: boolean })
  })
  handle(WRITING_STYLE_CHANNELS.userContent, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.userContent()
  })
  handle(WRITING_STYLE_CHANNELS.replaceUserContent, (_event, content: unknown) => {
    if (!writingStyleGatewayBridge || typeof content !== 'string') throw new Error('写作风格正文参数无效。')
    return writingStyleGatewayBridge.replaceUserContent(content)
  })
  handle(WRITING_STYLE_CHANNELS.regenerateUserContent, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.regenerateUserContent()
  })
  handle(WRITING_STYLE_CHANNELS.recompute, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.recompute()
  })
  handle(WRITING_STYLE_CHANNELS.backfill, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.backfill()
  })
  handle(WRITING_STYLE_CHANNELS.corpus, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.corpus()
  })
  handle(WRITING_STYLE_CHANNELS.setExclusion, (_event, documentId: unknown, excluded: unknown) => {
    if (!writingStyleGatewayBridge || typeof documentId !== 'string' || typeof excluded !== 'boolean') {
      throw new Error('写作风格语料参数无效。')
    }
    return writingStyleGatewayBridge.setExclusion(documentId, excluded)
  })
  handle(WRITING_STYLE_CHANNELS.insights, () => {
    if (!writingStyleGatewayBridge) throw new Error('写作风格服务尚未就绪。')
    return writingStyleGatewayBridge.insights()
  })
  handle(WRITING_STYLE_CHANNELS.snoozeInsight, (_event, insightId: unknown) => {
    if (!writingStyleGatewayBridge || typeof insightId !== 'string') throw new Error('写作风格洞察参数无效。')
    return writingStyleGatewayBridge.snoozeInsight(insightId)
  })
  handle(WRITING_STYLE_CHANNELS.confirmInsight, (_event, insightId: unknown) => {
    if (!writingStyleGatewayBridge || typeof insightId !== 'string') throw new Error('写作风格洞察参数无效。')
    return writingStyleGatewayBridge.confirmInsight(insightId)
  })
  handle(WRITING_STYLE_CHANNELS.completionFeedback, (_event, input: unknown) => {
    if (!writingStyleGatewayBridge || !input || typeof input !== 'object') throw new Error('写作风格补全反馈参数无效。')
    const { accepted, rejected, samples } = input as { accepted?: unknown; rejected?: unknown; samples?: unknown }
    if (typeof accepted !== 'number' || typeof rejected !== 'number'
      || !Array.isArray(samples) && samples !== undefined) {
      throw new Error('写作风格补全反馈参数无效。')
    }
    return writingStyleGatewayBridge.reportCompletionFeedback({
      accepted,
      rejected,
      samples: Array.isArray(samples) ? samples.filter((sample): sample is string => typeof sample === 'string') : [],
    })
  })
}

function registerAgentAccessHandlers(): void {
  const requireBridge = (): AgentAccessGatewayBridge => {
    if (!agentAccessGatewayBridge) throw new Error('Agent 连接服务尚未就绪。')
    return agentAccessGatewayBridge
  }
  const requireString = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}无效。`)
    return value
  }
  handle(AGENT_ACCESS_CHANNELS.listConnections, () => requireBridge().listConnections())
  handle(AGENT_ACCESS_CHANNELS.createConnection, (_event, input: unknown) => {
    if (!input || typeof input !== 'object') throw new Error('Agent 连接参数无效。')
    return requireBridge().createConnection(input as never)
  })
  handle(AGENT_ACCESS_CHANNELS.updateConnection, (_event, id: unknown, input: unknown) => {
    if (typeof id !== 'string' || !input || typeof input !== 'object') throw new Error('Agent 连接参数无效。')
    return requireBridge().updateConnection(id, input as never)
  })
  handle(AGENT_ACCESS_CHANNELS.revokeConnection, (_event, id: unknown) =>
    requireBridge().revokeConnection(requireString(id, '连接 ID')))
  handle(AGENT_ACCESS_CHANNELS.rotateToken, (_event, id: unknown) =>
    requireBridge().rotateToken(requireString(id, '连接 ID')))
  handle(AGENT_ACCESS_CHANNELS.submissions, (_event, id: unknown) =>
    requireBridge().submissions(requireString(id, '连接 ID')))
  handle(AGENT_ACCESS_CHANNELS.events, (_event, id: unknown) =>
    requireBridge().events(requireString(id, '连接 ID')))
  handle(AGENT_ACCESS_CHANNELS.selftest, (_event, id: unknown) =>
    requireBridge().selftest(requireString(id, '连接 ID')))
  handle(AGENT_ACCESS_CHANNELS.exampleQuery, (_event, id: unknown, query: unknown) => {
    if (typeof query !== 'string' && query !== undefined) throw new Error('查询参数无效。')
    return requireBridge().exampleQuery(requireString(id, '连接 ID'), query)
  })
  handle(AGENT_ACCESS_CHANNELS.install, async (_event, connectionId: unknown, target: unknown, token: unknown) => {
    const plan = await requireBridge().install(
      requireString(connectionId, '连接 ID'),
      requireString(target, '目标工具'),
      requireString(token, '连接 token'),
    )
    if (!agentAccessInstaller) throw new Error('安装服务尚未就绪。')
    const outcome = agentAccessInstaller.apply(plan.install)
    return { plan: plan.install, outcome }
  })
  handle(AGENT_ACCESS_CHANNELS.uninstall, (_event, target: unknown) => {
    if (!agentAccessInstaller) throw new Error('安装服务尚未就绪。')
    return agentAccessInstaller.uninstall(requireString(target, '目标工具'))
  })
  handle(AGENT_ACCESS_CHANNELS.settingsGet, () => {
    if (!agentAccessSettingsStore || !gatewaySupervisor) throw new Error('Agent 连接服务尚未就绪。')
    return {
      fixedPort: agentAccessSettingsStore.read().fixedPort,
      currentPort: agentAccessSettingsStore.currentGatewayPort(gatewaySupervisor),
    }
  })
  handle(AGENT_ACCESS_CHANNELS.settingsSetFixedPort, async (_event, port: unknown) => {
    if (!agentAccessSettingsStore) throw new Error('Agent 连接服务尚未就绪。')
    if (port === null) {
      agentAccessSettingsStore.write({ fixedPort: null })
      return { fixedPort: null as number | null, needsRestart: true }
    }
    if (typeof port !== 'number' || !isValidFixedPort(port)) {
      throw new Error('端口必须是 1024–65535 的整数。')
    }
    if (!(await AgentAccessSettingsStore.isPortFree(port))) {
      throw new Error(`端口 ${port} 已被占用，请换一个。`)
    }
    agentAccessSettingsStore.write({ fixedPort: port })
    return { fixedPort: port, needsRestart: true }
  })
  handle(AGENT_ACCESS_CHANNELS.restartGateway, async () => {
    if (!gatewaySupervisor) throw new Error('网关尚未就绪。')
    await gatewaySupervisor.shutdown()
    const connection = await gatewaySupervisor.start()
    return { baseUrl: connection.baseUrl }
  })
}

function registerAgentDebugHandlers(): void {
  const requireBridge = (): AgentDebugGatewayBridge => {
    if (!agentDebugGatewayBridge) throw new Error('Agent 调试服务尚未就绪。')
    return agentDebugGatewayBridge
  }
  handle(AGENT_DEBUG_CHANNELS.listAgents, () => requireBridge().listAgents())
  handle(AGENT_DEBUG_CHANNELS.getAgent, (_event, id: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Agent ID 无效。')
    return requireBridge().getAgent(id)
  })
  handle(AGENT_DEBUG_CHANNELS.listUsage, (_event, id: unknown, limit: unknown) => {
    if (typeof id !== 'string' || !id.trim()) throw new Error('Agent ID 无效。')
    if (limit !== undefined
      && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)) {
      throw new Error('limit 无效。')
    }
    return requireBridge().listUsage(id, limit)
  })
  // 独立窗口不依赖网关桥就绪：窗口先开，页面自己再拉数据（失败就显示可读错误）。
  handle(AGENT_DEBUG_CHANNELS.openWindow, () => {
    openAgentDebugWindow()
  })
}

function isAppWindowNavigationAllowed(url: string): boolean {
  try {
    if (process.env.ELECTRON_RENDERER_URL) {
      return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    }
    return new URL(url).href === pathToFileURL(join(__dirname, '../renderer/index.html')).href
  } catch {
    return false
  }
}

/**
 * Agent 调试面板的独立窗口：独立渲染入口 debug.html（复用同一 preload），
 * 与主窗口解耦——不参与 GenOffice 脏关闭守卫，关闭它也不影响主窗口。
 * 单例：已开窗时聚焦（最小化则先还原）。
 */
function openAgentDebugWindow(): BrowserWindow {
  if (agentDebugWindow && !agentDebugWindow.isDestroyed()) {
    if (agentDebugWindow.isMinimized()) agentDebugWindow.restore()
    agentDebugWindow.show()
    agentDebugWindow.focus()
    return agentDebugWindow
  }
  const window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Agent 调试',
    backgroundColor: appearanceWindowBackground(),
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const sendMaximizedChanged = () => {
    if (!window.isDestroyed()) window.webContents.send('window:maximized-changed', window.isMaximized())
  }
  window.on('maximize', sendMaximizedChanged)
  window.on('unmaximize', sendMaximizedChanged)
  window.on('closed', () => {
    if (agentDebugWindow === window) agentDebugWindow = null
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`Failed to load Agent debug preload script: ${preloadPath}`, error)
  })
  // 调试页没有外链：任何窗口打开/跳转都拦下，避免页面拿着 preload 桥离开应用。
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')}/`
    void window.loadURL(new URL('debug.html', base).toString())
  } else {
    void window.loadFile(join(__dirname, '../renderer/debug.html'))
  }
  agentDebugWindow = window
  return window
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    title: 'Everroom',
    backgroundColor: appearanceWindowBackground(),
    // macOS 走 hiddenInset + 系统红绿灯；Windows 隐藏整条系统标题栏，
    // 由渲染端 TopBar/引导页头部绘制 EverRoom 风格的自绘窗口按钮。
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 16 } }
      : { titleBarStyle: 'hidden' as const }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const sendMaximizedChanged = () => {
    if (!window.isDestroyed()) window.webContents.send('window:maximized-changed', window.isMaximized())
  }
  window.on('maximize', sendMaximizedChanged)
  window.on('unmaximize', sendMaximizedChanged)

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
  window.once('ready-to-show', () => window.show())
  window.webContents.on('did-finish-load', () => sendPendingAgentNotificationTarget())
  // 渲染进程崩溃（OOM/原生崩溃）默认留下永久白屏窗口；记日志并整页重载。
  window.webContents.on('render-process-gone', (_event, details) => {
    if (window.isDestroyed()) return
    console.error(`[window] 渲染进程异常退出（reason=${details.reason}），正在重载页面。`)
    window.webContents.reload()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  // 同窗口导航只放行应用自身页面（dev 服务器 origin / 生产 index.html）。
  // 文档里的外链（Notion/飞书导入等）不得把主窗口带去远端页面——否则该页面
  // 会拿到 preload 暴露的网关桥；拦截后降级为系统浏览器打开。
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppWindowNavigationAllowed(url)) return
    event.preventDefault()
    openExternalUrl(url)
  })

  // everoffice UI 迁移：office-proto GenOffice 桥随首个窗口初始化；
  // 关窗前跑脏关闭守卫（守卫里点过取消则维持原状）。
  genofficeProtoBridge ??= new GenofficeProtoBridge()
  {
    let protoCloseApproved = false
    window.on('close', (event) => {
      if (protoCloseApproved || !genofficeProtoBridge) return
      event.preventDefault()
      void genofficeProtoBridge.confirmCloseAll().then((clean) => {
        if (!clean) return
        protoCloseApproved = true
        window.destroy()
      })
    })
  }

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  applyNativeTheme(readAppearanceTheme())
  if (process.defaultApp && process.argv[1] && process.platform !== 'darwin') {
    app.setAsDefaultProtocolClient('everroom', process.execPath, [app.getAppPath()])
  } else {
    app.setAsDefaultProtocolClient('everroom')
  }
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
  }
  // 退出兜底（win32）：崩溃/强杀路径 before-quit 不会执行，exit 钩子同步击杀
  // 仍存活的受管子进程；POSIX 正常退出已有进程组语义，不注册。
  installExitCleanupHook()
  // 窗口先显示,Gateway 等服务在后台初始化,状态由左下角 Gateway 指示器呈现。
  const documentAssets = new DocumentAssetStore(join(dataDirectory, 'document-assets'))
  protocol.handle(DOCUMENT_ASSET_SCHEME, (request) => documentAssets.response(request.url))
  protocol.handle(OBSIDIAN_VAULT_ASSET_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const [vaultId, resourceId] = url.pathname.replace(/^\//, '').split('/').map(decodeURIComponent)
      if (url.hostname !== 'local' || !vaultId || !resourceId || !obsidianVaultService) {
        return new Response('Not found', { status: 404 })
      }
      const asset = await obsidianVaultService.asset(vaultId, resourceId)
      return new Response(new Uint8Array(asset.buffer), {
        headers: { 'Content-Type': asset.mime, 'Cache-Control': 'private, max-age=60' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  protocol.handle('everroom-material', async (request) => {
    // everroom-material://<64位sha256> → 网关 /v1/materials/:hash（文件桥惰性取）。
    try {
      const url = new URL(request.url)
      const hash = `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(hash) || !officeFilesBridge) {
        return new Response('Not found', { status: 404 })
      }
      const content = await officeFilesBridge.readMaterial(hash)
      if (!content) return new Response('Not found', { status: 404 })
      return new Response(new Uint8Array(content.buffer), {
        headers: { 'Content-Type': content.mime, 'Cache-Control': 'private, max-age=86400' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
  installIpcRouters()
  // runtime-config 处理器必须早于窗口注册：否则渲染层首次查询会落到
  // servicesReady 的兜底队列里，启动闪屏被迫等全量服务初始化。
  registerRuntimeConfigHandlers()
  registerSystemClipboardHandler()
  registerGatewayHandlers()
  registerOpenConnectorHandlers()
  // Agent 授权引导（飞书 lark-cli）：不依赖 gateway/OpenConnector，尽早可用。
  // lark-cli 使用应用私有 HOME：不读写用户终端里 `~/.lark-cli` 的配置，随应用卸载清理。
  const larkRuntime = getLarkCliRuntime()
  agentAuthController = new AgentAuthController(
    new LarkAuthRunner(larkRuntime.executable, {
      homeDirectory: larkRuntime.homeDirectory,
      source: larkRuntime.source,
    }),
    {
      onEvent: (frame) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send('agent-auth:event', frame)
          }
        }
      },
      // 授权链接一到即自动拉起浏览器（数据源卡片点击后直达授权页）。
      onVerificationUrl: (url) => openExternalUrl(url),
      // 非 token 授权状态加密落盘（本地静态密钥，不依赖 safeStorage/钥匙串）。
      persist: createAgentAuthPersistence(join(dataDirectory, 'agent-auth', 'challenge.bin')),
    },
    resolveNtnCliExecutable() ? new NtnAuthRunner(resolveNtnCliExecutable()!) : null,
  )
  registerAgentAuthHandlers()
  // 中转额度视图：窗口即将创建而 SaaS 客户端要到启动链后段才构造，设置页
  // 登录态一挂载即查询——这里提前注册，客户端未就绪时返回 null 静默降级
  // （此前启动期查询必报 No handler registered，console 错误还上 Sentry）。
  handle(ACCOUNT_CHANNELS.aiRelayStatus, () => {
    const client = saasClient
    if (!client) return Promise.resolve(null)
    return rateLimitAware(() => client.aiGatewayStatus())
  })
  handle(ACCOUNT_CHANNELS.aiRelayVerdict, () => ({ quotaExhausted: aiRelayKeeper?.isQuotaExhausted() ?? false }))
  // SaaS 客户端先于连接器栈构造：saas 连接层在 gateway 启动前就需要登录态换 oo 会话。
  // 放在 createWindow 之前：渲染层挂载即查账号，处理器必须先于首帧就位。
  const credentials = new CredentialStore(join(app.getPath('userData'), 'credentials.json'), join(app.getPath('userData'), 'backups'))
  await credentials.initialize()
  // SaaS 客户端仍需要录音目录参数（历史中转建单落盘路径），保留同一目录。
  const recordingsDirectory = join(dataDirectory, 'recordings')
  saasClient = new SaasClient(credentials, app, recordingsDirectory, (url) => shell.openExternal(url))
  void saasClient.initialize()
  // 启动期账号查询不能排到 servicesReady：登录态解析（刷新令牌等网络往返）
  // 本身就该与 gateway 启动并行。这里先注册轻量 status 处理器，完整处理器
  // （含账号事件钩子）稍后覆盖同一 channel。
  const startupSaasClient = saasClient
  handle(ACCOUNT_CHANNELS.status, (_event, refreshSubscription?: unknown) => rateLimitAware(async () => (
    startupSaasClient.status(refreshSubscription === true)
  )))
  startDesktopUpdater(saasClient)
  createWindow()
  // 首帧关键路径之外：残留进程清理、文档资产 / Obsidian 初始化只影响各自页面，
  // 放到窗口显示之后做。闪屏出现时间从 ~1.0s 提前到 ~0.4s，不动总启动时间。
  await cleanupLegacyGatewaySecretKey(join(dataDirectory, 'security'))
  const staleProcesses = await cleanupStaleProcessRecords(join(dataDirectory, 'runtime'))
  if (staleProcesses.length > 0) {
    console.warn(`[startup] 已清理上次残留进程：${staleProcesses.join('、')}`)
  }
  await documentAssets.initialize().catch((error: unknown) => {
    console.error('Failed to initialize local document assets', error)
  })
  // 文档资产本地桥：飞书导出时 lark-cli 经此下载本地图并上传（token 只进网关 env）。
  documentAssetBridge = await startDocumentAssetBridge(documentAssets).catch((error: unknown) => {
    console.warn('Document asset bridge unavailable; exports degrade to placeholders.', error)
    return null
  })
  obsidianVaultService = new ObsidianVaultService(dataDirectory, (path) => shell.trashItem(path))
  await obsidianVaultService.initialize().catch((error) => {
    console.error('Failed to initialize Obsidian Vault service', error)
  })
  registerObsidianHandlers(obsidianVaultService)
  // 连接器栈在所有页面可用（sources/connectors 页面模式分叉已删除）
  const connectorModeStore = connectorModeStoreRef ?? createConnectorModeStore(dataDirectory)
  connectorModeStoreRef = connectorModeStore
  const connectorModeState = await connectorModeStore.read()
  try {
    // SaaS 模式（默认）：不拉本地实例；local 模式拉起
    if (connectorModeState.mode === 'local') {
      openConnectorSupervisor = new OpenConnectorSupervisor(join(dataDirectory, 'open-connector'))
      const openConnector = await openConnectorSupervisor.start().catch((error) => {
        console.error('Managed OpenConnector failed to start; connector tools stay disabled.', error)
        return null
      })
      if (openConnector) {
        ooCliBridge = createOoCliBridge(openConnector)
        attachOpenConnectorBridge(ooCliBridge)
      }
    }
    agentNotificationBridgeServer = new AgentNotificationBridgeServer(
      () => saasClient,
      (local) => {
        // 来源桌面端本机兜底通知：远程推送按设计排除来源设备，这里直接弹出
        // 内容相同的通知，点击后定位到对应 Agent 会话。
        if (!Notification.isSupported()) return
        const sourceDeviceId = saasClient?.deviceId
        if (!sourceDeviceId) return
        const notification = new Notification({ title: local.title, body: local.body })
        notification.on('click', () => openAgentNotificationTarget({
          kind: 'agent_session',
          notificationId: local.notificationId,
          sourceDeviceId,
          sessionId: local.sessionId,
          runId: local.runId,
          roomId: local.roomId,
        }))
        notification.on('failed', (_event, reason) => console.warn('Local agent notification failed to display', reason, local.notificationId))
        notification.show()
      },
    )
    const notificationBridge = await agentNotificationBridgeServer.start().catch((error) => {
      console.warn('Agent notification bridge unavailable; notification tool stays disabled.', error)
      agentNotificationBridgeServer = null
      return null
    })
    // 系统代理探测（PAC/手动代理均覆盖）：gateway 的 Node fetch 不读系统代理，
    // 外网端点（LLM 连通测试、ai-relay 上游、embedding/VLM）在代理环境下会
    // 整体 unreachable。注入 HTTPS_PROXY + NO_PROXY（loopback 桥接不走代理），
    // gateway 侧由 proxyFetch 的 EnvHttpProxyAgent 消费。DIRECT 环境零改动。
    const gatewayProxyEnvironment = await detectSystemProxyEnvironment()
    gatewayProxyEnv = gatewayProxyEnvironment
    // Agent 生成 Word：gateway capability 工具 → 桥 → 隐藏 GenOffice docs view
    // → file-imports 入库。失败只禁用工具，不阻塞启动。
    // 生成进度/完成事件推给所有渲染窗口（进度提示 + 完成自动打开预览）。
    officeBridgeServer = new OfficeBridgeServer(
      () => officeFilesBridge,
      broadcastOfficeAgentFileEvent,
      // Agent 编辑已打开的 slides 产物：registry 持有可编辑实例 → fork 活会话事务
      // （编辑实时重绘 + 静默保存回填版本链）。
      () => (fileId, req) => officePreviewRegistry.editSlidesArtifact(fileId, req),
      // 视觉复检：已打开 slides 产物的一页 → 1x PNG（渲染层离屏栅格化）。
      () => (fileId, slideIndex) => officePreviewRegistry.renderSlidesPagePng(fileId, slideIndex),
      // Agent 改写当前打开的 Word/Excel：字节 → 工作副本 → 版本链（含访达写回）→ 重开视图。
      () => (fileId, bytes, expectedContentHash) =>
        officePreviewRegistry.applyAgentFileBytes(fileId, bytes, expectedContentHash),
      // 活 Word/Excel 宿主执行器：read = describe（上下文+词汇表+指南）；
      // apply = 渲染层执行 docs/sheets AI 工具调用 + 静默保存（fileSaved → 版本链回填）。
      () => async (req: OfficeAgentToolsRequest): Promise<
        | { ok: true; data: Record<string, unknown> }
        | {
          ok: false
          reason: AgentArtifactFailureReason
          message?: string
          open?: unknown[]
        }
      > => {
        const hints = { roomId: req.roomId ?? null, workspaceId: req.workspaceId ?? null }
        if (req.mode === 'read') {
          const outcome = req.kind === 'docx'
            ? await officePreviewRegistry.describeDocArtifact(req.fileId, hints)
            : await officePreviewRegistry.describeSpreadsheetArtifact(req.fileId, hints)
          return outcome.ok
            ? { ok: true, data: { describe: outcome.describe } as unknown as Record<string, unknown> }
            : outcome
        }
        const calls = (req.calls ?? []).map((call) => ({
          id: call.id,
          name: call.name,
          input: call.input ?? {},
        }))
        const outcome = req.kind === 'docx'
          ? await officePreviewRegistry.applyDocAgentTools(req.fileId, calls, hints)
          : await officePreviewRegistry.applySpreadsheetAgentTools(req.fileId, calls, hints)
        return outcome.ok
          ? {
            ok: true,
            data: {
              results: outcome.results,
              ...(outcome.error ? { error: outcome.error } : {}),
              ...(outcome.version ? { version: outcome.version } : {}),
            } as unknown as Record<string, unknown>,
          }
          : outcome
      },
      // Word → PDF 导出并入库（word_export_pdf）：LibreOffice 转换 catalog 里的
      // docx，再把 PDF 作为新文件导入文件库（不覆盖原 Word）。未注入则不暴露。
      () => async (req: OfficeExportPdfRequest): Promise<
        OfficeExportPdfResult | { ok: false; message: string }
      > => {
        const files = officeFilesBridge
        if (!files) return { ok: false, message: '文件网关不可用，暂时无法导出 PDF。' }
        try {
          const catalogEntry = await files.catalogEntry(req.fileId).catch(() => null)
          const legacyEntry = catalogEntry ? null : await files.get(req.fileId).catch(() => null)
          const originalName = catalogEntry?.originalName ?? legacyEntry?.originalName ?? ''
          if (!originalName) return { ok: false, message: `文件 ${req.fileId} 不在文件库中（可能已删除）。` }
          if (!/\.docx$/i.test(originalName)) {
            return { ok: false, message: `《${originalName}》不是 Word 文档，无法导出 PDF。` }
          }
          const storagePath = await files.storagePath(req.fileId)
          const exportDirectory = join(app.getPath('userData'), 'office-exports')
          const converted = await convertOfficeFileToPdf(storagePath, originalName, exportDirectory)
          if ('unavailable' in converted) {
            return { ok: false, message: '本机未安装 LibreOffice，无法导出 PDF。' }
          }
          const rawName = (req.fileName ?? '').trim()
            || `${basename(originalName, extname(originalName))}.pdf`
          const safeName = (rawName.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120) || 'document.pdf')
          const pdfName = /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`
          try {
            const imported = await files.importAgentGeneratedFile({
              filePath: converted.pdfPath,
              originalName: pdfName,
              sourceKey: `agent:word:pdf:${req.fileId}:${Date.now()}`,
              ...(req.roomId ? { roomId: req.roomId } : {}),
              ...(req.workspaceId ? { workspaceId: req.workspaceId } : {}),
            })
            return {
              ok: true,
              fileId: imported.fileEntryId,
              originalName: pdfName,
              ...(imported.contentHash ? { contentHash: imported.contentHash } : {}),
            }
          } finally {
            await rm(converted.pdfPath, { force: true }).catch(() => undefined)
          }
        } catch (error) {
          return {
            ok: false,
            message: `导出 PDF 失败：${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    )
    // 论文排版成品落库 → 自动打开成品标签（与「预览模版」复用同一条预览管线）。
    // 没有这一步，排版成功后当前文档不会变、资料库也不自动刷新，用户只会看到
    // 「进度条走完了，但什么都没发生」。
    officeBridgeServer.setThesisProductHook(async (product) => {
      const bridge = officeFilesBridge
      if (!bridge) return
      const opened = await openFileInAppPreview(bridge, product.fileEntryId, product.originalName, {
        ...(product.workspaceId ? { workspaceId: product.workspaceId } : {}),
        // 排版是从 docs 面板发起的：把主窗口提到前台，否则成品标签开在后面看不见。
        focusWindow: true,
      })
      const request = previewRequestFromOpenResult(opened)
      if (request) notifyPreviewRequested(request)
    })
    const officeBridge = await officeBridgeServer.start().catch((error) => {
      console.warn('Office bridge unavailable; office generation tool stays disabled.', error)
      officeBridgeServer = null
      return null
    })
    agentAccessSettingsStore = new AgentAccessSettingsStore(dataDirectory)
    gatewaySupervisor = new GatewaySupervisor(
      dataDirectory,
      () => ({
        // packaged app 无 .env，gateway 默认 agentRuntime=fake（假流式响应）；
        // 显式注入 pi——AI 四要素由 runtime config 兜底（降级启动到配置完成）。
        NXCORE_AGENT_RUNTIME: 'pi',
        ...gatewayProxyEnv,
        ...(notificationBridge
          ? {
            NXCORE_NOTIFICATION_BRIDGE_URL: notificationBridge.baseUrl,
            NXCORE_NOTIFICATION_BRIDGE_TOKEN: notificationBridge.token,
          }
          : {}),
        ...(officeBridge
          ? {
            NXCORE_OFFICE_BRIDGE_URL: officeBridge.baseUrl,
            NXCORE_OFFICE_BRIDGE_TOKEN: officeBridge.token,
          }
          : {}),
        ...(ooCliBridge ? ooCliBridge.environment() : {}),
        ...connectorOoGatewayEnv,
        // 飞书导出：lark-cli 路径注入 gateway（网关只执行写入命令，授权在桌面本地）。
        ...(agentAuthController ? agentAuthController.gatewayEnvironment() : {}),
        // 文档资产桥：网关把本地图改写为该 loopback URL，lark-cli markdown 导入自动下载。
        ...(documentAssetBridge
          ? { NXCORE_DOCUMENT_ASSET_BRIDGE_URL: documentAssetBridge.baseUrl }
          : {}),
      }),
      {
        // 外部 Agent 访问（PRD 第 7 章）固定端口：连接页可设置；设置后安装到
        // 外部工具的 MCP 配置在网关重启后仍有效（随机端口会失效）。
        portProvider: () => agentAccessSettingsStore?.portProvider() ?? null,
        // gateway 连接变化（dev 热重载换端口/token）时，托管子进程指向
        // /ai-relay 的稳定 token 随之失效——联动补一次 env 同步。
        onConnectionChanged: () => {
          void runtimeConfigBridge?.get()
            .then(snapshot => (snapshot ? syncManagedChildProcesses(snapshot) : undefined))
            .catch(() => undefined)
        },
      },
    )
    // agent-access 桥只包 supervisor（ensureConnection 惰性等待网关就绪），处理器
    // 提前到 start() 前注册：否则早期 IPC 会排队等 servicesReady（全量服务初始化），
    // 冷启动即开连接页时列表加载会超时失败（需点「应用」触发二次加载才成功）。
    agentAccessGatewayBridge = new AgentAccessGatewayBridge(gatewaySupervisor)
    agentAccessInstaller = new AgentAccessInstaller()
    registerAgentAccessHandlers()
    // Agent 调试面板同理：桥只包 supervisor（ensureConnection 惰性等待网关就绪），
    // 处理器必须在 start() 前注册，否则冷启动打开面板会排队等 servicesReady。
    agentDebugGatewayBridge = new AgentDebugGatewayBridge(gatewaySupervisor)
    registerAgentDebugHandlers()
    const gateway = await gatewaySupervisor.start()
    console.info(`NxCore Gateway ready at ${gateway.baseUrl} (pid=${gateway.pid})`)
    runtimeConfigBridge = new RuntimeConfigBridge(gatewaySupervisor)
    resolveGatewayReady?.()
    // 冷启动补全服务只带 .env 透传；gateway 就绪后按已存 runtime config 补一次
    // （把「每次冷启动回退 .env」的窗口收窄到 gateway ready 之前）。配置没变
    // 不会重启任何实例。
    void runtimeConfigBridge.get()
      .then((snapshot) => syncManagedChildProcesses(snapshot))
      .catch((error) => console.warn('[managed-children] startup runtime-config sync skipped:', error))
    writingStyleGatewayBridge = new WritingStyleGatewayBridge(gatewaySupervisor)
    registerWritingStyleHandlers()
    agentSchedulerGatewayBridge = new AgentSchedulerGatewayBridge(gatewaySupervisor)
    registerAgentSchedulerHandlers()
    cursorCompletionSupervisor = new GatewaySupervisor(
      join(dataDirectory, 'cursor-completion-service'),
      // getter：惰性 respawn 时重新求值，拿到最新 runtime config 派生的 AI env。
      () => ({
        NXCORE_AGENT_RUNTIME: 'pi',
        ...gatewayProxyEnv,
        ...cursorCompletionAiEnv,
      }),
      {
        devScript: 'dev:cursor-completion',
        packagedEntry: 'cursor-completion-serve.js',
        logLabel: 'cursor-completion',
        devPortEnvironment: 'NXCORE_CURSOR_COMPLETION_DEV_PORT',
      },
    )
    registerSubagentHandlers(new SubagentGatewayBridge(gatewaySupervisor))
    // slides 配图过目卡轮询（后台逐张生成期间渲染层拉最新会话快照）。
    const slidesGatewaySupervisor = gatewaySupervisor
    handle(SLIDES_CHANNELS.pageImagesStatus, (_event, documentId: string) => {
      if (!slidesGatewaySupervisor) throw new Error('gateway_not_ready')
      return new SlidesGatewayBridge(slidesGatewaySupervisor).pageImagesStatus(documentId)
    })
    connectorGatewayBridge = new ConnectorGatewayBridge(gatewaySupervisor, (url) => shell.openExternal(url))
    // saas 连接层：授权面走 SaaS 代发起 + oo 数据面探测（客户端不持 oo admin
    // token，gateway 无法代发起）；其余数据面通道仍走 gateway。local 模式不变。
    saasConnectorBridge = new SaasConnectorBridge(gatewaySupervisor, (url) => shell.openExternal(url), {
      startAuthorization: (service) => {
        const client = saasClient
        if (!client) return Promise.reject(new Error('SaaS 客户端尚未就绪。'))
        // 预热 oo 会话：启动期换会话失败（如 SaaS 短暂不可用）后没有重试时机，
        // 授权完成前必须把探测会话与 gateway env 补齐。
        if (connectorOoUserId && !connectorOoSessionCache) {
          void fetchConnectorOoSession(connectorOoUserId)
            .then((session) => applyConnectorOoSession(session))
            .catch(() => undefined)
        }
        return client.startConnectorAuthorization(service)
      },
      ooSession: () => {
        const session = connectorOoSessionCache?.session
        return session ? { baseUrl: session.baseUrl, token: session.token } : null
      },
      oauthConfigs: () => {
        const client = saasClient
        if (!client) return Promise.reject(new Error('SaaS 客户端尚未就绪。'))
        return client.connectorOAuthConfigs()
      },
    })
    const connectorIpcBridge = connectorModeState.mode === 'saas' ? saasConnectorBridge : connectorGatewayBridge
    registerConnectorHandlers(connectorIpcBridge)
    // SaaS 会话恢复排在 gateway 启动之后：这两个网络往返（刷新令牌 + 换 oo 会话）
    // 曾经卡在 gateway spawn 之前，登录态下等于把网关启动整体推迟 1s 以上。现在
    // 网关先在后台启动，会话到位后经 /v1/connector-session 热推送（不重启进程），
    // 连接器配置不丢；未登录/暂不可达时同样不阻断启动，由账号事件钩子补拉。
    if (connectorModeState.mode === 'saas') {
      await saasClient.initialize()
      const account = await saasClient.status().catch(() => null)
      connectorOoLoginSeen = Boolean(account?.authenticated)
      connectorOoUserId = account?.authenticated ? account.user?.id ?? null : null
      await applyConnectorOoSession(
        account?.authenticated && account.user?.id
          ? await fetchConnectorOoSession(account.user.id)
          : null,
      )
    }
    // Agent status reporting is attached after the authenticated SaaS client is created below.
    registerSearchHandlers(new SearchGatewayBridge(gatewaySupervisor))
    documentGatewayBridge = new DocumentGatewayBridge(gatewaySupervisor)
    registerDocumentHandlers(documentGatewayBridge, documentAssets, obsidianVaultService)
    registerExternalDocumentHandlers(new ExternalDocumentsGatewayBridge(gatewaySupervisor))
    registerDocumentPdfExportHandler()
    registerMcpHandlers(new McpGatewayBridge(gatewaySupervisor))
    registerExternalCallHandlers(new ExternalCallsGatewayBridge(gatewaySupervisor))
    const highRiskImports = new HighRiskImportCoordinator(join(dataDirectory, 'high-risk-imports.json'), join(dataDirectory, 'backups'))
    await highRiskImports.initialize()
    const filesGatewayBridge = new FilesGatewayBridge(gatewaySupervisor, highRiskImports)
    filesGatewayBridgeRef = filesGatewayBridge
    migrationCoordinator = new MigrationCoordinator(new MigrationsGatewayBridge(gatewaySupervisor), filesGatewayBridge, () => BrowserWindow.getAllWindows()[0] ?? null, join(dataDirectory, 'migrations', 'sources.json'), join(dataDirectory, 'backups'))
    await migrationCoordinator.initialize()
    registerMigrationHandlers(migrationCoordinator)
    void migrationCoordinator.restoreCherrySync()
    officeFilesBridge = filesGatewayBridge
    // 后台 Office（Word/Excel）编辑会话：把任意 fileId 解析成可编辑工作副本
    // （catalog 优先、legacy 兜底；内容哈希必须与 prepareOfficeDocument /
    // prepareSpreadsheet 的 64-hex 契约一致）。
    officePreviewRegistry.setAgentFileResolver(async (fileId) => {
      try {
        let originalName = ''
        let contentHash = ''
        let workspaceId: string | null = null
        try {
          const entry = await filesGatewayBridge.catalogEntry(fileId)
          if (entry) {
            originalName = entry.originalName
            contentHash = entry.contentHash
            workspaceId = entry.workspaceId ?? null
          }
        } catch {
          /* fall through to legacy get */
        }
        if (!originalName) {
          const legacy = await filesGatewayBridge.get(fileId)
          originalName = legacy.originalName
          workspaceId = (legacy as { workspaceId?: string | null }).workspaceId ?? null
        }
        if (!originalName) return null
        const storagePath = await filesGatewayBridge.storagePath(fileId)
        if (!contentHash) contentHash = await hashFileBytes(storagePath)
        return { fileId, originalName, storagePath, contentHash, workspaceId }
      } catch (error) {
        console.warn('office: 后台 Office 会话解析文件失败', {
          fileId,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    })
    // Room 产物 docx 人手编辑：保存 → 去抖重导入（fileEntryId 钉条目走版本链）→ 广播刷新。
    officePreviewRegistry.setEditSync({
      importAgentFile: (input) => {
        if (!officeFilesBridge) return Promise.reject(new Error('文件网关不可用。'))
        return officeFilesBridge.importAgentGeneratedFile(input)
      },
      broadcast: broadcastOfficeAgentFileEvent,
    })
    // slides「AI 修改」弹层 → 反查 Room → 渲染层注入对话框（hook 在运行时首用时懒装）。
    officePreviewRegistry.setAgentAskForward(broadcastAgentAskEvent)
    registerFilesHandlers(filesGatewayBridge, highRiskImports)
    // 文件桥就位：排空启动前/启动中累积的「访达打开」请求。
    osOpenQueue.setHandler(openDocumentFromSystem)
    const thesisFormatBridge = new ThesisFormatGatewayBridge(gatewaySupervisor)
    thesisFormatBridgeRef = thesisFormatBridge
    registerThesisFormatHandlers(thesisFormatBridge, officePreviewRegistry, filesGatewayBridge)
    // AI 页签（docs 视图内）论文排版桥：复用同一网关实现，pick 走磁盘选择直传。
    officePreviewRegistry.setThesisPanelBridge({
      listCards: (workspaceId) => thesisFormatBridge.listCards(workspaceId),
      pickAndSet: (workspaceId, options) => pickThesisTemplateFromDisk(workspaceId, options),
      removeCard: (workspaceId, cardId) => thesisFormatBridge.removeCard(workspaceId, cardId),
      // 彻底删除：先删模版文件（连带级联清理），再删格式卡
      deleteTemplate: (workspaceId, cardId, options) =>
        thesisFormatBridge.deleteTemplate(
          workspaceId,
          cardId,
          (fileEntryId) => filesGatewayBridge.delete(fileEntryId),
          options?.keepCard === true,
        ),
      reformat: (workspaceId, fileEntryId, cardId, options) =>
        thesisFormatBridge.reformat(workspaceId, fileEntryId, cardId, options),
      // 任务化排版：面板提交作业后每秒轮询一次状态（网关 30 分钟保留，重启丢、报错清晰）
      startReformatJob: (workspaceId, fileEntryId, cardId, options) =>
        thesisFormatBridge.startReformatJob(workspaceId, fileEntryId, cardId, options),
      reformatJobStatus: (jobId) => thesisFormatBridge.reformatJobStatus(jobId),
      // 真预览：直接用 files.openOriginal 的主进程实现打开模板原文件
      previewTemplate: async (workspaceId, cardId) => {
        const cards = await thesisFormatBridge.listCards(workspaceId)
        const card = cards.find((entry) => entry.id === cardId)
        if (!card) return { opened: false, reason: 'card_not_found' }

        // 打开真预览：与应用内「打开 Office 文件」同一条路径（失败会抛错，不再静默）
        const open = async (fileId: string, originalName: string) => {
          const result = await openFileInAppPreview(filesGatewayBridge, fileId, originalName, {
            // 预览实例带着工作区：从预览页再开 AI 排版面板时仍落在同一空间。
            workspaceId,
            // 预览标签开在主窗口：从 docs 面板点预览时要把主窗口提到前台，
            // 否则用户看着 docs 窗口会觉得「点了没反应」。
            focusWindow: true,
          })
          // 光把窗口提到前台不够：实例的 WebContentsView 默认是隐藏的，可见性由
          // 渲染端驱动（开标签 → 上报矩形 → setActiveInstance）。docs 面板发起的
          // 打开不经过渲染端的 openOriginal，所以必须在这里补一条通知，否则
          // 用户看到的就是「点了 👁 完全没反应」。
          const request = previewRequestFromOpenResult(result)
          if (request) notifyPreviewRequested(request)
          return { opened: true as const }
        }

        if (card.sourceFileEntryId) {
          const meta = (await filesGatewayBridge.get(card.sourceFileEntryId).catch(() => null)) as
            | { originalName?: string } | null
          return open(card.sourceFileEntryId, meta?.originalName ?? card.sourceName ?? '模版.docx')
        }
        // 老卡片（创建于「上传自动入库」之前）没有文件条目：
        //  ① 资料区里有唯一同名文件 → 直接用那份打开
        //  ② 本次运行还留着上传字节 → 落盘导入（内容去重）后打开
        const sameName = await findLibraryFileByName(card.sourceName, workspaceId)
        if (sameName) return open(sameName, card.sourceName ?? '模版.docx')

        const cached = uploadedTemplateBytes.get(cardId)
        if (!cached) return { opened: false, reason: 'no_file' }
        const tempDir = join(app.getPath('temp'), 'everroom-thesis-preview')
        await mkdir(tempDir, { recursive: true })
        const safeName = cached.name.replace(/[\\/:*?"<>|]/g, '_') || '模版.docx'
        const tempPath = join(tempDir, `${cardId}-${safeName}`)
        await writeFile(tempPath, cached.bytes)
        const imported = await filesGatewayBridge.importPathsOnce([tempPath], { workspaceId })
        const fileId = imported.map((entry) => entry.fileId).find((id): id is string => Boolean(id))
        if (!fileId) return { opened: false, reason: 'no_file' }
        return open(fileId, cached.name)
      },
    })
    macosPushNotifications = new MacosPushNotificationService(() => saasClient, openAgentNotificationTarget)
    macosPushNotifications.install()
    registerNotificationHandlers(saasClient)
    agentStatusReporter = new AgentStatusReporter(saasClient)
    agentGatewayBridge = new AgentGatewayBridge(gatewaySupervisor, agentStatusReporter, {
      // 工作区打开的全部 Office 页签随每次 run 注入：Agent 既要知道“这份文档”
      // 指的哪一份（activeFile 由清单的 active 项推出），也要知道工作区一共
      // 开着哪些文件，才能回答“另一个文件/都开了些什么”。
      openFiles: () => officePreviewRegistry.openOfficeFiles(),
    })
    agentStatusReporter.setSessionsProvider(async () => (await agentGatewayBridge!.listAllSessionSnapshots()).map((snapshot) => ({
      ...snapshot.session,
      activeRun: snapshot.activeRun,
      lastEventSeq: snapshot.lastEventSeq,
      messages: snapshot.messages.slice(-120),
    })))
    remoteAgentCommandClient = new RemoteAgentCommandClient(saasClient, agentGatewayBridge)
    registerAgentHandlers(agentGatewayBridge, migrationCoordinator)
    // 独立 event channel：与主 Agent UI 的 'agent:event' 隔离，避免两个桥的
    // websocket 帧在渲染进程串台。
    cursorCompletionAgentBridge = new AgentGatewayBridge(cursorCompletionSupervisor, undefined, {
      eventChannel: 'cursor-completion-agent:event',
    })
    registerCursorCompletionAgentHandlers(cursorCompletionAgentBridge)
    agentStatusReporter.start()
    sessionLeaseKeeper = new SessionLeaseKeeper(saasClient, () => {
      // 设备额度被占满：拉取含准入挑战的账号状态并推给所有窗口，renderer
      // 据此进入设备准入 UI（renderer 侧 AccountContext 监听该事件）。
      const client = saasClient
      if (!client) return
      void client.status(true).then((status) => {
        for (const target of BrowserWindow.getAllWindows()) {
          if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
            target.webContents.send('account:admission-required', status)
          }
        }
      }).catch(() => undefined)
    })
    // Sentry 门控只在账号 IPC 时同步：启动时订阅拉取失败会让整个会话静默。
    // 未开闸时低频重试，网络恢复后自动补开（status() 内部有订阅缓存与退避）。
    const sentryAccountResyncTimer = setInterval(() => {
      const client = saasClient
      if (!client || isSentryRemoteDebugEnabled()) return
      void syncAccountMonitoring(client.status()).catch(() => undefined)
    }, 5 * 60_000)
    sentryAccountResyncTimer.unref()
    aiRelayKeeper = new AiRelayKeeper(saasClient, gatewaySupervisor, (event: AiRelayKeeperEvent) => {
      if (event.type === 'session-activated' || event.type === 'models-changed') {
        // relay 会话就绪后 gateway 才把槽位重写为 /ai-relay——补一次子进程
        // env 同步，闭合「boot 时会话未就绪 → 补全服务缺 LLM」的冷启动窗口。
        // models-changed：续签时 SaaS 侧套餐场景模型变更，gateway 槽位已热
        // 更新，托管子进程的 env 需要重派生。
        void runtimeConfigBridge?.get()
          .then(snapshot => (snapshot ? syncManagedChildProcesses(snapshot) : undefined))
          .catch(() => undefined)
      }
      for (const target of BrowserWindow.getAllWindows()) {
        if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
          target.webContents.send(`ai-relay:${event.type}`, event)
        }
      }
    })
    const keyring = new AccountKeyringService(join(dataDirectory, 'account-keyring.json'), join(dataDirectory, 'backups'))
    const initialAccount = await saasClient.status().catch(() => null)
    if (initialAccount?.authenticated) remoteAgentCommandClient.start()
    if (initialAccount?.authenticated) aiRelayKeeper?.start()
    if (initialAccount?.authenticated) void macosPushNotifications.registerAuthenticatedDevice()
    if (process.platform !== 'darwin') {
      const startupProtocolUrl = process.argv.find((argument) => argument.startsWith(OIDC_CALLBACK_URL))
      if (startupProtocolUrl) queuedProtocolUrls.push(startupProtocolUrl)
    }
    for (const url of queuedProtocolUrls.splice(0)) {
      if (saasClient.handleOidcCallback(url) === 'no-login-in-progress') notifyLoginCallbackDropped()
    }
    let lastAccountId = initialAccount?.user?.id ?? null
    registerAccountHandlers(saasClient, (account, context) => {
      // saas 连接层跟随登录态：登录（或切换账号）后换 oo 会话，登出即拆除。
      connectorOoLoginSeen = account.authenticated
      connectorOoUserId = account.authenticated ? account.user?.id ?? null : null
      void (account.authenticated && account.user?.id
        ? fetchConnectorOoSession(account.user.id).then((session) => applyConnectorOoSession(session))
        : applyConnectorOoSession(null))
      if (!account.authenticated && context?.explicitLogout) {
        // 显式登出：拆除中转会话后把子进程 env 同步回清空态（内置默认源与
        // BYOK user 源都是本地自足状态，无需切源；keeper.stop 幂等，下方
        // !authenticated 分支的 stop 会再跑一次空清理）。
        void aiRelayKeeper?.stop()
          .then(() => runtimeConfigBridge?.get())
          .then((snapshot) => (snapshot ? syncManagedChildProcesses(snapshot) : undefined))
          .catch(() => undefined)
      }
      if (!account.authenticated) {
        remoteAgentCommandClient?.stop()
        agentStatusReporter?.reset()
        sessionLeaseKeeper?.stop()
        aiRelayKeeper?.stop()
        lastAccountId = null
      } else {
        if (lastAccountId !== account.user?.id) agentStatusReporter?.reset()
        lastAccountId = account.user?.id ?? null
        remoteAgentCommandClient?.start()
        agentStatusReporter?.reportNow()
        sessionLeaseKeeper?.reset()
        aiRelayKeeper?.start()
        void macosPushNotifications?.registerAuthenticatedDevice()
      }
    }, () => macosPushNotifications?.beforeLogout() ?? Promise.resolve())
    registerAccountKeyringHandlers(saasClient, keyring)
    registerPermissionHandlers()

    const fileCapabilities = await filesGatewayBridge.capabilities().catch((error) => {
      console.warn('Unable to load file capabilities; automatic local scanning stays disabled.', error)
      return { items: [] }
    })
    const autoScanExtensions = new Set(fileCapabilities.items
      .filter((item) => item.autoScan && LOCAL_AUTO_SCAN_EXTENSIONS.has(item.extension.toLowerCase()))
      .map((item) => item.extension.toLowerCase()))
    const connectorImportExtensions = new Set(fileCapabilities.items
      .filter((item) => item.connectorImport)
      .map((item) => item.extension.toLowerCase()))
    const connectors = new ConnectorRegistry()
      .register(new LocalFolderConnector(autoScanExtensions, (path) => obsidianVaultService?.isPathExcluded(path) ?? false))
      .register(new GitHubConnector((key) => credentials.get(key)))
      .register(new GoogleDocsConnector((key) => credentials.get(key)))
      .register(new NotionConnector((key) => credentials.get(key)))
    localDataService = new LocalDataService(
      dataDirectory,
      connectors,
      filesGatewayBridge,
      autoScanExtensions,
      connectorImportExtensions,
      highRiskImports,
    )
    await localDataService.initialize()
    registerSourceHandlers(localDataService, credentials)
    // Default folders are only connected after the user consents in the
    // folder onboarding dialog (sources:connect-default-local-folders).
    resolveServicesReady?.()
  } catch (error) {
    rejectServicesReady?.(error instanceof Error ? error : new Error(String(error)))
    rejectGatewayReady?.(error instanceof Error ? error : new Error(String(error)))
    await agentNotificationBridgeServer?.stop()
    agentNotificationBridgeServer = null
    await officeBridgeServer?.stop()
    officeBridgeServer = null
    macosPushNotifications?.stop()
    macosPushNotifications = null
    const service = localDataService
    localDataService = null
    await service?.shutdown()
    agentGatewayBridge?.dispose()
    agentGatewayBridge = null
    remoteAgentCommandClient?.stop()
    remoteAgentCommandClient = null
    agentStatusReporter?.stop()
    agentStatusReporter = null
    cursorCompletionAgentBridge?.dispose()
    cursorCompletionAgentBridge = null
    documentGatewayBridge?.dispose()
    documentGatewayBridge = null
    agentSchedulerGatewayBridge = null
    connectorGatewayBridge = null
    await gatewaySupervisor?.shutdown()
    gatewaySupervisor = null
    await cursorCompletionSupervisor?.shutdown()
    cursorCompletionSupervisor = null
    console.error('Failed to initialize Everroom desktop services', error)
    // 静默退出 = 用户看到白屏数分钟后应用消失且毫无提示（issue #179）。
    // 用原生错误框告知原因与日志位置，再退出。
    const failureDetail = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(
      desktopText('error.gatewayStart.title'),
      desktopText('error.gatewayStart.body')
        .replace('{error}', failureDetail)
        .replace('{logs}', join(dataDirectory, 'logs')),
    )
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
  const vaults = obsidianVaultService
  const gateway = gatewaySupervisor
  const connectorCli = ooCliBridge
  const connectorRuntime = openConnectorSupervisor
  const connectorConsole = openConnectorConsoleWindow
  const cursorCompletion = cursorCompletionSupervisor
  const agentBridge = agentGatewayBridge
  const statusReporter = agentStatusReporter
  const leaseKeeper = sessionLeaseKeeper
  const relayKeeper = aiRelayKeeper
  const remoteCommands = remoteAgentCommandClient
  const cursorCompletionBridge = cursorCompletionAgentBridge
  const documentBridge = documentGatewayBridge
  const cloud = saasClient
  const notificationBridge = agentNotificationBridgeServer
  const pushNotificationsService = macosPushNotifications
  localDataService = null
  obsidianVaultService = null
  gatewaySupervisor = null
  ooCliBridge = null
  connectorConsoleBaseUrl = null
  openConnectorSupervisor = null
  openConnectorConsoleWindow = null
  cursorCompletionSupervisor = null
  agentGatewayBridge = null
  agentStatusReporter = null
  sessionLeaseKeeper = null
  remoteAgentCommandClient = null
  cursorCompletionAgentBridge = null
  documentGatewayBridge = null
  agentSchedulerGatewayBridge = null
  connectorGatewayBridge = null
  officeFilesBridge = null
  saasClient = null
  agentNotificationBridgeServer = null
  macosPushNotifications = null
  agentAuthController?.shutdown()
  agentAuthController = null
  void documentAssetBridge?.stop()
  documentAssetBridge = null
  void notificationBridge?.stop()
  pushNotificationsService?.stop()
  void officePreviewRegistry.disposeAll()
  void genofficeProtoBridge?.confirmCloseAll()
  genofficeProtoBridge = null
  if (connectorConsole && !connectorConsole.isDestroyed()) connectorConsole.destroy()
  connectorCli?.shutdown()
  agentBridge?.dispose()
  statusReporter?.stop()
  leaseKeeper?.stop()
  relayKeeper?.stop()
  remoteCommands?.stop()
  cursorCompletionBridge?.dispose()
  documentBridge?.dispose()
  cloud?.cancelOidcLogin('EverRoom 正在退出。')
  void Promise.allSettled([
    service?.shutdown(),
    vaults?.shutdown(),
    gateway?.shutdown(),
    connectorRuntime?.shutdown(),
    cursorCompletion?.shutdown(),
  ]).then(async () => {
    await flushDesktopLogs()
    if (clearUserDataOnQuit) {
      try {
        await rm(resolvedDataDirectory, { recursive: true, force: true })
      } catch (error) {
        console.error('Failed to clear EverRoom user data', error)
        clearUserDataOnQuit = false
      }
    }
    if (clearUserDataOnQuit) app.relaunch()
  }).finally(() => app.quit())
})
app.on('window-all-closed', () => app.quit())
