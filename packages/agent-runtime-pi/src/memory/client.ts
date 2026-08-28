import type {
  MemoryAtomicItem,
  MemoryAtomicPage,
  MemoryAtomicProvenance,
  MemoryAtomicQuery,
  MemoryCaptureMessage,
  MemoryConversationHit,
  MemoryConversationItem,
  MemoryConversationPage,
  MemoryConversationQuery,
  MemoryCoreFile,
  MemoryDocumentDetail,
  MemoryDocumentImportResult,
  MemoryDocumentItem,
  MemoryPipelineStatus,
  MemoryRuntimeConfig,
  MemoryScenarioEntry,
  MemoryScenarioFile,
} from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
/** 文档导入：切块 + 逐块 embedding + L0 落库，大文档远超普通查询超时。 */
const DOCUMENT_IMPORT_TIMEOUT_MS = 120_000;
/**
 * 连接失败重试等待：桌面主进程在 runtime config 变更后会重启
 * MemoryCore（embedding env 注入），kill → 新进程过 health 探活之间有
 * 1~3s 空窗；期间 renderer 轮询（如 memory:overview）会撞上 ECONNREFUSED
 * 刷屏。只对连接类失败重试两次（1s、2s 后），4xx/5xx/超时不重试。
 */
const CONNECT_RETRY_DELAYS_MS = [1_000, 2_000] as const;

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(message);
}

interface ApiResponseEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
}

/** MemoryCore 调用失败的分类，供上层（如 gateway）映射 HTTP 状态。 */
export type MemoryCoreErrorKind = "unreachable" | "http" | "api";

export class MemoryCoreError extends Error {
  constructor(
    readonly kind: MemoryCoreErrorKind,
    message: string,
    /** HTTP 状态码（http 类）或响应 code（api 类）。 */
    readonly status?: number,
  ) {
    super(message);
    this.name = "MemoryCoreError";
  }
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
  private readonly timeoutMs: number;

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
    this.timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
        ...(message.recordedAt ? { recorded_at: message.recordedAt } : {}),
      })),
    });
  }

  /** L1：原子记忆混合检索（不限定 session，跨会话聚合）；timeRange 按命中项 updated_at 过滤（含端点）。 */
  async searchAtomic(
    query: string,
    limit: number,
    timeRange?: { start?: string | undefined; end?: string | undefined },
  ): Promise<MemoryAtomicItem[]> {
    const data = await this.post<{ items?: MemoryAtomicItem[] }>("/v3/atomic/search", {
      ...this.isolationBody,
      query,
      limit,
      ...(timeRange?.start ? { time_start: timeRange.start } : {}),
      ...(timeRange?.end ? { time_end: timeRange.end } : {}),
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

  // ---- 以下为 PC 端「记忆」应用（gateway /v1/memory/* 代理）扩展的浏览/管理接口 ----

  /** L1：原子记忆分页全量列表（非检索）。 */
  async queryAtomic(query: MemoryAtomicQuery): Promise<MemoryAtomicPage> {
    const data = await this.post<MemoryAtomicPage>("/v3/atomic/query", {
      ...this.isolationBody,
      ...(query.type ? { type: query.type } : {}),
      limit: query.limit,
      offset: query.offset,
      ...(query.timeStart ? { time_start: query.timeStart } : {}),
      ...(query.timeEnd ? { time_end: query.timeEnd } : {}),
    });
    return { items: data?.items ?? [], total: data?.total ?? 0 };
  }

  /** L1：编辑单条原子记忆。 */
  async updateAtomic(
    id: string,
    content: string,
    background?: string,
  ): Promise<{ id: string; version: number; updated_at: string }> {
    return this.post("/v3/atomic/update", {
      ...this.isolationBody,
      id,
      content,
      ...(background !== undefined ? { background } : {}),
    }) as Promise<{ id: string; version: number; updated_at: string }>;
  }

  /** L1：批量删除原子记忆。 */
  async deleteAtomic(ids: string[]): Promise<{ deleted_count: number }> {
    const data = await this.post<{ deleted_count?: number }>("/v3/atomic/delete", {
      ...this.isolationBody,
      ids,
    });
    return { deleted_count: data?.deleted_count ?? 0 };
  }

  /** L1：原子记忆总数（可按 type 过滤）。 */
  async countAtomic(type?: MemoryAtomicQuery["type"]): Promise<number> {
    const data = await this.post<{ total?: number }>("/v3/atomic/count", {
      ...this.isolationBody,
      ...(type ? { type } : {}),
    });
    return data?.total ?? 0;
  }

  /** L0：对话消息分页列表（不传 sessionId 时跨会话，消息带 session_id）。 */
  async queryConversation(query: MemoryConversationQuery): Promise<MemoryConversationPage> {
    const data = await this.post<MemoryConversationPage>("/v3/conversation/query", {
      ...this.isolationBody,
      ...(query.sessionId ? { session_id: query.sessionId } : {}),
      limit: query.limit,
      offset: query.offset,
      ...(query.timeStart ? { time_start: query.timeStart } : {}),
      ...(query.timeEnd ? { time_end: query.timeEnd } : {}),
      ...(query.sourceKind ? { source_kind: query.sourceKind } : {}),
    });
    return { messages: data?.messages ?? [], total: data?.total ?? 0 };
  }

  /** L0：按会话或消息删除。 */
  async deleteConversation(
    target: { sessionIds?: string[] | undefined; messageIds?: string[] | undefined },
  ): Promise<{ deleted_count: number }> {
    const data = await this.post<{ deleted_count?: number }>("/v3/conversation/delete", {
      ...this.isolationBody,
      ...(target.sessionIds?.length ? { session_ids: target.sessionIds } : {}),
      ...(target.messageIds?.length ? { message_ids: target.messageIds } : {}),
    });
    return { deleted_count: data?.deleted_count ?? 0 };
  }

  /** L0：消息总数。 */
  async countConversation(): Promise<number> {
    const data = await this.post<{ total?: number }>("/v3/conversation/count", {
      ...this.isolationBody,
    });
    return data?.total ?? 0;
  }

  /** L2：读取单个场景文件正文；文件不存在时 content 为 null。 */
  async readScenario(path: string): Promise<MemoryScenarioFile> {
    const data = await this.post<MemoryScenarioFile | null>("/v3/scenario/read", {
      ...this.isolationBody,
      path,
    });
    return {
      path,
      content: data?.content ?? null,
      version: data?.version ?? 0,
      created_at: data?.created_at ?? "",
      updated_at: data?.updated_at ?? "",
    };
  }

  /** L2：场景文件总数。 */
  async countScenario(): Promise<number> {
    const data = await this.post<{ total?: number }>("/v3/scenario/count", {
      ...this.isolationBody,
    });
    return data?.total ?? 0;
  }

  /** L3：读取核心画像（带版本元信息）。 */
  async readCoreFile(): Promise<MemoryCoreFile> {
    const data = await this.post<MemoryCoreFile | null>("/v3/core/read", {
      ...this.isolationBody,
    });
    return {
      content: data?.content ?? null,
      version: data?.version ?? 0,
      created_at: data?.created_at ?? "",
      updated_at: data?.updated_at ?? "",
    };
  }

  /** L3：全量覆盖写入核心画像。 */
  async writeCore(content: string): Promise<{ version: number; updated_at: string }> {
    const data = await this.post<{ version?: number; updated_at?: string }>("/v3/core/write", {
      ...this.isolationBody,
      content,
    });
    return { version: data?.version ?? 0, updated_at: data?.updated_at ?? "" };
  }

  /** 异步提炼管道运行状态（standalone 模式的 /v2/pipeline/status）。 */
  async pipelineStatus(): Promise<MemoryPipelineStatus> {
    return this.post("/v2/pipeline/status", {})
      .then((data) => data as MemoryPipelineStatus);
  }

  // ---- 文档记忆子系统（md 一等来源，fork /v3/document/*）----

  /** 导入 md 文档：callerRef 传调用方资产 id（EverRoom 为知识资产 file id）。 */
  async importDocument(input: {
    title: string;
    markdown: string;
    callerRef: string;
    taskId?: string;
  }): Promise<MemoryDocumentImportResult> {
    return this.post<MemoryDocumentImportResult>("/v3/document/import", {
      ...this.isolationBody,
      title: input.title,
      markdown: input.markdown,
      caller_ref: input.callerRef,
      ...(input.taskId ? { task_id: input.taskId } : {}),
    }, DOCUMENT_IMPORT_TIMEOUT_MS) as Promise<MemoryDocumentImportResult>;
  }

  /** 文档详情：登记行 + 分块（含正文）+ 派生 L1（双向溯源数据源）。 */
  async getDocument(documentId: string): Promise<MemoryDocumentDetail> {
    return this.post<MemoryDocumentDetail>("/v3/document/get", {
      ...this.isolationBody,
      document_id: documentId,
    }) as Promise<MemoryDocumentDetail>;
  }

  /** 文档登记清单（当前身份下每身份键最新版本）。 */
  async listDocuments(query?: {
    limit?: number;
    offset?: number;
  }): Promise<{ documents: MemoryDocumentItem[]; total: number }> {
    const data = await this.post<{ documents?: MemoryDocumentItem[]; total?: number }>(
      "/v3/document/list",
      {
        ...this.isolationBody,
        limit: query?.limit ?? 50,
        offset: query?.offset ?? 0,
      },
    );
    return { documents: data?.documents ?? [], total: data?.total ?? 0 };
  }

  /** 删除文档（级联清 L0 会话、分块锚点、派生 L1 由 MemoryCore 负责）。 */
  async deleteDocument(documentId: string): Promise<{ document_id: string; deleted: boolean }> {
    return this.post("/v3/document/delete", {
      ...this.isolationBody,
      document_id: documentId,
    }) as Promise<{ document_id: string; deleted: boolean }>;
  }

  /** 原子记忆一站式溯源：来源会话/文档 + 锚点消息（含文档行区间）。 */
  async atomicProvenance(memoryId: string): Promise<MemoryAtomicProvenance> {
    return this.post<MemoryAtomicProvenance>("/v3/atomic/provenance", {
      ...this.isolationBody,
      memory_id: memoryId,
    }) as Promise<MemoryAtomicProvenance>;
  }

  private async post<T>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T | undefined> {
    const attempt = async (): Promise<Response> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
      try {
        return await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }
    };
    let response: Response | undefined;
    let lastConnectionError: unknown;
    for (let attemptNumber = 0; attemptNumber <= CONNECT_RETRY_DELAYS_MS.length; attemptNumber += 1) {
      try {
        response = await attempt();
        break;
      } catch (error) {
        lastConnectionError = error;
        const retryDelay = CONNECT_RETRY_DELAYS_MS[attemptNumber];
        if (!isConnectionFailure(error) || retryDelay === undefined) {
          throw new MemoryCoreError(
            "unreachable",
            `MemoryCore ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
    if (!response) {
      throw new MemoryCoreError(
        "unreachable",
        `MemoryCore ${path} unreachable: ${lastConnectionError instanceof Error ? lastConnectionError.message : String(lastConnectionError)}`,
      );
    }

    if (!response.ok) {
      throw new MemoryCoreError("http", `MemoryCore ${path} failed: HTTP ${response.status}`, response.status);
    }
    let envelope: ApiResponseEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiResponseEnvelope<T>;
    } catch (error) {
      throw new MemoryCoreError(
        "http",
        `MemoryCore ${path} returned non-JSON body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (envelope.code !== 0) {
      throw new MemoryCoreError(
        "api",
        `MemoryCore ${path} failed: code=${envelope.code} ${envelope.message}`,
        envelope.code,
      );
    }
    return envelope.data;
  }
}
