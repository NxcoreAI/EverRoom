import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun, AgentSession, TrustedMcpSession } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

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
    knowledge: null,
    backgroundPi: null,
    asrInputDir: join(dataDir, "recordings"),
    asr: null,
  };
}

afterEach(async () => {
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
      payload: { prompt: "列出当前文档", idempotencyKey: "mcp-http-run" },
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
      payload: { prompt: "列出当前文档", idempotencyKey: "mcp-client-run" },
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
});
