export type DataSourceStatus = 'connected' | 'syncing' | 'paused' | 'disconnected' | 'error'
export type DataSourceKind = 'local-folder' | 'web-page' | 'github' | 'feishu' | 'google-docs' | 'notion'
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

import type {
  AgentEvent,
  PendingAgentIntent,
  AgentRun,
  AgentStatusSnapshot,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  AgentSocketFrame,
  ContextRoomSnapshot,
  CreateContextRoomInput,
  CreateContextRoomResult,
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
  DocumentVersionSummary,
  ImportRoomDocumentInput,
  RoomDocument,
  ResolveDocumentBlockReferencesInput,
  ResolveDocumentBlockReferencesResult,
  SaveRoomDocumentInput,
  SaveContextRoomSnapshotInput,
  StartAgentRunInput,
  SubmitPendingAgentIntentInput,
  StartDocumentOperationInput,
  UpdateAgentSessionInput,
} from '@nxcore/agent-contract'
import type {
  CreateRealityEventInput,
  FinishRealityCaptureInput,
  MarkRealityEventInput,
  RealityEvent,
  RealityInsights,
  RealityTag,
  RealityEventStatus,
  RealitySocketFrame,
  UpdateRealityTranscriptInput,
} from '@nxcore/reality-contract'
import type {
  ConnectorAuthorizationAttempt,
  ConnectorConnection,
  ConnectorJsonRecord,
  ConnectorStatus,
  MailMessage,
  SyncMode,
  SyncRun,
  SyncScope,
  WikiDocumentPreview,
  WikiDocumentSummary,
} from '@nxcore/connector-contract'
import type {
  KnowledgeAttachInput,
  KnowledgeDecisionDto,
  KnowledgeEntityDetailDto,
  KnowledgeEntityDto,
  KnowledgeEntityStatus,
  KnowledgeFileDto,
  KnowledgeFileUploadResult,
  KnowledgeRoomContextDto,
  KnowledgeRoomDto,
  KnowledgeUnmatchedItemDto,
  KnowledgeWikiDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from './knowledge'
import type {
  OpenConnectorCommandEvent,
  OpenConnectorCommandResult,
  OpenConnectorExecutionInput,
  OpenConnectorStatus,
} from './open-connector'
import type {
  ConnectorAccount,
  ConnectorDataPage,
  ConnectorDataQuery,
  ConnectorDataRecord,
  ConnectorIngestResult,
  ConnectorPromptProfile,
  ConnectorQuarantinedRecord,
  ConnectorSyncJob,
  ConnectorSyncJobInput,
  ConnectorSyncRun,
  ConnectorSyncStatus,
} from './connector-sync'
import type { DesktopLocale } from './i18n/desktop'

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
  speakerId: number | null
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
}

export interface CloudDevice {
  id: string
  name: string
  platform: string
  appVersion?: string | null
  status: string
  lastSeenAt: string
  createdAt?: string
}

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

export interface PrivateTranscriptionRecord {
  recordId: string
  revision: number
  createdAt: string
  updatedAt: string
  transcript: string
  segments: AsrSegment[]
  metadata?: Record<string, unknown>
}

export interface PrivateTranscriptionSyncResult {
  status: AccountKeyringStatus
  cursor: number
  synced: number
  removed: number
  records: PrivateTranscriptionRecord[]
}

export interface PrivateTranscriptionSyncCompletedEvent {
  completedAt: string
}
export interface SyncedPrivateAudioAsset {
  id: string
  recordingId: string
  eventId?: string
  sequence?: number
  mimeType: string
  status: string
}

export type CloudOidcProvider = 'apple' | 'google'

export interface DesktopRequestError {
  channel: string
  message: string
  title?: string
  severity?: 'error' | 'notice'
  action?: 'open-microphone-settings' | 'open-system-audio-settings'
  actionLabel?: string
}

export type WindowScreenshotResult =
  | {
      ok: true
      filePath: string
      fileName: string
      width: number
      height: number
      bytes: number
      capturedAt: string
      perceptualHash?: string
    }
  | {
      ok: false
      code: 'window-unavailable' | 'capture-failed' | 'save-failed'
      message: string
    }

export interface WindowScreenshotStatus {
  enabled: boolean
  intervalMs: number
  lastResult: WindowScreenshotResult | null
}

export interface PerceptionSettings {
  captureEnabled: boolean
  captureIntervalSeconds: number
  onlineVlmEnabled: boolean
  configVersion: number
  updatedAt: string
}

export type PerceptionNodeKind = 'audio' | 'screenshot' | 'photo'
export type VisualPerceptionStatus = 'disabled' | 'pending' | 'processing' | 'ready' | 'failed'

export interface PerceptionNode {
  id: string
  kind: PerceptionNodeKind
  startAt: string
  endAt: string
  title: string
  summary: string
  status: string
  eventType: string | null
  tags: string[]
  keyPoints: string[]
  insightTags: RealityTag[]
  confidence: number | null
  model: string | null
  error: string | null
  sampleCount: number
  mediaFileId: string | null
}

export interface VisualObservation {
  id: string
  nodeId: string
  fileId: string
  kind: 'screenshot' | 'photo'
  capturedAt: string
  perceptualHash: string | null
  width: number | null
  height: number | null
  createdAt: string
}

export interface PerceptionNodeDetail extends PerceptionNode {
  observations?: VisualObservation[]
}

export interface PerceptionNodeQuery {
  from?: string
  to?: string
  kind?: PerceptionNodeKind
  status?: string
}

export interface DiarySettings {
  ownerId: string
  enabled: boolean
  localTime: string
  timezone: string
  enabledFrom: string | null
  nextRunAt: string | null
  configVersion: number
  createdAt: string
  updatedAt: string
}

export type DiaryRunStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface DiaryRun {
  id: string
  date: string
  trigger: 'scheduled' | 'catch_up' | 'manual'
  status: DiaryRunStatus
  attempt: number
  error: string | null
  versionId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface DiaryContent {
  headline: string
  summary: string
  reflection: string
  range: { start: string; end: string }
  events: Array<{
    time: string
    endTime?: string
    title: string
    summary: string
    sourceRefs: string[]
    tags?: string[]
  }>
  closing: string
}

export interface DiaryDayDetails {
  day: {
    date: string
    status: 'pending' | 'generating' | 'ready' | 'stale' | 'failed'
    eventCount: number
    lastError: string | null
  }
  currentVersion: {
    id: string
    date: string
    version: number
    content: DiaryContent
    agentModel: string | null
    createdAt: string
  } | null
  sources: Array<{
    sourceId: string
    sourceKind: string
    occurredAt: string
    endedAt: string | null
    timeBasis: string
    evidenceSummary: string
    assetFileId: string | null
    assetKind: 'document' | 'screenshot' | 'photo' | 'audio' | 'other' | null
    mime: string | null
  }>
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

export interface NxcoreDesktopApi {
  platform: string
  locale: {
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
  nangoConnector: {
    status(): Promise<ConnectorStatus>
    startAuthorization(provider: 'gmail' | 'outlook' | 'google-docs' | 'notion' | 'google-calendar'): Promise<ConnectorAuthorizationAttempt>
    authorizationStatus(id: string): Promise<ConnectorAuthorizationAttempt>
    registerConnection(input: { provider: 'gmail' | 'outlook' | 'google-calendar'; nangoConfigKey: string; nangoConnectionId: string; filters?: Record<string, unknown> }): Promise<ConnectorConnection>
    disableConnection(id: string): Promise<void>
    purgeConnection(id: string): Promise<void>
    triggerSync(id: string, mode: SyncMode): Promise<SyncRun>
    cancelRun(id: string): Promise<SyncRun>
    scopes(connectionId?: string): Promise<SyncScope[]>
    runs(connectionId?: string): Promise<SyncRun[]>
    mail(query?: { connectionId?: string; scopeId?: string; search?: string; limit?: number; cursor?: string }): Promise<MailMessage[]>
    documents(connectionId: string): Promise<WikiDocumentSummary[]>
    document(connectionId: string, documentId: string): Promise<WikiDocumentPreview>
    records(connectionId: string, type: 'mail' | 'calendar'): Promise<ConnectorJsonRecord[]>
  }
  cliConnector: {
    status(): Promise<OpenConnectorStatus>
    execute(input: OpenConnectorExecutionInput): Promise<OpenConnectorCommandResult>
    cancel(requestId: string): Promise<boolean>
    openConsole(): Promise<void>
    onEvent(listener: (event: OpenConnectorCommandEvent) => void): () => void
  }
  cliConnectorSync: {
    status(): Promise<ConnectorSyncStatus>
    accounts(): Promise<ConnectorAccount[]>
    promptProfiles(): Promise<ConnectorPromptProfile[]>
    jobs(): Promise<ConnectorSyncJob[]>
    createJob(input: ConnectorSyncJobInput): Promise<ConnectorSyncJob>
    updateJob(id: string, input: Partial<ConnectorSyncJobInput> & { configVersion: number }): Promise<ConnectorSyncJob>
    runJob(id: string): Promise<ConnectorSyncJob>
    setJobPaused(id: string, paused: boolean, configVersion: number): Promise<ConnectorSyncJob>
    archiveJob(id: string, configVersion: number): Promise<ConnectorSyncJob>
    runs(jobId: string): Promise<ConnectorSyncRun[]>
    quarantine(runId: string): Promise<ConnectorQuarantinedRecord[]>
    data(query: ConnectorDataQuery): Promise<ConnectorDataPage>
    record(id: string): Promise<ConnectorDataRecord>
    ingestRecords(recordIds: string[]): Promise<ConnectorIngestResult>
  }
  mcp: {
    listServers(): Promise<McpServersSnapshot>
    saveServers(servers: McpServersSnapshot['servers']): Promise<McpServersSnapshot>
  }
  screenCapture: {
    captureCurrentWindow(): Promise<WindowScreenshotResult>
    start(intervalMs: number): Promise<WindowScreenshotStatus>
    updateInterval(intervalMs: number): Promise<WindowScreenshotStatus>
    stop(): Promise<WindowScreenshotStatus>
    status(): Promise<WindowScreenshotStatus>
    perceptionSettings(): Promise<PerceptionSettings>
    updateOnlineVlm(enabled: boolean, configVersion: number): Promise<PerceptionSettings>
    listPerceptionNodes(query?: PerceptionNodeQuery): Promise<{ items: PerceptionNode[] }>
    getPerceptionNode(id: string): Promise<PerceptionNodeDetail>
    retryPerceptionNode(id: string): Promise<{ accepted: boolean }>
    deletePerceptionNode(id: string, deleteAssets?: boolean): Promise<{
      deleted: boolean
      deletedAssets: string[]
      retainedAssets: string[]
    }>
  }
  diary: {
    settings(): Promise<DiarySettings>
    updateSettings(input: Partial<Pick<DiarySettings, 'enabled' | 'localTime' | 'timezone'>> & { configVersion: number }): Promise<DiarySettings>
    generate(date: string): Promise<{ runId: string }>
    run(id: string): Promise<DiaryRun>
    activeRun(): Promise<DiaryRun | null>
    days(start: string, end: string): Promise<DiaryDayDetails['day'][]>
    day(date: string): Promise<DiaryDayDetails | null>
  }
  contextRooms: {
    list(): Promise<ContextRoomSnapshot>
    create(input: CreateContextRoomInput): Promise<CreateContextRoomResult>
    syncSnapshot(input: SaveContextRoomSnapshotInput): Promise<ContextRoomSnapshot>
  }
  account: {
    status(options?: { quiet?: boolean }): Promise<CloudAccountStatus>
    devices(options?: { quiet?: boolean }): Promise<CloudDevice[]>
    login(input:{identifier:string;password:string}): Promise<CloudAccountStatus>
    loginWithOidc(provider: CloudOidcProvider): Promise<CloudAccountStatus>
    cancelOidcLogin(): Promise<void>
    logout(): Promise<CloudAccountStatus>
    keyringStatus(options?: { quiet?: boolean }): Promise<AccountKeyringStatus>
    createPairingSession(): Promise<{ pairingSessionId: string; pairingToken?: string; status: string; confirmationCode: string; expiresAt: string; origin?: string }>
    getPairingSession(id: string, options?: { quiet?: boolean }): Promise<{ pairingSessionId: string; status: string; confirmationCode: string; expiresAt: string; targetDeviceId?: string | null; targetDeviceName?: string | null; targetPublicKey?: string | null; targetAlgorithm?: string | null }>
    approvePairingSession(id: string): Promise<{ pairingSessionId: string; status: string; targetDeviceId?: string | null }>
  }
  asr: {
    requestMicrophoneAccess(): Promise<boolean>
    openMicrophoneSettings(): Promise<void>
    openSystemAudioSettings(): Promise<void>
    beginRecording(mimeType: string): Promise<{ id: string }>
    appendRecording(id: string, chunk: Uint8Array): Promise<void>
    finishRecording(id: string): Promise<{ filePath: string }>
    cancelRecording(id: string): Promise<void>
    createJob(input: CreateAsrJobInput): Promise<AsrJob>
    getJob(id: string): Promise<AsrJob>
  }
  privateAudio: {
    list(cursor?: number): Promise<{ assets: SyncedPrivateAudioAsset[]; nextCursor: number }>
    download(assetId: string, outputPath: string): Promise<string>
    read(assetId: string): Promise<{ bytes: Uint8Array; mimeType: string }>
  }
  transcriptions: {
    syncPrivate(options?: { quiet?: boolean }): Promise<PrivateTranscriptionSyncResult>
    onSyncCompleted(listener: (event: PrivateTranscriptionSyncCompletedEvent) => void): () => void
    listPrivate(): Promise<PrivateTranscriptionRecord[]>
    listTags(): Promise<RealityTag[]>
    replaceSummaryTags(summaryRecordId: string, tags: RealityTag[]): Promise<void>
    renameTag(tagId: string, label: string): Promise<void>
    mergeTag(targetTagId: string, sourceTagId: string): Promise<void>
  }
  memory: {
    overview(): Promise<MemoryOverviewDto>
    startOnboarding(input: MemoryOnboardingInput): Promise<MemoryOnboardingResultDto>
    listAtomic(options: MemoryAtomicListOptions): Promise<MemoryAtomicPageDto>
    searchAtomic(query: string, limit?: number): Promise<{ items: MemoryAtomicItemDto[] }>
    updateAtomic(id: string, content: string, background?: string): Promise<{ id: string; version: number; updatedAt: string }>
    deleteAtomic(ids: string[]): Promise<{ deletedCount: number }>
    listScenarios(pathPrefix?: string): Promise<{ entries: MemoryScenarioEntryDto[]; total: number }>
    readScenario(path: string): Promise<MemoryScenarioContentDto>
    readCore(): Promise<MemoryCoreDto>
    writeCore(content: string): Promise<{ version: number; updatedAt: string }>
    listConversations(options: MemoryConversationListOptions): Promise<MemoryConversationPageDto>
    searchConversations(query: string, limit?: number, sessionId?: string): Promise<{ messages: MemoryConversationMessageDto[] }>
    deleteConversations(target: { sessionIds?: string[]; messageIds?: string[] }): Promise<{ deletedCount: number }>
    /** md 文档导入（gateway 资产化 + MemoryCore 登记，title 必填）。 */
    importMarkdown(input: { title: string; markdown: string; filename?: string }): Promise<MemoryImportMarkdownResultDto>
    /** 系统文件选择框（仅 .md，≤2MB）→ 文本（取消返回空数组；失败项带 error）。 */
    pickMarkdownFiles(): Promise<Array<{ filename: string; markdown: string } | { filename: string; error: string }>>
    /** 导入文档登记清单（每身份键最新版本）。 */
    listDocuments(limit?: number, offset?: number): Promise<{ documents: MemoryDocumentDto[]; total: number }>
    /** 文档详情：登记行 + 分块（含正文与行区间）+ 派生 L1。 */
    getDocument(id: string): Promise<MemoryDocumentDetailDto>
    deleteDocument(id: string): Promise<{ documentId: string; deleted: boolean }>
    /** 原子记忆一站式溯源（文档锚点/会话原话）。 */
    atomicProvenance(id: string): Promise<MemoryAtomicProvenanceDto>
    captureDocumentRewrite(input: MemoryDocumentRewriteInput): Promise<{ captured: boolean }>
  }
  reality: {
    listEvents(filters?: { status?: RealityEventStatus; search?: string }): Promise<RealityEvent[]>
    getEvent(id: string): Promise<RealityEvent>
    createEvent(input: CreateRealityEventInput): Promise<RealityEvent>
    finishCapture(id: string, input: FinishRealityCaptureInput): Promise<RealityEvent>
    updateTranscript(id: string, input: UpdateRealityTranscriptInput): Promise<RealityEvent>
    addMarker(id: string, input: MarkRealityEventInput): Promise<RealityEvent>
    setImportant(id: string, important: boolean): Promise<RealityEvent>
    confirm(id: string): Promise<RealityEvent>
    discard(id: string): Promise<void>
    fail(id: string, error: string): Promise<RealityEvent>
    readAudio(id: string): Promise<Uint8Array>
    exportTranscript(input: { fileName: string; content: string }): Promise<{ canceled: boolean; filePath?: string }>
    subscribe(): Promise<void>
    unsubscribe(): Promise<void>
    onEvent(listener: (frame: RealitySocketFrame) => void): () => void
  }
  agent: {
    getStatus(): Promise<AgentStatusSnapshot>
    listSessions(pageLabel?: string, roomId?: string | null): Promise<AgentSession[]>
    createSession(input: CreateAgentSessionInput): Promise<AgentSession>
    createSessionLink(input: CreateAgentSessionLinkInput): Promise<AgentSessionLink>
    listSessionLinks(sessionId: string): Promise<AgentSessionLink[]>
    markSessionLinkReturned(linkId: string): Promise<AgentSessionLink>
    updateSession(sessionId: string, input: UpdateAgentSessionInput): Promise<AgentSession>
    deleteSession(sessionId: string): Promise<void>
    getSession(sessionId: string): Promise<AgentSessionSnapshot>
    getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
    startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
    submitPendingIntent(
      intentId: string,
      input: SubmitPendingAgentIntentInput,
    ): Promise<{ intent: PendingAgentIntent; run: AgentRun }>
    cancelRun(runId: string): Promise<AgentRun>
    subscribe(sessionId: string): Promise<void>
    unsubscribe(): Promise<void>
    onEvent(listener: (frame: AgentSocketFrame) => void): () => void
  }
  cursorCompletionAgent: {
    createSession(input: CreateAgentSessionInput): Promise<AgentSession>
    deleteSession(sessionId: string): Promise<void>
    getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
    startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
    cancelRun(runId: string): Promise<AgentRun>
  }
  documents: {
    list(roomId: string): Promise<RoomDocument[]>
    listTrash(roomId: string): Promise<RoomDocument[]>
    get(documentId: string): Promise<RoomDocument>
    listBlocks(documentId: string): Promise<DocumentBlockList>
    listBlockBacklinks(documentId: string, blockId?: string): Promise<DocumentBlockBacklinkList>
    listVersions(documentId: string): Promise<DocumentVersionSummary[]>
    restoreVersion(documentId: string, version: number, baseVersion: number): Promise<RoomDocument>
    resolveBlockReferences(input: ResolveDocumentBlockReferencesInput): Promise<ResolveDocumentBlockReferencesResult>
    listOperations(filters?: {
      roomId?: string
      documentId?: string
      sessionId?: string
      status?: DocumentOperationStatus
    }): Promise<DocumentOperationSummary[]>
    startOperation(input: StartDocumentOperationInput): Promise<DocumentOperation>
    getOperation(operationId: string): Promise<DocumentOperation>
    executeOperationCommand(
      operationId: string,
      input: DocumentOperationCommandInput,
    ): Promise<DocumentOperationCommandResult>
    storeImage(documentId: string, input: StoreDocumentImageInput): Promise<StoredDocumentImage>
    import(input: ImportRoomDocumentInput): Promise<RoomDocument>
    save(documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument>
    delete(documentId: string): Promise<void>
    restore(documentId: string): Promise<RoomDocument>
    deletePermanently(documentId: string): Promise<void>
    emptyTrash(roomId: string): Promise<void>
    exportPdf(input: ExportDocumentPdfInput): Promise<ExportDocumentPdfResult>
    subscribe(roomId: string): Promise<void>
    unsubscribe(roomId?: string): Promise<void>
    onEvent(listener: (frame: DocumentEventFrame) => void): () => void
    onOperationChanged(listener: (operationId: string) => void): () => void
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
    addGitHub(input: { repository: string; branch?: string; token?: string; syncIssues?: boolean }): Promise<SyncResult>
    addGoogleDocs(input: { documentIds: string[]; token: string }): Promise<SyncResult>
    addNotion(input: { pageIds: string[]; token: string }): Promise<SyncResult>
    sync(id: string): Promise<SyncResult>
    setPaused(id: string, paused: boolean): Promise<DataSourceSummary>
    disconnect(id: string, deleteLocalData: boolean): Promise<void>
  }
  knowledge: {
    listRooms(origin?: 'user' | 'auto'): Promise<{ items: KnowledgeRoomDto[] }>
    getRoomContext(roomId: string): Promise<KnowledgeRoomContextDto>
    upsertRoom(input: { id: string; title: string; kind?: string }): Promise<KnowledgeRoomDto>
    deleteRoom(roomId: string): Promise<void>
    listWikiPages(roomId: string): Promise<{ status: string; items: KnowledgeWikiPageDto[]; pageCount: number | null }>
    readWikiPage(roomId: string, ref: string): Promise<{ ref: string; markdown: string }>
    /** 全部 Room 的 wiki 映射（Wiki 应用清单）。 */
    listWikis(): Promise<{ items: KnowledgeWikiDto[] }>
    /** Room wiki 内链图谱（页面=节点、md 内链=边；无 wiki/失败为空图）。 */
    getWikiGraph(roomId: string): Promise<KnowledgeWikiGraphDto>
    /** Room 的上传文件清单（含路由状态徽标数据）。 */
    listRoomFiles(roomId: string): Promise<{ items: KnowledgeFileDto[] }>
    /** 文件解析产物 markdown（预览）。 */
    readFileMarkdown(fileId: string): Promise<{ markdown: string }>
    /** 在系统文件管理器中定位文件本体。 */
    revealFile(fileId: string): Promise<void>
    /** 候选实体列表（ready = 首页推荐池；挂载下拉用 weak）。 */
    listEntities(status: KnowledgeEntityStatus): Promise<{ items: KnowledgeEntityDto[] }>
    getEntity(entityId: string): Promise<KnowledgeEntityDetailDto>
    /** 用户确认创建（推荐态实体走完整晋升流程）。 */
    promoteEntity(entityId: string): Promise<{ queued: boolean; jobId: string }>
    /** 手动合并：from 并入 target。 */
    mergeEntity(fromId: string, targetId: string): Promise<{ ok: boolean }>
    listUnmatched(): Promise<{ items: KnowledgeUnmatchedItemDto[] }>
    /** 未识别资料手动挂实体（role=manual）。 */
    attachDoc(sourceKind: string, sourceId: string, input: KnowledgeAttachInput): Promise<{ entityId: string }>
    listRecentDecisions(limit?: number): Promise<{ items: KnowledgeDecisionDto[] }>
    revertDecision(decisionId: string): Promise<{ ok: boolean }>
  }
  files: {
    list(limit?: number, offset?: number): Promise<{ items: FileDto[]; total: number }>
    get(fileId: string): Promise<FileDto & { storagePath: string; currentParsedId: string | null }>
    /** 解析产物 markdown（未进过链路的裸上传 404）。 */
    readMarkdown(fileId: string): Promise<{ markdown: string }>
    readDataUrl(fileId: string): Promise<{ dataUrl: string }>
    rename(fileId: string, displayName: string): Promise<FileDto>
    /** 删除：级联 knowledge cleanup + memory 文档 + 对象库 GC。 */
    delete(fileId: string): Promise<{
      deleted: boolean
      knowledgeCleanup: boolean
      deletedMemoryDocuments: string[]
      blobCollected: boolean
    }>
    /** 在系统文件管理器中定位文件本体。 */
    reveal(fileId: string): Promise<void>
    /** 统一导入：选择框 → /v1/files → /v1/ingest（逐文件结果）。roomId（Room 内上传）= 显式归属直达该 Room。 */
    pickAndImport(options?: { pipelines?: IngestPipelines; roomId?: string }): Promise<FileImportOutcome[]>
  }
  ingest: {
    /** 统一进入台账（导入记录）。策略不在此面：defaults 在代码，覆盖走部署期配置文件。 */
    listEvents(query: {
      limit?: number
      offset?: number
      sourceKind?: string
      sourceId?: string
    }): Promise<{ items: IngestEventDto[]; total: number }>
  }
}
import type {
  MemoryAtomicItemDto,
  MemoryAtomicListOptions,
  MemoryAtomicPageDto,
  MemoryAtomicProvenanceDto,
  MemoryConversationListOptions,
  MemoryConversationMessageDto,
  MemoryConversationPageDto,
  MemoryCoreDto,
  MemoryDocumentDetailDto,
  MemoryDocumentDto,
  MemoryImportMarkdownResultDto,
  MemoryDocumentRewriteInput,
  MemoryOnboardingInput,
  MemoryOnboardingResultDto,
  MemoryOverviewDto,
  MemoryScenarioContentDto,
  MemoryScenarioEntryDto,
} from './memory'
import type {
  FileDto,
  FileImportOutcome,
  IngestEventDto,
  IngestPipelines,
} from './ingest'
import type { McpServersSnapshot } from './mcp'
export type {
  CreateRealityEventInput,
  FinishRealityCaptureInput,
  MarkRealityEventInput,
  RealityEvent,
  RealityEventType,
  RealityInsights,
  RealityTag,
  RealityEventStatus,
  RealitySocketFrame,
  UpdateRealityTranscriptInput,
} from '@nxcore/reality-contract'
