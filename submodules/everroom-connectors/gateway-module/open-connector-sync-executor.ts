/**
 * Seam 1 · 取数传输（链路A）：NangoExecutor.proxy 的 oo 替代。
 *
 * 实现 ConnectorExecutor 接口（types.ts），把 sync-providers/* 适配器发出的
 * provider 原生 REST URL 路由到 oo 的 action 目录（OpenConnectorHttpClient）。
 * 五个 OAuth provider 的映射依据 P0 覆盖核对（connector-unification-p0-findings）：
 *   gmail: get_profile / fetch_emails / fetch_message_by_message_id / list_history
 *   notion: search / list_block_children
 *   google-calendar: list_calendars / list_events（syncToken 透传）
 *   google-docs: googledrive files.list / files.export（docs export 走 drive）
 *   outlook: list_messages / get_message（无 delta，待上游）
 *
 * action 输出与 REST 原生响应字段一致（上游 action 即 REST 结构化包装），
 * 适配器对响应字段的消费保持不变；仅 outlook 的 Prefer 头语义不可透传
 * （oo action 内部自理 ImmutableId）。
 */
import type { ConnectorProvider, SyncMode } from "@nxcore/connector-contract";
import type { OpenConnectorCliConfig } from "./host-types.js";
import { OpenConnectorHttpClient, envelopeData } from "./open-connector-http-client.js";
import type { ConnectorExecutor, PullPage } from "./types.js";
import { syncProviderOf } from "./sync-providers/index.js";
import { normalizeGmailMessage } from "./providers/gmail.js";
import { gmailHistoryChanges } from "./providers/gmail.js";
import { normalizeOutlookMessage } from "./providers/outlook.js";
import type { NormalizedMailChange } from "@nxcore/connector-contract";

interface RouteResult {
  service: string;
  action: string;
  input: Record<string, unknown>;
}

/**
 * URL → action 路由。无法映射时返回 null（视为不支持，抛错给上层）。
 * query 参数（pageToken/maxResults/q 等）翻译为 action input。
 */
export function routeProxyUrlForTest(rawUrl: string, method: "GET" | "POST", body?: unknown): RouteResult | null {
  const url = new URL(rawUrl);
  const q = url.searchParams;
  const path = url.pathname.replace(/\/+$/, "");
  const num = (key: string, fallback?: number): number | undefined => {
    const value = q.get(key);
    if (value === null) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  // Gmail
  if (url.hostname === "gmail.googleapis.com") {
    if (path === "/gmail/v1/users/me/profile") return { service: "gmail", action: "get_profile", input: {} };
    if (path === "/gmail/v1/users/me/messages") {
      const input: Record<string, unknown> = { detail: "full", maxResults: num("maxResults", 100) ?? 100 };
      const query = q.get("q");
      if (query) input.query = query;
      if (q.get("includeSpamTrash") === "true") input.includeSpamTrash = true;
      const token = q.get("pageToken");
      if (token) input.pageToken = token;
      return { service: "gmail", action: "fetch_emails", input };
    }
    const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
    if (messageMatch) {
      return {
        service: "gmail",
        action: "fetch_message_by_message_id",
        input: { messageId: decodeURIComponent(messageMatch[1]!), detail: "full" },
      };
    }
    if (path === "/gmail/v1/users/me/history") {
      const input: Record<string, unknown> = {};
      const start = q.get("startHistoryId");
      if (start) input.startHistoryId = start;
      const token = q.get("pageToken");
      if (token) input.pageToken = token;
      if (num("maxResults")) input.maxResults = num("maxResults");
      return { service: "gmail", action: "list_history", input };
    }
    return null;
  }

  // Notion
  if (url.hostname === "api.notion.com") {
    if (path === "/v1/search") {
      const payload = (body ?? {}) as Record<string, unknown>;
      return {
        service: "notion",
        action: "search",
        input: {
          page_size: num("page_size", 100) ?? (typeof payload.page_size === "number" ? payload.page_size : 100),
          ...(payload.filter ? { filter: payload.filter } : {}),
        },
      };
    }
    const childrenMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (childrenMatch) {
      return {
        service: "notion",
        action: "list_block_children",
        input: {
          block_id: decodeURIComponent(childrenMatch[1]!),
          page_size: num("page_size", 100) ?? 100,
        },
      };
    }
    return null;
  }

  // Google Calendar
  if (url.hostname === "www.googleapis.com" && path.startsWith("/calendar/v3")) {
    if (path === "/calendar/v3/users/me/calendarList") {
      return { service: "googlecalendar", action: "list_calendars", input: {} };
    }
    const eventsMatch = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path);
    if (eventsMatch) {
      const input: Record<string, unknown> = { calendarId: decodeURIComponent(eventsMatch[1]!) };
      for (const key of ["timeMin", "timeMax", "syncToken", "pageToken", "orderBy", "timeZone", "q"]) {
        const value = q.get(key);
        if (value !== null) input[key] = value;
      }
      if (num("maxResults")) input.maxResults = num("maxResults");
      if (q.get("showDeleted") === "true") input.showDeleted = true;
      if (q.get("singleEvents") === "true") input.singleEvents = true;
      // syncToken 存在 → 增量语义，优先 sync_events（返回 nextSyncToken）
      if (typeof input.syncToken === "string") return { service: "googlecalendar", action: "sync_events", input };
      return { service: "googlecalendar", action: "list_events", input };
    }
    return null;
  }

  // Google Drive / Docs（链路A google-docs provider 走 drive REST）
  if (url.hostname === "www.googleapis.com" && path.startsWith("/drive/v3")) {
    if (path === "/drive/v3/files") {
      const input: Record<string, unknown> = {};
      for (const key of ["pageToken", "orderBy", "fields"]) {
        const value = q.get(key);
        if (value !== null) input[key] = value;
      }
      const q1 = q.get("q");
      if (q1) input.q = q1;
      const pageSize = num("pageSize", 100) ?? 100;
      input.pageSize = pageSize;
      return { service: "googledrive", action: "files.list", input };
    }
    const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
    if (exportMatch) {
      return {
        service: "googledrive",
        action: "files.export",
        input: {
          fileId: decodeURIComponent(exportMatch[1]!),
          mimeType: q.get("mimeType") ?? "text/plain",
        },
      };
    }
    return null;
  }

  // Outlook（Microsoft Graph）
  if (url.hostname === "graph.microsoft.com") {
    const messagesMatch = /^\/v1\.0\/me\/messages(?:\/([^/]+))?$/.exec(path) ?? /^\/v1\.0\/users\/[^/]+\/messages(?:\/([^/]+))?$/.exec(path);
    if (messagesMatch) {
      const id = messagesMatch[1];
      if (id) {
        return {
          service: "outlook",
          action: "get_message",
          input: { messageId: decodeURIComponent(id) },
        };
      }
      const input: Record<string, unknown> = {};
      const top = num("$top") ?? num("top");
      if (top) input.top = top;
      const filter = q.get("$filter") ?? q.get("filter");
      if (filter) input.filter = filter;
      const orderby = q.get("$orderby") ?? q.get("orderby");
      if (orderby) input.orderby = orderby;
      const select = q.get("$select") ?? q.get("select");
      if (select) input.select = select.split(",").map((item) => item.trim());
      const nextLink = q.get("nextLink");
      if (nextLink) input.nextLink = nextLink;
      return { service: "outlook", action: "list_messages", input };
    }
    if (path === "/v1.0/me/mailFolders" || path.endsWith("/mailFolders")) {
      return { service: "outlook", action: "list_mail_folders", input: {} };
    }
    return null;
  }

  return null;
}

export interface OpenConnectorSyncExecutorOptions {
  config: OpenConnectorCliConfig;
  logger?: { warn(bindings: Record<string, unknown>, message: string): void };
}

export class OpenConnectorSyncExecutor implements ConnectorExecutor {
  private readonly client: OpenConnectorHttpClient;

  constructor(private readonly options: OpenConnectorSyncExecutorOptions) {
    this.client = new OpenConnectorHttpClient(options.config);
  }

  async *pull(
    scope: {
      provider: ConnectorProvider;
      nangoConnectionId: string;
      nangoConfigKey?: string;
      providerScopeId: string;
      sourceCursor: string | null;
    },
    mode: SyncMode,
  ): AsyncGenerator<PullPage> {
    const definition = syncProviderOf(scope.provider);
    if (!definition) throw new Error(`unknown_connector_provider: ${scope.provider}`);
    if (definition.engine !== "nango" || typeof definition.pull !== "function") {
      throw new Error(`provider_engine_not_oauth: ${scope.provider}`);
    }
    const ctx = {
      connectionId: scope.nangoConnectionId,
      proxyGet: async (url: string, headers?: Record<string, string>): Promise<any> => {
        void headers;
        return this.request("GET", url);
      },
      proxyPost: async (url: string, body: unknown): Promise<any> => this.request("POST", url, body),
    };
    // 复用适配器的 pull 生成器（URL 会被上面的路由翻译为 action）
    yield* (definition.pull as NonNullable<typeof definition.pull>)(ctx as never, mode);
  }

  private async request(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
    const routed = routeProxyUrlForTest(url, method, body);
    if (!routed) {
      throw new Error(`open_connector_route_unsupported: ${url.slice(0, 160)}`);
    }
    const envelope = await this.client.runAction(routed.service, routed.action, routed.input, {});
    return envelopeData(envelope);
  }
}
