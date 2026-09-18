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

export type KnowledgeRoomRelationVisibility = 'active' | 'hidden' | 'all'
export type KnowledgeRoomRelationStrength = 'weak' | 'medium' | 'strong'
export type KnowledgeRoomRelationManualType =
  | 'related'
  | 'depends_on'
  | 'part_of'
  | 'supports'
  | 'blocks'
  | 'owns'
  | 'custom'

export interface KnowledgeRoomRelationReasonDto {
  kind: 'shared_source' | 'direct_mention' | 'shared_entity'
  contribution: number
  key: string
  label: string
  sourceKind?: string
  sourceId?: string
  entityId?: string
  evidence?: string | null
}

export interface KnowledgeRoomRelationDto {
  id: string
  sourceRoomId: string
  targetRoomId: string
  directed: boolean
  type: 'shared_evidence' | 'shared_entity' | 'mixed' | KnowledgeRoomRelationManualType
  origin: 'auto' | 'manual' | 'hybrid'
  score: number
  strength: KnowledgeRoomRelationStrength
  sharedSourceCount: number
  sharedEntityCount: number
  directMentionCount: number
  pinned: boolean
  hidden: boolean
  label: string | null
  note: string | null
  topReasons: KnowledgeRoomRelationReasonDto[]
  updatedAt: string
}

export interface KnowledgeRoomGraphDto {
  revision: number
  generatedAt: string
  indexing: {
    status: 'ready' | 'building' | 'degraded'
    pendingSources: number
  }
  nodes: Array<{
    id: string
    title: string
    kind: string
    origin: string
    updatedAt: string
  }>
  edges: KnowledgeRoomRelationDto[]
}

export interface CreateKnowledgeRoomRelationInput {
  fromRoomId: string
  toRoomId: string
  type: KnowledgeRoomRelationManualType
  directed?: boolean
  label?: string | null
  note?: string | null
}

export interface UpdateKnowledgeRoomRelationInput {
  type?: KnowledgeRoomRelationManualType
  directed?: boolean
  fromRoomId?: string
  toRoomId?: string
  label?: string | null
  note?: string | null
  pinned?: boolean
  hidden?: boolean
}

export interface KnowledgeRoomContextDto {
  roomId: string
  generatedAt: string
  sourceDocuments: Array<{ documentId: string; title: string; version: number; updatedAt: string }>
  overview: string
  status: string
  nextSteps: string[]
  entities: Array<{ name: string; kind: string; description: string }>
  actionItems: Array<{ title: string; owner: string | null; dueDate: string | null; sourceTitle: string }>
  meetings: Array<{ title: string; when: string; participants: string[]; sourceTitle: string }>
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
export type KnowledgeEntityStatus = 'weak' | 'ready' | 'promoting' | 'room' | 'archived' | 'suppressed'

export interface KnowledgePromotionProgressDto {
  jobId: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  stage: 'queued' | 'checking_identity' | 'registering_entity' | 'creating_room' | 'creating_wiki' | 'importing_documents' | 'completed' | 'failed'
  message: string
  current: number | null
  total: number | null
  queuePosition: number | null
  roomId: string | null
  error: string | null
  updatedAt: string
}

/** 候选实体（entity-room-plan §4.7）：弱期概述由 UI 从依据句派生（ED7）。 */
export interface KnowledgeEntityDto {
  id: string
  name: string
  kind: string
  status: string
  roomId: string | null
  /** 归属 Room 标题（网关已按 merged 链 canonical 化；挂载/推荐读侧展示归属用）。 */
  roomTitle: string | null
  evidenceScore: number
  sourceCount: number
  eligibleSourceCount: number
  trustedSourceCount: number
  strongSourceCount: number
  readinessPath: 'standard' | 'strong' | null
  sourceKinds: string[]
  excludedSourceCount: number
  promoteScore: number
  promoteSources: number
  firstEvidence: string | null
  lastLinkedAt: string | null
  updatedAt: string
  existingRoomMatch: {
    roomId: string
    roomTitle: string
    entityId: string
    confidence: 'high' | 'medium'
    score: number
    reasons: string[]
  } | null
  promotion: KnowledgePromotionProgressDto | null
}

export interface KnowledgeEntityLinkDto {
  id: string
  entityId: string
  sourceKind: string
  sourceId: string
  sourceVersion: number
  role: string
  salience: number
  evidenceGroupKey: string
  roleWeight: number
  sourceWeight: number
  qualityFactor: number
  relevanceFactor: number
  effectiveWeight: number
  qualityLevel: string
  trusted: boolean
  strong: boolean
  scoreReasons: string[]
  scoringVersion: number
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
    eligibleSourceCount: number
    trustedSourceCount: number
    strongSourceCount: number
    readinessPath: 'standard' | 'strong' | null
    mergedFrom: string[]
    lastLinkedAt: string | null
    createdAt: string
    updatedAt: string
  }
  room: { id: string; title: string; kind: string } | null
  links: KnowledgeEntityLinkDto[]
}

export interface KnowledgeBatchPromoteResultDto {
  entityId: string
  status: 'queued' | 'already_queued' | 'rejected'
  jobId: string | null
  error: string | null
}

export interface KnowledgeBatchSuppressResultDto {
  entityId: string
  status: 'suppressed' | 'already_suppressed' | 'rejected'
  error: string | null
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

/** M3 知识整理偏好统计（确定性层，只读回溯三类信号的可复现快照）。 */
export interface KnowledgePreferenceStatsDto {
  corrections: { reverts: number; manualLinks: number }
  mergeVerdicts: {
    distinct: number
    related: number
    topDistinctNames: Array<{ name: string; count: number }>
  }
  promotion: { suppressed: number; promotedRooms: number }
  generatedAt: string
}

/** M3 知识整理偏好（三段式）：统计 + 系统洞察（只读）+ 用户偏好（编辑即接管）。 */
export interface KnowledgePreferencesDto {
  stats: KnowledgePreferenceStatsDto | null
  insight: string | null
  userPreference: string
  userEdited: boolean
  settings: { learningEnabled: boolean; injectionEnabled: boolean }
  materialCursor: string | null
}

export interface KnowledgeFileUploadResult {
  filename: string
  title: string
  sourceId?: string
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

/** 按 sourceId 查到的最新路由决策（任意状态）：推荐会话进度轮询用。 */
export interface KnowledgeRouteStatusDto {
  sourceId: string
  status: string
  title: string | null
  updatedAt: string
}

/** on-demand Room 推荐卡（创建入口「智能推荐」页签）。entityId 非空可走晋升链路。 */
export interface KnowledgeRoomProposalDto {
  entityId: string | null
  anchorName: string
  name: string
  kind: string
  description: string
  reason: string
  sourceNames: string[]
  fileCount: number
  evidenceScore: number | null
  sourceCount: number | null
}

/* ============ 思路 · 知识涌现（POST /v1/knowledge/rooms/:roomId/emergence） ============ */

export type EmergenceMode = 'focus' | 'wander'

export interface EmergenceFocusInput {
  /** 当前产物/文档 id（伴随区编辑态；独立面板缺省=Room 级焦点）。 */
  documentId?: string | null
  /** 选区文本（渲染层负责截断）。 */
  selectionText?: string | null
  blockId?: string | null
}

export interface EmergenceWanderInput {
  /** 「沿此漫步」换起点：候选的 nodeRef；缺省=当前焦点。 */
  startNodeRef?: string | null
  /** 可复现随机种子；「再走一次」传新 seed。 */
  seed?: number | null
}

export interface EmergenceRequest {
  mode: EmergenceMode
  focus: EmergenceFocusInput
  wander?: EmergenceWanderInput | null
  /** 卡片上限（聚焦默认 5，漫步默认 15）。 */
  limit?: number | null
  /** 客户端递增版本，响应原样带回；旧响应不得覆盖新焦点。 */
  requestVersion: number
}

/** 卡片类型（PRD 7.6）。 */
export type EmergenceCardKind =
  | 'evidence' // 直接证据
  | 'decision' // 历史决策
  | 'viewpoint' // 相邻观点
  | 'conflict' // 冲突反例
  | 'actor' // 人物与项目
  | 'case' // 相似案例
  | 'question' // 待回答问题

/** 统一对象层节点（PRD 8.2 CanonicalNode 的 DTO 投影）。 */
export interface EmergenceNodeDto {
  /** nodeRef 形如 entity:12 / fact:7 / doc:9 / block:9:3 / memory:x / wiki:3 / room:4。 */
  id: string
  nodeType: 'room' | 'entity' | 'fact' | 'document' | 'block' | 'memory' | 'wikiPage' | 'wikiTopic'
  label: string
  sourceGraph: 'roomGraph' | 'entityFacts' | 'linkGraph' | 'wiki'
  /** 来源 Room（跨 Room 结果标注用）。 */
  roomRef: { id: string; title: string } | null
  updatedAt: string | null
}

export interface EmergenceEdgeDto {
  id: string
  from: string
  to: string
  relationType: string
  /** PRD 8.3 关系分级：原始=实线 / 组合=虚线 / 语义=点线。 */
  edgeLevel: 'original' | 'composed' | 'semantic'
  confidence: number | null
}

/** 起点到目标的完整可解释路径（漫步硬性要求）。 */
export interface EmergencePathDto {
  /** nodeRef 链，含起点与终点。 */
  nodeRefs: string[]
  /** 每跳的简短关系说明，长度 = nodeRefs.length - 1。 */
  hops: string[]
}

export interface EmergenceCardDto {
  id: string
  kind: EmergenceCardKind
  title: string
  summary: string
  sourceType: string
  occurredAt: string | null
  roomRef: { id: string; title: string } | null
  /** 出现理由（聚焦=LLM 生成或降级路径说明；漫步=确定性路径说明）。 */
  reason: string
  quote: string | null
  path: EmergencePathDto | null
  confidence: number
  /** 指向 ProjectionResult.nodes 的节点（卡片⇄脉络联动）。 */
  nodeRef: string | null
}

export interface EmergenceProjectionResultDto {
  cards: EmergenceCardDto[]
  nodes: EmergenceNodeDto[]
  edges: EmergenceEdgeDto[]
  paths: EmergencePathDto[]
  scoreComponents: Record<string, number> | null
  requestVersion: number
  /** LLM 任务理解不可用时按 PRD 7.4 降级（关键词+向量+图谱路径）。 */
  degraded: boolean
  degradedReason: string | null
  generatedAt: string
}
