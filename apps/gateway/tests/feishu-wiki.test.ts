import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createConnectorDatabase } from "../src/infrastructure/connectors/client.js";
import { ConnectorRepository } from "../src/modules/connectors/repository.js";
import { ConnectorManager } from "../src/modules/connectors/manager.js";
import { SyncEngine } from "../src/modules/connectors/sync-engine.js";
import { nangoConnectorRoutes } from "../src/modules/connectors/routes.js";
import { feishuWikiSyncProvider } from "../src/modules/connectors/sync-providers/feishu-wiki.js";
import { apiTokenAuthChannel } from "../src/modules/connectors/auth-channels/types.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function feishuCtx(credentials: string, pages: Record<string, unknown>) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      credentials,
      providerScopeId: "wiki",
      sourceCursor: null as string | null,
      httpGet: async (url: string) => {
        calls.push(`GET ${url}`);
        const body = pages[url.split("?")[0] ?? ""];
        if (!body) return { status: 404, headers: {}, body: "" };
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      },
      httpPostJson: async (url: string, body: unknown) => {
        calls.push(`POST ${url}`);
        const payload = pages[url];
        if (!payload) throw new Error("unexpected post");
        return payload;
      },
    } as const,
  };
}

describe("feishu-wiki provider (api-token channel)", () => {
  const pages = {
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal": {
      code: 0, data: { tenant_access_token: "t-1" },
    },
    "https://open.feishu.cn/open-apis/wiki/v2/spaces": {
      code: 0, data: { items: [{ space_id: "sp1", name: "团队知识库" }], page_token: "" },
    },
    "https://open.feishu.cn/open-apis/wiki/v2/spaces/sp1/nodes": {
      code: 0,
      data: {
        items: [
          { node_token: "nt-1", obj_token: "docx-1", obj_type: "docx", title: "需求文档" },
          { node_token: "nt-2", obj_token: "bd-9", obj_type: "bitable", title: "表格（跳过）" },
        ],
        has_more: false,
      },
    },
    "https://open.feishu.cn/open-apis/docx/v1/documents/docx-1/raw_content": {
      code: 0, data: { content: "正文第一行" },
    },
  };

  it("walks spaces → docx nodes → raw content as NormalizedDocument", async () => {
    const { ctx } = feishuCtx("cli_app:secret", pages);
    const collected: Array<{ documents?: unknown[] }> = [];
    for await (const page of feishuWikiSyncProvider.pullDirect!(ctx as any, "full")) {
      collected.push(page as any);
    }
    const documents = collected[0]?.documents as Array<Record<string, unknown>>;
    expect(documents).toHaveLength(1); // bitable 节点被跳过
    expect(documents[0]).toMatchObject({
      providerDocumentId: "docx-1",
      title: "需求文档",
      markdown: "# 需求文档\n\n正文第一行",
      sourceUrl: "https://feishu.cn/wiki/nt-1",
    });
  });

  it("rejects malformed credentials and surfaces feishu error codes", async () => {
    await expect(async () => {
      for await (const _ of feishuWikiSyncProvider.pullDirect!(feishuCtx("no-separator", pages).ctx as any, "full")) break;
    }).rejects.toThrow("feishu_credentials_invalid");

    const badToken = { ...pages, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal": { code: 99991663, msg: "app secret invalid" } };
    await expect(async () => {
      for await (const _ of feishuWikiSyncProvider.pullDirect!(feishuCtx("a:b", badToken).ctx as any, "full")) break;
    }).rejects.toThrow("feishu_token_failed: 99991663");
  });

  it("validates api-token channel credentials", async () => {
    await expect(apiTokenAuthChannel.start({ provider: "feishu-wiki", ownerId: "local-user", secret: "appId:appSecret" }))
      .resolves.toMatchObject({ status: "connected" });
    await expect(apiTokenAuthChannel.start({ provider: "feishu-wiki", ownerId: "local-user", secret: "nope" }))
      .rejects.toThrow("api_token_credentials_invalid");
  });
});

describe("generic connection endpoint (api-token)", () => {
  it("creates idempotent feishu connections without echoing the secret", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-route-"));
    dirs.push(dir);
    const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
    const repo = new ConnectorRepository(connectors.sqlite);
    const engine = new SyncEngine(null, (connection) => connection.credentialsRef ?? null);
    const manager = new ConnectorManager(repo, null, null, engine);
    const app = Fastify();
    await app.register(nangoConnectorRoutes(manager, true));
    const payload = { provider: "feishu-wiki", credentials: "cli_app:sekret" };
    const created = await app.inject({ method: "POST", url: "/v1/connectors/connections", payload });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ provider: "feishu-wiki", authMethod: "api-token", nangoConfigKey: "direct" });
    expect(created.json().credentialsRef).toBeUndefined();
    const again = await app.inject({ method: "POST", url: "/v1/connectors/connections", payload });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(created.json().id);
    // 非法凭据与 OAuth provider 均拒绝。
    expect((await app.inject({ method: "POST", url: "/v1/connectors/connections", payload: { provider: "feishu-wiki", credentials: "only-app-id" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/connectors/connections", payload: { provider: "gmail", credentials: "a:b" } })).statusCode).toBe(400);
    await app.close();
    await manager.dispose();
    connectors.sqlite.close();
  });
});

describe("prefix aliasing (/v1/connectors → /v1/nango-connectors)", () => {
  it("serves providers under the new prefix via the rewrite hook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prefix-route-"));
    dirs.push(dir);
    const connectors = createConnectorDatabase(join(dir, "connectors.sqlite"));
    const repo = new ConnectorRepository(connectors.sqlite);
    const manager = new ConnectorManager(repo, null);
    const app = Fastify();
    await app.register(nangoConnectorRoutes(manager, true));
    // 与 create-server 相同的 404 兜底别名转发（前缀泛化的实现体）。
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/v1/connectors/") && request.url !== "/v1/connectors/connections" && !request.url.startsWith("/v1/connectors/connections/")) {
        const rewritten = `/v1/nango-connectors/${request.url.slice("/v1/connectors/".length)}`;
        const response = await app.inject({ method: request.method as any, url: rewritten, headers: { ...request.headers, "x-internal-alias": "1" } });
        reply.code(response.statusCode);
        for (const [key, value] of Object.entries(response.headers)) {
          if (["content-length", "connection", "transfer-encoding", "date", "keep-alive"].includes(key)) continue;
          reply.header(key, value);
        }
        reply.send(response.rawPayload);
        return;
      }
      reply.code(404).send({ error: "not_found" });
    });
    const viaNew = await app.inject({ url: "/v1/connectors/providers" });
    expect(viaNew.statusCode).toBe(200);
    expect(viaNew.json().providers.some((item: any) => item.provider === "feishu-wiki")).toBe(true);
    const viaOld = await app.inject({ url: "/v1/nango-connectors/providers" });
    expect(viaOld.statusCode).toBe(200);
    expect(viaOld.headers.deprecation).toBe("true");
    await app.close();
    await manager.dispose();
    connectors.sqlite.close();
  });
});
