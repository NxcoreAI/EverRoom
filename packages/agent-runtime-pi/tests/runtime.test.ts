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
      tools: true,
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
      }, {
        name: "connector_search",
        label: "Search connectors",
        description: "Search connected service actions",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: "[]" }),
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
      expect(JSON.stringify(requestBodies[0]?.tools)).toContain('"name":"bash"');
      expect(JSON.stringify(requestBodies[0]?.tools)).not.toContain("v2_desktop_user_pc_bash");
      const firstRequest = JSON.stringify(requestBodies[0]);
      expect(firstRequest).toContain("必须使用简体中文");
      expect(firstRequest).toContain("准备写入正文的实际核心内容、重点或结论");
      expect(firstRequest).toContain("标题要随内容类型调整");
      expect(firstRequest).toContain("随后写出的正文必须与标题一致");
      expect(firstRequest).toContain("充实、完整的长篇内容");
      expect(firstRequest).toContain("标题层级应服务于内容结构");
      expect(firstRequest).toContain("默认让同一层级的章节使用一致的标题级别");
      expect(firstRequest).toContain("如果用户明确要求一级标题");
      expect(firstRequest).toContain("明确表达了要在 EverRoom 工作区的 Context Room 中创建、保存或写入一篇文档");
      expect(firstRequest).toContain("解释、分析、总结、整理、列计划、写方案、起草内容、润色、扩写");
      expect(firstRequest).toContain("意图不明确时不要调用 context_room_list 或 context_room_write_begin");
      expect(firstRequest).toContain("只有当用户明确要求在 EverRoom 工作区的 Context Room 中创建、保存或写入文档");
      expect(firstRequest).toContain("必须立即调用 context_room_list");
      expect(firstRequest).toContain("不得询问用户是否需要查看列表");
      expect(firstRequest).toContain("普通页面的普通聊天不要主动提示 Room 选择");
      expect(firstRequest).toContain("也不要替用户猜测目标 Room");
      expect(firstRequest).toContain("调用 context_room_write_begin 之前必须先用 memory_search 和 conversation_search");
      expect(firstRequest).toContain("不得把 Notion workspace/page 解释成 EverRoom 工作区文档");
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

  it("forces one bounded recovery step after a recoverable tool failure", async () => {
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
          id: `chatcmpl-recovery-${String(requestIndex)}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        if (requestIndex === 0) {
          response.write(`data: ${chunk({
            tool_calls: [{
              index: 0,
              id: "call-failing",
              type: "function",
              function: { name: "connector_run", arguments: "{}" },
            }],
          })}\n\n`);
          response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
        } else if (requestIndex === 1) {
          response.write(`data: ${chunk({
            tool_calls: [{
              index: 0,
              id: "call-recovery",
              type: "function",
              function: { name: "connector_search", arguments: "{}" },
            }],
          })}\n\n`);
          response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
        } else {
          response.write(`data: ${chunk({ content: "已通过搜索恢复并完成请求" })}\n\n`);
          response.write(`data: ${chunk({}, "stop")}\n\n`);
        }
        requestIndex += 1;
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-recovery-test-"));
    temporaryDirectories.push(dataDir);
    const toolCalls: string[] = [];
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
      tools: [
        {
          name: "connector_run",
          label: "Run connector",
          description: "Run a connector action",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            toolCalls.push("connector_run");
            throw new Error("HTTP 404 action metadata not found");
          },
          classifyFailure: () => ({
            category: "action_not_found",
            recoverable: true,
            recommendedTool: "connector_search",
            instruction: "Search for the exact action and continue.",
            retryKey: "gmail.list_messages",
            maxAttempts: 1,
          }),
        },
        {
          name: "connector_search",
          label: "Search connectors",
          description: "Search connector actions",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: async () => {
            toolCalls.push("connector_search");
            return { content: JSON.stringify([{ service: "gmail", name: "fetch_emails" }]) };
          },
        },
      ],
    });

    try {
      const run = await runtime.start({
        runId: "run-recovery",
        sessionId: "session-recovery",
        runtimeSessionRef: null,
        prompt: "查看最近邮件",
        pageLabel: "首页",
        roomId: null,
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(toolCalls).toEqual(["connector_run", "connector_search"]);
      expect(events.find((event) => event.type === "tool.failed")?.payload).toMatchObject({
        name: "connector_run",
        failure: {
          category: "action_not_found",
          recoverable: true,
          recommendedTool: "connector_search",
          recoveryAttempt: 1,
          maxAttempts: 1,
        },
      });
      expect(events.map((event) => event.type)).toContain("tool.completed");
      expect(events.find((event) => event.type === "message.completed")?.payload).toEqual({
        role: "assistant",
        content: "已通过搜索恢复并完成请求",
      });
      expect(requestBodies).toHaveLength(3);
      expect(JSON.stringify(requestBodies[1]?.messages)).toContain("系统恢复指令");
      expect(JSON.stringify(requestBodies[1]?.messages)).toContain("connector_search");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("terminates a run before an identical failed tool call can execute twice", async () => {
    let requestIndex = 0;
    const endpoint = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => JSON.stringify({
          id: `chatcmpl-loop-guard-${String(requestIndex)}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        response.write(`data: ${chunk({
          tool_calls: [{
            index: 0,
            id: `call-loop-${String(requestIndex)}`,
            type: "function",
            function: {
              name: "connector_run",
              arguments: '{"service":"notion","name":"create_page","input":{"title":"父页面"}}',
            },
          }],
        })}\n\n`);
        response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
        requestIndex += 1;
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-loop-guard-test-"));
    temporaryDirectories.push(dataDir);
    let executions = 0;
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
        name: "connector_run",
        label: "Run connector",
        description: "Run a connector action",
        parameters: { type: "object", additionalProperties: true },
        execute: async () => {
          executions += 1;
          throw new Error("HTTP 400 invalid_input");
        },
        classifyFailure: () => ({
          category: "invalid_input",
          recoverable: true,
          recommendedTool: "connector_schema",
          instruction: "Inspect the schema once.",
          retryKey: "notion.create_page",
          maxAttempts: 1,
        }),
      }],
    });

    try {
      const run = await runtime.start({
        runId: "run-loop-guard",
        sessionId: "session-loop-guard",
        runtimeSessionRef: null,
        prompt: "创建页面",
        pageLabel: "首页",
        roomId: null,
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(executions).toBe(1);
      expect(requestIndex).toBe(2);
      expect(events.filter((event) => event.type === "tool.failed")).toHaveLength(2);
      expect(events.find((event) => event.type === "tool.failed"
        && (event.payload as { failure?: { category?: string } }).failure?.category === "tool_loop_blocked")?.payload).toMatchObject({
        failure: { recoverable: false },
      });
      expect(events.at(-1)?.type).toBe("run.failed");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("terminates a run after the total tool execution budget is exhausted", async () => {
    let requestIndex = 0;
    const endpoint = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => JSON.stringify({
          id: `chatcmpl-tool-budget-${String(requestIndex)}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        response.write(`data: ${chunk({
          tool_calls: [{
            index: 0,
            id: `call-budget-${String(requestIndex)}`,
            type: "function",
            function: { name: "lookup", arguments: JSON.stringify({ index: requestIndex }) },
          }],
        })}\n\n`);
        response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
        requestIndex += 1;
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-tool-budget-test-"));
    temporaryDirectories.push(dataDir);
    let executions = 0;
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
        name: "lookup",
        label: "Lookup",
        description: "Return one lookup result",
        parameters: { type: "object", additionalProperties: true },
        execute: async () => {
          executions += 1;
          return { content: '{"ok":true}' };
        },
      }],
    });

    try {
      const run = await runtime.start({
        runId: "run-tool-budget",
        sessionId: "session-tool-budget",
        runtimeSessionRef: null,
        prompt: "执行大量查询",
        pageLabel: "首页",
        roomId: null,
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(executions).toBe(24);
      expect(requestIndex).toBe(25);
      expect(events.find((event) => event.type === "tool.failed"
        && (event.payload as { failure?: { category?: string } }).failure?.category === "tool_budget_exhausted")).toBeDefined();
      expect(events.at(-1)?.type).toBe("run.failed");
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
