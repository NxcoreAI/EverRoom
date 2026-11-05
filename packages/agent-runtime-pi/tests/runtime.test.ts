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
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(events.map((event) => event.type)).toEqual([
        "run.started",
        "message.started",
        "message.delta",
        "message.delta",
        "context.usage",
        "message.completed",
        "run.completed",
      ]);
      expect(events.find((event) => event.type === "context.usage")?.payload).toEqual({
        tokens: expect.any(Number),
        contextWindow: 8192,
        percent: expect.any(Number),
        segments: expect.any(Array),
        runUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      expect(events.find((event) => event.type === "message.completed")?.payload).toEqual({
        role: "assistant",
        content: "你好，Pi!",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
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

  it("injects the user profile block into the system prompt", async () => {
    let requestBody: { messages?: Array<{ role: string; content: unknown }> } | null = null;
    const endpoint = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk.toString(); });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as typeof requestBody;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ id: "profile", object: "chat.completion.chunk", model: "nxcore-test-model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: "profile", object: "chat.completion.chunk", model: "nxcore-test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"));
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-profile-test-"));
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
        runId: "run-profile",
        sessionId: "session-profile",
        runtimeSessionRef: null,
        prompt: "帮我把这份周报改短",
        pageLabel: "测试",
        userProfilePrompt: "【用户画像】\n- 职业：前端负责人",
      });
      for await (const _event of run.events) { /* consume */ }

      // 回调里赋值会让 CFA 把 requestBody 收窄成 null，这里重新按声明类型取值
      const body = requestBody as { messages?: Array<{ role: string; content: unknown }> } | null;
      const system = (body?.messages ?? []).find((message) => message.role === "system");
      const systemText = typeof system?.content === "string"
        ? system.content
        : JSON.stringify(system?.content ?? null);
      expect(systemText).toContain("【用户画像】");
      expect(systemText).toContain("职业：前端负责人");
      // 画像只进 system prompt，不污染用户可见的 prompt
      const user = (body?.messages ?? []).find((message) => message.role === "user");
      expect(JSON.stringify(user?.content ?? null)).not.toContain("职业：前端负责人");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("adds document text and image blocks to a multimodal prompt", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const endpoint = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk.toString(); });
      request.on("end", () => {
        requestBody = JSON.parse(raw) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          `data: ${JSON.stringify({ id: "multimodal", object: "chat.completion.chunk", model: "nxcore-test-model", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: "multimodal", object: "chat.completion.chunk", model: "nxcore-test-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"));
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-multimodal-test-"));
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
        runId: "run-multimodal",
        sessionId: "session-multimodal",
        runtimeSessionRef: null,
        prompt: "识别附件",
        pageLabel: "测试",
        attachments: [
          { filename: "notes.md", mimeType: "text/plain", kind: "document", text: "附件正文" },
          { filename: "image.png", mimeType: "image/png", kind: "image", dataUrl: "data:image/png;base64,aGVsbG8=" },
        ],
      });
      for await (const _event of run.events) { /* consume */ }
      const serialized = JSON.stringify(requestBody);
      expect(serialized).toContain("附件正文");
      expect(serialized).toContain("aGVsbG8=");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("reports a token-limited response as incomplete", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const endpoint = createServer((_request, response) => {
      let raw = "";
      _request.on("data", (chunk) => { raw += chunk.toString(); });
      _request.on("end", () => {
        requestBodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (content: string, finishReason: string | null = null) => JSON.stringify({
          id: "chatcmpl-output-limit",
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
        });
        response.write(`data: ${chunk("正在整理检索结果。")}\n\n`);
        response.write(`data: ${chunk("", "length")}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-output-limit-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 32,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    });

    try {
      const run = await runtime.start({
        runId: "run-output-limit",
        sessionId: "session-output-limit",
        runtimeSessionRef: null,
        prompt: "整理检索结果",
        pageLabel: "首页",
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(events.map((event) => event.type)).toContain("message.delta");
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        payload: { message: expect.stringContaining("输出上限") },
      });
      expect(events.some((event) => event.type === "run.completed")).toBe(false);
      const request = JSON.stringify(requestBodies[0]);
      // Phase 2i 去 Room：run 无 Room 维度，提示词只保留工作区级文稿指引，
      // 不注入 Room 快照，也不引导模型传 roomId 或调用已删除的 context_room_list。
      expect(request).toContain("工作区文稿一律按工作区级文稿创建");
      expect(request).toContain("不需要用户先选择或确认归属");
      expect(request).not.toContain("<available_rooms>");
      expect(request).not.toContain("candidateRoomIds");
      expect(request).not.toContain("document_write_begin.roomId");
      expect(request).not.toContain("context_room_list");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("自动续写：命中输出上限后接着跑完，而不是判失败", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const endpoint = createServer((_request, response) => {
      let raw = "";
      _request.on("data", (chunk) => { raw += chunk.toString(); });
      _request.on("end", () => {
        requestBodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (content: string, finishReason: string | null = null) => JSON.stringify({
          id: "chatcmpl-auto-continue",
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
        });
        // 第一轮被长度截断，续写这一轮正常说完
        const first = requestBodies.length === 1;
        response.write(`data: ${chunk(first ? "先说明还差哪几项：" : "剩余步骤已完成，结论如下。")}\n\n`);
        response.write(`data: ${chunk("", first ? "length" : "stop")}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-auto-continue-test-"));
    temporaryDirectories.push(dataDir);
    const runtime = new PiAgentRuntime({
      provider: "nxcore-test-provider",
      model: "nxcore-test-model",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "nxcore-test-key",
      api: "openai-completions",
      maxTokens: 32,
      contextWindow: 8192,
      temperature: 0.3,
      reasoning: "off",
      sessionsDir: join(dataDir, "sessions"),
      workingDirectory: join(dataDir, "workspace"),
      agentDirectory: join(dataDir, "config"),
    });

    try {
      const run = await runtime.start({
        runId: "run-auto-continue",
        sessionId: "session-auto-continue",
        runtimeSessionRef: null,
        prompt: "把报告改完",
        pageLabel: "首页",
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      // 续写补完了输出 → 整轮成功，不再把球踢回给用户
      expect(events.at(-1)).toMatchObject({ type: "run.completed" });
      expect(events.some((event) => event.type === "run.failed")).toBe(false);
      // 续写提示词要求"接着写、别重复"，且新请求带上了上一轮的上下文
      expect(requestBodies).toHaveLength(2);
      const continuation = JSON.stringify(requestBodies[1]);
      expect(continuation).toContain("上一轮输出被长度上限截断");
      expect(continuation).toContain("接着把剩下的部分做完");
      // 续写不是重开：原始请求仍在同一条会话里
      expect(continuation).toContain("把报告改完");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("hides every tool for a disabled run and restores them by default", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const endpoint = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk.toString(); });
      request.on("end", () => {
        requestBodies.push(JSON.parse(raw) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-tools-toggle",
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta: { content: "完成" }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-tools-toggle",
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-tools-toggle-test-"));
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
    }, {
      promptGuidelines: ["document tool guidance"],
      tools: [{
        name: "document_read",
        label: "读取文档",
        description: "读取文档",
        parameters: { type: "object", properties: {} },
        execute: async () => ({ content: "{}" }),
      }],
    });

    try {
      const disabled = await runtime.start({
        runId: "run-tools-disabled",
        sessionId: "agent-session",
        runtimeSessionRef: null,
        prompt: "补全",
        pageLabel: "文档",
        toolsEnabled: false,
      });
      for await (const _event of disabled.events) { /* consume */ }
      const enabled = await runtime.start({
        runId: "run-tools-default",
        sessionId: "agent-session",
        runtimeSessionRef: disabled.runtimeSessionRef,
        prompt: "正常聊天",
        pageLabel: "文档",
      });
      for await (const _event of enabled.events) { /* consume */ }

      expect(requestBodies[0]?.tools).toBeUndefined();
      expect(JSON.stringify(requestBodies[0])).not.toContain("document tool guidance");
      // Phase 2i 去 Room：不再注入 Room 快照（<room_metadata> 消失），
      // 换成工作区级文稿指引。
      expect(JSON.stringify(requestBodies[0])).not.toContain("<room_metadata>");
      expect(JSON.stringify(requestBodies[0])).not.toContain("手动创建的 Room");
      expect(JSON.stringify(requestBodies[0])).toContain("工作区文稿一律按工作区级文稿创建");
      expect(JSON.stringify(requestBodies[1]?.tools)).toContain("document_read");
      expect(JSON.stringify(requestBodies[1]?.tools)).toContain('"name":"bash"');
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
          usage: finishReason ? { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } : undefined,
        });
        if (requestIndex % 2 === 0) {
          response.write(`data: ${chunk({
            tool_calls: [{
              index: 0,
              id: `call-${String(requestIndex)}`,
              type: "function",
              function: {
                name: "document_write_begin",
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
    const toolContexts: Array<{ sessionId: string; runId: string }> = [];
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
      promptGuidelines: ["动态文档能力规范：只使用当前注册表提供的能力说明。"],
      tools: [{
        name: "document_write_begin",
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
          toolContexts.push({ sessionId: input.sessionId, runId: input.runId });
          return { content: JSON.stringify({ state: "open" }) };
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
        responseLanguage: "ja-JP",
        pageLabel: "Room A",
      });
      const firstEvents: RuntimeEvent[] = [];
      for await (const event of first.events) firstEvents.push(event);

      const second = await runtime.start({
        runId: "run-room-b",
        sessionId: "agent-session",
        runtimeSessionRef: first.runtimeSessionRef,
        prompt: "再创建一份文档",
        responseLanguage: "en-US",
        pageLabel: "Room B",
      });
      const secondEvents: RuntimeEvent[] = [];
      for await (const event of second.events) secondEvents.push(event);

      expect(toolContexts).toEqual([
        { sessionId: "agent-session", runId: "run-room-a" },
        { sessionId: "agent-session", runId: "run-room-b" },
      ]);
      expect(finished).toEqual([
        { runId: "run-room-a", outcome: "completed" },
        { runId: "run-room-b", outcome: "completed" },
      ]);
      expect(firstEvents.map((event) => event.type)).toContain("tool.started");
      expect(firstEvents.map((event) => event.type)).toContain("tool.completed");
      expect(secondEvents.map((event) => event.type)).toContain("tool.completed");
      const toolCompletedIndex = firstEvents.findIndex(event => event.type === "tool.completed");
      expect(firstEvents.slice(0, toolCompletedIndex)).toContainEqual(expect.objectContaining({
        type: "context.usage", payload: expect.objectContaining({ runUsage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 } }),
      }));
      expect(firstEvents.find(event => event.type === "message.completed")?.payload).toMatchObject({
        usage: { input: 24, output: 6, cacheRead: 0, cacheWrite: 0 },
      });
      const reusedRunRequest = JSON.stringify(requestBodies[2]);
      expect(reusedRunRequest).toContain("本轮执行 ID：run-room-b");
      expect(reusedRunRequest).toContain("历史 run 的 readReceipt、operationId、patchId、工具结果和工具错误均已失效");
      expect(reusedRunRequest).toContain("不要先调用 document_read");
      expect(reusedRunRequest).toContain("不得要求用户提供 readReceipt、operationId、patchId、blockId 或 patch markdown");
      expect(reusedRunRequest).toContain("工具调用、文档全文、块标识、读取凭证、Operation 标识和工具错误均已移除");
      expect(reusedRunRequest).toContain("用户：创建文档");
      expect(reusedRunRequest).not.toContain('{\\"roomId\\":\\"room-a\\",\\"state\\":\\"open\\"}');
      expect(requestBodies).toHaveLength(4);
      expect(JSON.stringify(requestBodies[0]?.tools)).toContain("document_write_begin");
      expect(JSON.stringify(requestBodies[0]?.tools)).toContain('"name":"bash"');
      expect(JSON.stringify(requestBodies[0]?.tools)).not.toContain("v2_desktop_user_pc_bash");
      const firstRequest = JSON.stringify(requestBodies[0]);
      expect(firstRequest).toContain("必须使用简体中文");
      expect(firstRequest).toContain("当前界面 locale：ja-JP");
      const firstMessages = requestBodies[0]?.messages as Array<{ role?: string; content?: string }>;
      expect(firstMessages.find((message) => message.role === "system")?.content)
        .toContain("当前界面 locale：ja-JP");
      expect(firstMessages.filter((message) => message.role === "user").at(-1)?.content)
        .not.toContain("当前界面 locale");
      expect(firstRequest).toContain("动态文档能力规范：只使用当前注册表提供的能力说明。");
      expect(firstRequest).not.toContain("准备写入正文的实际核心内容、重点或结论");
      expect(requestBodies[1]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: '{"state":"open"}' }),
      ]));
      expect(requestBodies[3]?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: '{"state":"open"}' }),
      ]));
      expect(reusedRunRequest).toContain("当前界面 locale：en-US");

      await expect(runtime.start({
        runId: "run-wrong-owner",
        sessionId: "different-agent-session",
        runtimeSessionRef: first.runtimeSessionRef,
        prompt: "不应执行",
        pageLabel: "Room C",
      })).rejects.toThrow("different Agent session");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("stops a run before executing a tool past maxToolCallsPerRun", async () => {
    let requestIndex = 0;
    const endpoint = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => { raw += chunk.toString(); });
      request.on("end", () => {
        JSON.parse(raw);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => JSON.stringify({
          id: `chatcmpl-tool-limit-${String(requestIndex)}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        response.write(`data: ${chunk({
          tool_calls: [{
            index: 0,
            id: `call-limit-${String(requestIndex)}`,
            type: "function",
            function: {
              name: "limited_tool",
              arguments: "{}",
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
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-tool-limit-test-"));
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
      maxToolCallsPerRun: 1,
    }, {
      tools: [{
        name: "limited_tool",
        label: "受限工具",
        description: "用于测试调用上限",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          executions += 1;
          return { content: "工具完成" };
        },
      }],
    });

    try {
      const run = await runtime.start({
        runId: "run-tool-limit",
        sessionId: "session-tool-limit",
        runtimeSessionRef: null,
        prompt: "连续调用工具",
        pageLabel: "测试工作区",
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(executions).toBe(1);
      expect(requestIndex).toBe(2);
      expect(events.map((event) => event.type)).toContain("run.failed");
      // 文案改成中文可行动版本：说清上限、已中止、以及下一步怎么做
      expect(events.find((event) => event.type === "run.failed")?.payload).toEqual({
        message: expect.stringContaining("工具调用已达上限（1 次）"),
      });
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


  it("resets the streamed message body when pi retries a truncated stream (#199)", async () => {
    let requestCount = 0;
    const endpoint = createServer((request, response) => {
      requestCount += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (content: string, finishReason: string | null = null) => JSON.stringify({
        id: "chatcmpl-nxcore-retry-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "nxcore-test-model",
        choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
      });
      if (requestCount === 1) {
        // 第一波：流中途断开（无 finish_reason、无 [DONE]）。
        // 先等客户端收到并解析这条增量再断流，模拟真实的传输中断。
        response.write(`data: ${chunk("第一波的半截正文")}\n\n`);
        setTimeout(() => response.destroy(), 100);
        return;
      }
      // 第二波：完整响应
      response.write(`data: ${chunk("重试后的完整")}\n\n`);
      response.write(`data: ${chunk("正文")}\n\n`);
      response.write(`data: ${chunk("", "stop")}\n\n`);
      response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-retry-reset-test-"));
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
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    });

    try {
      const run = await runtime.start({
        runId: "run-retry-reset",
        sessionId: "session-retry-reset",
        runtimeSessionRef: null,
        prompt: "写一段话",
        pageLabel: "测试",
      });
      const events: RuntimeEvent[] = [];
      for await (const event of run.events) events.push(event);

      expect(requestCount).toBe(2);
      const completed = events.find((event) => event.type === "message.completed");
      // 最终正文只含重试波次的内容，不含第一波半截
      expect((completed?.payload as { content?: unknown }).content).toBe("重试后的完整正文");
      // 重试波次前必须重发 message.started 作为"消息体重启"信号
      const startedSeq = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === "message.started");
      expect(startedSeq).toHaveLength(2);
      const deltas = events.filter((event) => event.type === "message.delta");
      const resetEvent = startedSeq[1]!.event;
      const resetAt = events.indexOf(resetEvent);
      const firstWave = deltas.filter((event) => events.indexOf(event) < resetAt);
      const secondWave = deltas.filter((event) => events.indexOf(event) > resetAt);
      expect(firstWave.map((event) => (event.payload as { delta?: unknown }).delta).join("")).toBe("第一波的半截正文");
      expect(secondWave.map((event) => (event.payload as { delta?: unknown }).delta).join("")).toBe("重试后的完整正文");
      expect(events[events.length - 1]?.type).toBe("run.completed");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });

  it("enforces the permission-mode matrix for bash and edit approvals", async () => {
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
    try {
      const seen: string[] = [];
      runtime.setBashApprovalHandler(async (request) => {
        seen.push(`${request.kind ?? "shell"}:${request.toolName}`);
        return false;
      });
      const runInput = {
        runId: "run-1",
        sessionId: "session-1",
        runtimeSessionRef: null,
        prompt: "",
        pageLabel: "test",
      };
      const request = (toolName?: string) => ({
        approvalId: `approval-${seen.length}`,
        input: runInput,
        command: "echo hi",
        cwd: "/tmp",
        timeoutMs: 1_000,
        ...(toolName ? { toolName } : {}),
      });

      // 默认（accept_edits = 既有行为）：bash 必审、edit 放行
      expect(await runtime.requestBashApproval(request())).toBe(false);
      expect(seen).toEqual(["shell:bash"]);
      expect(await runtime.requestEditApproval(request("edit"))).toBe(true);
      expect(seen).toEqual(["shell:bash"]);

      // ask_before_write：edit 也必审（kind=edit 的审批卡）
      runtime.setSessionPermissionMode("session-1", "ask_before_write");
      expect(await runtime.requestEditApproval(request("edit"))).toBe(false);
      expect(seen).toEqual(["shell:bash", "edit:edit"]);

      // auto / full_access：bash 与 edit 全放行，不打扰审批链
      runtime.setSessionPermissionMode("session-1", "auto");
      expect(await runtime.requestBashApproval(request())).toBe(true);
      expect(await runtime.requestEditApproval(request("write"))).toBe(true);
      runtime.setSessionPermissionMode("session-1", "full_access");
      expect(await runtime.requestBashApproval(request())).toBe(true);
      expect(seen).toEqual(["shell:bash", "edit:edit"]);

      // 会话级授权（审批卡「本会话允许」）：ask_before_write 下 edit 免审
      runtime.setSessionPermissionMode("session-1", "ask_before_write");
      runtime.setEditSessionAuthorizationChecker(() => true);
      expect(await runtime.requestEditApproval(request("edit"))).toBe(true);
      expect(seen).toEqual(["shell:bash", "edit:edit"]);

      // forget → 回到默认 accept_edits
      runtime.forgetSessionPermissionMode("session-1");
      expect(runtime.getSessionPermissionMode("session-1")).toBe("accept_edits");
    } finally {
      await runtime.dispose();
    }
  });

  it("clamps oversized tool results and prunes old tool payloads between turns", async () => {
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
          id: `chatcmpl-budget-${String(requestIndex)}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "nxcore-test-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        });
        if (requestIndex < 3) {
          response.write(`data: ${chunk({
            tool_calls: [{
              index: 0,
              id: `call-${String(requestIndex)}`,
              type: "function",
              function: { name: "big_result", arguments: "{}" },
            }],
          })}\n\n`);
          response.write(`data: ${chunk({}, "tool_calls")}\n\n`);
        } else {
          response.write(`data: ${chunk({ content: "完成" })}\n\n`);
          response.write(`data: ${chunk({}, "stop")}\n\n`);
        }
        requestIndex += 1;
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolvePromise) => endpoint.listen(0, "127.0.0.1", resolvePromise));
    const address = endpoint.address();
    if (!address || typeof address === "string") throw new Error("Test endpoint did not bind a TCP port");

    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-pi-budget-test-"));
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
      // 单条工具结果 800 字符封顶；上下文估算超 50 token 后只保留最近 1 轮工具载荷。
      maxToolResultChars: 800,
      runContextGuard: { triggerTokens: 50, keepRecentTurns: 1 },
    }, {
      tools: [{
        name: "big_result",
        label: "大结果",
        description: "返回一个超长结果",
        parameters: { type: "object", additionalProperties: false, properties: {} },
        execute: async () => ({ content: `BIG-${"x".repeat(5_000)}` }),
      }],
    });

    try {
      const run = await runtime.start({
        runId: "run-budget",
        sessionId: "session-budget",
        runtimeSessionRef: null,
        prompt: "连续调用工具",
        pageLabel: "预算测试",
      });
      for await (const _event of run.events) { /* consume */ }

      expect(requestBodies).toHaveLength(4);
      // 单条工具结果被预算截断后才进入下一轮请求。
      expect(JSON.stringify(requestBodies[1])).toContain("截断");
      // 第 3 轮请求里，更早的工具结果被替换成占位符，最近一轮保留。
      const lastBody = JSON.stringify(requestBodies[3]);
      expect(lastBody).toContain("已省略");
      expect(lastBody).toContain("BIG-");
    } finally {
      await runtime.dispose();
      await new Promise<void>((resolvePromise, reject) => endpoint.close((error) => error ? reject(error) : resolvePromise()));
    }
  });
});
