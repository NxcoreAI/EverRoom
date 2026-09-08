import type { NormalizedDocument } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

/**
 * 飞书 OAuth（用户连接）同步源：SaaS 已配置 feishu OAuth client 后，与
 * gmail/notion 同为 nango-oauth 通道；凭据由 OpenConnector 连接持有，
 * 拉取经 ctx.proxy 走连接的 user_access_token。仅根目录 docx 的轻量镜像
 * （同步兜底）；完整文档导入走连接器导入面板（drive BFS + wiki 树）。
 */
export const feishuSyncProvider: SyncProviderDefinition = {
  provider: "feishu",
  engine: "nango",
  dataTypes: ["document"],
  auth: {
    channel: "nango-oauth",
    nango: {
      configKeyEnv: ["NXCORE_NANGO_CONNECTOR_FEISHU_CONFIG_KEY"],
      configKeyDefault: "feishu",
      integrationProvider: "feishu",
      // OAuth client 由 SaaS 侧运行时持有（用户连接模式），网关不自举凭据。
      credential: "none",
    },
  },
  defaultScopes: [{ providerScopeId: "docs", displayName: "飞书文档" }],
  ui: { label: "飞书", category: "docs", iconKey: "feishu" },
  async *pull(ctx) {
    const documents: NormalizedDocument[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({ page_size: "200", ...(pageToken ? { page_token: pageToken } : {}) });
      const list = await ctx.proxyGet(`https://open.feishu.cn/open-apis/drive/v1/files?${query.toString()}`);
      for (const file of list.files ?? []) {
        if (file.type !== "docx" || !file.token) continue;
        const raw = await ctx.proxyGet(
          `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(String(file.token))}/raw_content`,
        );
        const title = String(file.name ?? "").trim() || String(file.token).slice(0, 8);
        documents.push({
          providerDocumentId: String(file.token),
          title,
          markdown: `# ${title}\n\n${raw.content ?? ""}`,
          providerRevision: String(file.modified_time ?? ""),
          ...(file.url ? { sourceUrl: String(file.url) } : {}),
        });
      }
      pageToken = list.page_token;
      if (!list.has_more || !pageToken) break;
    }
    yield { changes: [], documents };
  },
};
