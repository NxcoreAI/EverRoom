import axios, { type AxiosInstance } from "axios";
import type { ConnectorExecutor, PullPage } from "./types.js";
import type { PullContext, SyncPullContext } from "./sync-providers/types.js";
import { syncProviderOf } from "./sync-providers/index.js";

export function nangoProxyRequest(
  secret: string,
  connectionId: string,
  configKey: string,
  url: string,
  providerHeaders: Record<string, string> = {},
) {
  const target = new URL(url);
  return {
    path: `/proxy${target.pathname}${target.search}`,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Connection-Id": connectionId,
      "Provider-Config-Key": configKey,
      Retries: "3",
      "Retry-On": "408",
      ...Object.fromEntries(
        Object.entries(providerHeaders).map(([key, value]) => [
          `nango-proxy-${key}`,
          value,
        ]),
      ),
    },
  };
}

/**
 * 通用 Nango 引擎（阶段二拆迁后）：只负责 Nango 代理的鉴权/重试/错误语义与
 * SyncProvider 上下文装配——provider 逻辑全部在 sync-providers/ 注册表里，
 * 本文件不出现任何 provider 字面量。
 */
export class NangoExecutor implements ConnectorExecutor {
  private readonly http: AxiosInstance;
  private readonly secret: () => string;
  constructor(
    baseURL: string,
    secret: string | (() => string),
    http?: AxiosInstance,
  ) {
    this.secret = typeof secret === "function" ? secret : () => secret;
    this.http =
      http ??
      axios.create({ baseURL: baseURL.replace(/\/$/, ""), timeout: 30_000 });
  }
  private async proxy(
    connectionId: string,
    configKey: string,
    url: string,
    headers?: Record<string, string>,
  ) {
    const request = nangoProxyRequest(
      this.secret(),
      connectionId,
      configKey,
      url,
      headers,
    );
    try {
      return (await this.http.get(request.path, { headers: request.headers })).data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const detail = typeof error.response?.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response?.data ?? {});
        throw new Error(`Nango proxy GET ${url} failed (${error.response?.status ?? 'network'}): ${detail.slice(0, 1000)}`);
      }
      throw error;
    }
  }
  /** 只读代理 GET（agent 工具 nango_request 使用）；与内部 proxy 共用鉴权与错误语义。 */
  async proxyGet(
    connectionId: string,
    configKey: string,
    url: string,
    headers?: Record<string, string>,
  ) {
    return this.proxy(connectionId, configKey, url, headers);
  }

  private async proxyPost(connectionId: string, configKey: string, url: string, body: unknown) {
    const request = nangoProxyRequest(this.secret(), connectionId, configKey, url);
    try {
      return (await this.http.post(request.path, body, { headers: request.headers })).data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const detail = typeof error.response?.data === 'string'
          ? error.response.data
          : JSON.stringify(error.response?.data ?? {});
        throw new Error(`Nango proxy POST ${url} failed (${error.response?.status ?? 'network'}): ${detail.slice(0, 1000)}`);
      }
      throw error;
    }
  }

  private context(connectionId: string, configKey: string | undefined, fallbackKey: string): PullContext {
    const resolved = configKey || fallbackKey;
    return {
      connectionId,
      configKey: resolved,
      proxyGet: (url, headers) => this.proxy(connectionId, resolved, url, headers),
      proxyPost: (url, body) => this.proxyPost(connectionId, resolved, url, body),
    };
  }

  async discoverScopes(connection: {
    provider: string;
    nangoConnectionId: string;
    nangoConfigKey?: string;
  }) {
    const definition = syncProviderOf(connection.provider);
    if (!definition) throw new Error(`unknown_connector_provider: ${connection.provider}`);
    const ctx = this.context(
      connection.nangoConnectionId,
      connection.nangoConfigKey,
      definition.auth.nango?.configKeyDefault ?? definition.provider,
    );
    // 引擎边界：SyncScopeSeed → ConnectorExecutor 的 {id, displayName} 形状
    // （manager.register 与既有测试替身均按此形状消费）。
    const seeds = definition.discoverScopes
      ? await definition.discoverScopes(ctx)
      : definition.defaultScopes;
    return seeds.map((seed) => ({ id: seed.providerScopeId, displayName: seed.displayName }));
  }

  async *pull(
    scope: {
      provider: string;
      nangoConnectionId: string;
      nangoConfigKey?: string;
      providerScopeId: string;
      sourceCursor: string | null;
    },
    mode: Parameters<ConnectorExecutor["pull"]>[1],
  ): AsyncGenerator<PullPage> {
    const definition = syncProviderOf(scope.provider);
    if (!definition || !definition.pull) throw new Error(`unknown_connector_provider: ${scope.provider}`);
    const ctx: SyncPullContext = {
      ...this.context(scope.nangoConnectionId, scope.nangoConfigKey, definition.auth.nango?.configKeyDefault ?? definition.provider),
      providerScopeId: scope.providerScopeId,
      sourceCursor: scope.sourceCursor,
    };
    yield* definition.pull(ctx, mode);
  }
}
