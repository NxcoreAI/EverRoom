import type {
  MemoryAtomicItem,
  MemoryCaptureMessage,
  MemoryConversationHit,
  MemoryRuntimeConfig,
  MemoryScenarioEntry,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 3_000;

interface ApiResponseEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
}

/**
 * MemoryCore v3 数据面的薄 HTTP 客户端。
 *
 * 只覆盖 pi agent 记忆接入需要的五个接口；所有请求带 3s 超时，
 * 非 2xx 或 code !== 0 时抛错，由调用方决定降级策略。
 */
export class MemoryCoreClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly isolationBody: Record<string, string>;

  constructor(config: MemoryRuntimeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      "x-tdai-service-id": config.serviceId,
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    };
    this.isolationBody = {
      team_id: config.teamId,
      agent_id: config.agentId,
      user_id: config.userId,
    };
  }

  /** L0：写入本轮对话消息。 */
  async addConversation(sessionId: string, messages: MemoryCaptureMessage[]): Promise<void> {
    await this.post<void>("/v3/conversation/add", {
      ...this.isolationBody,
      session_id: sessionId,
      messages: messages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      })),
    });
  }

  /** L1：原子记忆混合检索（不限定 session，跨会话聚合）。 */
  async searchAtomic(query: string, limit: number): Promise<MemoryAtomicItem[]> {
    const data = await this.post<{ items?: MemoryAtomicItem[] }>("/v3/atomic/search", {
      ...this.isolationBody,
      query,
      limit,
    });
    return data?.items ?? [];
  }

  /** L0：历史对话全文检索；sessionId 存在时限定单会话。 */
  async searchConversation(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<MemoryConversationHit[]> {
    const data = await this.post<{ messages?: MemoryConversationHit[] }>("/v3/conversation/search", {
      ...this.isolationBody,
      ...(sessionId ? { session_id: sessionId } : {}),
      query,
      limit,
    });
    return data?.messages ?? [];
  }

  /** L3：读取核心画像；尚未生成时返回 null。 */
  async readCore(): Promise<{ content: string; updatedAt: string | null } | null> {
    const data = await this.post<{ content: string | null; updated_at: string | null }>(
      "/v3/core/read",
      { ...this.isolationBody },
    );
    if (!data || data.content == null) return null;
    return { content: data.content, updatedAt: data.updated_at ?? null };
  }

  /** L2：列出场景目录（仅元信息，正文由 agent 用工具按需读取）。 */
  async listScenarios(): Promise<MemoryScenarioEntry[]> {
    const data = await this.post<{ entries?: MemoryScenarioEntry[] }>("/v3/scenario/ls", {
      ...this.isolationBody,
    });
    return data?.entries ?? [];
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`MemoryCore ${path} failed: HTTP ${response.status}`);
    }
    const envelope = (await response.json()) as ApiResponseEnvelope<T>;
    if (envelope.code !== 0) {
      throw new Error(`MemoryCore ${path} failed: code=${envelope.code} ${envelope.message}`);
    }
    return envelope.data;
  }
}
