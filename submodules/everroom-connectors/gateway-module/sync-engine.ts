import type { ConnectorConnection } from "@nxcore/connector-contract";
import type { ConnectorExecutor, PullPage } from "./types.js";
import type { DirectHttpResponse, DirectPullContext } from "./sync-providers/types.js";
import { syncProviderOf } from "./sync-providers/index.js";

/** 直连请求的统一安全约束：https（http 仅限 loopback 源自托管场景？否——一律禁）、
 * 禁内网/环回、禁 URL 内嵌凭据、超时与响应体大小上限。 */
function assertDirectUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`direct_url_invalid: ${raw.slice(0, 120)}`);
  }
  if (parsed.protocol !== "https:") throw new Error("direct_url_must_be_https");
  if (parsed.username || parsed.password) throw new Error("direct_url_credentials_forbidden");
  if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1$|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(parsed.hostname))
    throw new Error("direct_url_private_address_forbidden");
  return parsed;
}

const DIRECT_TIMEOUT_MS = 15_000;
const DIRECT_MAX_BYTES = 5 * 1024 * 1024;

async function directGet(url: string, headers: Record<string, string> = {}): Promise<DirectHttpResponse> {
  assertDirectUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    const raw = await response.arrayBuffer();
    if (raw.byteLength > DIRECT_MAX_BYTES)
      throw new Error(`direct_response_too_large: ${raw.byteLength}`);
    const flattened: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      flattened[key.toLowerCase()] = value;
    });
    return {
      status: response.status,
      headers: flattened,
      body: new TextDecoder("utf-8").decode(raw),
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(`direct_timeout_after_ms: ${DIRECT_TIMEOUT_MS}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function directPostJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  assertDirectUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
      body: JSON.stringify(body ?? {}),
      redirect: "follow",
      signal: controller.signal,
    });
    const raw = await response.text();
    if (raw.length > DIRECT_MAX_BYTES) throw new Error(`direct_response_too_large: ${raw.length}`);
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`direct_response_not_json (HTTP ${response.status})`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError")
      throw new Error(`direct_timeout_after_ms: ${DIRECT_TIMEOUT_MS}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SyncEngine（阶段三）：按 SyncProvider.engine 分发拉取——OAuth 源走 Nango 代理，
 * 直连源走引擎 HTTP。Nango secret 未就绪期间（桌面冷启动自举窗口）canServe 对
 * nango 源返回 false，避免 401 噪音；direct 源不受影响。
 */
export class SyncEngine {
  private nangoReady = true;
  constructor(
    private readonly nango: ConnectorExecutor | null,
    /** 连接凭据解析（webcal-url = 订阅 URL；由 repository 的 credentials_ref 列提供）。 */
    private readonly credentialsOf: (connection: ConnectorConnection) => string | null,
  ) {}

  setNangoReady(ready: boolean) {
    this.nangoReady = ready;
  }

  canServe(provider: string): boolean {
    const definition = syncProviderOf(provider);
    if (!definition) return false;
    if (definition.engine === "direct") return typeof definition.pullDirect === "function";
    return this.nango !== null && this.nangoReady;
  }

  async *pull(
    scope: {
      id: string;
      provider: string;
      connectionName: string;
      service?: string;
      providerScopeId: string;
      sourceCursor: string | null;
    },
    connection: ConnectorConnection,
    mode: Parameters<ConnectorExecutor["pull"]>[1],
  ): AsyncGenerator<PullPage> {
    const definition = syncProviderOf(scope.provider);
    if (!definition) throw new Error(`unknown_connector_provider: ${scope.provider}`);
    if (definition.engine === "direct") {
      if (!definition.pullDirect) throw new Error(`sync_provider_missing_pull_direct: ${scope.provider}`);
      const credentials = this.credentialsOf(connection);
      if (!credentials) throw new Error("direct_credentials_missing");
      const ctx: DirectPullContext = {
        credentials,
        providerScopeId: scope.providerScopeId,
        sourceCursor: scope.sourceCursor,
        httpGet: directGet,
        httpPostJson: directPostJson,
      };
      yield* definition.pullDirect(ctx, mode);
      return;
    }
    if (!this.nango) throw new Error("connectors_disabled");
    yield* this.nango.pull(
      {
        ...scope,
        provider: scope.provider,
        connectionName: scope.connectionName,
        ...(scope.service ? { service: scope.service } : {}),
      },
      mode,
    );
  }
}
