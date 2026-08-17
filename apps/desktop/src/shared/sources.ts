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
  AcknowledgeDocumentTransactionInput,
  AgentEvent,
  AgentRun,
  AgentSession,
  AgentSessionLink,
  AgentSessionSnapshot,
  AgentSocketFrame,
  ContextRoomSnapshot,
  CreateAgentSessionInput,
  CreateAgentSessionLinkInput,
  DocumentEventFrame,
  ImportRoomDocumentInput,
  RoomDocument,
  SaveRoomDocumentInput,
  SaveContextRoomSnapshotInput,
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
  connectorDebug: {
    enabled: boolean
    faultsEnabled: boolean
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
    failures(query?: { connectionId?: string; runId?: string; limit?: number }): Promise<Array<{ id: string; scopeId: string | null; runId: string | null; category: string; message: string; itemKey: string | null; createdAt: string }>>
    documents(connectionId: string): Promise<WikiDocumentSummary[]>
    document(connectionId: string, documentId: string): Promise<WikiDocumentPreview>
    records(connectionId: string, type: 'mail' | 'calendar'): Promise<ConnectorJsonRecord[]>
    armFault(point: string): Promise<void>
  }
  contextRooms: {
    list(): Promise<ContextRoomSnapshot>
    syncSnapshot(input: SaveContextRoomSnapshotInput): Promise<ContextRoomSnapshot>
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
    captureDocumentRewrite(input: MemoryDocumentRewriteInput): Promise<{ captured: boolean }>
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
    createSessionLink(input: CreateAgentSessionLinkInput): Promise<AgentSessionLink>
    listSessionLinks(sessionId: string): Promise<AgentSessionLink[]>
    markSessionLinkReturned(linkId: string): Promise<AgentSessionLink>
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
    listTrash(roomId: string): Promise<RoomDocument[]>
    get(documentId: string): Promise<RoomDocument>
    import(input: ImportRoomDocumentInput): Promise<RoomDocument>
    save(documentId: string, input: SaveRoomDocumentInput): Promise<RoomDocument>
    delete(documentId: string): Promise<void>
    restore(documentId: string): Promise<RoomDocument>
    deletePermanently(documentId: string): Promise<void>
    emptyTrash(roomId: string): Promise<void>
    acknowledge(transactionId: string, input: AcknowledgeDocumentTransactionInput): Promise<void>
    subscribe(roomId: string): Promise<void>
    unsubscribe(roomId?: string): Promise<void>
    onEvent(listener: (frame: DocumentEventFrame) => void): () => void
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
}
import type {
  MemoryAtomicItemDto,
  MemoryAtomicListOptions,
  MemoryAtomicPageDto,
  MemoryConversationListOptions,
  MemoryConversationMessageDto,
  MemoryConversationPageDto,
  MemoryCoreDto,
  MemoryDocumentRewriteInput,
  MemoryOverviewDto,
  MemoryScenarioContentDto,
  MemoryScenarioEntryDto,
} from './memory'
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
