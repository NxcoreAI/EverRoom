import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

/**
 * 外部 Agent 访问（PRD 第 7 章）的 HTTP 层测试：真引导整服务器（含 0081 迁移），
 * 用 app.inject 实打 /v1/agent-access/* REST 与 /v1/mcp/agents MCP 端点——
 * 覆盖鉴权豁免、TypeBox 校验、自检/示例查询编排与安装代写出口。
 */

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-access-routes-"));
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
    litePi: null,
    knowledge: null,
    ingestFilter: { enabled: false, mode: "observe", confidenceThreshold: 0.7, batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [], toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048, insightEnabled: false, insightIntervalMs: 3_600_000 },
    backgroundPi: null,
    transcriptionSummaryPi: null,
    asrInputDir: join(dataDir, "recordings"),
    webSearch: null,
    mcpConfigPath: join(dataDir, 'agent', 'mcp.json'),
    asr: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FULL_CAPS = [
  "read_metadata", "search", "read_documents", "read_conversations", "read_files",
  "read_rules", "write_session", "write_candidates", "register_files",
];
const READ_ONLY_CAPS = FULL_CAPS.filter((cap) => cap.startsWith("read") || cap === "search");

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function createConnection(
  app: Awaited<ReturnType<typeof createServer>>,
  gatewayToken: string,
  scopes: { capabilities: string[] },
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/agent-access/connections",
    headers: { ...authHeaders(gatewayToken), "content-type": "application/json" },
    payload: {
      name: "HTTP 测试连接",
      tool: "claude-code",
      scopes: { roomIds: "all", capabilities: scopes.capabilities, writebackRoomId: null },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { connection: { id: string; status: string }; token: string };
}

async function mcp(
  app: Awaited<ReturnType<typeof createServer>>,
  connectionToken: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/mcp/agents",
    headers: { ...authHeaders(connectionToken), "content-type": "application/json" },
    payload: { jsonrpc: "2.0", id: Math.floor(Math.random() * 1_000_000), method, params },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("agent-access REST（全局 bearer）", () => {
  it("未带/错带全局 token 一律 401；合法创建返回 token 一次", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const payload = {
      name: "x",
      tool: "claude-code",
      scopes: { roomIds: "all", capabilities: FULL_CAPS, writebackRoomId: null },
    };

    const anonymous = await app.inject({
      method: "POST", url: "/v1/agent-access/connections",
      headers: { "content-type": "application/json" }, payload,
    });
    expect(anonymous.statusCode).toBe(401);

    const wrongToken = await app.inject({
      method: "POST", url: "/v1/agent-access/connections",
      headers: { ...authHeaders("not-the-gateway-token"), "content-type": "application/json" }, payload,
    });
    expect(wrongToken.statusCode).toBe(401);

    const created = await createConnection(app, config.authToken, { capabilities: FULL_CAPS });
    expect(created.token).toMatch(/^evr_/);
    expect(created.connection.status).toBe("active");

    const listed = await app.inject({
      method: "GET", url: "/v1/agent-access/connections", headers: authHeaders(config.authToken),
    });
    const body = listed.json() as { connections: Array<{ id: string; tokenPrefix: string }> };
    expect(listed.statusCode).toBe(200);
    expect(body.connections).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(created.token);
  });

  it("能力校验、暂停/恢复、轮换与吊销", async () => {
    const config = await testConfig();
    const app = await createServer(config);

    const badCaps = await app.inject({
      method: "POST", url: "/v1/agent-access/connections",
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { name: "x", tool: "claude-code", scopes: { roomIds: "all", capabilities: ["nonsense"], writebackRoomId: null } },
    });
    expect(badCaps.statusCode).toBe(400);

    const badTool = await app.inject({
      method: "POST", url: "/v1/agent-access/connections",
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { name: "x", tool: "warp", scopes: { roomIds: "all", capabilities: FULL_CAPS, writebackRoomId: null } },
    });
    expect(badTool.statusCode).toBe(400);

    const created = await createConnection(app, config.authToken, { capabilities: FULL_CAPS });
    const id = created.connection.id;

    const paused = await app.inject({
      method: "PATCH", url: `/v1/agent-access/connections/${id}`,
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { status: "paused" },
    });
    expect((paused.json() as { connection: { status: string } }).connection.status).toBe("paused");

    const rotated = await app.inject({
      method: "POST", url: `/v1/agent-access/connections/${id}/token`, headers: authHeaders(config.authToken),
    });
    const rotatedToken = (rotated.json() as { token: string }).token;
    expect(rotatedToken).toMatch(/^evr_/);
    expect(rotatedToken).not.toBe(created.token);

    const revoked = await app.inject({
      method: "DELETE", url: `/v1/agent-access/connections/${id}`, headers: authHeaders(config.authToken),
    });
    expect((revoked.json() as { connection: { status: string } }).connection.status).toBe("revoked");
  });

  it("自检与示例查询可用（空库下各步返回合法状态）", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const created = await createConnection(app, config.authToken, { capabilities: FULL_CAPS });

    const selftest = await app.inject({
      method: "POST",
      url: `/v1/agent-access/connections/${created.connection.id}/selftest`,
      headers: authHeaders(config.authToken),
    });
    expect(selftest.statusCode).toBe(200);
    const steps = (selftest.json() as { steps: Record<string, { status: string }> }).steps;
    expect(steps.list!.status).toBe("empty");
    expect(steps.search!.status).toBe("empty");
    expect(steps.fetch!.status).toBe("empty");
    expect(["ok", "duplicate"]).toContain(steps.submit!.status);

    const example = await app.inject({
      method: "POST",
      url: `/v1/agent-access/connections/${created.connection.id}/example-query`,
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { query: "上线" },
    });
    expect(example.statusCode).toBe(200);
    expect((example.json() as { result: { status: string } }).result.status).toBe("empty");
  });

  it("安装代写：token 匹配校验 + 计划含 MCP 地址与技能文件", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const created = await createConnection(app, config.authToken, { capabilities: FULL_CAPS });
    const url = `/v1/agent-access/connections/${created.connection.id}/install/claude-code`;

    const mismatch = await app.inject({
      method: "POST", url,
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { token: "evr_wrong-token" },
    });
    expect(mismatch.statusCode).toBe(403);

    const install = await app.inject({
      method: "POST", url,
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { token: created.token },
    });
    expect(install.statusCode).toBe(200);
    const plan = (install.json() as { install: { url: string; skillFiles: Array<{ path: string }>; mcpConfig: string } }).install;
    expect(plan.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1\/mcp\/agents$/);
    expect(plan.skillFiles.map((file) => file.path)).toContain("SKILL.md");
    expect(plan.mcpConfig).toContain(`"Authorization": "Bearer ${created.token}"`);
  });
});

describe("agent-access MCP 端点（连接 token 自鉴权）", () => {
  it("initialize → tools/list → get_status 全链路；能力过滤生效", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const readOnly = await createConnection(app, config.authToken, { capabilities: READ_ONLY_CAPS });

    const anonymous = await mcp(app, "evr-not-a-connection-token", "tools/list");
    expect(anonymous.statusCode).toBe(401);

    const init = await mcp(app, readOnly.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "claude-code", version: "1" },
    });
    expect(init.statusCode).toBe(200);
    expect(init.body.result).toMatchObject({ serverInfo: { name: "everroom-agent-access" } });

    const listed = await mcp(app, readOnly.token, "tools/list");
    const names = (listed.body.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    expect(names).toContain("everroom_search");
    expect(names).not.toContain("everroom_submit");

    const status = await mcp(app, readOnly.token, "tools/call", {
      name: "everroom_get_status",
      arguments: {},
    });
    const structured = (status.body.result as { structuredContent: { status: string; data: { connection: { name: string } } } }).structuredContent;
    expect(structured.status).toBe("ok");
    expect(structured.data.connection.name).toBe("HTTP 测试连接");
  });

  it("暂停的连接立刻失去 MCP 访问", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const created = await createConnection(app, config.authToken, { capabilities: FULL_CAPS });
    const id = created.connection.id;

    const before = await mcp(app, created.token, "tools/list");
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: "PATCH", url: `/v1/agent-access/connections/${id}`,
      headers: { ...authHeaders(config.authToken), "content-type": "application/json" },
      payload: { status: "paused" },
    });

    const after = await mcp(app, created.token, "tools/list");
    expect(after.statusCode).toBe(401);
    expect((after.body.error as { code: number }).code).toBe(-32001);
  });
});
