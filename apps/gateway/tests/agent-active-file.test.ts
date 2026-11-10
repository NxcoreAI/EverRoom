import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-active-file-"));
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

describe("agent run 的 Office 页签上下文", () => {
  it("接受 activeFile + openFiles 并在一轮里正常启动", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Office" },
    })).json<AgentSession>();

    const response = await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "工作区都开着哪些文件？这份文档讲了什么？",
        idempotencyKey: crypto.randomUUID(),
        context: {
          pageLabel: "Office",
          activeFile: {
            fileId: "file-contract",
            title: "软件开发合同.docx",
            kind: "docx",
            editable: true,
          },
          openFiles: [
            { fileId: "file-contract", title: "软件开发合同.docx", kind: "docx", editable: true, active: true },
            { fileId: "file-budget", title: "预算.xlsx", kind: "spreadsheet", active: false },
          ],
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ status: string }>().status).toMatch(/accepted|running/);
    await app.close();
  });

  it("openFiles 超过 20 条被 schema 拒绝", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "Office" },
    })).json<AgentSession>();

    const response = await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "有哪些文件",
        idempotencyKey: crypto.randomUUID(),
        context: {
          openFiles: Array.from({ length: 21 }, (_, index) => ({
            fileId: `file-${index}`,
            title: `文件${index}.docx`,
            kind: "docx",
            active: index === 0,
          })),
        },
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
