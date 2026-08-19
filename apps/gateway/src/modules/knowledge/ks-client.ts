/**
 * KS（TencentDB MemoryKnowledge）写路径与管理接口的薄 HTTP 客户端。
 *
 * 与 pi 侧 KnowledgeServiceClient（只读三接口）互补，覆盖 Room wiki
 * 生命周期的管理面：create / update-meta / raw/write / ingest / get / raw/rm。
 * 所有请求带超时；409 busy（wiki 正在 processing）抛 KsBusyError，
 * 由 ingest-worker 退避重试（plan §5.3 per-wiki 串行约束的来源）。
 */

export interface KsClientConfig {
  /** 服务根地址（不含 /v3 前缀）。 */
  baseUrl: string;
  serviceId: string;
  teamId: string;
  timeoutMs?: number;
}

interface ApiResponseEnvelope<T> {
  code: number;
  message: string;
  data?: T;
}

/** wiki 正在 processing 时的并发拒绝（HTTP 409），调用方应退避重试。 */
export class KsBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KsBusyError";
  }
}

export class KsClientError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = "KsClientError";
  }
}

export interface KsWikiDetail {
  wiki_id: string;
  name: string;
  status: "draft" | "pending" | "processing" | "ready" | "failed";
  page_count: number | null;
  summary: string | null;
}

export interface KsRawFile {
  filename: string;
  content: string;
}

/** /v3/wiki/page/ls 条目：③ 实体匹配用 wiki 页面标题当术语表（plan §5.2）。 */
export interface KsWikiPageItem {
  id: string;
  title: string;
  type: string;
  path: string;
  description?: string;
}

/** /v3/wiki/page/read 单页结果：ref 为 page/ls 的 path，content 为 Markdown 全文。 */
export interface KsPageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class KsAdminClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly teamId: string;
  private readonly timeoutMs: number;

  constructor(config: KsClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      "x-tdai-service-id": config.serviceId,
    };
    this.teamId = config.teamId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** 幂等建 wiki：同 (service, team, name) 已存在返回原 wiki（200），新建 201；两者 data 相同。 */
  async createWiki(name: string): Promise<string> {
    const detail = await this.post<KsWikiDetail>("/v3/wiki/create", {
      team_id: this.teamId,
      name,
      user_id: "everroom",
    });
    if (!detail?.wiki_id) throw new KsClientError("wiki create returned no wiki_id");
    return detail.wiki_id;
  }

  /** 维护 wiki summary（agent 侧 about 线索 + 路由层候选身份卡）。 */
  async updateWikiSummary(wikiId: string, summary: string): Promise<void> {
    await this.post<KsWikiDetail>("/v3/wiki/update-meta", { wiki_id: wikiId, summary });
  }

  /**
   * 上传源文件（KS 限：单文件 512KB / 批 10 文件 / 总量 5MB）。
   * 同名覆盖——文档版本更新走同一路径实现 re-ingest（plan §5.5）。
   */
  async rawWrite(wikiId: string, files: KsRawFile[]): Promise<void> {
    await this.post("/v3/wiki/raw/write", { wiki_id: wikiId, team_id: this.teamId, files });
  }

  /** 触发 ingest（202 异步）；busy 抛 KsBusyError。 */
  async ingest(wikiId: string): Promise<void> {
    await this.post("/v3/wiki/ingest", { wiki_id: wikiId, user_id: "everroom" });
  }

  /** 删除源文件（KS 按 sources 并集级联清理页面）。 */
  async rawRm(wikiId: string, filenames: string[]): Promise<void> {
    await this.post("/v3/wiki/raw/rm", { wiki_id: wikiId, team_id: this.teamId, filenames });
  }

  async getWiki(wikiId: string): Promise<KsWikiDetail | null> {
    try {
      return (await this.post<KsWikiDetail>("/v3/wiki/get", { wiki_id: wikiId })) ?? null;
    } catch (error) {
      if (error instanceof KsClientError && error.status === 404) return null;
      throw error;
    }
  }

  /** wiki 处理产物页面清单（status≠ready 时 KS 返回空数组）。 */
  async listPages(wikiId: string): Promise<KsWikiPageItem[]> {
    const data = await this.post<{ items: KsWikiPageItem[] }>("/v3/wiki/page/ls", { wiki_id: wikiId });
    return data?.items ?? [];
  }

  /** 读页面 Markdown 全文（渲染器 Wiki Tab 用）；单 ref 不存在时 item.not_found=true。 */
  async readPage(wikiId: string, ref: string): Promise<KsPageReadItem | null> {
    const data = await this.post<{ items: KsPageReadItem[] }>("/v3/wiki/page/read", {
      wiki_id: wikiId,
      refs: [ref],
    });
    return data?.items?.[0] ?? null;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | undefined> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new KsClientError(
        `Knowledge service ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // KS 唯一的 409 语义：目标 wiki 正在 processing（ingest 并发 / 写入竞态）。
    if (response.status === 409) {
      throw new KsBusyError(`Knowledge service ${path} busy (wiki is processing)`);
    }
    if (!response.ok) {
      throw new KsClientError(`Knowledge service ${path} failed: HTTP ${response.status}`, response.status);
    }

    let envelope: ApiResponseEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiResponseEnvelope<T>;
    } catch (error) {
      throw new KsClientError(
        `Knowledge service ${path} returned non-JSON body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (envelope.code !== 0) {
      throw new KsClientError(
        `Knowledge service ${path} failed: code=${envelope.code} ${envelope.message}`,
        response.status,
        envelope.code,
      );
    }
    return envelope.data;
  }
}
