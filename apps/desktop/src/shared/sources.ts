export type DataSourceStatus = 'connected' | 'syncing' | 'paused' | 'disconnected' | 'error'
export type DataSourceKind = 'local-folder' | 'obsidian-vault' | 'web-page' | 'github' | 'feishu' | 'google-docs' | 'notion'
export type SourceFileStatus =
  | 'added'
  | 'updated'
  | 'renamed'
  | 'moved'
  | 'restored'
  | 'unchanged'
  | 'missing'
  | 'error'
export type EvidenceParseStatus = 'pending' | 'running' | 'success' | 'failed' | 'unsupported'

/** 全局外观主题：与 renderer styles/themes.css 的 [data-theme] 一一对应。 */
export type AppearanceThemeId = 'paper' | 'plain' | 'moss' | 'night'
export const APPEARANCE_THEME_IDS: readonly AppearanceThemeId[] = ['paper', 'plain', 'moss', 'night']
/** 主进程建窗底色：深色主题下避免首帧/缩放时闪白。 */
export const APPEARANCE_THEME_BACKGROUND: Record<AppearanceThemeId, string> = {
  paper: '#fbfaf6',
  plain: '#ffffff',
  moss: '#f4f6ef',
  night: '#15191c',
}
export function isAppearanceThemeId(value: unknown): value is AppearanceThemeId {
  return typeof value === 'string' && (APPEARANCE_THEME_IDS as readonly string[]).includes(value)
}

import type {
  AgentEvent,
  AgentAttachmentReference,
  AgentUsageRange,
  AgentUsageSnapshot,
  PendingAgentIntent,
  AgentRun,
  AgentStatusSnapshot,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  AgentSocketFrame,
  AgentWorkspace,
  AgentSpaceBackfillReport,
  AgentSpaceCacheGcResult,
  AgentSpaceCacheStats,
  AgentScratchListing,
  AgentSpaceCandidate,
  AgentSpaceDefaultRoot,
  AgentSpaceDetectResult,
  AgentSpaceLayout,
  AgentSpaceReconcileReport,
  AgentSpaceRepairReport,
  CreateAgentWorkspaceInput,
  UpdateAgentWorkspaceInput,
  MovedRoomDocument,
  MoveRoomDocumentsResult,
  SubagentInvocation,
  CreateAgentSessionInput,
  CreateAgentSessionLinkInput,
  DocumentEventFrame,
  DocumentOperation,
  DocumentOperationCommandInput,
  DocumentOperationCommandResult,
  DocumentOperationStatus,
  DocumentOperationSummary,
  DocumentBlockList,
  DocumentBlockBacklinkList,
  DocumentOverviewView,
  DocumentSectionPreviewInput,
  DocumentSectionPreviewResult,
  DocumentVersionSummary,
  DocumentVersionListOptions,
  DocumentVersionSnapshot,
  DocumentDiffResult,
  ImportRoomDocumentInput,
  RoomDocument,
  ResolveDocumentBlockReferencesInput,
  ResolveDocumentBlockReferencesResult,
  SaveRoomDocumentInput,
  StartAgentRunInput,
  SubmitPendingAgentIntentInput,
  StartDocumentOperationInput,
  UpdateAgentSessionInput,
  AgentDocumentExportMode,
  AgentDocumentExportRunView,
  AgentDocumentExportTarget,
  DocumentImportCommentDiffSummary,
  DocumentImportBatchMode,
  DocumentImportBatchView,
  DocumentImportHistoryEntry,
  DocumentImportRunView,
  ExternalDocumentCommentView,
  ExternalDocumentListResponse,
  ExternalDocumentPreview,
  ExternalDocumentProvider,
  ExternalDocumentSearchResponse,
  ImportCandidateDiffView,
  AgentPermissionMode,
  AgentPermissionModeState,
  AgentThinkingLevel,
  AgentThinkingLevelUpdate,
  WorkspaceActivityPage,
  WorkspaceActivityQuery,
} from '@nxcore/agent-contract'
import type { ObsidianVaultApi } from './obsidian'
import type { OfficeAgentAskEvent, OfficeAgentFileEvent, OfficeAskAnchor, OfficeAskQueueActionEvent, OsOpenedDocument } from './office'
import type {
  AgentAuthEnvironmentStatus,
  AgentAuthEventFrame,
  AgentAuthStartInput,
  DesktopAgentAuthChallenge,
} from './agent-auth'
import type { LocalAgentAcpAdapterInfo, LocalAgentAdapterInstallResult, LocalAgentDispatchDetail, LocalAgentHistoryImportResult, LocalAgentInstallation, LocalAgentWorkspaceBinding } from './local-agents'

export interface LocalAgentAdapterCheck {
  agentId: string
  provider: string
  displayName: string
  adapter: LocalAgentAcpAdapterInfo
}
import type { MigrationApi } from './migrations'
import type { RealityInsights } from '@nxcore/reality-contract'
import type {
  ConnectorAuthorizationAttempt,
  ConnectorConnection,
  ConnectorJsonRecord,
  ConnectorProvidersResponse,
  ConnectorRemoteAccount,
  ConnectorStatus,
  MailMessage,
  SyncMode,
  SyncRun,
  SyncScope,
  WikiDocumentPreview,
  WikiDocumentSummary,
} from '@nxcore/connector-contract'
export type {
  ConnectorProviderSummary,
  ConnectorProvidersResponse,
} from '@nxcore/connector-contract'
import type {
  OpenConnectorCommandEvent,
  OpenConnectorCommandResult,
  OpenConnectorExecutionInput,
  OpenConnectorStatus,
} from './open-connector'
import type { DesktopLocale } from './i18n/desktop'
import type {
  AgentNotificationTarget,
  CloudAgentMessagePage,
  CloudAgentSessionSummary,
  NotificationPreferences,
} from './notifications'

export interface LocalDocumentComment {
  id: string
  parentId: string | null
  blockId: string | null
  quotedText: string | null
  body: string
  authorName: string
  resolved: boolean
  createdAt: string
  updatedAt: string
}

export interface EvidenceBlock {
  id: string
  kind: 'heading' | 'paragraph'
  ordinal: number
  parentId: string | null
  headingLevel: number | null
  headingPath: string[]
  pageNumber: number | null
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  text: string
  contentHash: string
}

export interface EvidenceDocument {
  sourceId: string
  fileId: string
  versionId: string
  fileName: string
  relativePath: string
  extension: string
  modifiedAt: string
  contentHash: string
  exists: boolean
  status: EvidenceParseStatus
  parser: string | null
  error: string | null
  parsedAt: string | null
  blocks: EvidenceBlock[]
}

export interface EvidenceSearchResult extends EvidenceBlock {
  sourceId: string
  sourceName: string
  fileId: string
  fileName: string
  relativePath: string
  versionId: string
  modifiedAt: string
}

export interface SourceFileSummary {
  id: string
  name: string
  relativePath: string
  previousRelativePath: string | null
  originalPath: string
  extension: string
  size: number
  modifiedAt: string
  exists: boolean
  status: SourceFileStatus
  changedAt: string
  versionCount: number
  contentHash: string | null
  lastSeenAt: string
  parseStatus: EvidenceParseStatus
  evidenceCount: number
}

export interface MarkdownPreview {
  fileName: string
  relativePath: string
  modifiedAt: string
  content: string
}

export interface DataSourceSummary {
  id: string
  kind: DataSourceKind
  name: string
  rootPath: string
  status: DataSourceStatus
  fileCount: number
  versionCount: number
  totalBytes: number
  lastSyncedAt: string | null
  lastError: string | null
  createdAt: string
}

export interface SyncResult {
  source: DataSourceSummary
  discovered: number
  added: number
  updated: number
  moved: number
  unchanged: number
  removed: number
  failed: number
}

export type DefaultLocalFolder = 'documents' | 'desktop'

export interface DefaultLocalFolderStatus {
  folder: DefaultLocalFolder
  connected: boolean
}

export interface DefaultLocalFolderConnectionResult {
  folder: DefaultLocalFolder
  connected: boolean
  error?: string
}

export interface SourceChangeEvent {
  sourceId: string
  filesChanged: boolean
  deletion?: {
    stage: 'queued' | 'waiting' | 'database' | 'objects' | 'completed' | 'failed'
    percent: number
    message: string
  }
}

export type GatewayState = 'starting' | 'ready' | 'stopped' | 'error'

export interface GatewayStatus {
  state: GatewayState
  pid: number | null
  baseUrl: string | null
  version: string | null
  message: string | null
}

export type AsrJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AsrSegment {
  text: string
  beginTime: number
  endTime: number
  speakerId: number | string | null
  speakerName?: string | null
}

export interface AsrResult {
  transcript: string
  segments: AsrSegment[]
  insights?: RealityInsights
}

export interface AsrJob {
  id: string
  source: 'local' | 'saas'
  provider: string
  status: AsrJobStatus
  fileName: string
  languageHints: string[]
  diarizationEnabled: boolean
  contextPrompt: string
  result: AsrResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateAsrJobInput {
  filePath: string
  mode: 'local' | 'cloud'
  recordingId?: string
  durationMs?: number
  retryToken?: string
  languageHints?: string[]
  diarizationEnabled: boolean
  contextPrompt?: string
}

export interface CloudAccountStatus {
  authenticated: boolean
  apiBaseUrl: string
  /** 已保存登录凭据但网络原因无法验证（≠ 未登录）：UI 应提示网络问题并提供
   *  重试，而不是把用户踹回登录页。null/缺省 = 无此情况。 */
  authBlocked?: 'network' | null
  user?: { id:string;tenantId:string;email?:string|null;phone?:string|null;name?:string }
  device?: { id:string;name?:string;platform?:string }
  subscription?: {
    status: string
    planCode: string
    planName: string
    periodStart: string
    periodEnd: string
    quotaSeconds: number
    usedSeconds: number
    remainingSeconds: number
  }
  registration?: {
    accountCreated: boolean
    invitationApplied: boolean
    invitationRejected?: 'pro_plan_active'
  }
  /** 设备额度已满时的准入挑战：renderer 展示设备列表并选择替换。 */
  admission?: {
    reason: string
    maxDevices: number
    admissionToken: string
    expiresAt: string
    devices: CloudDevice[]
  }
}

export interface CloudDevice {
  id: string
  name: string
  platform: string
  appVersion?: string | null
  connectionStatus?: 'online' | 'offline'
  lastSeenAt: string
  createdAt?: string
}

/** 中转额度视图（`GET /app/ai-gateway/status`，按订阅周期开窗）。 */
/** 充值档位(主进程经 SaaS /app/billing/packs 拉取)。 */
export interface CreditPack {
  id: string
  code: string
  name: string
  amountCents: number
  grantQuota: number
  active: boolean
  /** credits = 积分包;pro_month = Pro 月卡(不发积分,开通 30 天订阅)。 */
  productKind?: 'credits' | 'pro_month'
}

/** 充值下单结果:approvalUrl 为 PayPal approval 页(mock:// 为本地联调协议)。 */
export interface TopupOrder {
  orderId: string
  approvalUrl: string
  provider: 'paypal' | 'mock'
}

/** 套餐档位(GET /app/plans),升级弹窗动态渲染权益。 */
export interface PlanTier {
  id: string
  code: string
  name: string
  priceCents: number
  currency: string
  entitlements: {
    asrSecondsPerPeriod?: number
    maxDevices?: number
    syncRetentionDays?: number
    llmCreditsPerPeriod?: number
    [key: string]: unknown
  }
}

export type TopupStatus = 'pending' | 'completed' | 'failed' | 'expired'

export interface AiGatewayStatus {
  configured: boolean
  subscriptionStatus: string | null
  llmCredits: number | null
  usedCredits: number
  remainingCredits: number
  /** 周期内剩余(套餐月额度口径;旧后端无此字段时等于 remainingCredits)。 */
  periodRemainingCredits?: number
  /** 充值余额(旁路,长期有效;旧后端无此字段时为 0)。 */
  topupRemainingCredits?: number
  /** 活跃充值 grant 明细(新后端下发;无此字段时只展示充值合计行)。 */
  /** 套餐周期额度(quota 原值,2026-11-04 后端起提供):进度条分母,与美元口径字段区分。 */
  planPeriodQuota?: number
  /** 额度包明细(购买+赠送):credits 字段为美元口径(quota/500000)。 */
  grants?: Array<{ id: string; remainingCredits: number; amountCredits: number; expiresAt: string | null; source?: string }>
  periodEnd: string | null
}

/** LLM 额度换算：new-api 原生 quota 单位 ↔ 美元（QuotaPerUnit 默认 500000 = $1）。 */
export const QUOTA_PER_USD = 500000

/** 用户侧积分口径：1 积分 = $0.1 = 50000 quota(展示层换算,后端 quota 一概不动)。 */
export const QUOTA_PER_CREDIT = 50000

/** quota → 积分整数(四舍五入);全面积分化后所有面向用户的额度都走这里。 */
export function formatCredits(quota: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(quota / QUOTA_PER_CREDIT))
}

export function formatLlmUsd(quota: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(quota / QUOTA_PER_USD)
}

export type AiRelayKeeperEventType = 'quota-exhausted' | 'session-activated'

/** 扫码登录 renderer 可见的展示信息（二维码载荷要素，无桌面交换凭证）。 */
export interface QrLoginPresentation {
  qrLoginSessionId: string
  qrScanToken: string
  /** 主进程组装好的完整二维码 JSON 载荷（origin 为主进程真实 SaaS 源）。 */
  qrPayload: string
  confirmationCode: string
  expiresAt: string
  status: 'pending_scan'
}

export type QrLoginStatusPayload =
  | { status: 'pending_scan'; expiresAt: string }
  | { status: 'scanned'; expiresAt: string; confirmationCode: string }
  | {
      status: 'confirmed'
      expiresAt: string
      confirmationCode: string
      account: { userId: string; displayName: string; identifierHint: string | null }
    }
  | { status: 'rejected' | 'cancelled' | 'expired' | 'exchanged' }

export type KeyringDeviceStatus = 'unregistered' | 'pending' | 'ready'

export interface AccountKeyringStatus {
  enabled: boolean
  reason?: string
  initialized: boolean
  umkId: string | null
  activeVersion: number | null
  deviceStatus: KeyringDeviceStatus
  verificationCode: string | null
}

export type CloudOidcProvider = 'apple' | 'google'

/**
 * 用户取消 OIDC 登录时主进程 reject 的固定文案。
 * preload 据此跳过全局错误上报，renderer 据此区分「取消」与「失败」——
 * 跨 IPC 只有 message 字符串可携带语义，故以常量共享三处判定。
 */
export const OIDC_LOGIN_CANCELLED_MESSAGE = '登录已取消。'

export interface DesktopRequestError {
  channel: string
  message: string
  title?: string
  severity?: 'error' | 'notice'
}

export interface RuntimeConfigSnapshot {
  config: Record<string, unknown>
  /** user 源原始 payload（脱敏后）；从未保存过自定义配置时为 null。 */
  userConfig: Record<string, unknown> | null
  source: 'user' | 'default'
  selectedSource: 'user' | 'default'
  availableSources: Array<'user' | 'default'>
  configVersion: number
  updatedAt: string
  webSearchCredential?: {
    configured: boolean
    source: 'user' | 'env' | 'none'
  }
  /** primary AI 四要素（provider/model/baseUrl/apiKey）是否已填写（占位空串视为未配置）。 */
  primaryConfigured?: boolean
}

/** gateway 侧两种密钥占位值：快照 redact() 的 "********" 与响应序列化器的 "[REDACTED]"。 */
export const RUNTIME_CONFIG_SECRET_MASKS = ['********', '[REDACTED]'] as const

/**
 * 值是否为脱敏占位。派生托管子进程 env 时掩码等同缺失：注入占位串
 * 子进程能正常起服务、随后每个上游请求静默 401；宁可整套不注入，让它明确报「未配置」。
 */
export function isMaskedRuntimeConfigSecret(value: unknown): boolean {
  return typeof value === 'string' && (RUNTIME_CONFIG_SECRET_MASKS as readonly string[]).includes(value.trim())
}

export interface RuntimeConfigTestResult {
  valid: boolean
  error?: string
  /** knowledge.embedding 四要素齐全时才返回的 /embeddings 连通测试结果。 */
  embedding?: {
    valid: boolean
    error?: string
    /** 成功时的向量维度。 */
    dimensions?: number
  }
  /** vlm 四要素齐全时才返回的 chat/completions 连通测试结果。 */
  vlm?: {
    valid: boolean
    error?: string
  }
}

export interface AgentScheduledTask {
  id: string
  agentId: string
  name: string
  description: string
  prompt?: string
  builtin: boolean
  enabled: boolean
  scheduleType: 'daily'
  localTime: string
  timezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: 'pending' | 'running' | 'completed' | 'failed' | null
  lastError: string | null
  configVersion: number
}

export interface ExportDocumentPdfInput {
  fileName: string
  title: string
  html: string
}

export type ExportDocumentPdfResult =
  | { canceled: true }
  | { canceled: false; filePath: string; fileName: string }

export type DocumentImageMimeType =
  | 'image/avif'
  | 'image/gif'
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'

export interface StoreDocumentImageInput {
  fileName: string
  mimeType: DocumentImageMimeType
  bytes: ArrayBuffer
}

export interface StoredDocumentImage {
  assetId: string
  src: string
  mimeType: DocumentImageMimeType
  bytes: number
}

export interface DesktopDiagnosticLogInput {
  module: string
  level: 'info' | 'warn' | 'error'
  event: Record<string, unknown>
}

export interface NangoRuntimeStatus {
  state: 'starting' | 'ready' | 'error' | 'disabled'
  message: string | null
}

export interface OfficeWorkspaceBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 内嵌 Office 预览的实例类型（genoffice docs / sheets / slides / pdf / markdown 运行时）。 */
export type OfficePreviewKind = 'docx' | 'spreadsheet' | 'slides' | 'pdf' | 'markdown'

/** 顶栏 Office 预览标签（对齐 ContextRoomWorkspaceTab 的标签形状）。 */
export interface OfficePreviewTab {
  id: string
  title: string
  kind: OfficePreviewKind
}

/**
 * 主进程主动发起的预览：实例已经在主进程建好（例：排版面板点 👁 预览模版原文件），
 * 渲染端只需要开一个顶栏标签并激活它。
 *
 * 少了这条通知，实例的 WebContentsView 会一直是 setVisible(false)：没人开标签、
 * 没人上报矩形、没人调 setActiveInstance，用户看到的就是「点了预览完全没反应」。
 */
export interface OfficePreviewRequest {
  instanceId: string
  title: string
  kind: OfficePreviewKind
}

/** 主进程 → 主窗口渲染端：请把已建好的预览实例显示出来。 */
export const OFFICE_PREVIEW_REQUEST_CHANNEL = 'office:preview-request'

/** 内嵌 Office 预览的文件名分流（主进程白名单与渲染端入口共用；旧格式经 LibreOffice 转换后同样内嵌）。 */
export function officePreviewKindForFileName(fileName: string): OfficePreviewKind | null {
  const dot = fileName.lastIndexOf('.')
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
  if (extension === '.docx' || extension === '.doc') return 'docx'
  if (extension === '.pptx' || extension === '.ppt') return 'slides'
  if (extension === '.xlsx' || extension === '.xlsm' || extension === '.xls') return 'spreadsheet'
  if (extension === '.pdf') return 'pdf'
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  return null
}

/** 产物库认可的 Room 文件来源：Agent 生成 + 用户导入的 Office 产物（其余 sourceKind 归资料）。 */
export const ROOM_ARTIFACT_SOURCE_KINDS = ['agent-generated', 'artifact-imported'] as const

export function isRoomArtifactSourceKind(sourceKind: string | null | undefined): boolean {
  return sourceKind === 'agent-generated' || sourceKind === 'artifact-imported'
}

/** 产物库导入的 Office 扩展名（内嵌预览/编辑覆盖的格式；PDF 走资料导入，不在此列）。 */
export const ARTIFACT_IMPORT_EXTENSIONS = [
  '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsm', '.xlsx',
] as const

export function isArtifactImportFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.')
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : ''
  return (ARTIFACT_IMPORT_EXTENSIONS as readonly string[]).includes(extension)
}

/** doc-writer 子 Agent（划词改写）dispatch 入参，见 gateway POST /v1/documents/selection-rewrite。 */
export interface SubagentSelectionRewriteInput {
  documentId?: string
  documentName?: string
  selectedText: string
  instruction?: string
  contextBefore?: string
  contextAfter?: string
  blockType?: string
  responseLanguage?: string
}

/** Agent 审批表态：bash 命令审批三态。 */
export type AgentApprovalDecision =
  | 'approved'
  | 'approved_session'
  | 'denied'

/** 网关 `/v1/agent/definition/:agentId` 的返回：内置 Agent 的人格定义。 */
export interface AgentPersonaDto {
  id: string
  name: string
  description: string
  systemPrompt: string
  skills: string[]
  capabilities: string[]
}

/**
 * 「技能」页的一行（网关 `/v1/skills`）。
 *
 * 技能是随应用发布的只读能力（内置 Agent bundle 的 SKILL.md / 子 Agent 清单），
 * 唯一可变的是 `enabled`：状态落网关 agent_skill_states，并作用到运行时装配。
 */
export interface AgentSkillDto {
  /** `<kind>:<ownerId>:<目录名>`，如 builtin:main:document-export。 */
  id: string
  name: string
  description: string
  ownerId: string
  ownerName: string
  ownerKind: 'builtin' | 'subagent' | 'user'
  /** manifest 里声明的相对路径（./skills/document-export）。 */
  path: string
  enabled: boolean
  bytes: number
  /** 最近一次显式启停的时刻；从未改过为 null。 */
  updatedAt: string | null
}

/** 技能详情（`/v1/skills/:id`）：多带 SKILL.md 全文。 */
export interface AgentSkillDetailDto extends AgentSkillDto {
  prompt: string
}

/** 手写一个用户技能（网关生成 SKILL.md frontmatter）。 */
export interface CreateAgentSkillInput {
  name: string
  description: string
  body: string
}

/** 技能清单（`/v1/skills`）。 */
export interface AgentSkillsSnapshotDto {
  skills: AgentSkillDto[]
  counts: { total: number; enabled: number }
}

/** 长期记忆条目（网关 `/v1/memory/entries`，hippo-memory 库）。 */
export interface MemoryEntryDto {
  id: string
  content: string
  tags: string[]
  strength: number
  halfLifeDays: number
  retrievalCount: number
  createdAt: string
  score: number
  /** 记忆层：episodic/semantic（hippo 原始层；整理回合会把聚集的经验合并成 semantic）。 */
  layer: string
  /** 对外类别：fact=长期事实，lesson=经验。以它为准，layer 只作参考。 */
  category?: 'fact' | 'lesson'
  /** 作用域：`workspace:<id>`；null/缺省 = 全局记忆。 */
  scope?: string | null
}

/** 画像分组（网关 `/v1/memory/profile`：聚合优先、标签兜底）。 */
export interface MemoryProfileGroupDto {
  title: string
  items: Array<{ id: string; content: string }>
}

export interface MemoryProfileDto {
  /** aggregate=模型聚合出的画像；fallback=按标签分组的原始事实；empty=记忆库为空。 */
  source: 'aggregate' | 'fallback' | 'empty'
  groups: MemoryProfileGroupDto[]
}

/**
 * 每日洞察（`/v1/journal/today`）：当天日记的**当前版本**。
 *
 * 数据源是当天新写入的长期记忆条目（见 docs/daily-journal-plan.zh-CN.md）；
 * 卡片只负责渲染，文案口径只在网关侧有一份。
 */
export interface JournalBulletDto {
  text: string
  /** 支撑该要点的证据 id（如 `memory:<id>`）；渲染层只做可追溯展示，不解析。 */
  sourceIds: string[]
}

export interface JournalActionDto {
  label: string
  /** open-file=打开证据里的真实文件；ask-agent=带着当天上下文起一条会话。 */
  kind: 'open-file' | 'ask-agent'
  /** 证据 id（`file:<fileId>` / `memory:<id>`）；不存在的目标网关侧已丢弃。 */
  targetId: string
}

export interface JournalEntryDto {
  id: string
  /** 本地时区日期（YYYY-MM-DD）。 */
  date: string
  /** 同一天的第几版（每次重写 +1）。 */
  version: number
  /** 一句话主题（≤16 字）。 */
  headline: string
  /** 2–4 句正文。 */
  summary: string
  bullets: JournalBulletDto[]
  actions: JournalActionDto[]
  /** 下一步建议（0–2 条，总结之外的可执行项）；旧条目没有该字段。 */
  advice?: string[]
  /** 产出该版本的模型名；null = 模板兜底（模型档位未就绪或调用失败）。 */
  model: string | null
  createdAt: string
}

/** 工作空间洞察（概览 B 区）：LLM 总结 + 建议；由网关派生，不落库。 */
export interface WorkspaceInsightAdviceDto {
  text: string
  /** 建议指向的会话 id；null = 无指向。 */
  sessionId: string | null
}

export interface WorkspaceInsightDto {
  /** 2–3 句状态总结；空间无工作时为空串。 */
  summary: string
  advice: WorkspaceInsightAdviceDto[]
  /** 产出模型名；null = 模板兜底（确定性聚合）。 */
  model: string | null
  /** true = 命中网关缓存（同证据指纹 5 分钟内）。 */
  cached: boolean
}

export interface JournalTodayDto {
  /** 本地时区日期（YYYY-MM-DD）。 */
  date: string
  /** null = 当天还没有可用条目（没有信号 / 正在生成 / 生成失败）。 */
  entry: JournalEntryDto | null
  status: 'pending' | 'generating' | 'ready' | 'failed'
  /** 进汇总的证据条数（当天新增记忆条数），用于卡片副标题「基于 N 条记忆」。 */
  signalCount: number
  /** status=failed 时的失败原因（一句话，可直接展示）。 */
  lastError: string | null
}

export interface NxcoreDesktopApi {
  platform: string
  app: {
    clearUserData(): Promise<void>
  }
  updater: {
    /** 当前版本、渠道与安装标识（诊断/白名单登记用） */
    getStatus(): Promise<{ version: string; channel: 'stable' | 'nightly'; installId: string; supported: boolean; lastError: string | null }>
    /** 手动检查更新：update-found=有新版正在后台下载（完成后弹窗）；no-update=已是最新 */
    checkNow(): Promise<'update-found' | 'no-update' | 'busy' | 'error'>
    /** 订阅下载进度（percent 0-100、bytesPerSecond），返回取消函数 */
    onProgress(listener: (progress: { percent: number; bytesPerSecond: number }) => void): () => void
    /** 订阅下载完成（version），返回取消函数 */
    onDownloaded(listener: (info: { version: string }) => void): () => void
    /** 订阅更新链路错误（检查/下载/校验/安装失败），返回取消函数 */
    onError(listener: (payload: { message: string }) => void): () => void
  }
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    getState(): Promise<{ maximized: boolean }>
    onMaximizedChange(listener: (maximized: boolean) => void): () => void
  }
  appearance: {
    /** 把全局外观主题持久化到主进程（窗口底色 / 原生主题跟随；渲染端仍以 localStorage 为准）。 */
    setTheme(theme: AppearanceThemeId): Promise<void>
  }
  office: {
    /** 激活指定 Office 预览实例并隐藏其余实例；null = 全部隐藏（标签仍保留）。false = 实例未找到。 */
    setActiveInstance(id: string | null): Promise<boolean>
    /** 关闭并销毁一个预览实例（标签关闭时调用）。 */
    /** 关闭预览实例；false = 可编辑实例在脏关闭守卫里被取消（保留标签）。 */
    closeInstance(id: string): Promise<boolean>
    /**
     * 干净画布：隐藏/显示 Word 编辑器操作区（Ribbon/状态栏/标尺/导航）。
     * fileId 省略 = 当前焦点 Word 页签；hidden 省略 = 切换。false = 没命中可见 Word 实例。
     */
    toggleChrome(input?: { fileId?: string; hidden?: boolean }): Promise<boolean>
    /** Doc 生成流程原型：真实走 genoffice 管线生成 docx 并入库，返回 fileId。 */
    generateDocxPrototype(input: { title: string; html: string }): Promise<{ fileEntryId: string; originalName: string }>
    setWorkspaceBounds(bounds: OfficeWorkspaceBounds): void
    /** 主进程主动打开的预览实例（渲染端负责开标签并激活；如排版面板预览模版原文件）。 */
    onPreviewRequest(listener: (request: OfficePreviewRequest) => void): () => void
    /** Agent 生成 Office 文件的进度/完成事件（完成带 fileId 用于自动打开预览）。 */
    onAgentFile(listener: (event: OfficeAgentFileEvent) => void): () => void
    /** 批注队列快照：渲染层（队列事实）→ 主进程 → 对应文件的编辑器视图（文档内锚点）。 */
    syncAskQueue(input: {
      fileId: string
      items: Array<{
        id: string
        instruction: string
        excerpt?: string
        /** 各格式自己的定位字段（Word 块索引 / Excel 区域 / PPT 元素 / PDF 页面 quads）。 */
        anchor?: OfficeAskAnchor
      }>
    }): void
    /** 文档内批注面板动作（全部发送 / 移除 / 改写一条）→ 渲染层队列事实。 */
    onAskQueueAction(listener: (event: OfficeAskQueueActionEvent) => void): () => void
    /** slides「AI 修改」弹层转发事件（切到对应 Room 并自动发送注入消息）。 */
    onAgentAsk(listener: (event: OfficeAgentAskEvent) => void): () => void
    /** Agent 改写落盘后实例被重开：渲染端需重新上报视口矩形（原生视图换了一个）。 */
    onInstanceReloaded(listener: (event: { id: string; kind: OfficePreviewKind }) => void): () => void
  }
  locale: {
    system: string
    getSystem(): Promise<string>
    set(locale: DesktopLocale): void
  }
  clipboard: {
    writeText(text: string): Promise<void>
  }
  errors: {
    onRequestError(listener: (error: DesktopRequestError) => void): () => void
    report(error: DesktopRequestError): void
  }
  diagnostics?: {
    log(input: DesktopDiagnosticLogInput): void
  }
  gateway: {
    status(): Promise<GatewayStatus>
  }
  migrations: MigrationApi
  runtimeConfig: {
    get(): Promise<RuntimeConfigSnapshot>
    saveUser(input: unknown): Promise<RuntimeConfigSnapshot>
    clearUser(): Promise<RuntimeConfigSnapshot>
    relayReady(): Promise<RuntimeConfigSnapshot | null>
    selectSource(source: 'user' | 'default'): Promise<RuntimeConfigSnapshot | undefined>
    test(): Promise<RuntimeConfigTestResult>
  }
  nangoConnector: {
    status(): Promise<ConnectorStatus>
    providers(): Promise<ConnectorProvidersResponse>
    /** SaaS 已配置 OAuth 的应用全集（连接器目录源）；null = 不可用（local 模式/未登录/旧主进程），渲染层回落网关注册表。
     *  新版主进程返回带 displayName/iconUrl 的明细（SaaS 配置即目录）；旧版只有 provider 名（仅作过滤）。 */
    oauthConfigs?(): Promise<Array<{ provider: string; displayName: string | null; iconUrl: string | null }> | string[] | null>
    startAuthorization(provider: string): Promise<ConnectorAuthorizationAttempt>
    authorizationStatus(id: string): Promise<ConnectorAuthorizationAttempt>
    /** 远端 oo 租户的活跃旧授权探测（saas 模式；local/无会话返回 null）——重连弹窗选择用。 */
    remoteAccount(provider: string): Promise<ConnectorRemoteAccount | null>
    purgeConnection(id: string): Promise<void>
    /** 重新开启：移除本地墓碑（oo 凭据保留），连接回到可见/可查询状态。 */
    reconnectConnection?(id: string): Promise<void>
  }
  cliConnector: {
    status(): Promise<OpenConnectorStatus>
    execute(input: OpenConnectorExecutionInput): Promise<OpenConnectorCommandResult>
    cancel(requestId: string): Promise<boolean>
    openConsole(): Promise<void>
    /** 发起 provider OAuth（本地直调运行时 / SaaS 代发起），返回授权页 URL 并由主进程打开。 */
    startAuthorization(service: string): Promise<{ authorizationUrl: string }>
    mode(): Promise<{ mode: 'saas' | 'local'; switchedAt: string | null }>
    setMode(mode: 'saas' | 'local'): Promise<{ mode: 'saas' | 'local'; switchedAt: string | null }>
    onEvent(listener: (event: OpenConnectorCommandEvent) => void): () => void
  }
  agentAuth: {
    status(): Promise<AgentAuthEnvironmentStatus>
    start(input: AgentAuthStartInput): Promise<DesktopAgentAuthChallenge>
    resume(challengeId: string): Promise<DesktopAgentAuthChallenge | null>
    cancel(challengeId?: string): Promise<DesktopAgentAuthChallenge | null>
    disconnect(provider: 'feishu'): Promise<AgentAuthEnvironmentStatus>
    onEvent(listener: (frame: AgentAuthEventFrame) => void): () => void
  }
  mcp: {
    listServers(): Promise<McpServersSnapshot>
    saveServers(servers: import('./mcp').McpServersMutation): Promise<McpServersSnapshot>
  }
  externalCalls: {
    listPolicies(query?: import('./external-calls').ExternalCallQuery): Promise<import('./external-calls').ExternalCallPage<import('./external-calls').ExternalCallPolicy>>
    savePolicy(input: import('./external-calls').ExternalCallPolicyInput): Promise<import('./external-calls').ExternalCallPolicy>
    deletePolicy(id: string): Promise<void>
    listUsage(query?: import('./external-calls').ExternalCallQuery): Promise<import('./external-calls').ExternalCallPage<import('./external-calls').ExternalCallUsage>>
    listAudits(query?: import('./external-calls').ExternalCallQuery): Promise<import('./external-calls').ExternalCallPage<import('./external-calls').ExternalCallAudit>>
  }
  writingStyle: {
    profile(): Promise<import('./writing-style').WritingStyleProfileDto>
    settings(): Promise<import('./writing-style').WritingStyleSettingsDto>
    updateSettings(input: Partial<Pick<import('./writing-style').WritingStyleSettingsDto, 'completionEnabled' | 'generationEnabled'>>): Promise<import('./writing-style').WritingStyleSettingsDto>
    userContent(): Promise<import('./writing-style').WritingStyleUserContentDto>
    replaceUserContent(content: string): Promise<import('./writing-style').WritingStyleUserContentDto>
    regenerateUserContent(): Promise<import('./writing-style').WritingStyleUserContentDto>
    recompute(): Promise<{ queuedDocuments: number }>
    backfill(): Promise<{ queuedDocuments: number }>
    corpus(): Promise<{ documents: Array<import('./writing-style').WritingStyleCorpusEntryDto> }>
    setExclusion(documentId: string, excluded: boolean): Promise<{ ok: boolean }>
    insights(): Promise<{ insights: Array<import('./writing-style').WritingStyleInsightDto> }>
    snoozeInsight(insightId: string): Promise<import('./writing-style').WritingStyleInsightDto>
    confirmInsight(insightId: string): Promise<import('./writing-style').WritingStyleInsightDto>
    reportCompletionFeedback(input: { accepted: number; rejected: number; samples?: string[] }): Promise<{ ok: boolean }>
  }
  agentSchedules: {
    list(): Promise<AgentScheduledTask[]>
    create(input: { agentId: string; name: string; description?: string; prompt: string; localTime?: string; timezone?: string; enabled?: boolean }): Promise<AgentScheduledTask>
    update(id: string, input: Partial<Pick<AgentScheduledTask, 'name' | 'description' | 'prompt' | 'enabled' | 'localTime' | 'timezone'>> & { configVersion: number }): Promise<AgentScheduledTask>
    remove(id: string): Promise<void>
    runNow(id: string): Promise<{ runId: string }>
  }
  agentAccess: {
    listConnections(): Promise<{ connections: import('./agent-access').AgentConnectionDto[] }>
    createConnection(input: import('./agent-access').AgentAccessCreateInput): Promise<{ connection: import('./agent-access').AgentConnectionDto; token: string }>
    updateConnection(id: string, input: import('./agent-access').AgentAccessUpdateInput): Promise<{ connection: import('./agent-access').AgentConnectionDto }>
    revokeConnection(id: string): Promise<{ connection: import('./agent-access').AgentConnectionDto }>
    rotateToken(id: string): Promise<{ connection: import('./agent-access').AgentConnectionDto; token: string }>
    submissions(id: string): Promise<{ submissions: Array<Record<string, unknown>> }>
    events(id: string): Promise<{ events: Array<Record<string, unknown>> }>
    selftest(id: string): Promise<import('./agent-access').AgentAccessSelftestDto>
    exampleQuery(id: string, query?: string): Promise<import('./agent-access').AgentAccessExampleQueryDto>
    install(connectionId: string, target: string, token: string): Promise<{ outcome: import('./agent-access').AgentAccessInstallOutcomeDto; plan: { url: string; notes: string[] } }>
    uninstall(target: string): Promise<import('./agent-access').AgentAccessUninstallOutcomeDto>
    settingsGet(): Promise<import('./agent-access').AgentAccessSettingsDto>
    setFixedPort(port: number | null): Promise<{ fixedPort: number | null; needsRestart: boolean }>
    restartGateway(): Promise<{ baseUrl: string }>
  }
  memory: {
    listEntries(input?: { limit?: number; scope?: string }): Promise<{ items: MemoryEntryDto[] }>
    /** 「智能体 → 用户画像」：聚合优先、标签兜底（分组口径在网关侧维护）。 */
    getProfile(input?: { limit?: number }): Promise<MemoryProfileDto>
  }
  journal: {
    /** 当天日记的当前版本（无条目时 entry=null，不是错误）。 */
    today(): Promise<JournalTodayDto>
    /** 手动重写当天（绕过最小间隔，仍受去抖与单飞行保护）。 */
    refresh(): Promise<JournalTodayDto>
  }
  workspaceInsight: {
    /** 工作空间洞察（概览 B 区）：LLM 总结 + 建议；force 跳过网关缓存。 */
    get(workspaceId: string, options?: { force?: boolean }): Promise<WorkspaceInsightDto>
  }
  /**
   * 工作空间「计划」（任务 / todo）。
   *
   * 读写都走普通 invoke：写失败要冒泡给看板回滚（读失败由页面自己渲染空态）。
   * `onChanged` 是网关 SSE 转发的实时变更，用于"Agent 认领后卡片自己动"。
   */
  plan: {
    list(query: import('@nxcore/agent-contract').PlanItemListQuery): Promise<{ items: import('@nxcore/agent-contract').PlanItem[] }>
    create(input: import('@nxcore/agent-contract').CreatePlanItemInput): Promise<import('@nxcore/agent-contract').PlanItem>
    get(itemId: string): Promise<import('@nxcore/agent-contract').PlanItem>
    update(itemId: string, input: import('@nxcore/agent-contract').UpdatePlanItemInput): Promise<import('@nxcore/agent-contract').PlanItem>
    move(itemId: string, input: import('@nxcore/agent-contract').MovePlanItemInput): Promise<import('@nxcore/agent-contract').PlanItem>
    release(itemId: string, reason: string): Promise<import('@nxcore/agent-contract').PlanItem>
    /** 交给 Agent：建会话 + 起 run，返回绑定的会话与 run。 */
    assign(itemId: string, agentId?: string): Promise<import('@nxcore/agent-contract').PlanAssignResult>
    /** 删除 = 取消（可恢复）。 */
    remove(itemId: string): Promise<import('@nxcore/agent-contract').PlanItem>
    events(itemId: string): Promise<{ events: import('@nxcore/agent-contract').PlanItemEvent[] }>
    /** 认领包预览（详情页"Agent 会看到什么"）。 */
    claimPackage(itemId: string): Promise<import('@nxcore/agent-contract').PlanClaimPackage>
    /** 批量移动 / 取消（多选后操作；单条失败不影响其它条）。 */
    batch(input: import('@nxcore/agent-contract').PlanBatchInput): Promise<import('@nxcore/agent-contract').PlanBatchResult>
    /** 订阅本空间的实时变更（每窗口一条）。 */
    subscribe(workspaceId: string): Promise<void>
    /** 不传 workspaceId = 退订本窗口全部计划流。 */
    unsubscribe(workspaceId?: string): Promise<void>
    onChanged(listener: (payload: import('@nxcore/agent-contract').PlanChangePayload) => void): () => void
  }
  agentDebug: {
    listAgents(): Promise<import('./agent-debug').AgentDebugAgentsResponse>
    getAgent(id: string): Promise<import('./agent-debug').AgentDebugAgentResponse>
    /** 使用记录（内置 Agent = agent_runs，子 Agent = subagent_invocations）。 */
    listUsage(id: string, limit?: number): Promise<import('./agent-debug').AgentDebugUsageResponse>
    /** 打开独立调试窗口（单例；已打开时聚焦）。 */
    openWindow(): Promise<void>
  }
  slides: {
    pageImagesStatus(documentId: string): Promise<import('./slides').SlidesPageImagesStatus | null>
  }
  subagents: {
    dispatchSelectionRewrite(input: SubagentSelectionRewriteInput): Promise<{ invocationId: string }>
    getSubagentInvocation(invocationId: string): Promise<SubagentInvocation>
    cancelSubagentInvocation(invocationId: string): Promise<SubagentInvocation>
    listRunSubagentInvocations(rootRunId: string): Promise<import('@nxcore/agent-contract').SubagentInvocationNode[]>
    listSubagentInvocationEvents(invocationId: string, afterSeq?: number): Promise<import('@nxcore/agent-contract').SubagentInvocationEvent[]>
  }
  account: {
    status(options?: { quiet?: boolean }): Promise<CloudAccountStatus>
    devices(options?: { quiet?: boolean }): Promise<CloudDevice[]>
    login(input:{identifier:string;password:string}): Promise<CloudAccountStatus>
    validateInvitationCode(invitationCode: string): Promise<{ valid: true }>
    redeemInvitationCode(invitationCode: string): Promise<{ applied: boolean; rejected?: 'pro_plan_active' }>
    loginWithOidc(provider: CloudOidcProvider, invitationCode?: string): Promise<CloudAccountStatus>
    cancelOidcLogin(): Promise<void>
    logout(): Promise<CloudAccountStatus>
    keyringStatus(options?: { quiet?: boolean }): Promise<AccountKeyringStatus>
    createPairingSession(): Promise<{ pairingSessionId: string; pairingToken?: string; status: string; confirmationCode: string; expiresAt: string; origin?: string }>
    getPairingSession(id: string, options?: { quiet?: boolean }): Promise<{ pairingSessionId: string; status: string; confirmationCode: string; expiresAt: string; targetDeviceId?: string | null; targetDeviceName?: string | null; targetPublicKey?: string | null; targetAlgorithm?: string | null }>
    approvePairingSession(id: string): Promise<{ pairingSessionId: string; status: string; targetDeviceId?: string | null }>
    /** 扫码登录：返回的展示信息只含 qrScanToken（进入二维码），无桌面交换凭证。 */
    createQrLoginSession(): Promise<QrLoginPresentation>
    getQrLoginStatus(sessionId?: string): Promise<QrLoginStatusPayload>
    exchangeQrLoginSession(sessionId?: string): Promise<CloudAccountStatus>
    cancelQrLoginSession(sessionId?: string): Promise<void>
    replaceDeviceAdmission(input: { admissionToken: string; replaceDeviceId: string }): Promise<CloudAccountStatus>
    dismissDeviceAdmission(): Promise<{ dismissed: boolean }>
    onAdmissionRequired(listener: (status: CloudAccountStatus) => void): () => void
  }
  aiRelay: {
    /** 中转额度视图（订阅周期开窗）；未登录/未配置时为 null。 */
    status(): Promise<AiGatewayStatus | null>
    /** SaaS 权威额度判定；keeper 未启动/未判定时 false。 */
    verdict(): Promise<{ quotaExhausted: boolean }>
    onEvent(listener: (event: { type: AiRelayKeeperEventType }) => void): () => void
  }
  billing: {
    /** 充值档位(登录后可用)。 */
    packs(): Promise<CreditPack[]>
    /** 下单:真实渠道时主进程自动用系统浏览器打开 approval 页。 */
    topup(packCode: string): Promise<TopupOrder>
    /** 订单状态轮询(pending 时服务端主动核对渠道)。 */
    topupStatus(orderId: string): Promise<{ status: TopupStatus; amountCents: number }>
    /** Mock 联调批准;真实渠道服务端 409。 */
    topupMockApprove(orderId: string): Promise<{ status: 'completed'; amountCents: number }>
    /** 套餐档位列表(升级弹窗)。 */
    plans(): Promise<PlanTier[]>
  }
  notifications: {
    preferences(): Promise<NotificationPreferences>
    updatePreferences(input: Partial<NotificationPreferences>): Promise<NotificationPreferences>
    cloudSessions(deviceId: string): Promise<CloudAgentSessionSummary[]>
    cloudMessages(deviceId: string, sessionId: string, before?: string): Promise<CloudAgentMessagePage>
    onOpenTarget(listener: (target: AgentNotificationTarget) => void): () => void
  }
  permissions: {
    /** OS 麦克风授权状态（本地 TCC 查询，不经网关）。 */
    getMicrophoneAccessStatus(): Promise<'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'>
    /** 弹出系统麦克风授权请求（本地 TCC，不经网关）。 */
    requestMicrophoneAccess(): Promise<boolean>
    /** 打开系统「麦克风」隐私设置页。 */
    openMicrophoneSettings(): Promise<void>
  }
  search: {
    invoke(request: SearchRequestDto): Promise<SearchPageDto>
    status(): Promise<SearchScopeDto>
    prioritize(itemType: SearchItemType, refId: string): Promise<{ ok: boolean }>
    messageContext(messageId: string, before?: number, after?: number): Promise<SearchMessageContextDto>
  }
  agent: {
    discoverLocalAgents(): Promise<LocalAgentInstallation[]>
    checkLocalAgentAdapters(agentIds: string[]): Promise<LocalAgentAdapterCheck[]>
    installLocalAgentAdapter(agentId: string): Promise<LocalAgentAdapterInstallResult>
    importLocalAgentHistory(agentId: string): Promise<LocalAgentHistoryImportResult>
    bindLocalAgentWorkspace(agentId: string, sessionId: string): Promise<LocalAgentWorkspaceBinding | null>
    getStatus(): Promise<AgentStatusSnapshot>
    /** 单个 Agent 的人格定义（名称/简介/系统提示词/技能）；网关未知 agent 时 null。 */
    getDefinition(agentId: string): Promise<AgentPersonaDto | null>
    /** 技能清单（「技能」页）：内置 Agent bundle + 子 Agent 清单的 SKILL.md。 */
    listSkills(): Promise<AgentSkillsSnapshotDto>
    /** 单个技能详情（含 SKILL.md 全文）；不存在时 null。 */
    getSkill(skillId: string): Promise<AgentSkillDetailDto | null>
    /** 启停一个技能；网关会随即重装运行时，使其立刻生效。 */
    setSkillEnabled(skillId: string, enabled: boolean): Promise<AgentSkillDto>
    /** 手写一个用户技能（落在网关数据目录的 agent/skills 下）。 */
    createSkill(input: CreateAgentSkillInput): Promise<AgentSkillDto>
    /** 从一个含 SKILL.md 的本地文件夹导入技能。 */
    importSkillDirectory(sourceDirectory: string): Promise<AgentSkillDto>
    /** 选择技能文件夹（系统选择器，返回绝对路径；取消为 null）。 */
    pickSkillDirectory(): Promise<string | null>
    /** 删除一个用户技能（内置/子 Agent 技能会 409）。 */
    deleteSkill(skillId: string): Promise<void>
    getUsage(range?: AgentUsageRange): Promise<AgentUsageSnapshot>
    /** 「+ → 挂载目录」：系统选择框选本地目录，取消返回 null。 */
    pickMountDirectory(): Promise<string | null>
    /** 列表；workspaceId 可选（P1 起按空间过滤，缺省仍返回全量，兼容旧调用）。 */
    listSessions(pageLabel?: string, roomId?: string | null, workspaceId?: string): Promise<AgentSession[]>
    createSession(input: CreateAgentSessionInput): Promise<AgentSession>
    createSessionLink(input: CreateAgentSessionLinkInput): Promise<AgentSessionLink>
    listSessionLinks(sessionId: string): Promise<AgentSessionLink[]>
    markSessionLinkReturned(linkId: string): Promise<AgentSessionLink>
    updateSession(sessionId: string, input: UpdateAgentSessionInput): Promise<AgentSession>
    generateSessionTitle(input: {
      sessionId: string
      userText: string
      assistantText: string
      language?: string
    }): Promise<{ title: string }>
    suggestConversationPrompt(input: {
      sessionId: string | null
      pageLabel?: string
      roomTitle: string | null
      messages: Array<{ role: 'user' | 'assistant'; text: string }>
      recentSessions?: Array<{ title: string | null; updatedAt: string }>
      language?: string
    }): Promise<{ suggestion: string }>
    suggestStarterPrompts(input: {
      pageLabel?: string
      roomTitle: string | null
      recentSessions: Array<{ title: string | null; updatedAt: string }>
      language?: string
    }): Promise<{ prompts: string[] }>
    deleteSession(sessionId: string): Promise<void>
    getSession(sessionId: string): Promise<AgentSessionSnapshot>
    getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
    getLocalAgentDispatch(sessionId: string, taskId: string): Promise<LocalAgentDispatchDetail>
    startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
    submitPendingIntent(
      intentId: string,
      input: SubmitPendingAgentIntentInput,
    ): Promise<{ intent: PendingAgentIntent; run: AgentRun }>
    cancelRun(runId: string): Promise<AgentRun>
    resolveApproval(
      approvalId: string,
      decision: AgentApprovalDecision,
      feedback?: string,
      choice?: string,
      text?: string,
    ): Promise<{ approvalId: string; decision: string }>
    getPermissionMode(sessionId: string): Promise<AgentPermissionModeState>
    setPermissionMode(sessionId: string, mode: AgentPermissionMode): Promise<{ mode: AgentPermissionMode; applied: boolean }>
    /** 会话思考档位（null=跟随模型配置）；返回后端权威回读值。 */
    setThinkingLevel(sessionId: string, level: AgentThinkingLevel | null): Promise<AgentThinkingLevelUpdate>
    subscribe(sessionId: string): Promise<void>
    /** 不传 workspaceId = 退订本窗口全部计划流。 */
    unsubscribe(workspaceId?: string): Promise<void>
    onEvent(listener: (frame: AgentSocketFrame) => void): () => void
  }
  /** 工作区（Workspace）：本地目录 + 会话组织容器；默认工作区永远存在。 */
  workspace: {
    list(): Promise<AgentWorkspace[]>
    create(input: CreateAgentWorkspaceInput): Promise<AgentWorkspace>
    update(workspaceId: string, input: UpdateAgentWorkspaceInput): Promise<AgentWorkspace>
    /**
     * 概览「动态」：网关按 (at, id) 游标派生的一页事件
     * （runs + 文件库 + 计划事件流）。无桥/失败由调用方降级为本地派生。
     */
    activities(workspaceId: string, query?: WorkspaceActivityQuery): Promise<WorkspaceActivityPage>
    remove(workspaceId: string): Promise<void>
    /** 原生目录选择器；用户取消返回 null。 */
    pickDirectory(): Promise<string | null>
    /** 默认落点预览：`<dataDir>/Workspace/<slug>`；目录服务不可用时返回 null。 */
    defaultRoot(name: string): Promise<AgentSpaceDefaultRoot | null>
    /** 判定目录是否为项目空间（只要 `.everoffice/space.json` 可解析就算）。 */
    detect(dir: string): Promise<AgentSpaceDetectResult>
    /** 扫容器根，发现磁盘上的项目空间（含是否已注册）。 */
    discover(): Promise<AgentSpaceCandidate[]>
    /** 接管已有目录为项目空间（复制品需显式 reassignSpaceId）。 */
    adopt(input: { dir: string; name?: string; reassignSpaceId?: boolean }): Promise<AgentWorkspace>
    /** 搬移空间目录（整个目录跟着走）。 */
    relocate(workspaceId: string, dir: string): Promise<AgentWorkspace>
    /** 空间目录快照（路径 + 健康）。未绑定目录时抛错，调用方按空态处理。 */
    layout(workspaceId: string): Promise<AgentSpaceLayout>
    /** 幂等修复：补缺失目录 / 补缺失标记。 */
    repair(workspaceId: string): Promise<AgentSpaceRepairReport>
    /** 在访达里选中某个目录。 */
    reveal(dir: string): Promise<boolean>
    /** 资料库对账（盘上删了→missing、回来了→恢复、多了→入库）。 */
    reconcileLibrary(workspaceId: string): Promise<AgentSpaceReconcileReport>
    /** 存量懒回填：把只在对象库里的老条目落到空间 Library。 */
    backfillLibrary(workspaceId: string, limit?: number): Promise<AgentSpaceBackfillReport>
    /** 空间缓存占用（tmp / derived / objects）。 */
    cacheStats(workspaceId: string): Promise<AgentSpaceCacheStats>
    /** 缓存回收（tmp/derived 按龄、objects 按引用、回收站 30 天）。 */
    gcCache(workspaceId: string): Promise<AgentSpaceCacheGcResult>
    /** `.tmp/` 只读清单（「临时文件」入口，不入资料库索引、不写库）。 */
    scratchFiles(workspaceId: string): Promise<AgentScratchListing>
  }
  cursorCompletionAgent: {
    createSession(input: CreateAgentSessionInput): Promise<AgentSession>
    deleteSession(sessionId: string): Promise<void>
    getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
    startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
    cancelRun(runId: string): Promise<AgentRun>
    subscribe(sessionId: string): Promise<void>
    /** 不传 workspaceId = 退订本窗口全部计划流。 */
    unsubscribe(workspaceId?: string): Promise<void>
    onEvent(listener: (frame: AgentSocketFrame) => void): () => void
  }
  documents: {
    list(roomId: string): Promise<RoomDocument[]>
    listTrash(roomId: string): Promise<RoomDocument[]>
    get(documentId: string): Promise<RoomDocument>
    readMarkdown(documentId: string): Promise<{ markdown: string }>
    listBlocks(documentId: string): Promise<DocumentBlockList>
    listBlockBacklinks(documentId: string, blockId?: string): Promise<DocumentBlockBacklinkList>
    listVersions(documentId: string, options?: DocumentVersionListOptions): Promise<DocumentVersionSummary[]>
    getVersionSnapshot(documentId: string, version: number): Promise<DocumentVersionSnapshot>
    getDiff(documentId: string, fromVersion: number | null, toVersion: number): Promise<DocumentDiffResult>
    versionChangeSummary(documentId: string, version: number): Promise<{ version: number; summary: string; source: 'ai' | 'local' }>
    listDocumentComments(documentId: string): Promise<{ items: LocalDocumentComment[] }>
    createDocumentComment(documentId: string, input: { body: string; parentId?: string | null; blockId?: string | null; quotedText?: string | null }): Promise<LocalDocumentComment>
    resolveDocumentComment(documentId: string, commentId: string, resolved: boolean): Promise<LocalDocumentComment>
    deleteDocumentComment(documentId: string, commentId: string): Promise<void>
    getOverview(documentId: string): Promise<DocumentOverviewView>
    generateOverview(documentId: string): Promise<DocumentOverviewView>
    getSectionPreview(documentId: string, input: DocumentSectionPreviewInput): Promise<DocumentSectionPreviewResult>
    restoreVersion(documentId: string, version: number, baseVersion: number): Promise<RoomDocument>
    resolveBlockReferences(input: ResolveDocumentBlockReferencesInput): Promise<ResolveDocumentBlockReferencesResult>
    listOperations(filters?: {
      roomId?: string
      documentId?: string
      sessionId?: string
      status?: DocumentOperationStatus
    }): Promise<DocumentOperationSummary[]>
    startOperation(input: StartDocumentOperationInput): Promise<DocumentOperation>
    getOperation(operationId: string, context?: { roomId: string | null; sessionId: string; runId: string }): Promise<DocumentOperation>
    executeOperationCommand(
      operationId: string,
      input: DocumentOperationCommandInput,
    ): Promise<DocumentOperationCommandResult>
    storeImage(documentId: string, input: StoreDocumentImageInput): Promise<StoredDocumentImage>
    import(input: ImportRoomDocumentInput): Promise<RoomDocument>
    save(documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument>
    delete(documentId: string): Promise<void>
    move(documentId: string, fromRoomId: string, roomId: string): Promise<MovedRoomDocument>
    moveMany(documentIds: string[], fromRoomId: string, roomId: string): Promise<MoveRoomDocumentsResult>
    restore(documentId: string): Promise<RoomDocument>
    deletePermanently(documentId: string): Promise<void>
    emptyTrash(roomId: string): Promise<void>
    exportPdf(input: ExportDocumentPdfInput): Promise<ExportDocumentPdfResult>
    subscribe(roomId: string): Promise<void>
    unsubscribe(roomId?: string): Promise<void>
    onEvent(listener: (frame: DocumentEventFrame) => void): () => void
    onOperationChanged(listener: (operationId: string) => void): () => void
    onReady(listener: (roomId: string) => void): () => void
  }
  externalDocuments: {
    importSearch(provider: ExternalDocumentProvider, query: string): Promise<ExternalDocumentSearchResponse>
    /** 连接器页按连接列举（飞书云空间+知识库 / Notion 共享页面）；cachedOnly 时读上次缓存；
     *  mode=full 全量替换（重新拉取/对账），mode=delta 增量合并、不可用回退全量。 */
    importList(provider: ExternalDocumentProvider, connectionName?: string, cachedOnly?: boolean, mode?: 'full' | 'delta'): Promise<ExternalDocumentListResponse>
    importBatch(input: {
      provider: ExternalDocumentProvider
      connectionName?: string
      remoteDocumentIds: string[]
      mode: DocumentImportBatchMode
      roomId?: string
      /** true：跳过来源去重，同来源一律新建（UI"创建新的"）。 */
      forceNew?: boolean
    }): Promise<{ batchId: string; total: number }>
    importBatchStatus(batchId: string): Promise<DocumentImportBatchView>
    /** 面板重挂载找回进行中批次（按 provider+连接名查最近一条 running，无则 null）。 */
    activeImportBatch(provider: ExternalDocumentProvider, connectionName?: string): Promise<DocumentImportBatchView | null>
    cancelImportBatch(batchId: string): Promise<DocumentImportBatchView>
    importPreview(provider: ExternalDocumentProvider, remoteDocumentId: string): Promise<ExternalDocumentPreview>
    importCommit(input: { runId: string; roomId: string; targetDocumentId?: string }): Promise<{
      run: DocumentImportRunView
      roomImportId: string | null
      relation: 'primary' | 'candidate'
      /** 远端内容与已应用快照相同：未创建候选/记录。 */
      noChange?: boolean
      documentId: string
    }>
    importRun(runId: string): Promise<DocumentImportRunView>
    cancelImportRun(runId: string): Promise<DocumentImportRunView>
    importHistory(documentId: string): Promise<{
      entries: DocumentImportHistoryEntry[]
      commentDiff: DocumentImportCommentDiffSummary | null
      comments: ExternalDocumentCommentView[]
    }>
    importDiff(roomImportId: string): Promise<{
      candidateTitle: string
      currentTitle: string
      appliedVersion: number | null
      hunks: Array<{ type: 'ctx' | 'add' | 'del'; text: string }>
      commentsComparable: boolean
    }>
    /** 候选 vs 当前版本的结构化 diff（复用版本 diff UI 契约）。 */
    importStructuredDiff(roomImportId: string): Promise<ImportCandidateDiffView>
    searchExportTargets(provider: ExternalDocumentProvider, query: string): Promise<{
      items: Array<{ remoteId: string; title: string; url: string; updatedAt: string | null; ownerName: string | null }>
    }>
    checkExternalUpdate(documentId: string): Promise<{
      run: DocumentImportRunView
      roomImportId: string | null
      relation: 'primary' | 'candidate'
      noChange?: boolean
      documentId: string
    }>
    applyCandidate(roomImportId: string): Promise<{ documentId: string; version: number }>
    createExport(input: {
      roomId: string
      documentId: string
      version?: number
      provider: ExternalDocumentProvider
      mode: AgentDocumentExportMode
      target?: AgentDocumentExportTarget | null
    }): Promise<AgentDocumentExportRunView>
    getExport(exportId: string): Promise<AgentDocumentExportRunView>
    confirmExport(exportId: string): Promise<AgentDocumentExportRunView>
    retryExport(exportId: string): Promise<AgentDocumentExportRunView>
    cancelExport(exportId: string): Promise<AgentDocumentExportRunView>
    listExports(documentId?: string): Promise<{ items: AgentDocumentExportRunView[] }>
  }
  sources: {
    list(): Promise<DataSourceSummary[]>
    listFiles(id: string): Promise<SourceFileSummary[]>
    listEvidence(id: string, fileId: string): Promise<EvidenceDocument>
    previewFile(id: string, fileId: string): Promise<MarkdownPreview>
    searchEvidence(query: string, id?: string): Promise<EvidenceSearchResult[]>
    onChanged(listener: (event: SourceChangeEvent) => void): () => void
    showFile(id: string, fileId: string): Promise<void>
    addLocalFolder(): Promise<SyncResult | null>
    listDefaultLocalFolders(): Promise<DefaultLocalFolderStatus[]>
    connectDefaultLocalFolders(folders: DefaultLocalFolder[]): Promise<DefaultLocalFolderConnectionResult[]>
    addGitHub(input: { repository: string; branch?: string; token?: string; syncIssues?: boolean }): Promise<SyncResult>
    addGoogleDocs(input: { documentIds: string[]; token: string }): Promise<SyncResult>
    addNotion(input: { pageIds: string[]; token: string }): Promise<SyncResult>
    sync(id: string): Promise<SyncResult>
    setPaused(id: string, paused: boolean): Promise<DataSourceSummary>
    disconnect(id: string, deleteLocalData: boolean): Promise<void>
  }
  obsidian: ObsidianVaultApi
  files: {
    list(limit?: number, offset?: number, options?: { workspaceId?: string }): Promise<{ items: FileCatalogDto[]; total: number }>
    catalogEntry(fileId: string): Promise<FileCatalogDto>
    get(fileId: string): Promise<FileDto & { storagePath: string; currentParsedId: string | null }>
    /** 解析产物 markdown（未进过链路的裸上传 404）。 */
    readMarkdown(fileId: string, options?: { waitMs?: number; pollMs?: number }): Promise<{ markdown: string }>
    readDataUrl(fileId: string): Promise<{ dataUrl: string }>
    rename(fileId: string, displayName: string): Promise<FileCatalogDto>
    /** 删除：级联 knowledge cleanup + 对象库 GC。 */
    delete(fileId: string): Promise<{
      deleted: boolean
      knowledgeCleanup: boolean
      blobCollected: boolean
    }>
    /** 在系统文件管理器中定位文件本体。 */
    reveal(fileId: string): Promise<void>
    /** 把文件本体按原始文件名复制到 ~/Downloads/EverOffice/（同名覆盖）并在系统文件管理器中定位。 */
    exportReveal(fileId: string, originalName: string): Promise<void>
    /** DOCX/XLSX/XLSM/PPTX 用内置 Office 预览标签打开（可多开，instanceId=fileId）；其他格式走操作系统默认查看器。
     * originalName/contentHash 缺省时（Context Room 等只带 fileId 的入口）由主进程向网关补齐。
     * options.editable：可直接编辑（保存回填同一 fileEntryId 的新版本）；缺省只读。 */
    openOriginal(
      fileId: string,
      originalName?: string,
      contentHash?: string,
      options?: { editable?: boolean; roomId?: string; workspaceId?: string; focusWindow?: boolean },
    ): Promise<
      | { openedWith: 'office'; instanceId: string; kind: OfficePreviewKind; title: string }
      /** legacyFallback：旧版 .doc/.xls/.ppt 转换失败，已交给系统默认应用。 */
      | { openedWith: 'external'; legacyFallback?: boolean }
    >
    /** 统一导入：选择框 → /v1/files → /v1/ingest（逐文件结果）。roomId（Room 内上传）= 显式归属直达该 Room；
     * workspaceId = 归属工作空间（资料库/产物库按空间隔离，缺省归 default）。 */
    pickAndImport(options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }): Promise<FileImportOutcome[]>
    /** 仅选择：返回文件/文件夹路径，不导入（创建 Room 弹窗暂存用）。 */
    pickPaths(): Promise<string[]>
    /** 提交后的一次性导入：把暂存路径交给统一导入链路。 */
    importPaths(paths: string[], options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }): Promise<FileImportOutcome[]>
    /** 拖拽文件/目录的一次性导入；不注册数据源，也不持续监听。 */
    importDropped(files: File[], options?: { pipelines?: IngestPipelines; roomId?: string; workspaceId?: string }): Promise<FileImportOutcome[]>
    /** 产物库导入：本地 Office 文件以 artifact-imported 直达 Room 产物库（成功项逐个回报）。
     *  workspaceId = 归属工作空间（产物库按空间隔离，缺省归 default）。 */
    importArtifacts(files: File[], roomId: string, workspaceId?: string): Promise<Array<{ fileId: string; originalName: string }>>
    /** 拖拽/直选导入对话附件；workspaceId = 归属工作空间（附件按空间落库，缺省归 default，
     *  Agent 的 file_search/library_browse 只查本空间——不传会「找不到刚拖进来的文件」）。 */
    importAgentAttachments(files: File[], workspaceId?: string): Promise<AgentAttachmentReference[]>
    /** 「+ → 导入文件」：系统选择框直选文件并导入为对话附件（取消返回空数组）。 */
    pickAgentAttachments(workspaceId?: string): Promise<AgentAttachmentReference[]>
    onImportProgress(listener: (event: FileImportProgressEvent) => void): () => void
    listHighRiskReviews(): Promise<{ items: HighRiskImportReview[] }>
    resolveHighRiskReview(id: string, accepted: boolean): Promise<HighRiskImportResolution>
    onHighRiskReviewsChanged(listener: () => void): () => void
    /** 系统文件管理器（访达「打开方式」/ 资源管理器双击）打开 Word/Excel/PPT 后的打开请求。 */
    onOpenFromOs(listener: (document: OsOpenedDocument) => void): () => void
    /** 冷启动竞态兜底：取走尚未被渲染层消费的系统打开请求（取后清空）。 */
    takePendingOsOpen(): Promise<OsOpenedDocument | null>
  }
  thesisFormat: {
    /** 当前工作区的论文格式卡列表（最新在前）；card 为 ThesisFormatCard 全量 JSON（样张预览数据源）。 */
    listCards(workspaceId: string): Promise<Array<{
      id: string
      sourceName: string
      sourceFileEntryId: string | null
      updatedAt: string
      card: Record<string, unknown>
    }>>
    /** 资料库内文件设为论文模版（docx/doc/pdf；同名模版覆盖旧卡）。factGaps 非空 = 模版部分信息未能解析（UI 必须提示，不得静默）。 */
    setFromLibrary(workspaceId: string, fileEntryId: string): Promise<{ cardId: string; sourceName: string; factGaps?: string[] }>
    /** 系统选择框直传模版（zip/docx/doc/pdf；zip 不进文件库）。用户取消返回 canceled=true。factGaps 语义同 setFromLibrary。
     *  options.wordOnly（产物区「排版工具」用）：选择框只接受 Word .docx。 */
    pickAndSet(workspaceId: string, options?: { wordOnly?: boolean }): Promise<{ canceled: boolean; cardId: string; sourceName: string; factGaps?: string[] }>
    /** 删除一张格式卡。 */
    removeCard(workspaceId: string, cardId: string): Promise<void>
    /** 工作台拖拽上传：字节直传网关解析成格式卡（不落盘）。factGaps 语义同 setFromLibrary。 */
    parseUpload(workspaceId: string, name: string, bytes: ArrayBuffer): Promise<{ cardId: string; sourceName: string; factGaps?: string[] }>
    /** 彻底删除模版：模版文件 + 格式卡。 */
    deleteTemplate(workspaceId: string, cardId: string): Promise<{ fileDeleted: boolean; hadFile: boolean }>
    /** 一键装订：按指定格式卡（缺省最新）把 docx 论文装订成 xxx-排版版.docx 新文件。
     *  report 为 v2 槽位映射报告（守恒核对/规则/未匹配块/待复核章节）。 */
    reformat(
      workspaceId: string,
      fileEntryId: string,
      cardId?: string,
      /** 工作台规则面板：严格/融合、Logo 与页眉页脚保留、标题层级映射。 */
      options?: {
        keepLogo?: boolean
        keepHeaderFooter?: boolean
        headingMapping?: { chapter?: number; section?: number; subsection?: number }
        /** 允许 AI 补写空白小节（默认关）。 */
        aiFill?: boolean
      },
    ): Promise<{
      fileEntryId: string
      originalName: string
      report?: Record<string, unknown>
    }>
    /** 任务化排版：提交即返回 jobId（长任务不占客户端请求槽）。 */
    reformatStart(
      workspaceId: string,
      fileEntryId: string,
      cardId?: string,
      options?: {
        keepLogo?: boolean
        keepHeaderFooter?: boolean
        headingMapping?: { chapter?: number; section?: number; subsection?: number }
      },
    ): Promise<{ jobId: string; phase: string }>
    /** 轮询排版作业：phase ∈ parsing|mapping|rendering|done，progress 0–100。 */
    reformatStatus(jobId: string): Promise<{
      id: string
      status: 'running' | 'completed' | 'failed'
      phase: string
      progress: number
      result?: { fileEntryId: string; originalName: string; report?: Record<string, unknown> }
      error?: string
    }>
    /** 导出 PDF：内置渲染引擎与 LibreOffice 均不可用时 unavailable=true（UI 需给出可执行说明）。 */
    exportPdf(workspaceId: string, fileEntryId: string): Promise<
      { unavailable: true } | { unavailable: false; path: string }
    >
    onCardChanged(listener: () => void): () => void
  }
}
import type { SearchItemType, SearchMessageContextDto, SearchPageDto, SearchRequestDto, SearchScopeDto } from './search'
import type {
  FileCatalogDto,
  FileDto,
  FileImportOutcome,
  FileImportProgressEvent,
  HighRiskImportResolution,
  HighRiskImportReview,
  IngestPipelines,
} from './ingest'
import type { McpServersSnapshot } from './mcp'
