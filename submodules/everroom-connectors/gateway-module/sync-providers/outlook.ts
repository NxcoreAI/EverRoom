import type { NormalizedMailChange } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

/** Outlook：scope = 邮件文件夹（递归发现）；游标 = Graph deltaLink（cursor 即 URL）。 */
export const outlookSyncProvider: SyncProviderDefinition = {
  provider: "outlook",
  engine: "nango",
  dataTypes: ["mail"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_OUTLOOK_CONFIG_KEY", "NXCORE_NANGO_OUTLOOK_CONFIG_KEY"],
      configKeyDefault: "microsoft-mail",
      integrationProvider: "microsoft",
      credential: "outlook",
    },
  },
  defaultScopes: [{ providerScopeId: "inbox", displayName: "Inbox" }],
  ui: { label: "Outlook", category: "mail", iconKey: "outlook" },
  async discoverScopes(ctx) {
    const scopes: Array<{ providerScopeId: string; displayName: string }> = [];
    const visit = async (url: string): Promise<void> => {
      while (url) {
        const data = await ctx.proxyGet(url, { Prefer: 'IdType="ImmutableId"' });
        for (const folder of data.value ?? []) {
          const excluded = ["junkemail", "deleteditems"].includes(
            String(folder.wellKnownName ?? "").toLowerCase(),
          );
          if (!excluded)
            scopes.push({
              providerScopeId: String(folder.id),
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
    await visit("https://graph.microsoft.com/v1.0/me/mailFolders?includeHiddenFolders=false");
    return scopes;
  },
  async *pull(ctx, mode) {
    // delta 协议统一两种模式：无 token 的初始 delta 枚举即全量，
    // deltaLink（sourceCursor）续拉即增量。全量断点续传优先接 lastContinuation。
    let url =
      ctx.continuation ??
      (mode === "incremental" && ctx.sourceCursor
        ? ctx.sourceCursor
        : `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(ctx.providerScopeId)}/messages/delta`);
    do {
      const data = await ctx.proxyGet(url);
      url = data["@odata.nextLink"] ?? "";
      const changes: NormalizedMailChange[] = [];
      for (const raw of data.value ?? []) {
        const record = raw as { id?: unknown; "@removed"?: unknown };
        if (record["@removed"] && typeof record.id === "string")
          changes.push({ kind: "tombstone", providerMessageId: record.id });
        else changes.push(await ctx.normalizeMail(raw));
      }
      yield {
        changes,
        ...(url
          ? { continuation: url }
          : data["@odata.deltaLink"]
            ? { terminalCursor: String(data["@odata.deltaLink"]) }
            : {}),
      };
    } while (url);
  },
};
