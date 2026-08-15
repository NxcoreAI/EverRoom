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
}

/** L0 对话分页查询（/v3/conversation/query）入参。 */
export interface MemoryConversationQuery {
  sessionId?: string | undefined;
  limit: number;
  offset: number;
  timeStart?: string | undefined;
  timeEnd?: string | undefined;
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

/** L0 历史对话命中项（/v3/conversation/search）。 */
export interface MemoryConversationHit {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
  score?: number;
}

/** 回写 MemoryCore L0 的一条消息。 */
export interface MemoryCaptureMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

