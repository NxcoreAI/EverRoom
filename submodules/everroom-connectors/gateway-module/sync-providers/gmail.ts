import type { NormalizedMailChange } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";
import {
  gmailHistoryChanges,
  normalizeGmailMessage,
} from "../providers/gmail.js";

/** Gmail：游标 = historyId；全量先锚定 profile.historyId 再扫列表，最后补扫锚点后的增量。 */
export const gmailSyncProvider: SyncProviderDefinition = {
  provider: "gmail",
  engine: "nango",
  dataTypes: ["mail"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_GMAIL_CONFIG_KEY", "NXCORE_NANGO_GMAIL_CONFIG_KEY"],
      configKeyDefault: "google-mail",
      integrationProvider: "google-mail",
      credential: "google",
      oauthScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly"],
    },
  },
  defaultScopes: [{ providerScopeId: "me", displayName: "Mailbox" }],
  ui: { label: "Gmail", category: "mail", iconKey: "gmail" },
  async *pull(ctx, mode) {
    if (mode === "incremental" && ctx.sourceCursor) {
      yield* gmailHistory(ctx, ctx.sourceCursor);
      return;
    }
    const profile = await ctx.proxyGet("https://gmail.googleapis.com/gmail/v1/users/me/profile");
    const anchor = String(profile.historyId);
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: "100", q: "-in:spam -in:trash" });
      if (token) query.set("pageToken", token);
      const list = await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`);
      const changes: NormalizedMailChange[] = [];
      for (const item of list.messages ?? [])
        changes.push(
          normalizeGmailMessage(
            await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${item.id}?format=full`),
          ),
        );
      token = list.nextPageToken;
      yield { changes, ...(token ? { continuation: token } : {}) };
    } while (token);
    yield* gmailHistory(ctx, anchor);
  },
};

async function* gmailHistory(ctx: { proxyGet(url: string): Promise<any>; connectionId: string }, startHistoryId: string) {
  let token: string | undefined;
  do {
    const query = new URLSearchParams({ startHistoryId });
    if (token) query.set("pageToken", token);
    const data = await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/history?${query}`);
    const changes: NormalizedMailChange[] = [];
    for (const hint of gmailHistoryChanges(data)) {
      if (hint.removed) changes.push({ kind: "tombstone", providerMessageId: hint.id });
      else
        changes.push(
          normalizeGmailMessage(
            await ctx.proxyGet(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${hint.id}?format=full`),
          ),
        );
    }
    token = data.nextPageToken;
    yield {
      changes,
      ...(token ? { continuation: token } : { terminalCursor: String(data.historyId ?? startHistoryId) }),
    };
  } while (token);
}
