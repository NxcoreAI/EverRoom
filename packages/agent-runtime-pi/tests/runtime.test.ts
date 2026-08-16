import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "@nxcore/agent-runtime";
import { PiAgentRuntime } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PiAgentRuntime", () => {
  it("advertises only the currently integrated capabilities without initializing the SDK", async () => {
    const runtime = new PiAgentRuntime({
      provider: "test",
      model: "test-model",
      baseUrl: "https://example.com/v1",
      apiKey: "not-used",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: "/tmp/nxcore-pi-test/sessions",
      workingDirectory: "/tmp/nxcore-pi-test/workspace",
      agentDirectory: "/tmp/nxcore-pi-test/config",
    });

    await expect(runtime.getCapabilities()).resolves.toEqual({
      streaming: true,
      reasoning: false,
      tools: false,
      steering: true,
      resume: false,
    });
    await runtime.dispose();
  });

  it("streams an OpenAI-compatible response through NxCore events", async () => {
    const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const endpoint = createServer((request, response) => {
      requests.push({ url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (content: string, finishReason: string | null = null) => JSON.stringify({
        id: "chatcmpl-nxcore-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "nxcore-test-model",
        choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
      });
      response.write(`data: ${chunk("你好")}\n\n`);
      response.write(`data: ${chunk("，Pi!")}\n\n`);
      response.write(`data: ${chunk("", "stop")}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-runtime-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    });

    try {
      const run = await runtime.start({
        runId: "run-1",
        sessionId: "session-1",
        runtimeSessionRef: null,
        prompt: "打个招呼",
        pageLabel: "测试工作区",
        roomId: null,
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(events.map((event) => event.type)).toEqual([
        "run.started",
        "message.started",
        "message.delta",
        "message.delta",
        "message.completed",
        "run.completed",
      ]);
      expect(events.find((event) => event.type === "message.completed")?.payload).toEqual({
        role: "assistant",
        content: "你好，Pi!",
      });
      expect(run.runtimeSessionRef).toContain(dataDir);
      expect(requests).toEqual([{ url: "/v1/chat/completions", authorization: "Bearer nxcore-test-key" }]);
      await expect(access(run.runtimeSessionRef)).resolves.toBeUndefined();
      await runtime.deleteSession(run.runtimeSessionRef);
      await expect(access(run.runtimeSessionRef)).rejects.toThrow();
      await expect(runtime.deleteSession(join(dataDir, "outside.jsonl"))).rejects.toThrow(
        "outside the NxCore session directory",
      );
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("executes custom tools with the latest run context on a persistent Pi session", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    let requestIndex = 0;
    const endpoint = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk.toString(); });
      request.on("end", () => {
        requestBodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => JSON.stringify({
          id: `chatcmpl-tool-${String(requestIndex)}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        if (requestIndex % 2 === 0) {
          response.write(`data: ${chunk({
            tool_calls: [{
              index: 0,
              id: `call-${String(requestIndex)}`,
              type: "function",
              function: {
                name: "context_room_write_begin",
                arguments: '{"mode":"create","title":"测试文档","format":"markdown"}',
              },
            }],
          })}\n\n`);
          response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
        } else {
          response.write(`data: ${chunk({ content: "文档已创建" })}\n\n`);
          response.write(`data: ${chunk({}, "stop")}\n\n`);
        }
        requestIndex += 1;
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-tool-test-"));
    temporaryDirectories.push(dataDir);
    const toolContexts: Array<{ sessionId: string; runId: string; roomId: string | null }> = [];
    const finished: Array<{ runId: string; outcome: string }> = [];
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    }, {
      tools: [{
        name: "context_room_write_begin",
        label: "开始创建 Room 文档",
        description: "创建当前 Room 的文档",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["create"] },
            title: { type: "string" },
            format: { type: "string", enum: ["markdown"] },
          },
          required: ["mode", "title", "format"],
        },
        executionMode: "sequential",
        execute: async (input) => {
          toolContexts.push({ sessionId: input.sessionId, runId: input.runId, roomId: input.roomId });
          return { content: JSON.stringify({ roomId: input.roomId, state: "open" }) };
        },
      }],
      onRunFinished: async (input, outcome) => {
        finished.push({ runId: input.runId, outcome });
      },
    });

    try {
      await expect(runtime.getCapabilities()).resolves.toMatchObject({ tools: true });
      const first = await runtime.start({
        runId: "run-room-a",
        sessionId: "agent-session",
        runtimeSessionRef: null,
        prompt: "创建文档",
        pageLabel: "Room A",
        roomId: "room-a",
      });
      const firstEvents: RuntimeEvent[] = [];
      for await (const event of first.events) firstEvents.push(event);

      const second = await runtime.start({
        runId: "run-room-b",
        sessionId: "agent-session",
        runtimeSessionRef: first.runtimeSessionRef,
        prompt: "再创建一份文档",
        pageLabel: "Room B",
        roomId: "room-b",
      });
      const secondEvents: RuntimeEvent[] = [];
      for await (const event of second.events) secondEvents.push(event);

      expect(toolContexts).toEqual([
        { sessionId: "agent-session", runId: "run-room-a", roomId: "room-a" },
        { sessionId: "agent-session", runId: "run-room-b", roomId: "room-b" },
      ]);
      expect(finished).toEqual([
        { runId: "run-room-a", outcome: "completed" },
        { runId: "run-room-b", outcome: "completed" },
      ]);
      expect(firstEvents.map((event) => event.type)).toContain("tool.started");
      expect(firstEvents.map((event) => event.type)).toContain("tool.completed");
      expect(secondEvents.map((event) => event.type)).toContain("tool.completed");
      expect(requestBodies).toHaveLength(4);
      expect(JSON.stringify(requestBodies[0]?.tools)).toContain("context_room_write_begin");
      const firstRequest = JSON.stringify(requestBodies[0]);
      expect(firstRequest).toContain("必须使用简体中文");
      expect(firstRequest).toContain("准备写入正文的实际核心内容、重点或结论");
      expect(firstRequest).toContain("标题要随内容类型调整");
      expect(firstRequest).toContain("随后写出的正文必须与标题一致");
      expect(firstRequest).toContain("充实、完整的长篇内容");
      expect(firstRequest).toContain("局部选区重写、普通问答或聊天不得擅自创建新文档");
      expect(requestBodies[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: '{"roomId":"room-a","state":"open"}' }),
      ]));
      expect(requestBodies[3]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: '{"roomId":"room-b","state":"open"}' }),
      ]));

      await expect(runtime.start({
        runId: "run-wrong-owner",
        sessionId: "different-agent-session",
        runtimeSessionRef: first.runtimeSessionRef,
        prompt: "不应执行",
        pageLabel: "Room C",
        roomId: "room-c",
      })).rejects.toThrow("different Agent session");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("awaits run cleanup when the model request fails", async () => {
    const endpoint = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "model unavailable" } }));
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-failed-cleanup-test-"));
    temporaryDirectories.push(dataDir);
    const cleanup: string[] = [];
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
      retry: { enabled: false },
    }, {
      onRunFinished: async (input, outcome) => {
        await Promise.resolve();
        cleanup.push(`${input.runId}:${outcome}`);
      },
    });

    try {
      const run = await runtime.start({
        runId: "run-model-failed",
        sessionId: "agent-session",
        runtimeSessionRef: null,
        prompt: "测试失败清理",
        pageLabel: "Room A",
        roomId: "room-a",
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);
      expect(events.at(-1)?.type).toBe("run.failed");
      expect(cleanup).toEqual(["run-model-failed:failed"]);
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("aborts an active request and waits for cancelled cleanup", async () => {
    let requestStartedResolve: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolvePromise) => { requestStartedResolve = resolvePromise; });
    const endpoint = createServer((_request, response) => {
      requestStartedResolve?.();
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-cancel-cleanup-test-"));
    temporaryDirectories.push(dataDir);
    const cleanup: string[] = [];
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 1024,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    }, {
      onRunFinished: async (input, outcome) => {
        cleanup.push(`${input.runId}:${outcome}`);
      },
    });

    try {
      const run = await runtime.start({
        runId: "run-cancelled",
        sessionId: "agent-session",
        runtimeSessionRef: null,
        prompt: "测试取消清理",
        pageLabel: "Room A",
        roomId: "room-a",
      });
      await requestStarted;
      await runtime.cancel(run.runId);
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);
      expect(events.at(-1)?.type).toBe("run.cancelled");
      expect(cleanup).toEqual(["run-cancelled:cancelled"]);
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });
});
