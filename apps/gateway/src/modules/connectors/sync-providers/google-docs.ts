import type { NormalizedDocument } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

function googleMarkdown(content: any): string {
  return (content?.body?.content ?? []).map((item: any) => {
    if (item.paragraph) return (item.paragraph.elements ?? []).map((part: any) => part.textRun?.content ?? '').join('').replace(/\n$/, '')
    if (item.table) return (item.table.tableRows ?? []).map((row: any) => `| ${(row.tableCells ?? []).map((cell: any) => googleMarkdown({ body: { content: cell.content } }).replace(/\n/g, ' ')).join(' | ')} |`).join('\n')
    return ''
  }).filter(Boolean).join('\n\n')
}

/** Google Docs（Drive export text/plain）：无游标全量拉。 */
export const googleDocsSyncProvider: SyncProviderDefinition = {
  provider: "google-docs",
  engine: "nango",
  dataTypes: ["document"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_GOOGLE_DOCS_CONFIG_KEY"],
      configKeyDefault: "google-drive",
      integrationProvider: "google-drive",
      credential: "google",
      oauthScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.readonly"],
    },
  },
  defaultScopes: [{ providerScopeId: "documents", displayName: "Google Docs" }],
  ui: { label: "Google Docs", category: "docs", iconKey: "google-docs" },
  async *pull(ctx) {
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (token) query.set('pageToken', token);
      const list = await ctx.proxyGet(`https://www.googleapis.com/drive/v3/files?${query}`);
      const documents: NormalizedDocument[] = [];
      for (const file of (list.files ?? []).filter((item: any) => item.mimeType === 'application/vnd.google-apps.document' && !item.trashed)) {
        const exported = await ctx.proxyGet(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/export?mimeType=text%2Fplain`);
        const text = typeof exported === 'string' ? exported : String(exported?.data ?? exported?.content ?? '');
        documents.push({ providerDocumentId: String(file.id), title: String(file.name ?? file.id), markdown: `# ${String(file.name ?? file.id)}\n\n${text}`, providerRevision: String(file.modifiedTime ?? ''), sourceUrl: `https://docs.google.com/document/d/${encodeURIComponent(file.id)}/edit` });
      }
      token = list.nextPageToken;
      yield { changes: [], documents, ...(token ? { continuation: token } : {}) };
    } while (token);
  },
};
