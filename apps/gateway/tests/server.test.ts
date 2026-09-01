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
    memory: null,
    pi: null,
    cursorCompletionPi: null,
    knowledge: null,
    ingestFilter: { enabled: false, mode: "observe", confidenceThreshold: 0.7, batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [], toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048, insightEnabled: false, insightIntervalMs: 3_600_000 },
    backgroundPi: null,
    asrInputDir: join(dataDir, "recordings"),
    webSearch: null,
    mcpConfigPath: join(dataDir, 'agent', 'mcp.json'),
    asr: null,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("gateway server", () => {
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
      url: "/v1/runtime-config/saas",
      headers,
      payload: { schemaVersion: 1, webSearch: { provider: "openai-compatible", api: "openai-completions", model: "search", baseUrl: "https://search.test/v1", apiKey: "saas-search-51" } },
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

  it("keeps memory routes enabled without a Pi runtime", async () => {
    const config = await testConfig();
    config.memory = {
      baseUrl: "http://127.0.0.1:8420",
      apiKey: "memory-key",
      serviceId: "everroom",
      teamId: "everroom",
      agentId: "pi-agent",
      userId: "local-user",
      recallLimit: 5,
      charBudget: 2_000,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      message: "ok",
      data: { items: [], total: 0 },
    }), { headers: { "content-type": "application/json" } })));
    const app = await createServer(config);

    const response = await app.inject({
      method: "GET",
      url: "/v1/memory/atomic?limit=1&offset=0",
      headers: { authorization: `Bearer ${config.authToken}` },
    });
    await app.close();

    expect(config.pi).toBeNull();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], total: 0 });
  });

  it("keeps env-backed memory config when runtime config default only has empty placeholders", async () => {
    const config = await testConfig();
    config.memory = {
      baseUrl: "http://127.0.0.1:8420",
      apiKey: "memory-key",
      serviceId: "everroom",
      teamId: "everroom",
      agentId: "pi-agent",
      userId: "local-user",
      recallLimit: 5,
      charBudget: 2_000,
    };
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      const data = url.includes("/v2/pipeline/status")
        ? { l1: {}, l2: {}, l3: {} }
        : url.includes("/v3/core/read")
          ? { content: null, version: 0, created_at: "", updated_at: "" }
          : { total: 0 };
      return new Response(JSON.stringify({ code: 0, message: "ok", data }), {
        headers: { "content-type": "application/json" },
      });
    }));
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    // 启动时 applyRuntimeConfig 会拿 runtime-config.default.json（全空串占位）
    // 覆盖 config；空串若被当作有效值，baseUrl 会被清成 ""，fetch 将收到
    // 相对路径 /v3/atomic/count 并抛 Failed to parse URL（memory_unreachable）。
    expect(config.memory?.baseUrl).toBe("http://127.0.0.1:8420");
    let response = await app.inject({
      method: "GET",
      url: "/v1/memory/overview",
      headers,
    });
    expect(response.statusCode).toBe(200);

    // SaaS 下发的 memory 段（云端凭据指向本地自管 MemoryCore）不得覆盖 env：
    // 本地实例的 apiKey 由主进程每次启动随机轮换，云端值必然 401。
    await app.inject({
      method: "PUT",
      url: "/v1/runtime-config/saas",
      headers,
      payload: {
        schemaVersion: 1,
        memory: {
          enabled: true,
          baseUrl: "http://127.0.0.1:8420",
          apiKey: "sk-mem-cloud-delivered-wrong-key",
        },
      },
    });
    expect(config.memory?.apiKey).toBe("memory-key");
    response = await app.inject({
      method: "GET",
      url: "/v1/memory/overview",
      headers,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
  });

  it("accepts runtime memory injection without persisting or resetting it", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const memory = {
      enabled: true,
      baseUrl: "http://127.0.0.1:8420",
      apiKey: "runtime-memory-key",
      serviceId: "service-from-saas",
      teamId: "team-from-saas",
      agentId: "agent-from-saas",
      userId: "local-user",
      recallLimit: 7,
      charBudget: 4_000,
    };

    const injected = await app.inject({ method: "PUT", url: "/v1/memory/config", headers, payload: memory });
    expect(injected.statusCode).toBe(200);
    expect(injected.json()).toEqual({ enabled: true });
    const persisted = await app.inject({ method: "GET", url: "/v1/runtime-config", headers });
    expect(persisted.json<{ config: { memory?: { apiKey?: string } } }>().config.memory?.apiKey).toBe("");

    // Runtime config persistence must not be used as the secret-bearing
    // transport, and a later config event must leave the injected client live.
    await app.inject({
      method: "PUT",
      url: "/v1/runtime-config/saas",
      headers,
      payload: { schemaVersion: 1, memory: { serviceId: "service-from-saas" } },
    });
    const stillEnabled = await app.inject({ method: "PUT", url: "/v1/memory/config", headers, payload: memory });
    expect(stillEnabled.json()).toEqual({ enabled: true });

    const disabled = await app.inject({ method: "DELETE", url: "/v1/memory/config", headers });
    await app.close();
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toEqual({ enabled: false });
  });

  it("degrades manual file imports to the memory pipeline when the knowledge router is off", async () => {
    // Packaged desktop injects NXCORE_KNOWLEDGE_* but never
    // NXCORE_KNOWLEDGE_ROUTER_ENABLED; without the connector-style degrade
    // every manual import is rejected whole by router_disabled.
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const form = new FormData();
    form.append("metadata", JSON.stringify({
      sourceKind: "manual-upload",
      sourceKey: "manual:router-off:1",
      originalName: "router-off.md",
    }));
    form.append("file", new Blob(["# Router off\n\nmemory-only degrade"], { type: "text/markdown" }), "router-off.md");
    const accepted = await app.inject({ method: "POST", url: "/v1/file-imports", headers, payload: form });
    expect(accepted.statusCode).toBe(202);

    // file.ingest 是异步 job；修复前终态 failed（router_disabled），修复后 ready。
    let entry: { processingState?: string } | undefined;
    for (let attempt = 0; attempt < 200 && (!entry || entry.processingState === "processing"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const catalog = await app.inject({ url: "/v1/files/catalog", headers });
      entry = catalog.json<{ items: Array<{ originalName: string; processingState: string }> }>()
        .items.find((item) => item.originalName === "router-off.md");
    }
    expect(entry?.processingState).toBe("ready");
    await app.close();
  });

  it("serves persisted perception and diary settings with local visual nodes", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const perceptionSettings = await app.inject({ method: "GET", url: "/v1/perception/settings", headers });
    const initialPerception = perceptionSettings.json<{ configVersion: number }>();
    const updatedPerception = await app.inject({
      method: "PATCH", url: "/v1/perception/settings", headers,
      payload: { configVersion: initialPerception.configVersion, captureEnabled: true, captureIntervalSeconds: 60 },
    });
    const capturedAt = new Date().toISOString();
    const uploaded = await app.inject({
      method: "POST", url: "/v1/files", headers,
      payload: {
        filename: "api-photo.jpg", contentBase64: Buffer.from("local photo").toString("base64"),
        mime: "image/jpeg", assetKind: "photo", capturedAt,
      },
    });
    const fileId = uploaded.json<{ id: string }>().id;
    const observed = await app.inject({
      method: "POST", url: "/v1/perception/visual-observations", headers,
      payload: { fileId, kind: "photo", capturedAt, width: 100, height: 80 },
    });
    const nodes = await app.inject({ method: "GET", url: "/v1/perception/nodes?kind=photo", headers });
    const diarySettings = await app.inject({ method: "GET", url: "/v1/diary/settings", headers });
    const initialDiary = diarySettings.json<{ configVersion: number }>();
    const updatedDiary = await app.inject({
      method: "PATCH", url: "/v1/diary/settings", headers,
      payload: { configVersion: initialDiary.configVersion, enabled: true, localTime: "23:30", timezone: "UTC" },
    });
    const diaryConflict = await app.inject({
      method: "PATCH", url: "/v1/diary/settings", headers,
      payload: { configVersion: initialDiary.configVersion, localTime: "22:00" },
    });
    await app.close();

    expect(updatedPerception.json()).toMatchObject({ captureEnabled: true, captureIntervalSeconds: 60 });
    expect(uploaded.statusCode).toBe(201);
    expect(observed.statusCode).toBe(200);
    expect(nodes.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(updatedDiary.json()).toMatchObject({ enabled: true, localTime: "23:30", timezone: "UTC" });
    expect(diaryConflict.statusCode).toBe(409);
  });

  it("manages agent schedules and delegates the diary task to the scheduler", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const initial = await app.inject({ method: "GET", url: "/v1/agent/schedules", headers });
    expect(initial.statusCode).toBe(200);
    const task = initial.json<Array<{ id: string; enabled: boolean; configVersion: number }>>()[0]!;
    expect(task.id).toBe("diary.daily");

    const updated = await app.inject({
      method: "PATCH",
      url: "/v1/agent/schedules/diary.daily",
      headers,
      payload: { enabled: !task.enabled, localTime: "08:15", timezone: "UTC", configVersion: task.configVersion },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ id: "diary.daily", enabled: !task.enabled, localTime: "08:15", timezone: "UTC" });

    const runNow = await app.inject({ method: "POST", url: "/v1/agent/schedules/diary.daily/run", headers });
    expect(runNow.statusCode).toBe(202);
    expect(runNow.json()).toMatchObject({ runId: expect.any(String) });

    const missing = await app.inject({ method: "POST", url: "/v1/agent/schedules/missing/run", headers });
    await app.close();
    expect(missing.statusCode).toBe(404);
  });

  it("supports user schedules while protecting built-in tasks and exposing MCP execution", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const created = await app.inject({
      method: "POST", url: "/v1/agent/schedules", headers,
      payload: { agentId: "primary", name: "整理收件箱", description: "测试任务", prompt: "整理今天的收件箱", localTime: "10:00", timezone: "UTC" },
    });
    const task = created.json<{ id: string; builtin: boolean }>();
    const builtinDelete = await app.inject({ method: "DELETE", url: "/v1/agent/schedules/diary.daily", headers });
    const mcpList = await app.inject({ method: "POST", url: "/v1/mcp/agent-schedules", headers, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    const deleted = await app.inject({ method: "DELETE", url: `/v1/agent/schedules/${task.id}`, headers });
    await app.close();
    expect(created.statusCode).toBe(201);
    expect(task.builtin).toBe(false);
    expect(builtinDelete.statusCode).toBe(409);
    expect(mcpList.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name)).toContain("agent_schedule_run");
    expect(deleted.statusCode).toBe(204);
  });

  it("manages connector sync jobs without accepting a client owner id", async () => {
    const config = await testConfig();
    config.connectorSyncOwnerId = "bound-owner";
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const payload = {
      name: "Gmail 最近一天", service: "gmail", dataset: "emails", resourceType: "email",
      connectionName: "default", allowedActions: ["fetch_emails", "get_message"],
      input: { query: "newer_than:1d", maxResults: 50 }, goal: "同步最近一天邮件",
      scheduleType: "interval", intervalMs: 900_000, timezone: "Asia/Shanghai", status: "active",
    };
    const created = await app.inject({
      method: "POST", url: "/v1/connectors/sync/jobs", headers,
      payload: { ...payload, ownerId: "other-owner" },
    });
    const createdJob = created.json<{ id: string; ownerId: string; configVersion: number }>();
    const paused = await app.inject({
      method: "POST", url: `/v1/connectors/sync/jobs/${createdJob.id}/pause`, headers,
      payload: { configVersion: createdJob.configVersion },
    });
    const conflict = await app.inject({
      method: "PATCH", url: `/v1/connectors/sync/jobs/${createdJob.id}`, headers,
      payload: { configVersion: createdJob.configVersion, name: "过期修改" },
    });
    await app.close();

    expect(created.statusCode).toBe(201);
    expect(createdJob.ownerId).toBe("bound-owner");
    expect(paused.json()).toMatchObject({ status: "paused", configVersion: 2 });
    expect(conflict.statusCode).toBe(409);
  });

  it("serves authenticated background transcription summaries", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const payload = {
      jobId: "job-1",
      sourceRecordId: "source-1",
      transcript: "这是待总结的转写内容。",
    };

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/processing/transcription-summary",
      payload,
    });
    const authorized = await app.inject({
      method: "POST",
      url: "/v1/processing/transcription-summary",
      headers: { authorization: `Bearer ${config.authToken}` },
      payload,
    });
    await app.close();

    expect(unauthorized.statusCode).toBe(401);
    expect(authorized.statusCode).toBe(200);
    const response = authorized.json<{ content: string }>();
    expect(JSON.parse(response.content)).toMatchObject({
      title: expect.any(String),
      overview: expect.any(String),
      keyPoints: expect.any(Array),
      decisions: expect.any(Array),
      actionItems: expect.any(Array),
      topics: expect.any(Array),
    });
  });

  it("persists and serves the complete Context Room snapshot", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const empty = await app.inject({ method: "GET", url: "/v1/context-rooms", headers });
    const saved = await app.inject({
      method: "PUT",
      url: "/v1/context-rooms/snapshot",
      headers,
      payload: {
        rooms: [{
          id: "room-active",
          title: "活动 Room",
          kind: "项目",
          data: { id: "room-active", title: "活动 Room", materials: [] },
        }],
        deletedRooms: [{
          id: "room-deleted",
          title: "回收站 Room",
          kind: "主题",
          data: { id: "room-deleted", title: "回收站 Room", materials: ["资料"] },
        }],
      },
    });
    const loaded = await app.inject({ method: "GET", url: "/v1/context-rooms", headers });
    await app.close();

    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ rooms: [], deletedRooms: [], updatedAt: null });
    expect(saved.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({
      rooms: [{ id: "room-active", title: "活动 Room", kind: "项目" }],
      deletedRooms: [{ id: "room-deleted", title: "回收站 Room", kind: "主题" }],
      updatedAt: expect.any(String),
    });
  });

  it("requires duplicate review before creation and runs a confirmed irreversible merge", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    await app.inject({
      method: "PUT",
      url: "/v1/context-rooms/snapshot",
      headers,
      payload: {
        rooms: [{ id: "room-existing", title: "校园生活", kind: "主题", data: { id: "room-existing", title: "校园生活" } }],
        deletedRooms: [],
      },
    });

    const review = await app.inject({
      method: "POST",
      url: "/v1/context-rooms/duplicate-check",
      headers,
      payload: { title: "校园生活", description: "校园资料" },
    });
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/context-rooms",
      headers,
      payload: { title: "校园生活", description: "校园资料" },
    });
    const reviewBody = review.json<{ overrideToken: string; candidates: unknown[] }>();
    const created = await app.inject({
      method: "POST",
      url: "/v1/context-rooms",
      headers,
      payload: { title: "校园生活", description: "校园资料", duplicateOverrideToken: reviewBody.overrideToken },
    });
    const createdRoomId = created.json<{ room: { id: string } }>().room.id;
    const preview = await app.inject({
      method: "POST",
      url: "/v1/context-rooms/merge-preview",
      headers,
      payload: { sourceRoomId: createdRoomId, targetRoomId: "room-existing" },
    });
    const previewHash = preview.json<{ previewHash: string }>().previewHash;
    const started = await app.inject({
      method: "POST",
      url: "/v1/context-rooms/merge-operations",
      headers,
      payload: {
        sourceRoomId: createdRoomId,
        targetRoomId: "room-existing",
        previewHash,
        idempotencyKey: "server-merge-test",
      },
    });
    const operationId = started.json<{ id: string }>().id;
    let operation: { status: string; commitReached: boolean } = { status: "queued", commitReached: false };
    for (let attempt = 0; attempt < 100 && operation.status !== "completed"; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      operation = (await app.inject({
        method: "GET",
        url: `/v1/context-rooms/merge-operations/${operationId}`,
        headers,
      })).json<typeof operation>();
    }
    const snapshot = (await app.inject({ method: "GET", url: "/v1/context-rooms", headers })).json<{
      rooms: Array<{ id: string }>;
    }>();
    await app.close();

    expect(review.statusCode).toBe(200);
    expect(reviewBody.candidates).toHaveLength(1);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "duplicate_review_required" });
    expect(created.statusCode).toBe(200);
    expect(preview.statusCode).toBe(200);
    expect(started.statusCode).toBe(200);
    expect(operation).toMatchObject({ status: "completed", commitReached: true });
    expect(snapshot.rooms.map((room) => room.id)).toEqual(["room-existing"]);
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
      url: "/v1/documents?roomId=room-delete",
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
      url: "/v1/documents?roomId=room-delete",
      headers,
    });
    const listedTrash = await app.inject({
      method: "GET",
      url: "/v1/documents?roomId=room-delete&trashed=true",
      headers,
    });
    const restored = await app.inject({
      method: "POST",
      url: "/v1/documents/document-to-delete/restore",
      headers,
    });
    const listedAfterRestore = await app.inject({
      method: "GET",
      url: "/v1/documents?roomId=room-delete",
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
      url: "/v1/documents/trash?roomId=room-delete",
      headers,
    });
    const trashAfterEmpty = await app.inject({
      method: "GET",
      url: "/v1/documents?roomId=room-delete&trashed=true",
      headers,
    });
    await app.close();

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({ id: "document-to-delete", roomId: "room-delete", version: 1 });
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
    await app.inject({
      method: "PUT",
      url: "/v1/context-rooms/snapshot",
      headers,
      payload: {
        rooms: [{ id: "room-test", title: "MCP Room", data: {} }],
        deletedRooms: [],
      },
    });
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
        context: { selectedRoomId: "room-test" },
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
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "context_room_list",
      "context_room_create",
      "context_room_document_list",
      "context_room_document_read",
      "context_room_patch_begin",
      "context_room_patch_hunk",
      "context_room_patch_commit",
      "context_room_patch_abort",
      "context_room_write_begin",
      "context_room_write_append",
      "context_room_write_commit",
      "context_room_write_abort",
    ]);
  });

  it("is compatible with the official Streamable HTTP MCP client", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const headers = { authorization: `Bearer ${config.authToken}` };
    await app.inject({
      method: "PUT",
      url: "/v1/context-rooms/snapshot",
      headers,
      payload: {
        rooms: [{ id: "room-client-test", title: "Client Room", data: {} }],
        deletedRooms: [],
      },
    });
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
        context: { selectedRoomId: "room-client-test" },
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
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "context_room_list",
        "context_room_create",
        "context_room_document_list",
        "context_room_document_read",
        "context_room_patch_begin",
        "context_room_patch_hunk",
        "context_room_patch_commit",
        "context_room_patch_abort",
        "context_room_write_begin",
        "context_room_write_append",
        "context_room_write_commit",
        "context_room_write_abort",
      ]);
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
        knowledge: {
          embedding: {
            provider: "openai-compatible",
            model: "text-embedding-test",
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "embed-key",
          },
        },
        vlm: {
          provider: "openai-compatible",
          model: "vlm-test-model",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "vlm-key",
        },
        asr: {
          provider: "aliyun",
          model: "asr-test-model",
          baseUrl: "https://dashscope.aliyuncs.com/api/v1",
          apiKey: "asr-key",
          oss: {
            region: "oss-cn-beijing",
            bucket: "test-bucket",
            accessKeyId: "ak",
            accessKeySecret: "sk",
          },
        },
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ primaryConfigured: true, selectedSource: "user" });

    // embedding apiKey 落库后在快照中脱敏（********），provider/model 不脱敏。
    const snapshot = await app.inject({ method: "GET", url: "/v1/runtime-config", headers });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({
      config: {
        knowledge: {
          embedding: {
            model: "text-embedding-test",
            apiKey: "********",
          },
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
        knowledge: { embedding: { apiKey: "embed-key" } },
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

    // 端点恢复 2xx → valid=true（primary/vlm 走 /chat/completions，embedding
    // 走 /embeddings 并返回向量维度）。
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/embeddings")) {
        return new Response(
          JSON.stringify({ data: [{ embedding: Array.from({ length: 8 }, () => 0.1) }] }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }));
    const ok = await app.inject({ method: "POST", url: "/v1/runtime-config/test", headers, payload: {} });
    vi.unstubAllGlobals();
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      valid: true,
      embedding: { valid: true, dimensions: 8 },
      vlm: { valid: true },
    });

    await app.inject({ method: "DELETE", url: "/v1/runtime-config/user", headers });
    // 清空 user source 后 embedding 未配置 → /test 不带 embedding 字段。
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const cleared = await app.inject({ method: "POST", url: "/v1/runtime-config/test", headers, payload: {} });
    vi.unstubAllGlobals();
    const clearedBody = cleared.json<{ valid: boolean; embedding?: unknown }>();
    expect(clearedBody.valid).toBe(false);
    expect(clearedBody.embedding).toBeUndefined();
    await app.close();
  });
});
