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
}

/** 单条 L1 原子记忆（/v3/atomic/search 命中项）。 */
export interface MemoryAtomicItem {
  id: string;
  type: string;
  content: string;
  background?: string;
  created_at: string;
  updated_at: string;
}

/** L2 场景目录项（/v3/scenario/ls）。 */
export interface MemoryScenarioEntry {
  path: string;
  summary?: string;
  created_at: string;
  updated_at: string;
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
