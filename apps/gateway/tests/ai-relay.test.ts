import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { runtimeConfigStore } from "../src/infrastructure/database/schema.js";
import { aiRelayRoutes } from "../src/modules/ai-relay/routes.js";
import { AiRelaySessionStore } from "../src/modules/ai-relay/session.js";
import { RuntimeConfigManager } from "../src/runtime-config.js";
import { SecretStore } from "../src/security/secret-store.js";
import { auth } from "../src/server/auth.js";

const directories: string[] = [];
const databases: Array<{ close(): void }> = [];
const key = () => randomBytes(32).toString("base64url");

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "everroom-ai-relay-test-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sessionApp(options: { sessions: AiRelaySessionStore; refresh?: () => void; token?: string }) {
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  const manager = { refresh: options.refresh ?? (() => undefined) } as unknown as RuntimeConfigManager;
  void app.register(async (instance) => {
    await instance.register(auth, { token: options.token ?? "gw-token-51" });
    await instance.register(aiRelayRoutes({ sessions: options.sessions, runtimeConfigManager: manager }));
  });
  return app;
}

async function managerWithPayload(payload: Record<string, unknown>, options?: {
  sessions?: AiRelaySessionStore;
  source?: "saas" | "user";
}) {
  const root = await directory();
  await mkdir(join(root, "security"), { recursive: true });
  const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database.sqlite);
  database.db.insert(runtimeConfigStore).values({
    source: options?.source ?? "saas",
    payload: payload as never,
    schemaVersion: 1,
    configVersion: 1,
    updatedAt: new Date(),
  }).run();
  const sessions = options?.sessions ?? new AiRelaySessionStore();
  sessions.set({
    baseUrl: "https://relay.example.com",
    token: "sk-relay-51",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    proxyOrigin: "http://127.0.0.1:49152",
  });
  const manager = new RuntimeConfigManager(
    database.db,
    new SecretStore(join(root, "security", "credentials.enc"), key()),
    resolve("runtime-config.default.json"),
    null,
    () => {
      const session = sessions.current();
      return session ? { proxyOrigin: session.proxyOrigin, token: "gw-self-token-51" } : null;
    },
  );
  return { manager, sessions, database };
}

describe("ai relay session store", () => {
  it("treats expired sessions as inactive", () => {
    const sessions = new AiRelaySessionStore();
    expect(sessions.active()).toBe(false);
    sessions.set({
      baseUrl: "https://relay.example.com",
      token: "sk-relay-51",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proxyOrigin: "http://127.0.0.1:49152",
    });
    expect(sessions.active()).toBe(true);
    sessions.set({
      baseUrl: "https://relay.example.com",
      token: "sk-relay-51",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      proxyOrigin: "http://127.0.0.1:49152",
    });
    expect(sessions.active()).toBe(false);
    sessions.clear();
    expect(sessions.active()).toBe(false);
  });
});

describe("ai relay session routes", () => {
  it("rejects unauthenticated requests, validates input, and refreshes runtime config", async () => {
    const sessions = new AiRelaySessionStore();
    const refresh = vi.fn();
    const app = sessionApp({ sessions, refresh });

    try {
      const unauthenticated = await app.inject({ method: "PUT", url: "/v1/ai-relay/session", payload: {} });
      expect(unauthenticated.statusCode).toBe(401);

      const invalid = await app.inject({
        method: "PUT",
        url: "/v1/ai-relay/session",
        headers: { authorization: "Bearer gw-token-51" },
        payload: { baseUrl: "not-a-url", token: "sk-51", expiresAt: new Date().toISOString(), proxyOrigin: "http://127.0.0.1:1" },
      });
      expect(invalid.statusCode).toBe(400);

      const ok = await app.inject({
        method: "PUT",
        url: "/v1/ai-relay/session",
        headers: { authorization: "Bearer gw-token-51" },
        payload: {
          baseUrl: "https://relay.example.com",
          token: "sk-relay-51",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          proxyOrigin: "http://127.0.0.1:49152",
        },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ ok: true, active: true });
      expect(refresh).toHaveBeenCalledTimes(1);

      const cleared = await app.inject({
        method: "DELETE",
        url: "/v1/ai-relay/session",
        headers: { authorization: "Bearer gw-token-51" },
      });
      expect(cleared.statusCode).toBe(200);
      expect(sessions.active()).toBe(false);
      expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});

describe("ai relay proxy", () => {
  async function withUpstream(handlers: Array<{ method: string; url: string; handler: (request: FastifyRequest, reply: FastifyReply) => unknown }>) {
    const upstream = Fastify();
    for (const item of handlers) {
      const registry = upstream as unknown as Record<string, ((url: string, handler: (request: FastifyRequest, reply: FastifyReply) => unknown) => unknown) | undefined>;
      registry[item.method.toLowerCase()]?.(item.url, item.handler);
    }
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const address = upstream.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { upstream, baseUrl: `http://127.0.0.1:${port}` };
  }

  it("forwards requests with the relay token and passes upstream status codes through", async () => {
    const captured: Array<{ auth: string | undefined; model: string | undefined }> = [];
    const { upstream, baseUrl } = await withUpstream([
      {
        method: "POST",
        url: "/v1/chat/completions",
        handler: async (request, reply) => {
          captured.push({
            auth: request.headers.authorization,
            model: (request.body as { model?: string } | undefined)?.model,
          });
          return reply.code(200).send({ choices: [{ message: { content: "ok" } }] });
        },
      },
      {
        method: "POST",
        url: "/v1/quota-exhausted",
        handler: async (_request, reply) => reply.code(402).send({ error: { message: "insufficient quota" } }),
      },
      {
        method: "GET",
        url: "/v1/models",
        handler: async (request, reply) => reply.send({ auth: request.headers.authorization, query: request.query }),
      },
    ]);

    const sessions = new AiRelaySessionStore();
    sessions.set({
      baseUrl,
      token: "sk-relay-51",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      proxyOrigin: "http://127.0.0.1:49152",
    });
    const app = sessionApp({ sessions });

    try {
      const completion = await app.inject({
        method: "POST",
        url: "/ai-relay/v1/chat/completions",
        headers: { authorization: "Bearer gw-token-51" },
        payload: { model: "qwen-plus", messages: [] },
      });
      expect(completion.statusCode).toBe(200);
      expect(completion.json()).toMatchObject({ choices: [{ message: { content: "ok" } }] });
      expect(captured[0]).toEqual({ auth: "Bearer sk-relay-51", model: "qwen-plus" });
      const quota = await app.inject({
        method: "POST",
        url: "/ai-relay/v1/quota-exhausted",
        headers: { authorization: "Bearer gw-token-51" },
        payload: {},
      });
      expect(quota.statusCode).toBe(402);
      expect(quota.json()).toMatchObject({ error: { message: "insufficient quota" } });

      const models = await app.inject({
        method: "GET",
        url: "/ai-relay/v1/models?group=pro",
        headers: { authorization: "Bearer gw-token-51" },
      });
      expect(models.statusCode).toBe(200);
      expect(models.json()).toMatchObject({ auth: "Bearer sk-relay-51", query: { group: "pro" } });
    } finally {
      await app.close();
      await upstream.close();
    }
  });

  it("returns 503 while no active session", async () => {
    const app = sessionApp({ sessions: new AiRelaySessionStore() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/ai-relay/v1/chat/completions",
        headers: { authorization: "Bearer gw-token-51" },
        payload: { model: "qwen-plus" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: { code: "ai_relay_not_ready" } });
    } finally {
      await app.close();
    }
  });
});

describe("runtime config relay slot rewrite", () => {
  it("rewrites configured LLM slots to the local proxy while asr and service URLs stay untouched", async () => {
    const { manager } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
      background: { provider: "openai-compatible", api: "openai-completions", model: "qwen-flash", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
      cursorCompletion: { provider: "openai-compatible", api: "openai-completions", model: "qwen-turbo", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
      vlm: { provider: "openai-compatible", api: "openai-completions", model: "qwen-vl-max", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
      webSearch: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1", apiKey: "search-key" },
      asr: { provider: "aliyun", model: "qwen-audio-3.0-asr-flash-filetrans", baseUrl: "https://dashscope.aliyuncs.com/api/v1", apiKey: "asr-key" },
      knowledge: {
        llm: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
        embedding: { provider: "openai-compatible", api: "openai-completions", model: "text-embedding-v4", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
      },
    });

    const snapshot = manager.snapshot(false);
    const slotOf = (name: string): Record<string, unknown> =>
      (snapshot.config as unknown as Record<string, Record<string, unknown> | undefined>)[name]!;
    expect(snapshot.selectedSource).toBe("saas");
    for (const slot of ["primary", "background", "cursorCompletion", "vlm", "webSearch"]) {
      expect(slotOf(slot).baseUrl).toBe("http://127.0.0.1:49152/ai-relay/v1");
      expect(slotOf(slot).apiKey).toBe("gw-self-token-51");
      expect(slotOf(slot).model).toBeTruthy();
    }
    const knowledge = slotOf("knowledge");
    const knowledgeLlm = knowledge.llm as Record<string, unknown>;
    const knowledgeEmbedding = knowledge.embedding as Record<string, unknown>;
    expect(knowledgeLlm.baseUrl).toBe("http://127.0.0.1:49152/ai-relay/v1");
    expect(knowledgeLlm.apiKey).toBe("gw-self-token-51");
    expect(knowledgeEmbedding.baseUrl).toBe("http://127.0.0.1:49152/ai-relay/v1");
    expect(knowledgeEmbedding.apiKey).toBe("gw-self-token-51");
    const asr = slotOf("asr");
    expect(asr.baseUrl).toBe("https://dashscope.aliyuncs.com/api/v1");
    expect(asr.apiKey).toBe("asr-key");
  });

  it("rewrites legacy upstream paths to the canonical relay prefix instead of inheriting them", async () => {
    const { manager } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "legacy-key" },
      background: { provider: "openai-compatible", api: "openai-completions", model: "qwen-flash", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "legacy-key" },
      asr: { provider: "aliyun", model: "qwen-audio-3.0-asr-flash-filetrans", baseUrl: "https://dashscope.aliyuncs.com/api/v1", apiKey: "asr-key" },
    });

    const snapshot = manager.snapshot(false);
    // 过渡期下发的是旧方案直连地址：relay 激活时 host/path 整体换成中转站
    // 出口（默认 /v1），不继承 /compatible-mode/v1——否则 new-api 会 404。
    expect(snapshot.config.primary?.baseUrl).toBe("http://127.0.0.1:49152/ai-relay/v1");
    expect(snapshot.config.primary?.apiKey).toBe("gw-self-token-51");
    expect(snapshot.config.background?.baseUrl).toBe("http://127.0.0.1:49152/ai-relay/v1");
    // asr 不重写：旧方案直连地址原样保留（relay 失效回退时同样直接可用）。
    const slotOf = (name: string): Record<string, unknown> =>
      (snapshot.config as unknown as Record<string, Record<string, unknown> | undefined>)[name]!;
    expect(slotOf("asr").baseUrl).toBe("https://dashscope.aliyuncs.com/api/v1");
  });

  it("does not rewrite when the user source is explicitly selected", async () => {
    const sessions = new AiRelaySessionStore();
    const { manager } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "my-model", baseUrl: "https://api.my-provider.com/v1", apiKey: "my-key" },
    }, { sessions, source: "user" });

    const snapshot = manager.snapshot(false);
    expect(snapshot.selectedSource).toBe("user");
    expect(snapshot.config.primary?.baseUrl).toBe("https://api.my-provider.com/v1");
    expect(snapshot.config.primary?.apiKey).toBe("my-key");
  });

  it("stops rewriting once the session is cleared and refresh() re-resolves", async () => {
    const sessions = new AiRelaySessionStore();
    const { manager } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
    }, { sessions });
    expect(manager.snapshot(false).config.primary?.baseUrl).toBe("http://127.0.0.1:49152/ai-relay/v1");

    // 生产路径：DELETE /v1/ai-relay/session 后由路由触发 refresh()。
    sessions.clear();
    manager.refresh();

    const snapshot = manager.snapshot(false);
    expect(snapshot.config.primary?.baseUrl).toBe("https://relay.example.com/v1");
    expect(snapshot.config.primary?.apiKey).toBe("saas-key");
  });

  it("refresh() re-resolves and emits onChange", async () => {
    const { manager, sessions } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1", apiKey: "saas-key" },
    });
    const listener = vi.fn();
    const unsubscribe = manager.onChange(listener);
    sessions.clear();
    manager.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.snapshot(false).config.primary?.apiKey).toBe("saas-key");
    unsubscribe();
  });
});

describe("runtime config saas source authority", () => {
  it("stores the saas payload verbatim so a cleared key stays cleared", async () => {
    const { manager, database, sessions } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1", apiKey: "old-saas-key" },
    });

    // 平台撤销槽位密钥（下发不含 apiKey 的槽位）→ 旧值必须真正消失，
    // 否则 relay 断开回退时仍会带着平台密钥直连上游。
    manager.set("saas", {
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "qwen-plus", baseUrl: "https://relay.example.com/v1" },
    });
    const stored = database.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, "saas")).get();
    const primary = (stored?.payload as { primary?: Record<string, unknown> } | undefined)?.primary;
    expect(primary).toBeTruthy();
    expect("apiKey" in primary!).toBe(false);
    // relay 断开后回退到原值：清除过的密钥必须真正消失，而不是旧值复活。
    sessions.clear();
    manager.refresh();
    expect(manager.snapshot(false).config.primary?.apiKey).toBe("");
  });

  it("keeps the masked-preserve round-trip for the user source", async () => {
    const { manager } = await managerWithPayload({
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "my-model", baseUrl: "https://api.my-provider.com/v1", apiKey: "my-key" },
    }, { source: "user" });

    manager.set("user", {
      schemaVersion: 1,
      primary: { provider: "openai-compatible", api: "openai-completions", model: "my-model-renamed", baseUrl: "https://api.my-provider.com/v1", apiKey: "********" },
    });
    const primary = manager.snapshot(false).config.primary;
    expect(primary?.apiKey).toBe("my-key");
    expect(primary?.model).toBe("my-model-renamed");
  });
});
