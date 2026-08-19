import type {
  KnowledgePageEntry,
  KnowledgePageReadItem,
  KnowledgeRuntimeConfig,
  KnowledgeSearchResult,
} from "./types.js";
import { resolveDefaultWikiIds } from "./types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
/** 服务端 page/read 单批上限（WriteOutcome 校验 PAGE_READ_MAX）。 */
const PAGE_READ_MAX = 20;

interface ApiResponseEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data?: T;
}

/** Knowledge Service 调用失败的分类，供上层（如 gateway）映射 HTTP 状态。 */
export type KnowledgeServiceErrorKind = "unreachable" | "http" | "api";

export class KnowledgeServiceError extends Error {
  constructor(
    readonly kind: KnowledgeServiceErrorKind,
    message: string,
    /** HTTP 状态码（http 类）或响应 code（api 类）。 */
    readonly status?: number,
  ) {
    super(message);
    this.name = "KnowledgeServiceError";
  }
}

/**
 * Knowledge Service v3 wiki 读路径的薄 HTTP 客户端。
 *
 * 只覆盖 pi agent 按需检索需要的三个接口（search / page/ls / page/read），
 * 均为 id-only 端点：header x-tdai-service-id + body wiki_id。
 * 所有请求带 3s 超时，非 2xx 或 code !== 0 时抛错，由调用方决定降级策略。
 */
export class KnowledgeServiceClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly configuredWikiIds: string[];
  private readonly timeoutMs: number;

  constructor(config: KnowledgeRuntimeConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = {
      "content-type": "application/json",
      "x-tdai-service-id": config.serviceId,
    };
    this.configuredWikiIds = resolveDefaultWikiIds(config);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** 配置携带的默认 wiki 集合（会话未解析出 Room wiki 时的回退）。 */
  get defaultWikiIds(): string[] {
    return this.configuredWikiIds;
  }

  /** 单次请求的目标 wiki；缺省取默认集合首个，两者皆空视为未配置。 */
  private resolveWikiId(wikiId?: string): string {
    const target = wikiId ?? this.configuredWikiIds[0];
    if (!target) {
      throw new KnowledgeServiceError("api", "Knowledge wiki is not configured for this request");
    }
    return target;
  }

  /** wiki 页面混合检索（BM25 种子 + 可选多跳图扩展）。 */
  async searchWiki(query: string, limit: number, wikiId?: string): Promise<KnowledgeSearchResult[]> {
    const data = await this.post<{ results?: KnowledgeSearchResult[] }>("/v3/wiki/search", {
      wiki_id: this.resolveWikiId(wikiId),
      query,
      limit,
    });
    return data?.results ?? [];
  }

  /** 列出 wiki 全部页面（目录元信息）；wiki 未 ready 时为空数组。 */
  async listPages(wikiId?: string): Promise<KnowledgePageEntry[]> {
    const data = await this.post<{ items?: KnowledgePageEntry[] }>("/v3/wiki/page/ls", {
      wiki_id: this.resolveWikiId(wikiId),
    });
    return data?.items ?? [];
  }

  /** 批量读取页面正文；超出单批上限时截断（not_found 由服务端逐项标注）。 */
  async readPages(refs: string[], wikiId?: string): Promise<KnowledgePageReadItem[]> {
    if (refs.length === 0) return [];
    const data = await this.post<{ items?: KnowledgePageReadItem[] }>("/v3/wiki/page/read", {
      wiki_id: this.resolveWikiId(wikiId),
      refs: refs.slice(0, PAGE_READ_MAX),
    });
    return data?.items ?? [];
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new KnowledgeServiceError(
        "unreachable",
        `Knowledge service ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new KnowledgeServiceError(
        "http",
        `Knowledge service ${path} failed: HTTP ${response.status}`,
        response.status,
      );
    }
    let envelope: ApiResponseEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiResponseEnvelope<T>;
    } catch (error) {
      throw new KnowledgeServiceError(
        "http",
        `Knowledge service ${path} returned non-JSON body: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (envelope.code !== 0) {
      throw new KnowledgeServiceError(
        "api",
        `Knowledge service ${path} failed: code=${envelope.code} ${envelope.message}`,
        envelope.code,
      );
    }
    return envelope.data;
  }
}
