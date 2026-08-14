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
});
