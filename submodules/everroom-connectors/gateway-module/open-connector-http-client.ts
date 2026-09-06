/**
 * OpenConnectorHttpClient —— gateway 与 oo 连接层的唯一传输缝。
 *
 * 取代两条 spawn 链路：
 *   - service.ts runOpenConnector（`oo connector run ...` 子进程 + stdout JSON）
 *   - open-connector-tools.ts runOo（Agent 工具的 `oo ...` 子进程）
 *
 * 契约（上游 @oomol-lab/open-connectruntime-api，钉 commit 5719a69）：
 *   POST {baseUrl}/v1/actions/{service}.{action}
 *   body: { input, connectionName? }   header: Authorization: Bearer <runtimeToken>
 *   200 → { success: true, message: "OK", data, meta: { executionId, ... } }
 *   失败 → { success: false, message, data, errorCode, meta }（非 2xx）
 *   connectionName 亦可用 header x-oomol-connector-alias 传递（SaaS 转发层注入用）。
 *
 * 承接原 spawn 语义：120s 超时、runtimeToken 脱敏、错误消息透传；
 * 新增：408/429/5xx 自动重试（Restries: 3 语义，幂等 action 安全）。
 */
import type { OpenConnectorCliConfig } from "./host-types.js";

export interface RunActionOptions {
  connectionName?: string | undefined;
  signal?: AbortSignal | undefined;
  /** 覆盖默认 120s 超时。 */
  timeoutMs?: number | undefined;
  /** 透传 idempotency key（oo 幂等索赔）。 */
  idempotencyKey?: string | undefined;
}

export interface OpenConnectorHttpError extends Error {
  readonly status: number;
  readonly errorCode: string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

function redactText(value: string, secret?: string): string {
  return secret ? value.split(secret).join("<redacted>") : value;
}

function redactValue(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactValue(item, secret)]),
    );
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** 与 connectorResultData 同源封套解包：优先 data 字段，退化整体对象。 */
export function envelopeData(value: unknown): Record<string, unknown> {
  const root = objectValue(value);
  return Object.keys(objectValue(root.data)).length > 0 ? objectValue(root.data) : root;
}

export class OpenConnectorHttpClient {
  constructor(private readonly config: OpenConnectorCliConfig) {}

  /** 执行 action：`runAction("gmail", "fetch_emails", {...}, { connectionName })`。 */
  async runAction(
    service: string,
    action: string,
    input: Record<string, unknown>,
    options: RunActionOptions = {},
  ): Promise<unknown> {
    return this.post(
      `/v1/actions/${service}.${action}`,
      { input, ...(options.connectionName ? { connectionName: options.connectionName } : {}) },
      options,
    );
  }

  /** 兼容旧 runner 注入点的平坦封装：直接返回封套 data。 */
  async runActionData(
    service: string,
    action: string,
    input: Record<string, unknown>,
    options: RunActionOptions = {},
  ): Promise<Record<string, unknown>> {
    return envelopeData(await this.runAction(service, action, input, options));
  }

  /** GET /v1/apps —— 已连接账号清单（service/connectionName/isDefault）。 */
  async listApps(options: { signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    return this.get("/v1/apps", options);
  }

  /** GET /v1/apps/services/:service。 */
  async listAppsByService(service: string, options: { signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    return this.get(`/v1/apps/services/${encodeURIComponent(service)}`, options);
  }

  /** GET /v1/actions（可带 provider 过滤）。 */
  async listActions(query: { service?: string } = {}, options: { signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    const suffix = query.service ? `?service=${encodeURIComponent(query.service)}` : "";
    return this.get(`/v1/actions${suffix}`, options);
  }

  /** GET /v1/actions/search?q=...。 */
  async searchActions(query: string, options: { signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    return this.get(`/v1/actions/search?q=${encodeURIComponent(query)}`, options);
  }

  /** GET /v1/actions/{service}.{action} —— 单 action schema。 */
  async getAction(service: string, action: string, options: { signal?: AbortSignal | undefined } = {}): Promise<unknown> {
    return this.get(`/v1/actions/${encodeURIComponent(`${service}.${action}`)}`, options);
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(new URL("/health", this.baseUrl()), {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return false;
      const payload = objectValue(await response.json().catch(() => null));
      return payload.ok === true || payload.success === true;
    } catch {
      return false;
    }
  }

  private baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, "");
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    options: RunActionOptions = {},
    attempt = 0,
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.runtimeToken) headers.authorization = `Bearer ${this.config.runtimeToken}`;
    if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;

    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl()), {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted && options.signal?.aborted) {
        throw new Error("OpenConnector sync cancelled");
      }
      if (signal.aborted) {
        throw new Error("OpenConnector sync timed out");
      }
      // 网络层瞬时错误（ECONNRESET 等）：可重试
      if (attempt < MAX_RETRIES) {
        await this.backoff(attempt, options.signal);
        return this.request(method, path, body, options, attempt + 1);
      }
      throw new Error(`OpenConnector 连接失败：${redactText(message, this.config.runtimeToken)}`);
    }

    if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_RETRIES) {
      await this.backoff(attempt, options.signal);
      return this.request(method, path, body, options, attempt + 1);
    }

    const payload = await response.json().catch(() => null);
    const envelope = objectValue(payload);
    const redacted = redactValue(envelope, this.config.runtimeToken);

    if (!response.ok || envelope.success === false) {
      const error = new Error(
        typeof envelope.message === "string" && envelope.message
          ? envelope.message
          : `OpenConnector request failed (HTTP ${String(response.status)})`,
      ) as OpenConnectorHttpError;
      Object.assign(error, {
        status: response.status,
        errorCode: typeof envelope.errorCode === "string" ? envelope.errorCode : null,
      });
      throw error;
    }
    return redacted;
  }

  private async post(path: string, body: Record<string, unknown>, options: RunActionOptions): Promise<unknown> {
    return this.request("POST", path, body, options);
  }

  private async get(path: string, options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined }): Promise<unknown> {
    return this.request("GET", path, undefined, options);
  }

  private backoff(attempt: number, signal?: AbortSignal): Promise<void> {
    const delay = Math.min(1_000 * 2 ** attempt, 8_000);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("OpenConnector sync cancelled"));
      }, { once: true });
    });
  }
}
