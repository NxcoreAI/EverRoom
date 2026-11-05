import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentSession, TrustedMcpSession } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];
if (!process.env.NXCORE_SECRET_STORE_KEY) process.env.NXCORE_SECRET_STORE_KEY = randomBytes(32).toString("base64url");

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-gateway-test-"));
  temporaryDirectories.push(dataDir);
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve("drizzle"),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    logLevel: "silent",
    authToken: "test-token-0123456789",
    agentRuntime: "fake",
    pi: null,
    cursorCompletionPi: null,
    litePi: null,
    backgroundPi: null,
    webSearch: null,
    mcpConfigPath: join(dataDir, 'agent', 'mcp.json'),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("gateway server", () => {
  it("serves the skill catalog and applies enable/disable", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const listed = await app.inject({ method: "GET", url: "/v1/skills", headers });
    expect(listed.statusCode).toBe(200);
    const catalog = listed.json() as {
      skills: Array<{ id: string; enabled: boolean; ownerKind: string }>;
      counts: { total: number; enabled: number };
    };
    // 内置 bundle 的技能在清单里；子 Agent 的技能也并进同一份清单。
    expect(catalog.skills.some((skill) => skill.id === "builtin:main:document-export")).toBe(true);
    expect(catalog.skills.some((skill) => skill.ownerKind === "subagent")).toBe(true);
    expect(catalog.counts.enabled).toBe(catalog.counts.total);

    const skillId = encodeURIComponent("builtin:main:document-export");
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/skills/${skillId}`,
      headers,
      payload: { enabled: false },
    });
    await app.close();

    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { enabled: boolean }).enabled).toBe(false);
  });

  it("reports liveness without authentication", async () => {
    const app = await createServer(await testConfig());
    const response = await app.inject({ method: "GET", url: "/v1/health/live" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok", service: "nxcore-gateway" });
  });

  it("protects non-health routes with a bearer token", async () => {
    const config = await testConfig();
    const app = await createServer(config);

    const unauthorized = await app.inject({ method: "GET", url: "/v1/system/info" });
    const authorized = await app.inject({
      method: "GET",
      url: "/v1/system/info",
      headers: { authorization: `Bearer ${config.authToken}` },
    });
    await app.close();

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
  }, 10_000);

  it("clears managed search secrets without deleting local MCP credentials", async () => {
    const previousKey = process.env.NXCORE_SECRET_STORE_KEY;
    process.env.NXCORE_SECRET_STORE_KEY = randomBytes(32).toString("base64url");
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const mcp = await app.inject({
      method: "PUT",
      url: "/v1/agent/mcp/servers",
      headers,
      payload: { servers: { local: { command: "npx", env: { TOKEN: { operation: "set", value: "local-mcp-51" } } } } },
    });
    expect(mcp.statusCode).toBe(200);
    const runtime = await app.inject({
      method: "PUT",
      url: "/v1/runtime-config/user",
      headers,
      payload: { schemaVersion: 1, webSearch: { provider: "openai-compatible", api: "openai-completions", model: "search", baseUrl: "https://search.test/v1", apiKey: "user-search-51" } },
    });
    expect(runtime.statusCode).toBe(200);
    const logout = await app.inject({ method: "POST", url: "/v1/security/secrets/logout", headers });
    expect(logout.statusCode).toBe(200);
    const mcpAfter = await app.inject({ method: "GET", url: "/v1/agent/mcp/servers", headers });
    expect(mcpAfter.json().servers.local.env).toEqual({ TOKEN: { configured: true } });
    const runtimeAfter = await app.inject({ method: "GET", url: "/v1/runtime-config", headers });
    expect(runtimeAfter.json().webSearchCredential).toMatchObject({ configured: false, source: "none" });
    await app.close();
    if (previousKey === undefined) delete process.env.NXCORE_SECRET_STORE_KEY;
    else process.env.NXCORE_SECRET_STORE_KEY = previousKey;
  });

  it("imports a manual file through the files pipeline to ready", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const form = new FormData();
    form.append("metadata", JSON.stringify({
      sourceKind: "manual-upload",
      sourceKey: "manual:files-pipeline:1",
      originalName: "manual-import.md",
    }));
    form.append("file", new Blob(["# Manual import\n\nfiles-pipeline"], { type: "text/markdown" }), "manual-import.md");
    const accepted = await app.inject({ method: "POST", url: "/v1/file-imports", headers, payload: form });
    expect(accepted.statusCode).toBe(202);

    // 解析登记是异步 job：轮询 catalog 直到 processingState 离开 processing。
    let entry: { processingState?: string } | undefined;
    for (let attempt = 0; attempt < 200 && (!entry || entry.processingState === "processing"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const catalog = await app.inject({ url: "/v1/files/catalog", headers });
      entry = catalog.json<{ items: Array<{ originalName: string; processingState: string }> }>()
        .items.find((item) => item.originalName === "manual-import.md");
    }
    expect(entry?.processingState).toBe("ready");
    await app.close();
  });

  it("lists only user schedules: the built-in diary slot is gone (Phase 1)", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const initial = await app.inject({ method: "GET", url: "/v1/agent/schedules", headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<unknown[]>()).toEqual([]);

    const created = await app.inject({
      method: "POST", url: "/v1/agent/schedules", headers,
      payload: { agentId: "primary", name: "每日复盘", prompt: "总结进展", localTime: "08:15", timezone: "UTC" },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<{ id: string; enabled: boolean; configVersion: number }>();
    expect(task.enabled).toBe(true);

    const updated = await app.inject({
      method: "PATCH", url: `/v1/agent/schedules/${task.id}`, headers,
      payload: { localTime: "08:30", timezone: "UTC", configVersion: task.configVersion },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: task.id, localTime: "08:30", timezone: "UTC" });

    const missingPatch = await app.inject({
      method: "PATCH", url: "/v1/agent/schedules/missing", headers,
      payload: { localTime: "08:30", configVersion: 1 },
    });
    const missing = await app.inject({ method: "POST", url: "/v1/agent/schedules/missing/run", headers });
    const removed = await app.inject({ method: "DELETE", url: `/v1/agent/schedules/${task.id}`, headers });
    await app.close();
    expect(missingPatch.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(removed.statusCode).toBe(204);
  });

  it("supports user schedules and exposes MCP execution", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const created = await app.inject({
      method: "POST", url: "/v1/agent/schedules", headers,
      payload: { agentId: "primary", name: "整理收件箱", description: "测试任务", prompt: "整理今天的收件箱", localTime: "10:00", timezone: "UTC" },
    });
    const task = created.json<{ id: string; builtin: boolean }>();
    const mcpList = await app.inject({ method: "POST", url: "/v1/mcp/agent-schedules", headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const deleted = await app.inject({ method: "DELETE", url: `/v1/agent/schedules/${task.id}`, headers });
    await app.close();
    expect(created.statusCode).toBe(201);
    expect(task.builtin).toBe(false);
    expect(mcpList.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name)).toContain("agent_schedule_run");
    expect(deleted.statusCode).toBe(204);
  });

  it("supports the complete authenticated document CRUD lifecycle", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const imported = await app.inject({
      method: "POST",
      url: "/v1/documents/import",
      headers,
      payload: {
        id: "document-to-delete",
        roomId: "room-delete",
        title: "待删除文档",
        contentJson: { type: "doc", content: [] },
      },
    });
    const listedAfterCreate = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers,
    });
    const readAfterCreate = await app.inject({
      method: "GET",
      url: "/v1/documents/document-to-delete",
      headers,
    });
    const updated = await app.inject({
      method: "PUT",
      url: "/v1/documents/document-to-delete",
      headers,
      payload: {
        baseVersion: 1,
        contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "已更新" }] }] },
      },
    });
    const conflict = await app.inject({
      method: "PUT",
      url: "/v1/documents/document-to-delete",
      headers,
      payload: { baseVersion: 1, contentJson: { type: "doc", content: [] } },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/v1/documents/document-to-delete",
      headers,
    });
    const listedAfterDelete = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers,
    });
    const listedTrash = await app.inject({
      method: "GET",
      url: "/v1/documents?trashed=true",
      headers,
    });
    const restored = await app.inject({
      method: "POST",
      url: "/v1/documents/document-to-delete/restore",
      headers,
    });
    const listedAfterRestore = await app.inject({
      method: "GET",
      url: "/v1/documents",
      headers,
    });
    await app.inject({
      method: "DELETE",
      url: "/v1/documents/document-to-delete",
      headers,
    });
    const permanentlyDeleted = await app.inject({
      method: "DELETE",
      url: "/v1/documents/document-to-delete/permanent",
      headers,
    });
    const readAfterPermanentDelete = await app.inject({
      method: "GET",
      url: "/v1/documents/document-to-delete",
      headers,
    });
    const trashImported = await app.inject({
      method: "POST",
      url: "/v1/documents/import",
      headers,
      payload: {
        id: "document-to-empty",
        roomId: "room-delete",
        title: "待清空文档",
        contentJson: { type: "doc", content: [] },
      },
    });
    const trashMarked = await app.inject({
      method: "DELETE",
      url: "/v1/documents/document-to-empty",
      headers,
    });
    const emptied = await app.inject({
      method: "DELETE",
      url: "/v1/documents/trash",
      headers,
    });
    const trashAfterEmpty = await app.inject({
      method: "GET",
      url: "/v1/documents?trashed=true",
      headers,
    });
    await app.close();

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ id: "document-to-delete", roomId: null, version: 1 });
    expect(listedAfterCreate.json()).toEqual([expect.objectContaining({ id: "document-to-delete" })]);
    expect(readAfterCreate.json()).toMatchObject({ id: "document-to-delete", version: 1 });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ version: 2, contentJson: { type: "doc" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "DOCUMENT_CONFLICT" });
    expect(deleted.statusCode).toBe(204);
    expect(listedAfterDelete.json()).toEqual([]);
    expect(listedTrash.json()).toEqual([
      expect.objectContaining({ id: "document-to-delete", deletedAt: expect.any(String) }),
    ]);
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ id: "document-to-delete", deletedAt: null });
    expect(listedAfterRestore.json()).toEqual([expect.objectContaining({ id: "document-to-delete" })]);
    expect(permanentlyDeleted.statusCode).toBe(204);
    expect(readAfterPermanentDelete.statusCode).toBe(404);
    expect(trashImported.statusCode).toBe(201);
    expect(trashMarked.statusCode).toBe(204);
    expect(emptied.statusCode).toBe(204);
    expect(trashAfterEmpty.json()).toEqual([]);
  });

  it("serves the document MCP protocol over authenticated HTTP", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Context Room", roomId: "room-test" },
    })).json<AgentSession>();
    const run = (await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "列出当前文档",
        idempotencyKey: "mcp-http-run",
        context: { selectedRoomId: "room-test", rooms: [{ id: "room-test", title: "MCP Room" }] },
      },
    })).json<AgentRun>();
    const trusted = (await app.inject({
      method: "POST",
      url: "/v1/agent/mcp-sessions",
      headers,
      payload: { agentSessionId: session.id, runId: run.id, roomId: "room-test" },
    })).json<TrustedMcpSession>();
    const url = `/v1/mcp/documents/${trusted.sessionId}`;

    const initialize = await app.inject({
      method: "POST",
      url,
      headers,
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "gateway-test", version: "1" },
        },
      },
    });
    const initialized = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    const tools = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    await app.close();

    expect(initialize.statusCode).toBe(200);
    expect(initialize.json()).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(initialized.statusCode).toBe(202);
    // Markdown 文稿工具链已下线（2026-11）；无 officeBridge 的测试配置下能力注册表为空，
    // 这里只验证 MCP 协议通路（initialize → initialized → tools/list 正常返回数组）。
    expect(Array.isArray(tools.json().result.tools)).toBe(true);
  });

  it("is compatible with the official Streamable HTTP MCP client", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Context Room", roomId: "room-client-test" },
    })).json<AgentSession>();
    const run = (await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "列出当前文档",
        idempotencyKey: "mcp-client-run",
        context: {
          selectedRoomId: "room-client-test",
          rooms: [{ id: "room-client-test", title: "Client Room" }],
        },
      },
    })).json<AgentRun>();
    const trusted = (await app.inject({
      method: "POST",
      url: "/v1/agent/mcp-sessions",
      headers,
      payload: { agentSessionId: session.id, runId: run.id, roomId: "room-client-test" },
    })).json<TrustedMcpSession>();
    const endpoint = new URL(`/v1/mcp/documents/${trusted.sessionId}`, address);
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${config.authToken}` } },
    });

    try {
      await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
      const listed = await client.listTools();
      // 同上：工具面依赖 officeBridge，协议兼容性以 tools/list 正常应答为准。
      expect(Array.isArray(listed.tools)).toBe(true);
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("serves API documentation without authentication", async () => {
    const app = await createServer(await testConfig());
    const response = await app.inject({ method: "GET", url: "/docs/json" });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().openapi).toBe("3.0.3");
  });

  it("persists structured logs in the gateway data directory", async () => {
    const config = await testConfig();
    config.logLevel = "info";
    const app = await createServer(config);
    app.log.info({ res: { statusCode: 200 } }, "response serializer test");
    app.log.info({ testMarker: "gateway-log-test" }, "log persistence test");
    await app.close();

    const logsDirectory = join(config.dataDir, "logs");
    const logFiles = (await readdir(logsDirectory)).filter(
      (file) => /^gateway\.\d{4}-\d{2}-\d{2}\.\d+\.log$/.test(file),
    );
    expect(logFiles).toHaveLength(1);

    const entries = (await readFile(join(logsDirectory, logFiles[0]!), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const markerEntry = entries.find((entry) => entry.testMarker === "gateway-log-test");
    const requestEntry = entries.find((entry) => entry.msg === "response serializer test") as
      | { res?: { statusCode?: number } }
      | undefined;
    expect(markerEntry).toMatchObject({ msg: "log persistence test" });
    expect(markerEntry?.time).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    expect(requestEntry?.res?.statusCode).toBe(200);
  });

  it("serves runtime-config snapshots with configured flag and connection test", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    // 默认 runtime config 全是空串占位 → primaryConfigured=false
    const initial = await app.inject({ method: "GET", url: "/v1/runtime-config", headers });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ primaryConfigured: false });

    // 写入完整 primary 配置（user source）→ primaryConfigured=true
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/runtime-config/user",
      headers,
      payload: {
        schemaVersion: 1,
        primary: {
          provider: "openai-compatible",
          model: "test-model",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "user-key",
          api: "openai-completions",
        },
        vlm: {
          provider: "openai-compatible",
          model: "vlm-test-model",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "vlm-key",
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ primaryConfigured: true, selectedSource: "user" });

    // 槽位 apiKey 落库后在快照中脱敏（********），provider/model 不脱敏。
    const snapshot = await app.inject({ method: "GET", url: "/v1/runtime-config", headers });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      config: {
        vlm: {
          model: "vlm-test-model",
          apiKey: "********",
        },
      },
    });

    // secrets 端点：主进程派生托管子进程 env 用，返回未脱敏真值（掩码会让
    // 子进程起服务后每个上游请求 401）。
    const secrets = await app.inject({ method: "GET", url: "/v1/runtime-config/secrets", headers });
    expect(secrets.statusCode).toBe(200);
    expect(secrets.json()).toMatchObject({
      primaryConfigured: true,
      config: {
        primary: { apiKey: "user-key" },
        vlm: { apiKey: "vlm-key" },
      },
    });

    // 连通测试端点：配置完整但端点不可达 → valid=false 且带 unreachable 原因。
    // bridge 实际发 POST 带 {} body（axios 空 body POST 会补 form-urlencoded
    // 头触发 415，见 runtime-config-bridge 注释）。
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    const test = await app.inject({ method: "POST", url: "/v1/runtime-config/test", headers, payload: {} });
    vi.unstubAllGlobals();
    expect(test.statusCode).toBe(200);
    const body = test.json<{ valid: boolean; error?: string }>();
    expect(body.valid).toBe(false);
    expect(body.error).toContain("runtime_config_test_unreachable");

    // 端点恢复 2xx → valid=true（primary/vlm 都走 /chat/completions）。
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const ok = await app.inject({ method: "POST", url: "/v1/runtime-config/test", headers, payload: {} });
    vi.unstubAllGlobals();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      valid: true,
      vlm: { valid: true },
    });

    await app.inject({ method: "DELETE", url: "/v1/runtime-config/user", headers });
    // 清空 user source 后 vlm 未配置 → /test 不带 vlm 字段。
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const cleared = await app.inject({ method: "POST", url: "/v1/runtime-config/test", headers, payload: {} });
    vi.unstubAllGlobals();
    const clearedBody = cleared.json<{ valid: boolean; vlm?: unknown }>();
    expect(clearedBody.valid).toBe(false);
    expect(clearedBody.vlm).toBeUndefined();
    await app.close();
  });
});
