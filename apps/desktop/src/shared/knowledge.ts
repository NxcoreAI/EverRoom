/** Knowledge 模块（Room×Wiki）跨进程 DTO：gateway 契约在 apps/gateway/src/modules/knowledge/routes.ts。 */

export interface KnowledgeRoomDto {
  id: string
  title: string
  kind: string
  origin: string
  summary: string | null
  aliases: string[]
  createdAt: string
  updatedAt: string
}

export interface KnowledgeWikiPageDto {
  id: string
  title: string
  type: string
  path: string
  description?: string
}

export interface KnowledgePendingCandidateDto {
  roomId: string
  title: string
  kind: string
  entityScore?: number
  vectorSimilarity?: number
}

export interface KnowledgePendingItemDto {
  decisionId: string
  sourceKind: string
  sourceId: string
  sourceVersion: number
  title: string
  summary: string | null
  reason: string | null
  confidence: number
  decidedBy: string | null
  newRoom: { name: string; summary: string; kind?: string } | null
  candidates: KnowledgePendingCandidateDto[]
  createdAt: string
}

export interface KnowledgeConfirmInput {
  roomIds?: string[]
  createRoom?: { name: string; summary?: string; kind?: string }
}

export interface KnowledgeFileUploadResult {
  filename: string
  title: string
  sourceId?: string
  /** true = 判重闸 1 命中：同名同内容已入库，全链路跳过（零成本）。 */
  deduped?: boolean
  error?: string
}

/** Room 的上传文件清单项（uploaded_files ⨝ 最新归属决策）。 */
export interface KnowledgeFileDto {
  id: string
  originalName: string
  bytes: number
  title: string | null
  status: string
  decidedBy: string | null
  confidence: number | null
  uploadedAt: string
}

/** 最近已落定（confirmed）决策：撤销入口用。 */
export interface KnowledgeDecisionDto {
  decisionId: string
  sourceKind: string
  sourceId: string
  title: string
  roomId: string | null
  roomTitle: string | null
  decidedBy: string | null
  confidence: number
  reason: string | null
  status: string
  createdAt: string
}
