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
  contentHash: string
  /** 是否已有归一化解析产物（未进过链路的裸上传为 false）。 */
  parsed: boolean
  createdAt: string
  updatedAt: string
}

/** 统一导入的每份文件结果（导入对话框逐行展示）。 */
export interface FileImportOutcome {
  filename: string
  fileId: string | null
  /** 引擎台账事件（进入链路成功时）。 */
  eventId: string | null
  dataType: string | null
  deduped: boolean
  pipelines: IngestPipelines | null
  memoryResult: { documentId: string; chunkCount: number; deduplicated: boolean } | { error: string } | null
  routeJobId: string | null
  error: string | null
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
  originChannel: string
  createdAt: string
  updatedAt: string
}
