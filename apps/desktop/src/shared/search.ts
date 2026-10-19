/** 统一搜索 wire 类型（与 gateway /v1/search DTO 一一对应）。 */

export type SearchItemType = 'file' | 'message' | 'room' | 'document' | 'export'
export type SearchItemStatus = 'meta_only' | 'indexed' | 'failed'
export type SearchTimeBasis = 'occurred' | 'ingested'

export interface SearchHitDto {
  id: string
  itemType: SearchItemType
  refId: string
  title: string
  snippet: string
  sourceKind: string | null
  roomIds: string[]
  occurredAt: string | null
  ingestedAt: string
  timeBasis: SearchTimeBasis
  versionLabel: string | null
  fileVersionId: string | null
  status: SearchItemStatus
  sessionId: string | null
  pageId: string | null
}

export interface SearchScopeDto {
  indexedCount: number
  pendingCount: number
}

export interface SearchRequestDto {
  query: string
  types?: SearchItemType[]
  roomIds?: string[]
  timeBasis?: SearchTimeBasis
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface SearchPageDto {
  items: SearchHitDto[]
  total: number
  scope: SearchScopeDto
  providers: string[]
}

export interface SearchMessageContextDto {
  sessionId: string
  messages: Array<{ id: string; role: string; content: string; createdAt: string }>
}
