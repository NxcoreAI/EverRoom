import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionSnapshot } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-mounted-dirs-"));
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
    mcpConfigPath: join(dataDir, "agent", "mcp.json"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForAssistantMessage(
  read: () => Promise<AgentSessionSnapshot>,
): Promise<AgentSessionSnapshot> {
  // Fake runtime 按字符流式回显运行提示，提示越长耗时越久：留足 20s 余量。
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = await read();
    if (snapshot.activeRun === null && snapshot.messages.length >= 2) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for agent message");
}

describe("agent run 的挂载目录上下文", () => {
  it("把 mountedDirectories 渲染进运行提示（去重后最多 8 条）", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Agent" },
    })).json<AgentSession>();

    const run = (await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "看看挂载目录里有什么",
        idempotencyKey: crypto.randomUUID(),
        context: {
          mountedDirectories: [
            { path: "/Users/x/docs", name: "docs" },
            // 空路径被丢弃、重复 path 只留一条。
            { path: "  ", name: "空" },
            { path: "/Users/x/docs", name: "docs-again" },
            { path: "/Users/x/project", name: "project" },
          ],
        },
      },
    })).json<{ status: string }>();
    expect(run.status).toMatch(/accepted|running/);

    const readSnapshot = async () => (await app.inject({
      method: "GET",
      url: `/v1/agent/sessions/${session.id}`,
      headers,
    })).json<AgentSessionSnapshot>();
    const snapshot = await waitForAssistantMessage(readSnapshot);
    const assistant = snapshot.messages.find((message) => message.role === "assistant");
    // Fake runtime 会把收到的运行提示原文回显，用回显验证提示渲染。
    expect(assistant?.content).toContain("<mounted_directories>");
    expect(assistant?.content).toContain('[{"name":"docs","path":"/Users/x/docs"},{"name":"project","path":"/Users/x/project"}]');
    expect(assistant?.content).toContain("直接用 read / ls / grep");
    await app.close();
  });

  it("没有挂载目录时提示里不出现挂载段", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Agent" },
    })).json<AgentSession>();

    await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "普通提问",
        idempotencyKey: crypto.randomUUID(),
      },
    });

    const readSnapshot = async () => (await app.inject({
      method: "GET",
      url: `/v1/agent/sessions/${session.id}`,
      headers,
    })).json<AgentSessionSnapshot>();
    const snapshot = await waitForAssistantMessage(readSnapshot);
    const assistant = snapshot.messages.find((message) => message.role === "assistant");
    expect(assistant?.content).not.toContain("<mounted_directories>");
    await app.close();
  });

  it("mountedDirectories 超过 8 条被 schema 拒绝", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Agent" },
    })).json<AgentSession>();

    const response = await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "挂载太多了",
        idempotencyKey: crypto.randomUUID(),
        context: {
          mountedDirectories: Array.from({ length: 9 }, (_, index) => ({
            path: `/Users/x/dir-${index}`,
            name: `dir-${index}`,
          })),
        },
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
