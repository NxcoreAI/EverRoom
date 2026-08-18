export type DataSourceStatus = 'connected' | 'syncing' | 'paused' | 'disconnected' | 'error'
export type DataSourceKind = 'local-folder' | 'web-page' | 'github' | 'feishu'
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
  AcknowledgeDocumentTransactionInput,
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSessionSnapshot,
  AgentSocketFrame,
  CreateAgentSessionInput,
  DocumentEventFrame,
  ImportRoomDocumentInput,
  RoomDocument,
  SaveRoomDocumentInput,
  StartAgentRunInput,
  UpdateAgentSessionInput,
} from '@nxcore/agent-contract'
import type {
  CreateRealityEventInput,
  FinishRealityCaptureInput,
  MarkRealityEventInput,
  RealityEvent,
  RealityInsights,
  RealityEventStatus,
  RealitySocketFrame,
  UpdateRealityTranscriptInput,
} from '@nxcore/reality-contract'
import type {
  KnowledgeAttachInput,
  KnowledgeDecisionDto,
  KnowledgeEntityDetailDto,
  KnowledgeEntityDto,
  KnowledgeEntityStatus,
  KnowledgeFileDto,
  KnowledgeFileUploadResult,
  KnowledgeRoomDto,
  KnowledgeUnmatchedItemDto,
  KnowledgeWikiDto,
  KnowledgeWikiGraphDto,
  KnowledgeWikiPageDto,
} from './knowledge'

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

export type CloudOidcProvider = 'apple' | 'google'

export interface DesktopRequestError {
  channel: string
  message: string
  title?: string
  action?: 'open-system-audio-settings'
  actionLabel?: string
}

export interface NxcoreDesktopApi {
  platform: string
  errors: {
    onRequestError(listener: (error: DesktopRequestError) => void): () => void
    report(error: DesktopRequestError): void
  }
  gateway: {
    status(): Promise<GatewayStatus>
  }
  account: {
    status(): Promise<CloudAccountStatus>
    login(input:{identifier:string;password:string}): Promise<CloudAccountStatus>
    loginWithOidc(provider: CloudOidcProvider): Promise<CloudAccountStatus>
    cancelOidcLogin(): Promise<void>
    logout(): Promise<CloudAccountStatus>
  }
  asr: {
    openSystemAudioSettings(): Promise<void>
    beginRecording(mimeType: string): Promise<{ id: string }>
    appendRecording(id: string, chunk: Uint8Array): Promise<void>
    finishRecording(id: string): Promise<{ filePath: string }>
    cancelRecording(id: string): Promise<void>
    createJob(input: CreateAsrJobInput): Promise<AsrJob>
    getJob(id: string): Promise<AsrJob>
  }
  memory: {
    overview(): Promise<MemoryOverviewDto>
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
  }
  reality: {
    listEvents(filters?: { status?: RealityEventStatus; search?: string }): Promise<RealityEvent[]>
    getEvent(id: string): Promise<RealityEvent>
    createEvent(input: CreateRealityEventInput): Promise<RealityEvent>
    finishCapture(id: string, input: FinishRealityCaptureInput): Promise<RealityEvent>
    updateTranscript(id: string, input: UpdateRealityTranscriptInput): Promise<RealityEvent>
    addMarker(id: string, input: MarkRealityEventInput): Promise<RealityEvent>
    confirm(id: string): Promise<RealityEvent>
    discard(id: string): Promise<void>
    fail(id: string, error: string): Promise<RealityEvent>
    readAudio(id: string): Promise<Uint8Array>
    subscribe(): Promise<void>
    unsubscribe(): Promise<void>
    onEvent(listener: (frame: RealitySocketFrame) => void): () => void
  }
  agent: {
    listSessions(pageLabel: string, roomId?: string | null): Promise<AgentSession[]>
    createSession(input: CreateAgentSessionInput): Promise<AgentSession>
    updateSession(sessionId: string, input: UpdateAgentSessionInput): Promise<AgentSession>
    deleteSession(sessionId: string): Promise<void>
    getSession(sessionId: string): Promise<AgentSessionSnapshot>
    getEvents(sessionId: string, runId: string, afterSeq: number): Promise<AgentEvent[]>
    startRun(sessionId: string, input: StartAgentRunInput): Promise<AgentRun>
    cancelRun(runId: string): Promise<AgentRun>
    subscribe(sessionId: string): Promise<void>
    unsubscribe(): Promise<void>
    onEvent(listener: (frame: AgentSocketFrame) => void): () => void
  }
  documents: {
    list(roomId: string): Promise<RoomDocument[]>
    get(documentId: string): Promise<RoomDocument>
    import(input: ImportRoomDocumentInput): Promise<RoomDocument>
    save(documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument>
    delete(documentId: string): Promise<void>
    acknowledge(transactionId: string, input: AcknowledgeDocumentTransactionInput): Promise<void>
    subscribe(roomId: string): Promise<void>
    unsubscribe(roomId?: string): Promise<void>
    onEvent(listener: (frame: DocumentEventFrame) => void): () => void
  }
  sources: {
    list(): Promise<DataSourceSummary[]>
    listFiles(id: string): Promise<SourceFileSummary[]>
    listEvidence(id: string, fileId: string): Promise<EvidenceDocument>
    searchEvidence(query: string, id?: string): Promise<EvidenceSearchResult[]>
    onChanged(listener: (event: SourceChangeEvent) => void): () => void
    showFile(id: string, fileId: string): Promise<void>
    addLocalFolder(): Promise<SyncResult | null>
    addGitHub(input: { repository: string; branch?: string; token?: string; syncIssues?: boolean }): Promise<SyncResult>
    sync(id: string): Promise<SyncResult>
    setPaused(id: string, paused: boolean): Promise<DataSourceSummary>
    disconnect(id: string, deleteLocalData: boolean): Promise<void>
  }
  knowledge: {
    listRooms(origin?: 'user' | 'auto'): Promise<{ items: KnowledgeRoomDto[] }>
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
    promoteEntity(entityId: string): Promise<{ queued: boolean }>
    /** 手动合并：from 并入 target。 */
    mergeEntity(fromId: string, targetId: string): Promise<{ ok: boolean }>
    listUnmatched(): Promise<{ items: KnowledgeUnmatchedItemDto[] }>
    /** 未识别资料手动挂实体（role=manual）。 */
    attachDoc(sourceKind: string, sourceId: string, input: KnowledgeAttachInput): Promise<{ entityId: string }>
    listRecentDecisions(limit?: number): Promise<{ items: KnowledgeDecisionDto[] }>
    revertDecision(decisionId: string): Promise<{ ok: boolean }>
    /** 系统文件选择框（仅 .md）→ 上传 gateway 走自动归类路由。 */
    pickAndUploadFiles(): Promise<KnowledgeFileUploadResult[]>
  }
  files: {
    list(limit?: number, offset?: number): Promise<{ items: FileDto[]; total: number }>
    get(fileId: string): Promise<FileDto & { storagePath: string; currentParsedId: string | null }>
    /** 解析产物 markdown（未进过链路的裸上传 404）。 */
    readMarkdown(fileId: string): Promise<{ markdown: string }>
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
    /** 统一导入：选择框 → /v1/files → /v1/ingest（逐文件结果）。 */
    pickAndImport(options?: { pipelines?: IngestPipelines }): Promise<FileImportOutcome[]>
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
export type {
  CreateRealityEventInput,
  FinishRealityCaptureInput,
  MarkRealityEventInput,
  RealityEvent,
  RealityEventType,
  RealityInsights,
  RealityEventStatus,
  RealitySocketFrame,
  UpdateRealityTranscriptInput,
} from '@nxcore/reality-contract'
