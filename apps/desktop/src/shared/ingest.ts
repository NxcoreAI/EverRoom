/** 统一理解引擎 / 文件中心的桌面端共享类型（unified-ingest-plan §8-§9，对齐 gateway DTO）。 */

/** 三链路开关（Room / wiki / 记忆）。 */
export interface IngestPipelines {
  room: boolean
  wiki: boolean
  memory: boolean
}

export interface FileDto {
  id: string
  originalName: string
  bytes: number
  mime: string
  assetKind: 'document' | 'screenshot' | 'photo' | 'audio' | 'other'
  originChannel: string
  visibility: 'private' | 'shared'
  capturedAt: string | null
  contentHash: string
  /** 是否已有归一化解析产物（未进过链路的裸上传为 false）。 */
  parsed: boolean
  createdAt: string
  updatedAt: string
}

export interface FileCatalogDto {
  id: string
  originalName: string
  displayName: string | null
  sharedTitle: string
  sourceKind: 'manual-upload' | 'local-folder' | 'connector' | 'web-clipper' | 'legacy-upload'
  sourceLabel: string
  relativePath: string | null
  provider: string | null
  bytes: number
  dataType: string | null
  agentCategory: string | null
  summary: string | null
  tags: string[]
  processingState: 'processing' | 'ready' | 'failed' | 'missing'
  clusterId: string | null
  contentHash: string
  parsed: boolean
  updatedAt: string
}

export interface FileFormatCapabilityDto {
  extension: string
  dataType: string
  parserId: string
  parserVersion: number
  manualImport: boolean
  autoScan: boolean
  connectorImport: boolean
  maxBytes: number
}

export interface FileImportAcceptedDto {
  fileEntryId: string
  fileVersionId: string
  jobId: string
  contentHash: string
  blobDeduped: boolean
  versionDeduped: boolean
}

/** 统一导入的每份文件结果（导入对话框逐行展示）。 */
export interface FileImportOutcome {
  filename: string
  fileId: string | null
  /** Exact immutable version accepted by the file service. */
  fileVersionId: string | null
  /** 引擎台账事件（进入链路成功时）。 */
  eventId: string | null
  dataType: string | null
  deduped: boolean
  /**
   * 非错误性跳过（不阻断其余文件，也不计入失败）：unsupported_format =
   * 格式不在白名单；pending_review = 高风险批次转人工确认。deduped 的
   * 「内容已存在」跳过由 deduped 字段表达。
   */
  skippedReason: 'unsupported_format' | 'pending_review' | null
  pipelines: IngestPipelines | null
  memoryResult: { documentId: string; chunkCount: number; deduplicated: boolean } | { error: string } | null
  routeJobId: string | null
  error: string | null
}

/** 手动导入批次的桌面端实时进度。 */
export interface FileImportProgressEvent {
  batchId: string
  status: 'started' | 'file-started' | 'file-completed' | 'completed'
  total: number
  completed: number
  filename: string | null
  succeeded: number
  failed: number
}

export interface HighRiskImportReview {
  id: string
  origin: 'manual-import' | 'auto-scan'
  sourceLabel: string
  fileCount: number
  createdAt: string
}

export interface HighRiskImportResolution {
  accepted: boolean
  imported: number
  failed: number
}

export interface IngestResultDto {
  eventId: string
  deduped: boolean
  source: { sourceKind: string; sourceId: string; sourceVersion: number }
  dataType: string
  detectedBy: string
  title: string
  contentHash: string
  parsedId: string
  pipelines: IngestPipelines
  routeJobId: string | null
  memoryResult: FileImportOutcome['memoryResult']
  originChannel: string
}

/** 过滤器判定快照（与 gateway IngestFilterVerdict 对齐）。 */
export interface IngestFilterVerdictDto {
  informative: boolean
  reason: string
  category: string
  confidence: number
}

export interface IngestEventDto {
  id: string
  sourceKind: string
  sourceId: string
  sourceVersion: number
  dataType: string
  detectedBy: string
  title: string
  contentHash: string
  parsedId: string
  pipelines: IngestPipelines
  memoryResult: FileImportOutcome['memoryResult']
  routeJobId: string | null
  /** 过滤闸状态：pending 判定中 / passed 放行 / filtered 被拦（可恢复）/ bypassed 故障放行。 */
  filterStatus: 'pending' | 'passed' | 'filtered' | 'bypassed' | null
  /** 判定快照（含 reason/category/confidence；恢复误杀的依据）。 */
  filterVerdict: IngestFilterVerdictDto | null
  originChannel: string
  createdAt: string
  updatedAt: string
}

/** 过滤规则文档（ingest-filter-agent-plan §4.3，记忆页「过滤规则」入口数据源）。 */
export interface IngestFilterRulesDto {
  /** 用户偏好段（可编辑，PUT 重写）。 */
  preference: string
  /** 系统洞察段（洞察 job 每小时重写，用户只读）。 */
  insight: string
  updatedAt: string | null
}
