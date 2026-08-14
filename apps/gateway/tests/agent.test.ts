import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AgentEvent, AgentRun, AgentSession, AgentSessionSnapshot } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createServer } from "../src/server/create-server.js";

const temporaryDirectories: string[] = [];

async function testConfig(): Promise<GatewayConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-agent-test-"));
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
    asrInputDir: join(dataDir, "recordings"),
    asr: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(
  read: () => Promise<AgentSessionSnapshot>,
  predicate: (snapshot: AgentSessionSnapshot) => boolean,
): Promise<AgentSessionSnapshot> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const snapshot = await read();
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for agent state");
}

describe("agent gateway", () => {
  it("lists, renames, and deletes sessions while protecting active runs", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const first = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "首页" },
    })).json<AgentSession>();
    const second = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "首页" },
    })).json<AgentSession>();
    await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "文档" },
    });

    const renamed = await app.inject({
      method: "PATCH",
      url: `/v1/agent/sessions/${first.id}`,
      headers,
      payload: { title: "  项目讨论  " },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<AgentSession>().title).toBe("项目讨论");

    const listed = (await app.inject({
      method: "GET",
      url: "/v1/agent/sessions?pageLabel=%E9%A6%96%E9%A1%B5",
      headers,
    })).json<AgentSession[]>();
    expect(listed.map((session) => session.id)).toEqual([first.id, second.id]);

    const activeRun = (await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${first.id}/runs`,
      headers,
      payload: { prompt: "不能在运行时删除", idempotencyKey: "delete-protection-key" },
    })).json<AgentRun>();
    const blocked = await app.inject({
      method: "DELETE",
      url: `/v1/agent/sessions/${first.id}`,
      headers,
    });
    expect(blocked.statusCode).toBe(409);

    await waitFor(
      async () => (await app.inject({
        method: "GET",
        url: `/v1/agent/sessions/${first.id}`,
        headers,
      })).json<AgentSessionSnapshot>(),
      (snapshot) => snapshot.activeRun === null,
    );
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/agent/sessions/${first.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({
      method: "GET",
      url: `/v1/agent/sessions/${first.id}`,
      headers,
    })).statusCode).toBe(404);
    expect((await app.inject({
      method: "GET",
      url: `/v1/agent/runs/${activeRun.id}`,
      headers,
    })).statusCode).toBe(404);
    await app.close();
  });

  it("streams authenticated agent events over WebSocket", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "首页" },
    })).json<AgentSession>();
    const streamUrl = `${address.replace(/^http/, "ws")}/v1/agent/sessions/${session.id}/stream`;
    const socket = new WebSocket(streamUrl, { headers: { Authorization: `Bearer ${config.authToken}` } });
    const frames: Array<{ type: string; event?: AgentEvent }> = [];
    const completed = new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket events")), 4_000);
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { type: string; event?: AgentEvent };
        frames.push(frame);
        if (frame.event?.type === "run.completed") {
          clearTimeout(timeout);
          resolvePromise();
        }
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", resolvePromise);
      socket.once("error", reject);
    });
    const started = await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: { prompt: "验证流式事件", idempotencyKey: "websocket-request-key" },
    });
    expect(started.statusCode).toBe(202);
    await completed;

    expect(frames.at(0)?.type).toBe("ready");
    expect(frames.some((frame) => frame.event?.type === "message.delta")).toBe(true);
    expect(frames.at(-1)?.event?.type).toBe("run.completed");
    socket.close();
    await app.close();
  });

  it("persists a streamed run and deduplicates its idempotency key", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };

    const created = await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "首页" },
    });
    const session = created.json<AgentSession>();
    const runRequest = {
      method: "POST" as const,
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: { prompt: "总结当前页面", idempotencyKey: "same-request-key" },
    };
    const started = await app.inject(runRequest);
    const duplicated = await app.inject(runRequest);
    const run = started.json<AgentRun>();

    expect(created.statusCode).toBe(201);
    expect(started.statusCode).toBe(202);
    expect(duplicated.json<AgentRun>().id).toBe(run.id);

    const readSnapshot = async () => (await app.inject({
      method: "GET",
      url: `/v1/agent/sessions/${session.id}`,
      headers,
    })).json<AgentSessionSnapshot>();
    const completed = await waitFor(readSnapshot, (snapshot) => snapshot.activeRun === null && snapshot.messages.length === 2);
    const eventResponse = await app.inject({
      method: "GET",
      url: `/v1/agent/sessions/${session.id}/events?runId=${run.id}&afterSeq=0`,
      headers,
    });
    const events = eventResponse.json<AgentEvent[]>();

    expect(completed.session.status).toBe("idle");
    expect(completed.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(events.at(0)?.type).toBe("run.accepted");
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    await app.close();
  });

  it("moves a cancelled run to a terminal state", async () => {
    const config = await testConfig();
    const app = await createServer(config);
    const headers = { authorization: `Bearer ${config.authToken}` };
    const session = (await app.inject({
      method: "POST",
      url: "/v1/agent/sessions",
      headers,
      payload: { pageLabel: "文档" },
    })).json<AgentSession>();
    const run = (await app.inject({
      method: "POST",
      url: `/v1/agent/sessions/${session.id}/runs`,
      headers,
      payload: { prompt: "生成一份长文档", idempotencyKey: "cancel-request-key" },
    })).json<AgentRun>();

    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/agent/runs/${run.id}/cancel`,
      headers,
    });
    expect(cancelled.statusCode).toBe(200);

    const terminal = await waitFor(
      async () => (await app.inject({
        method: "GET",
        url: `/v1/agent/sessions/${session.id}`,
        headers,
      })).json<AgentSessionSnapshot>(),
      (snapshot) => snapshot.activeRun === null,
    );
    const finalRun = (await app.inject({
      method: "GET",
      url: `/v1/agent/runs/${run.id}`,
      headers,
    })).json<AgentRun>();

    expect(terminal.session.status).toBe("idle");
    expect(finalRun.status).toBe("cancelled");
    await app.close();
  });
});
