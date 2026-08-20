import axios, { type AxiosInstance } from "axios";
import type { NormalizedCalendarChange, NormalizedDocument, NormalizedMailChange } from "@nxcore/connector-contract";
import type { ConnectorExecutor, PullPage } from "./types.js";
import {
  gmailHistoryChanges,
  normalizeGmailMessage,
} from "./providers/gmail.js";
import { normalizeOutlookMessage } from "./providers/outlook.js";

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

export class NangoExecutor implements ConnectorExecutor {
  private readonly http: AxiosInstance;
  constructor(
    baseURL: string,
    private readonly secret: string,
    http?: AxiosInstance,
  ) {
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
      this.secret,
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
    const request = nangoProxyRequest(this.secret, connectionId, configKey, url);
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
  async discoverScopes(connection: any) {
    if (connection.provider === "gmail")
      return [{ id: "me", displayName: "Mailbox" }];
    if (connection.provider === "google-docs")
      return [{ id: "documents", displayName: "Google Docs" }];
    if (connection.provider === "notion")
      return [{ id: "pages", displayName: "Notion pages" }];
    if (connection.provider === "google-calendar") {
      const data = await this.proxy(connection.nangoConnectionId, connection.nangoConfigKey, "https://www.googleapis.com/calendar/v3/users/me/calendarList");
      return (data.items ?? []).map((item: any) => ({ id: String(item.id), displayName: String(item.summary ?? item.id) }));
    }
    const scopes: Array<{ id: string; displayName: string }> = [];
    const visit = async (url: string): Promise<void> => {
      while (url) {
        const data = await this.proxy(
          connection.nangoConnectionId,
          connection.nangoConfigKey,
          url,
          { Prefer: 'IdType="ImmutableId"' },
        );
        for (const folder of data.value ?? []) {
          const excluded = ["junkemail", "deleteditems"].includes(
            String(folder.wellKnownName ?? "").toLowerCase(),
          );
          if (!excluded)
            scopes.push({
              id: String(folder.id),
              displayName: String(folder.displayName ?? folder.id),
            });
          if (!excluded && folder.childFolderCount > 0)
            await visit(
              `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders?includeHiddenFolders=false`,
            );
        }
        url = data["@odata.nextLink"] ?? "";
      }
    };
    await visit(
      "https://graph.microsoft.com/v1.0/me/mailFolders?includeHiddenFolders=false",
    );
    return scopes;
  }
  async *pull(scope: any, mode: any): AsyncGenerator<PullPage> {
    if (scope.provider === "gmail") yield* this.gmail(scope, mode);
    else if (scope.provider === "google-docs") yield* this.googleDocs(scope);
    else if (scope.provider === "notion") yield* this.notion(scope);
    else if (scope.provider === "google-calendar") yield* this.googleCalendar(scope, mode);
    else yield* this.outlook(scope, mode);
  }

  private googleMarkdown(content: any): string {
    return (content?.body?.content ?? []).map((item: any) => {
      if (item.paragraph) return (item.paragraph.elements ?? []).map((part: any) => part.textRun?.content ?? '').join('').replace(/\n$/, '')
      if (item.table) return (item.table.tableRows ?? []).map((row: any) => `| ${(row.tableCells ?? []).map((cell: any) => this.googleMarkdown({ body: { content: cell.content } }).replace(/\n/g, ' ')).join(' | ')} |`).join('\n')
      return ''
    }).filter(Boolean).join('\n\n')
  }

  private async *googleDocs(scope: any): AsyncGenerator<PullPage> {
    const key = scope.nangoConfigKey ?? 'google-drive';
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (token) query.set('pageToken', token);
      const list = await this.proxy(scope.nangoConnectionId, key, `https://www.googleapis.com/drive/v3/files?${query}`);
      const documents: NormalizedDocument[] = [];
      for (const file of (list.files ?? []).filter((item: any) => item.mimeType === 'application/vnd.google-apps.document' && !item.trashed)) {
        const exported = await this.proxy(scope.nangoConnectionId, key, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text%2Fplain`);
        const text = typeof exported === 'string' ? exported : String(exported?.data ?? exported?.content ?? '');
        documents.push({ providerDocumentId: String(file.id), title: String(file.name ?? file.id), markdown: `# ${String(file.name ?? file.id)}\n\n${text}`, providerRevision: String(file.modifiedTime ?? ''), sourceUrl: `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/edit` });
      }
      token = list.nextPageToken;
      yield { changes: [], documents, ...(token ? { continuation: token } : {}) };
    } while (token);
  }

  private notionMarkdown(blocks: any[]): string {
    return blocks.map((block) => {
      const data = block[block.type] ?? {};
      const value = (data.rich_text ?? []).map((item: any) => item.plain_text ?? '').join('');
      if (block.type === 'heading_1') return `# ${value}`;
      if (block.type === 'heading_2') return `## ${value}`;
      if (block.type === 'heading_3') return `### ${value}`;
      if (block.type === 'bulleted_list_item') return `- ${value}`;
      if (block.type === 'numbered_list_item') return `1. ${value}`;
      if (block.type === 'to_do') return `- [${data.checked ? 'x' : ' '}] ${value}`;
      if (block.type === 'quote') return `> ${value}`;
      if (block.type === 'divider') return '---';
      return value;
    }).filter(Boolean).join('\n\n');
  }

  private async *notion(scope: any): AsyncGenerator<PullPage> {
    const key = scope.nangoConfigKey ?? 'notion';
    const search = await this.proxyPost(scope.nangoConnectionId, key, 'https://api.notion.com/v1/search', { page_size: 100, filter: { property: 'object', value: 'page' } });
    const documents: NormalizedDocument[] = [];
    for (const page of search.results ?? []) {
      const title = Object.values(page.properties ?? {}).find((property: any) => property.type === 'title') as any;
      const name = (title?.title ?? []).map((item: any) => item.plain_text ?? '').join('') || page.id;
      const children = await this.proxy(scope.nangoConnectionId, key, `https://api.notion.com/v1/blocks/${page.id.replace(/-/g, '')}/children?page_size=100`);
      documents.push({ providerDocumentId: String(page.id), title: name, markdown: `# ${name}\n\n${this.notionMarkdown(children.results ?? [])}`, providerRevision: String(page.last_edited_time ?? ''), ...(page.url ? { sourceUrl: String(page.url) } : {}) });
    }
    yield { changes: [], documents };
  }

  private async *googleCalendar(scope: any, mode: string): AsyncGenerator<PullPage> {
    const key = scope.nangoConfigKey ?? "google-calendar";
    let url = mode === "incremental" && scope.sourceCursor
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(scope.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&syncToken=${encodeURIComponent(scope.sourceCursor)}`
      : `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(scope.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&timeMin=1970-01-01T00:00:00Z`;
    do {
      const data = await this.proxy(scope.nangoConnectionId, key, url);
      const calendarChanges: NormalizedCalendarChange[] = (data.items ?? []).map((item: any) => {
        if (item.status === "cancelled") return { kind: "tombstone", providerEventId: String(item.id) } as const;
        const start = item.start?.dateTime ?? `${item.start?.date}T00:00:00Z`;
        const end = item.end?.dateTime ?? `${item.end?.date}T00:00:00Z`;
        const address = (person: any) => person?.email ? { role: "attendee", displayName: person.displayName, address: String(person.email).toLowerCase() } : undefined;
        return { kind: "upsert", event: { providerEventId: String(item.id), title: String(item.summary ?? "(无标题)"), description: item.description ? String(item.description) : undefined, startsAt: start, endsAt: end, timeZone: item.start?.timeZone, location: item.location ? String(item.location) : undefined, status: item.status ? String(item.status) : undefined, organizer: address(item.organizer), attendees: (item.attendees ?? []).map(address).filter(Boolean), recurrence: item.recurrence ? { rules: item.recurrence } : undefined, providerRevision: item.etag ? String(item.etag) : undefined } } as const;
      });
      const next = data.nextPageToken ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(scope.providerScopeId)}/events?singleEvents=true&showDeleted=true&maxResults=2500&pageToken=${encodeURIComponent(data.nextPageToken)}` : "";
      yield { changes: [], calendarChanges, ...(next ? { continuation: next } : data.nextSyncToken ? { terminalCursor: String(data.nextSyncToken) } : {}) };
      url = next;
    } while (url);
  }

  private async *gmailHistory(
    scope: any,
    key: string,
    startHistoryId: string,
  ): AsyncGenerator<PullPage> {
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ startHistoryId });
      if (token) query.set("pageToken", token);
      const data = await this.proxy(
        scope.nangoConnectionId,
        key,
        `https://gmail.googleapis.com/gmail/v1/users/me/history?${query}`,
      );
      const changes: NormalizedMailChange[] = [];
      for (const hint of gmailHistoryChanges(data)) {
        if (hint.removed)
          changes.push({ kind: "tombstone", providerMessageId: hint.id });
        else
          changes.push(
            normalizeGmailMessage(
              await this.proxy(
                scope.nangoConnectionId,
                key,
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${hint.id}?format=full`,
              ),
            ),
          );
      }
      token = data.nextPageToken;
      yield {
        changes,
        ...(token
          ? { continuation: token }
          : { terminalCursor: String(data.historyId ?? startHistoryId) }),
      };
    } while (token);
  }

  private async *gmail(scope: any, mode: string): AsyncGenerator<PullPage> {
    const key = scope.nangoConfigKey ?? "google-mail";
    if (mode === "incremental" && scope.sourceCursor) {
      yield* this.gmailHistory(scope, key, scope.sourceCursor);
      return;
    }
    const profile = await this.proxy(
      scope.nangoConnectionId,
      key,
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    );
    const anchor = String(profile.historyId);
    let token: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: "100",
        q: "-in:spam -in:trash",
      });
      if (token) query.set("pageToken", token);
      const list = await this.proxy(
        scope.nangoConnectionId,
        key,
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`,
      );
      const changes: NormalizedMailChange[] = [];
      for (const item of list.messages ?? [])
        changes.push(
          normalizeGmailMessage(
            await this.proxy(
              scope.nangoConnectionId,
              key,
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`,
            ),
          ),
        );
      token = list.nextPageToken;
      yield { changes, ...(token ? { continuation: token } : {}) };
    } while (token);
    yield* this.gmailHistory(scope, key, anchor);
  }

  private async *outlook(scope: any, mode: string): AsyncGenerator<PullPage> {
    const key = scope.nangoConfigKey ?? "microsoft-mail";
    let url =
      mode === "incremental" && scope.sourceCursor
        ? scope.sourceCursor
        : `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(scope.providerScopeId)}/messages/delta`;
    do {
      const data = await this.proxy(scope.nangoConnectionId, key, url, {
        Prefer: 'IdType="ImmutableId"',
      });
      url = data["@odata.nextLink"] ?? "";
      yield {
        changes: (data.value ?? []).map(normalizeOutlookMessage),
        ...(url
          ? { continuation: url }
          : data["@odata.deltaLink"]
            ? { terminalCursor: String(data["@odata.deltaLink"]) }
            : {}),
      };
    } while (url);
  }
}
