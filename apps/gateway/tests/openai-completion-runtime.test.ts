import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { invokeAgent } from "../src/modules/agent/invoke.js";
import { OpenAiCompletionAgentRuntime } from "../src/modules/agent/openai-completion-runtime.js";
import { AgentResolver } from "../src/modules/agent/resolver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function completionBody(content: string | null, finishReason: string) {
  return JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

/** 与生产同构：AgentResolver 注册 OpenAiCompletionAgentRuntime，经 invokeAgent 驱动。 */
async function makeInvoker(maxTokens?: number): Promise<() => Promise<string>> {
  const root = await mkdtemp(join(tmpdir(), "everroom-openai-runtime-"));
  temporaryDirectories.push(root);
  const resolver = new AgentResolver();
  resolver.register(
    { id: "test-agent", name: "Test", description: "test", configDirectory: join(root, "config"), kind: "builtin" },
    () => new OpenAiCompletionAgentRuntime({
      runtimeId: "test-agent",
      baseUrl: "http://provider.test/v1",
      apiKey: "key",
      model: "glm-test",
      systemPrompt: "sys",
      temperature: 0.1,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      timeoutMs: 5_000,
      sessionsDir: join(root, "sessions"),
      workingDirectory: join(root, "workspace"),
      agentDirectory: join(root, "config"),
    }),
  );
  return () => invokeAgent(resolver, "test-agent", "使用 Knowledge Agent 的 entity-extraction Skill。\n资料标题：t");
}

function mockFetch(bodies: string[]): ReturnType<typeof vi.spyOn> {
  let call = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const body = bodies[Math.min(call, bodies.length - 1)]!;
    call += 1;
    return new Response(body, { headers: { "content-type": "application/json" } });
  });
}

function requestBodyOf(fetchMock: ReturnType<typeof vi.spyOn>, callIndex: number): { max_tokens?: number } {
  const init = fetchMock.mock.calls[callIndex]![1] as { body: string };
  return JSON.parse(init.body) as { max_tokens?: number };
}

describe("OpenAiCompletionAgentRuntime length 防护", () => {
  it("正常返回：一次请求，按配置透传 max_tokens", async () => {
    const invoke = await makeInvoker(4_096);
    const fetchMock = mockFetch([completionBody('{"ok":1}', "stop")]);

    await expect(invoke()).resolves.toBe('{"ok":1}');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBodyOf(fetchMock, 0).max_tokens).toBe(4_096);
  });

  it("finish_reason=length 无正文：4 倍加预算重试一次后成功", async () => {
    const invoke = await makeInvoker(4_096);
    const fetchMock = mockFetch([
      completionBody(null, "length"),
      completionBody('{"entities":[]}', "stop"),
    ]);

    await expect(invoke()).resolves.toBe('{"entities":[]}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodyOf(fetchMock, 0).max_tokens).toBe(4_096);
    expect(requestBodyOf(fetchMock, 1).max_tokens).toBe(16_384);
  });

  it("重试预算封顶 32768：16384 的重试是 32768，再截断即失败", async () => {
    const invoke = await makeInvoker(16_384);
    const fetchMock = mockFetch([
      completionBody(null, "length"),
      completionBody(null, "length"),
    ]);

    await expect(invoke()).rejects.toThrow(/finish_reason=length/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodyOf(fetchMock, 1).max_tokens).toBe(32_768);
  });

  it("重试后仍截断：以 finish_reason=length 失败，不无限重试", async () => {
    const invoke = await makeInvoker(4_096);
    const fetchMock = mockFetch([completionBody(null, "length")]);

    await expect(invoke()).rejects.toThrow(/finish_reason=length/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非 length 的空正文（如内容过滤）不重试，立即失败", async () => {
    const invoke = await makeInvoker(4_096);
    const fetchMock = mockFetch([completionBody(null, "content_filter")]);

    await expect(invoke()).rejects.toThrow(/finish_reason=content_filter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("未配置 max_tokens 时无预算可加：length 直接失败不重试", async () => {
    const invoke = await makeInvoker(undefined);
    const fetchMock = mockFetch([completionBody(null, "length")]);

    await expect(invoke()).rejects.toThrow(/finish_reason=length/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
})
