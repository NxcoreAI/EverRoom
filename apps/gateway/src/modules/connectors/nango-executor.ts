import axios, { type AxiosInstance } from "axios";
import type { NormalizedMailChange } from "@nxcore/connector-contract";
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
    return (await this.http.get(request.path, { headers: request.headers }))
      .data;
  }
  async discoverScopes(connection: any) {
    if (connection.provider === "gmail")
      return [{ id: "me", displayName: "Mailbox" }];
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
    else yield* this.outlook(scope, mode);
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
