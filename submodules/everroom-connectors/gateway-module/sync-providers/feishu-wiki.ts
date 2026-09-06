import type { NormalizedDocument } from "@nxcore/connector-contract";
import type { SyncProviderDefinition } from "./types.js";

/**
 * 飞书自建应用（阶段三第二试点）：api-token 通道（用户录入 app_id + app_secret），
 * direct 引擎直连 open.feishu.cn——tenant_access_token → wiki 空间列表 → 节点树 →
 * docx 原文，产出 NormalizedDocument 走既有文档管线（documentStore + ingest）。
 * 只读；无游标全量拉（upsert 幂等）。凭据格式 "appId:appSecret"（首个冒号分割）。
 */
const FEISHU_BASE = "https://open.feishu.cn";

interface FeishuResponse<T> { code?: number; msg?: string; data?: T }

/** GET + JSON 解析（httpGet 返回原始响应体；非 200/非 JSON 报可读错误）。 */
async function httpGetJson<T>(
  ctx: { httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> },
  url: string,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await ctx.httpGet(url, headers);
  if (response.status !== 200) throw new Error(`feishu_http_${response.status}: ${url.slice(0, 120)}`);
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error(`feishu_response_not_json: ${url.slice(0, 120)}`);
  }
}

async function feishuCheck<T>(payload: FeishuResponse<T>, what: string): Promise<T> {
  if (typeof payload.code === "number" && payload.code !== 0)
    throw new Error(`feishu_${what}_failed: ${payload.code} ${payload.msg ?? ""}`.trim());
  return payload.data as T;
}

export const feishuWikiSyncProvider: SyncProviderDefinition = {
  provider: "feishu-wiki",
  engine: "direct",
  dataTypes: ["document"],
  auth: { channel: "api-token" },
  defaultScopes: [{ providerScopeId: "wiki", displayName: "飞书知识库" }],
  ui: { label: "飞书知识库", category: "docs", iconKey: "feishu" },
  async *pullDirect(ctx) {
    const separator = ctx.credentials.indexOf(":");
    if (separator <= 0) throw new Error("feishu_credentials_invalid: expect appId:appSecret");
    const appId = ctx.credentials.slice(0, separator);
    const appSecret = ctx.credentials.slice(separator + 1);

    const tokenPayload = await ctx.httpPostJson<FeishuResponse<{ tenant_access_token?: string }>>(
      `${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: appId, app_secret: appSecret },
    );
    const tokenData = await feishuCheck(tokenPayload, "token");
    const token = tokenData.tenant_access_token;
    if (!token) throw new Error("feishu_token_missing");
    const auth = { Authorization: `Bearer ${token}` };

    // wiki 空间分页遍历。
    const documents: NormalizedDocument[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) });
      const spaces = await feishuCheck(
        await httpGetJson<FeishuResponse<{ items?: Array<{ space_id?: string; name?: string }>; page_token?: string }>>(ctx, `${FEISHU_BASE}/open-apis/wiki/v2/spaces?${query}`, auth),
        "spaces",
      );
      for (const space of spaces.items ?? []) {
        if (!space.space_id) continue;
        await collectSpaceNodes(ctx, auth, space.space_id, documents);
      }
      pageToken = spaces.page_token;
    } while (pageToken);
    yield { changes: [], documents };
  },
};

async function collectSpaceNodes(
  ctx: { httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> },
  auth: Record<string, string>,
  spaceId: string,
  documents: NormalizedDocument[],
): Promise<void> {
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) });
    const nodes = await feishuCheck(
      await httpGetJson<FeishuResponse<{
        items?: Array<{ node_token?: string; obj_token?: string; obj_type?: string; title?: string }>;
        page_token?: string;
        has_more?: boolean;
      }>>(ctx, `${FEISHU_BASE}/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes?${query}`, auth),
      "nodes",
    );
    for (const node of nodes.items ?? []) {
      if (node.obj_type !== "docx" || !node.obj_token) continue;
      const raw = await feishuCheck(
        await httpGetJson<FeishuResponse<{ content?: string }>>(ctx, `${FEISHU_BASE}/open-apis/docx/v1/documents/${encodeURIComponent(node.obj_token)}/raw_content`, auth),
        "raw_content",
      );
      const title = node.title?.trim() || node.obj_token;
      documents.push({
        providerDocumentId: String(node.obj_token),
        title,
        markdown: `# ${title}\n\n${raw.content ?? ""}`,
        sourceUrl: `https://feishu.cn/wiki/${encodeURIComponent(node.node_token ?? node.obj_token)}`,
      });
    }
    pageToken = nodes.has_more ? nodes.page_token : undefined;
  } while (pageToken);
}
