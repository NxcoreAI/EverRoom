/** 记忆（MemoryCore）浏览相关的渲染层 DTO，与 gateway /v1/memory/* 响应对齐。 */

export type MemoryAtomicType = 'episodic' | 'persona' | 'instruction'

export interface MemoryAtomicItemDto {
  id: string
  type: string
  content: string
  background: string | null
  createdAt: string
  updatedAt: string
  /** 用户指派的 Room 归属；null = 未绑定。 */
  roomId: string | null
  /** 绑定 Room 的当前标题；roomId 非空而为 null ⇒ Room 已软删/消失。 */
  roomTitle: string | null
  score?: number
}

export interface MemoryAtomicPageDto {
  items: MemoryAtomicItemDto[]
  total: number
}

export interface MemoryConversationMessageDto {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string | null
  sessionId: string | null
  /** 来源标记：null = 旧数据；'document' = md 导入的文档会话块。 */
  sourceKind: string | null
  score?: number
}

export interface MemoryConversationPageDto {
  messages: MemoryConversationMessageDto[]
  total: number
}

export interface MemoryScenarioEntryDto {
  path: string
  summary: string | null
  isDirectory: boolean
  createdAt: string
  updatedAt: string
}

export interface MemoryScenarioContentDto {
  path: string
  content: string | null
  version: number
  updatedAt: string
}

export interface MemoryCoreDto {
  content: string | null
  version: number
  updatedAt: string
}

export interface MemoryPipelineSessionDto {
  sessionId: string
  title: string | null
  latestUserMessage: string | null
}

export interface MemoryPipelineStageDto {
  queued: number
  running: number
  queuedSessions: MemoryPipelineSessionDto[]
  runningSessions: MemoryPipelineSessionDto[]
  idle: boolean
}

export interface MemoryPipelineDto {
  l1: MemoryPipelineStageDto | null
  l2: MemoryPipelineStageDto | null
  l3: MemoryPipelineStageDto | null
}

export interface MemoryOverviewDto {
  l1: { total: number; byType: { episodic: number; persona: number; instruction: number } } | null
  l0: { total: number } | null
  l2: { total: number } | null
  l3: { exists: boolean; updatedAt: string | null } | null
  pipeline: MemoryPipelineDto | null
}

export interface MemoryOnboardingInput {
  requestId: string
  locale: 'zh-CN' | 'en-US'
  workContext: string
  currentFocus: string
  collaborationPreference?: string
}

export interface MemoryOnboardingResultDto {
  sessionId: string
  capturedAt: string
  accepted: true
}

export interface MemoryAtomicListOptions {
  type?: MemoryAtomicType
  limit?: number
  offset?: number
  timeStart?: string
  timeEnd?: string
}

export interface MemoryConversationListOptions {
  sessionId?: string
  limit?: number
  offset?: number
  timeStart?: string
  timeEnd?: string
  /** 'conversation' = 仅对话（排除文档会话块）。 */
  sourceKind?: 'conversation' | 'document'
}

/** 导入文档登记行（gateway /v1/memory/documents）。 */
export interface MemoryDocumentDto {
  id: string
  title: string
  /** 资产引用 = 知识资产 file id（预览走 knowledge.readFileMarkdown）。 */
  callerRef: string
  version: number
  sessionId: string
  chunkCount: number
  derivedMemoryCount: number | null
  createdAt: string
  updatedAt: string
}

export interface MemoryDocumentChunkDto {
  chunkIndex: number
  messageId: string
  headingPath: string
  lineStart: number
  lineEnd: number
  content: string
  recordedAt: string | null
}

export interface MemoryDocumentMemoryDto {
  id: string
  type: string
  content: string
  background: string | null
  sourceMessageIds: string[]
  createdAt: string
  updatedAt: string
}

export interface MemoryDocumentDetailDto {
  document: MemoryDocumentDto
  chunks: MemoryDocumentChunkDto[]
  memories: MemoryDocumentMemoryDto[]
}

export interface MemoryImportMarkdownResultDto {
  fileId: string
  document: MemoryDocumentDto
  version: string
  sessionId: string
  chunkCount: number
  deduplicated: boolean
  replacedVersions: number
  acceptedChunks: number
}

export interface MemoryProvenanceAnchorDto {
  messageId: string
  role: string
  content: string
  recordedAt: string | null
  sessionId: string | null
  sourceKind: string
  headingPath?: string
  lineStart?: number
  lineEnd?: number
  chunkIndex?: number
}

export interface MemoryAtomicProvenanceDto {
  memoryId: string
  type: string
  content: string
  kind: string
  room: { roomId: string | null; roomTitle: string | null }
  session: { sessionId: string | null; sessionKey: string | null } | null
  document: {
    documentId: string
    title: string
    callerRef: string
    version: number
    sessionId: string
  } | null
  anchorMessageIds: string[]
  anchors: MemoryProvenanceAnchorDto[]
}

export interface MemoryDocumentRewriteInput {
  roomId: string
  documentId: string
  documentTitle: string
  instruction: string
  originalText: string
  replacementText: string
}
