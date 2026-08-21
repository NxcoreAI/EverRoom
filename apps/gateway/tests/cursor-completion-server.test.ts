import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentRun, AgentSession } from "@nxcore/agent-contract";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../src/config.js";
import { createCursorCompletionServer } from "../src/server/create-cursor-completion-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-cursor-completion-test-"));
  temporaryDirectories.push(dataDir);
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    databasePath: join(dataDir, "database", "gateway.sqlite"),
    migrationsDir: resolve("drizzle"),
    runtimeManifestPath: join(dataDir, "runtime", "gateway.json"),
    logLevel: "silent",
    authToken: "cursor-completion-test-token",
    agentRuntime: "fake",
    memory: null,
    pi: null,
    cursorCompletionPi: null,
    backgroundPi: null,
    knowledge: null,
    ingestFilter: { enabled: false, mode: "observe", confidenceThreshold: 0.7, batchSize: 5, batchDelayMs: 0, exemptSourceKinds: [], toolsEnabled: false, maxToolCalls: 8, rulesFile: "", rulesMaxBytes: 2048, insightEnabled: false, insightIntervalMs: 3_600_000 },
    asrInputDir: join(dataDir, "recordings"),
    webSearch: null,
    mcpConfigPath: join(dataDir, 'agent', 'mcp.json'),
    asr: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

describe("cursor completion process server", () => {
  it("serves isolated Agent runs without exposing document operations", async () => {
    const config = await testConfig();
    const app = await createCursorCompletionServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const sessionResponse = await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "AI 补全 · 测试文档", roomId: "room-1" },
    });
    expect(sessionResponse.statusCode).toBe(201);
    const session = sessionResponse.json<AgentSession>();

    const runResponse = await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: {
        prompt: "KEEP\n补全文本",
        idempotencyKey: "cursor-completion-run-1",
        captureMemory: false,
        recallMemory: false,
        toolsEnabled: false,
      },
    });
    expect(runResponse.statusCode).toBe(202);
    const run = runResponse.json<AgentRun>();

    let events: AgentEvent[] = [];
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      events = (await app.inject({
        method: "GET",
        url: `/v1/agent/sessions/${session.id}/events?runId=${run.id}&afterSeq=0`,
        headers,
      })).json<AgentEvent[]>();
      if (events.some((event) => event.type === "run.completed")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events.some((event) => event.type === "run.completed")).toBe(true);

    const documentRoute = await app.inject({
      method: "GET",
      url: "/v1/documents/document-1",
      headers,
    });
    expect(documentRoute.statusCode).toBe(404);
    await app.close();
  });
});
