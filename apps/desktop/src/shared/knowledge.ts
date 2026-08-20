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

export interface KnowledgeRoomContextDto {
  roomId: string
  generatedAt: string
  sourceDocuments: Array<{
    documentId: string
    title: string
    version: number
    updatedAt: string
  }>
  overview: string
  status: string
  nextSteps: string[]
  entities: Array<{ name: string; kind: string; description: string }>
  actionItems: Array<{
    title: string
    owner: string | null
    dueDate: string | null
    sourceTitle: string
  }>
  meetings: Array<{
    title: string
    when: string
    participants: string[]
    sourceTitle: string
  }>
}

export interface KnowledgeWikiPageDto {
  id: string
  title: string
  type: string
  path: string
  description?: string
}

/** Room ↔ wiki 映射行（GET /v1/knowledge/wikis）。 */
export interface KnowledgeWikiDto {
  roomId: string
  knowledgeId: string
  status: string
  createdAt: string
}

/** wiki 内链图谱（页面=节点、md 内链=边；无 wiki/失败为空图）。 */
export interface KnowledgeWikiGraphDto {
  nodes: Array<{ id: string; title: string; path: string; inLinks: number }>
  edges: Array<{ source: string; target: string }>
}

/** 实体六类（与 gateway ENTITY_KINDS 对齐）。 */
export const KNOWLEDGE_ENTITY_KINDS = ['人物', '项目', '主题', '长期目标', '议题', '事件'] as const

/** ready = 推荐态（达阈值等用户确认创建，entity-room-plan 推荐确认制）。 */
export type KnowledgeEntityStatus = 'weak' | 'ready' | 'promoting' | 'room' | 'archived'

/** 候选实体（entity-room-plan §4.7）：弱期概述由 UI 从依据句派生（ED7）。 */
export interface KnowledgeEntityDto {
  id: string
  name: string
  kind: string
  status: string
  roomId: string | null
  evidenceScore: number
  sourceCount: number
  promoteScore: number
  promoteSources: number
  firstEvidence: string | null
  lastLinkedAt: string | null
  updatedAt: string
}

export interface KnowledgeEntityLinkDto {
  id: string
  entityId: string
  sourceKind: string
  sourceId: string
  sourceVersion: number
  role: string
  salience: number
  evidence: string | null
  decidedBy: string
  sourceTitle: string | null
  createdAt: string
  updatedAt: string
}

export interface KnowledgeEntityDetailDto {
  entity: {
    id: string
    name: string
    aliases: string[]
    kind: string
    summary: string | null
    status: string
    roomId: string | null
    evidenceScore: number
    sourceCount: number
    mergedFrom: string[]
    lastLinkedAt: string | null
    createdAt: string
    updatedAt: string
  }
  room: { id: string; title: string; kind: string } | null
  links: KnowledgeEntityLinkDto[]
}

/** 未识别栏条目（抽取空/失败的资料，等待人工挂载）。 */
export interface KnowledgeUnmatchedItemDto {
  decisionId: string
  sourceKind: string
  sourceId: string
  title: string
  summary: string | null
  reason: string | null
  createdAt: string
}

/** 手动挂载：选既有实体，或就地新建。 */
export interface KnowledgeAttachInput {
  entityId?: string
  createEntity?: { name: string; kind: string }
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
