/** MemoryCore（TencentDB Agent Memory Standalone Gateway）接入配置。 */
export interface MemoryRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  recallLimit: number;
  charBudget: number;
  /** 单请求超时（毫秒）；agent 注入流程保持默认 3s，UI 浏览场景可放宽。 */
  timeoutMs?: number;
}

/** 单条 L1 原子记忆（/v3/atomic/query、/v3/atomic/search 命中项）。 */
export interface MemoryAtomicItem {
  id: string;
  type: string;
  content: string;
  background?: string | undefined;
  /** 检索接口（atomic/search）命中时携带的相关性得分。 */
  score?: number | undefined;
  created_at: string;
  updated_at: string;
}

/** L1 原子记忆分页查询（/v3/atomic/query）入参。 */
export interface MemoryAtomicQuery {
  type?: "episodic" | "persona" | "instruction" | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
}

/** L1 原子记忆分页查询结果。 */
export interface MemoryAtomicPage {
  items: MemoryAtomicItem[];
  total: number;
}

/** L2 场景目录项（/v3/scenario/ls）。 */
export interface MemoryScenarioEntry {
  path: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}

/** L2 场景文件正文（/v3/scenario/read）。 */
export interface MemoryScenarioFile {
  path: string;
  /** Markdown 原文（含 META 头）；文件不存在时为 null。 */
  content: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** L0 对话消息（/v3/conversation/query 命中项）。 */
export interface MemoryConversationItem {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  recorded_at?: string;
  session_id?: string;
  /** 来源标记：'conversation'（缺省）| 'document'（md 导入的文档会话块）。 */
  source_kind?: string;
  source_ref?: string;
}

/** L0 对话分页查询（/v3/conversation/query）入参。 */
export interface MemoryConversationQuery {
  sessionId?: string | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
  /** 来源过滤：'conversation' = 仅对话（排除文档会话块）。 */
  sourceKind?: "conversation" | "document" | undefined;
}

/** L0 对话分页查询结果。 */
export interface MemoryConversationPage {
  messages: MemoryConversationItem[];
  total: number;
}

/** L3 核心画像文件（/v3/core/read）。 */
export interface MemoryCoreFile {
  /** Markdown 全文；尚未生成时为 null。 */
  content: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** 单个提炼层的 pipeline 运行状态（/v2/pipeline/status）。 */
export interface MemoryPipelineStage {
  queued: number;
  running: number;
  queued_sessions: string[];
  running_sessions: string[];
  idle: boolean;
}

/** MemoryCore 异步提炼管道状态。 */
export interface MemoryPipelineStatus {
  l1: MemoryPipelineStage;
  l2: MemoryPipelineStage;
  l3: MemoryPipelineStage;
}

/** L0 历史对话命中项（/v3/conversation/search，默认排除文档块）。 */
export interface MemoryConversationHit {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  score?: number;
  source_kind?: string;
}

/** 回写 MemoryCore L0 的一条消息。 */
export interface MemoryCaptureMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/** 文档登记行（/v3/document/* 响应中的 documents/document 项，snake_case 原样）。 */
export interface MemoryDocumentItem {
  document_id: string;
  title: string;
  /** 调用方资产引用：EverRoom gateway 传知识资产 file id。 */
  caller_ref: string;
  version: number;
  session_id: string;
  chunk_count: number;
  team_id: string;
  user_id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
  derived_memory_count?: number;
}

/** /v3/document/import 响应。 */
export interface MemoryDocumentImportResult {
  document: MemoryDocumentItem;
  document_id: string;
  /** "v1" 形式的版本标签。 */
  version: string;
  session_id: string;
  chunk_count: number;
  deduplicated: boolean;
  replaced_versions: number;
  accepted_chunks: number;
}

/** 文档分块（/v3/document/get 的 chunks 项，含 L0 正文与行区间锚点）。 */
export interface MemoryDocumentChunk {
  chunk_index: number;
  message_id: string;
  heading_path: string;
  line_start: number;
  line_end: number;
  content: string;
  recorded_at?: string | null;
}

/** 文档派生的 L1 原子（/v3/document/get 的 memories 项）。 */
export interface MemoryDocumentMemory {
  id: string;
  type: string;
  content: string;
  priority?: number;
  background?: string;
  source_message_ids?: string[];
  created_at?: string;
  updated_at?: string;
}

/** /v3/document/get 响应。 */
export interface MemoryDocumentDetail {
  document: MemoryDocumentItem;
  chunks: MemoryDocumentChunk[];
  memories: MemoryDocumentMemory[];
}

/** /v3/atomic/provenance 的锚点项（消息原文 + 文档定位信息）。 */
export interface MemoryProvenanceAnchor {
  message_id: string;
  role: string;
  content: string;
  recorded_at?: string;
  session_id?: string;
  source_kind: string;
  heading_path?: string;
  line_start?: number;
  line_end?: number;
  chunk_index?: number;
}

/** /v3/atomic/provenance 响应（一站式双向溯源）。 */
export interface MemoryAtomicProvenance {
  memory_id: string;
  type: string;
  content: string;
  kind: string;
  session?: { session_id?: string; session_key?: string };
  document?: {
    document_id: string;
    title: string;
    caller_ref: string;
    version: number;
    session_id: string;
  };
  anchor_message_ids: string[];
  anchors: MemoryProvenanceAnchor[];
}

