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
 *   outlook: list_messages / get_message / sync_messages（delta） / list_mail_folders
 *   （含文件夹级消息列表与 childFolders 递归）
 *
 * gmail 的 message 类 action 输出是 oo 规范化形状，在 request() 出口翻译回
 * REST 形状（adaptActionOutputForSyncAdapter），适配器对响应字段的消费保持
 * 不变；其余 action 输出即 REST 结构化包装。入参一律按 oo action schema 的
 * 属性名（camelCase / format）发送——schema 禁未知字段。outlook 的 Prefer
 * 头语义不可透传（oo 的 sync_messages 内部自理 ImmutableId）。
 */
import type { ConnectorProvider, SyncMode } from "@nxcore/connector-contract";
import type { OpenConnectorCliConfig } from "./host-types.js";
import { OpenConnectorHttpClient, envelopeData } from "./open-connector-http-client.js";
import type { ConnectorExecutor, PullPage } from "./types.js";
import { syncProviderOf } from "./sync-providers/index.js";
import type { FormatMapperPort } from "./format-mapper-port.js";

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
      // detail=ids：oo 的 ids 分支不做逐封 hydration（一页一个 list action，5 units）。
      // 逐封取全文由适配器自己取——full 整页 hydration 在单 action 内会撞 120s 超时，
      // 且与后续逐封 get 双倍烧配额（Gmail 每用户配额 250 units/秒）。
      const input: Record<string, unknown> = { detail: "ids", maxResults: num("maxResults", 100) ?? 100 };
      const query = q.get("q");
      if (query) input.query = query;
      if (q.get("includeSpamTrash") === "true") input.includeSpamTrash = true;
      const token = q.get("pageToken");
      if (token) input.pageToken = token;
      return { service: "gmail", action: "fetch_emails", input };
    }
    const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
    if (messageMatch) {
      // oo 的入参属性是 format（不是 REST 的 format 查询参数），schema 禁未知字段。
      return {
        service: "gmail",
        action: "fetch_message_by_message_id",
        input: { messageId: decodeURIComponent(messageMatch[1]!), format: "full" },
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
      // oo 的 search 入参是 camelCase 且 query 必填（空串等价 Notion 的全量搜索）。
      const input: Record<string, unknown> = {
        query: typeof payload.query === "string" ? payload.query : "",
        pageSize: typeof payload.page_size === "number" ? payload.page_size : 100,
      };
      if (payload.filter) input.filter = payload.filter;
      if (payload.sort) input.sort = payload.sort;
      return { service: "notion", action: "search", input };
    }
    const childrenMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (childrenMatch) {
      return {
        service: "notion",
        action: "list_block_children",
        input: {
          blockId: decodeURIComponent(childrenMatch[1]!),
          pageSize: num("page_size", 100) ?? 100,
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
    // 文件夹级 delta（初始全量枚举与 deltaLink/skiptoken 续拉同为该路径形态；
    // Graph 的 OData 括号形式 mailFolders('{id}') 也要认）。
    const deltaMatch =
      /^\/v1\.0\/me\/mailFolders\((['"]?)([^)'"]+)\1\)\/messages\/delta$/.exec(path) ??
      /^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path);
    if (deltaMatch) {
      return {
        service: "outlook",
        action: "sync_messages",
        input: { mailFolderId: decodeURIComponent(deltaMatch[2] ?? deltaMatch[1]!), deltaLink: rawUrl },
      };
    }
    // 文件夹级消息列表（非 delta）。
    const folderMessagesMatch =
      /^\/v1\.0\/me\/mailFolders\((['"]?)([^)'"]+)\1\)\/messages$/.exec(path) ??
      /^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages$/.exec(path);
    if (folderMessagesMatch) {
      const input: Record<string, unknown> = {
        mailFolderId: decodeURIComponent(folderMessagesMatch[2] ?? folderMessagesMatch[1]!),
      };
      const top = num("$top") ?? num("top");
      if (top) input.top = top;
      const filter = q.get("$filter") ?? q.get("filter");
      if (filter) input.filter = filter;
      const orderby = q.get("$orderby") ?? q.get("orderby");
      if (orderby) input.orderby = orderby;
      const select = q.get("$select") ?? q.get("select");
      if (select) input.select = select.split(",").map((item) => item.trim());
      return { service: "outlook", action: "list_messages", input };
    }
    // 子文件夹枚举（discoverScopes 递归用）。
    const childFoldersMatch =
      /^\/v1\.0\/me\/mailFolders\((['"]?)([^)'"]+)\1\)\/childFolders$/.exec(path) ??
      /^\/v1\.0\/me\/mailFolders\/([^/]+)\/childFolders$/.exec(path);
    if (childFoldersMatch) {
      const input: Record<string, unknown> = {
        parentFolderId: decodeURIComponent(childFoldersMatch[2] ?? childFoldersMatch[1]!),
      };
      if (q.get("includeHiddenFolders") === "false") input.includeHiddenFolders = false;
      return { service: "outlook", action: "list_mail_folders", input };
    }
    if (path === "/v1.0/me/mailFolders" || path.endsWith("/mailFolders")) {
      const input: Record<string, unknown> = {};
      if (q.get("includeHiddenFolders") === "false") input.includeHiddenFolders = false;
      const nextLink = q.get("nextLink");
      if (nextLink) input.nextLink = nextLink;
      return { service: "outlook", action: "list_mail_folders", input };
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
  private formatMapper: FormatMapperPort | null = null;

  constructor(private readonly options: OpenConnectorSyncExecutorOptions) {
    this.client = new OpenConnectorHttpClient(options.config);
  }

  /** 格式映射端口（apps/gateway 注入）；缺席时 provider 的 ctx.normalize* 会抛错。 */
  setFormatMapper(mapper: FormatMapperPort | null): void {
    this.formatMapper = mapper;
  }

  /** 会话出席（baseUrl 非空）：SyncEngine.canServe 据此在登出态静默跳过轮询。 */
  isAvailable(): boolean {
    return Boolean(this.options.config.baseUrl.trim());
  }

  /** 在线 scope 发现：provider 适配器的 discoverScopes（文件夹/日历表枚举）走同一 URL 路由。 */
  async discoverScopes(connection: {
    provider: ConnectorProvider;
    connectionName: string;
    service: string;
  }): Promise<Array<{ id: string; displayName: string }>> {
    const definition = syncProviderOf(connection.provider);
    if (!definition?.discoverScopes) return [];
    const scopes = await definition.discoverScopes({
      connectionId: connection.connectionName,
      configKey: definition.auth.nango?.configKeyDefault ?? "",
      proxyGet: async (url: string, headers?: Record<string, string>): Promise<any> => {
        void headers;
        return this.request("GET", url);
      },
      proxyPost: async (url: string, body: unknown): Promise<any> => this.request("POST", url, body),
      normalizeMail: (raw: unknown) => this.formatMapper!.normalizeMail(connection.provider, raw),
      normalizeCalendar: (raw: unknown) => this.formatMapper!.normalizeCalendar(connection.provider, raw),
    });
    return scopes.map((scope) => ({ id: scope.providerScopeId, displayName: scope.displayName }));
  }

  async *pull(
    scope: {
      provider: ConnectorProvider;
      connectionName: string;
      service?: string;
      providerScopeId: string;
      sourceCursor: string | null;
      continuation?: string | null;
    },
    mode: SyncMode,
  ): AsyncGenerator<PullPage> {
    const definition = syncProviderOf(scope.provider);
    if (!definition) throw new Error(`unknown_connector_provider: ${scope.provider}`);
    if (definition.engine !== "nango" || typeof definition.pull !== "function") {
      throw new Error(`provider_engine_not_oauth: ${scope.provider}`);
    }
    if (!this.formatMapper) throw new Error("format_mapper_not_wired");
    const ctx = {
      connectionId: scope.connectionName,
      configKey: definition.auth.nango?.configKeyDefault ?? "",
      providerScopeId: scope.providerScopeId,
      sourceCursor: scope.sourceCursor,
      proxyGet: async (url: string, headers?: Record<string, string>): Promise<any> => {
        void headers;
        return this.request("GET", url);
      },
      proxyPost: async (url: string, body: unknown): Promise<any> => this.request("POST", url, body),
      normalizeMail: (raw: unknown) => this.formatMapper!.normalizeMail(scope.provider, raw),
      normalizeCalendar: (raw: unknown) => this.formatMapper!.normalizeCalendar(scope.provider, raw),
      continuation: scope.continuation ?? null,
    };
    // 复用适配器的 pull 生成器（URL 会被上面的路由翻译为 action）
    yield* (definition.pull as NonNullable<typeof definition.pull>)(ctx, mode);
  }

  private async request(method: "GET" | "POST", url: string, body?: unknown): Promise<unknown> {
    const routed = routeProxyUrlForTest(url, method, body);
    if (!routed) {
      throw new Error(`open_connector_route_unsupported: ${url.slice(0, 160)}`);
    }
    const envelope = await this.client.runAction(routed.service, routed.action, routed.input, {});
    return adaptActionOutputForSyncAdapter(routed.service, routed.action, envelopeData(envelope));
  }
}

/**
 * oo 的 gmail message 类 action 输出是 oo 规范化形状（messageId/preview/payload/...），
 * 而同步适配器（sync-providers/gmail.ts）消费 provider 原生 REST 字段
 * （messages[].id、Gmail REST 资源形状——格式映射体系的映射输入）。
 * 在 oo 适配边界把输出翻译回 REST 形状，适配器保持 REST/Nango 语义不变。
 */
export function adaptActionOutputForSyncAdapter(service: string, action: string, data: unknown): unknown {
  if (service === "outlook" && action === "sync_messages") {
    // oo 的 delta 输出是 { messages, nextLink, deltaLink }，翻回 Graph delta 信封
    // { value, @odata.nextLink, @odata.deltaLink }，适配器保持 REST 语义不变。
    const page = (data ?? {}) as {
      messages?: unknown[];
      value?: unknown[];
      nextLink?: unknown;
      deltaLink?: unknown;
    };
    return {
      ...page,
      value: page.value ?? page.messages ?? [],
      ...(page.nextLink != null ? { "@odata.nextLink": page.nextLink } : {}),
      ...(page.deltaLink != null ? { "@odata.deltaLink": page.deltaLink } : {}),
    };
  }
  if (service === "outlook" && action === "list_messages") {
    // oo 的 outlook 输出信封是 { messages, nextLink }，翻回 Graph 的
    // { value, @odata.nextLink } 信封，适配器保持 REST 语义不变。
    const page = (data ?? {}) as { messages?: unknown[]; value?: unknown[]; nextLink?: unknown };
    return {
      ...page,
      value: page.value ?? page.messages ?? [],
      ...(page.nextLink != null ? { "@odata.nextLink": page.nextLink } : {}),
    };
  }
  if (service === "outlook" && action === "list_mail_folders") {
    // 同上：{ mailFolders, nextLink } → { value, @odata.nextLink }（discoverScopes 消费）。
    const page = (data ?? {}) as { mailFolders?: unknown[]; value?: unknown[]; nextLink?: unknown };
    return {
      ...page,
      value: page.value ?? page.mailFolders ?? [],
      ...(page.nextLink != null ? { "@odata.nextLink": page.nextLink } : {}),
    };
  }
  if (service !== "gmail") return data;
  if (action === "fetch_message_by_message_id") return gmailMessageResourceFromAction(data);
  if (action === "fetch_emails") {
    const page = (data ?? {}) as { messages?: Array<Record<string, unknown>> };
    return {
      ...page,
      messages: (page.messages ?? []).map((message) => ({
        id: message.messageId,
        threadId: message.threadId,
      })),
    };
  }
  return data;
}

/**
 * oo 规范化邮件 → Gmail REST 资源形状（Gmail REST 即格式映射的输入）。
 * oo 保留了原始 payload（headers/body.data/parts），正文与附件得以无损透传；
 * 时间戳从 ISO 还原为 REST 的毫秒 internalDate。
 */
function gmailMessageResourceFromAction(output: unknown): unknown {
  const message = (output ?? {}) as {
    messageId?: unknown;
    threadId?: unknown;
    labelIds?: unknown;
    preview?: { body?: unknown };
    payload?: unknown;
    messageTimestamp?: unknown;
  };
  const parsedAt =
    typeof message.messageTimestamp === "string" ? Date.parse(message.messageTimestamp) : Number.NaN;
  return {
    id: message.messageId,
    threadId: message.threadId,
    labelIds: message.labelIds,
    snippet: message.preview?.body,
    payload: message.payload,
    ...(Number.isFinite(parsedAt) ? { internalDate: String(parsedAt) } : {}),
  };
}
