/** 记忆（MemoryCore）浏览相关的渲染层 DTO，与 gateway /v1/memory/* 响应对齐。 */

export type MemoryAtomicType = 'episodic' | 'persona' | 'instruction'

export interface MemoryAtomicItemDto {
  id: string
  type: string
  content: string
  background: string | null
  createdAt: string
  updatedAt: string
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

export interface MemoryPipelineStageDto {
  queued: number
  running: number
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
}

export interface MemoryDocumentRewriteInput {
  roomId: string
  documentId: string
  documentTitle: string
  instruction: string
  originalText: string
  replacementText: string
}
