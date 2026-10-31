import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntime, type PiAgentRuntimeConfig } from "../src/index.js";

/**
 * DeepSeek 系模型：不传 thinking 参数时上游默认思考（2026-10-23 实测
 * deepseek-v4.1-flash 对「1+1」也先写满 64 token 的 reasoning）。
 * reasoning:"off" 必须在请求里显式发 `thinking:{type:"disabled"}`，
 * 否则编排阶段每次调用白烧几分钟。
 */

const temporary: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sse(): Response {
  const lines = [
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}`,
    "",
    `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"deepseek-v4.1-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1,"total_tokens":11}}`,
    "",
    "data: [DONE]",
    "",
  ];
  return new Response(lines.join("\n"), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

interface CapturedRuntime {
  runtime: PiAgentRuntime;
  /** 每轮请求体，按发出顺序追加。 */
  bodies: Record<string, unknown>[];
}

/** 建 runtime + fetch stub：每个模型请求的 body 收进 bodies，响应统一是 sse。 */
async function createCapturedRuntime(
  config: Partial<PiAgentRuntimeConfig> & { model: string },
): Promise<CapturedRuntime> {
  const root = await mkdtemp(join(tmpdir(), "pi-thinking-request-"));
  temporary.push(root);
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return sse();
  });
  const runtime = new PiAgentRuntime({
    provider: "openai",
    // model 由末尾的 `...config` 展开提供（config 类型要求必有 model）。
    baseUrl: config.baseUrl ?? "https://example.test/v1",
    apiKey: "test-key",
    api: "openai-completions",
    maxTokens: 256,
    contextWindow: 128000,
    temperature: 0.3,
    reasoning: config.reasoning ?? "off",
    sessionsDir: join(root, "sessions"),
    workingDirectory: join(root, "ws"),
    agentDirectory: join(root, "agent"),
    builtinTools: [],
    systemPrompt: "你是测试助手。",
    ...config,
  });
  return { runtime, bodies };
}

/** 跑一轮并 drain 事件，返回 runtimeSessionRef 供下一轮复用。 */
async function startRound(
  runtime: PiAgentRuntime,
  input: { sessionId: string; runtimeSessionRef: string | null; runId: string },
): Promise<string> {
  const run = await runtime.start({
    runId: input.runId,
    sessionId: input.sessionId,
    runtimeSessionRef: input.runtimeSessionRef,
    prompt: "1+1 等于几？",
    pageLabel: "thinking request",
    roomId: null,
    toolsEnabled: false,
    captureMemory: false,
    recallMemory: false,
  } as never);
  for await (const _event of run.events) { /* drain */ }
  return run.runtimeSessionRef;
}

async function captureRequest(
  config: Partial<PiAgentRuntimeConfig> & { model: string },
): Promise<Record<string, unknown>> {
  const { runtime, bodies } = await createCapturedRuntime(config);
  try {
    await startRound(runtime, {
      runId: `run-${Math.random().toString(16).slice(2)}`,
      sessionId: `session-${Math.random().toString(16).slice(2)}`,
      runtimeSessionRef: null,
    });
  } finally {
    await runtime.dispose();
  }
  expect(bodies.length).toBeGreaterThan(0);
  return bodies[0]!;
}

describe("DeepSeek thinking 请求参数", () => {
  it("reasoning=off 时显式关闭思考（否则上游默认思考）", async () => {
    const body = await captureRequest({ model: "deepseek-v4.1-flash" });
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("reasoning=medium 时开启思考（不误发 disabled）", async () => {
    const body = await captureRequest({ model: "deepseek-v4.1-flash", reasoning: "medium" });
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("非 DeepSeek 模型不注入思考开关，避免第三方端点 400", async () => {
    const body = await captureRequest({ model: "qwen-plus" });
    expect(body.thinking).toBeUndefined();
  });
});

describe("会话级 thinkingLevel 覆盖", () => {
  it("覆盖从下一轮生效，重置为 null 后恢复跟随配置", async () => {
    const { runtime, bodies } = await createCapturedRuntime({ model: "deepseek-v4.1-flash", reasoning: "off" });
    const sessionId = "session-thinking-override";
    try {
      const ref = await startRound(runtime, { sessionId, runtimeSessionRef: null, runId: "run-1" });
      // 第一轮建会话时还没有覆盖值，跟随 config.reasoning="off"。
      expect(await runtime.setSessionThinkingLevel(sessionId, "medium")).toEqual({ applied: true });
      await startRound(runtime, { sessionId, runtimeSessionRef: ref, runId: "run-2" });
      await runtime.setSessionThinkingLevel(sessionId, null);
      await startRound(runtime, { sessionId, runtimeSessionRef: ref, runId: "run-3" });
    } finally {
      await runtime.dispose();
    }
    expect(bodies.map((body) => body.thinking)).toEqual([
      { type: "disabled" },
      { type: "enabled" },
      { type: "disabled" },
    ]);
  });

  it("建会话前设置：applied=false 但生效；覆盖互不影响，forget 后回到跟随配置", async () => {
    const { runtime, bodies } = await createCapturedRuntime({ model: "deepseek-v4.1-flash", reasoning: "off" });
    const sessionId = "session-thinking-pending";
    try {
      expect(await runtime.setSessionThinkingLevel(sessionId, "medium")).toEqual({ applied: false });
      const ref = await startRound(runtime, { sessionId, runtimeSessionRef: null, runId: "run-1" });
      // 另一个网关会话没有覆盖，仍跟随 config.reasoning。
      await startRound(runtime, { sessionId: "session-other", runtimeSessionRef: null, runId: "run-2" });
      // forget 清掉覆盖记录后，同一个缓存会话在下一轮回到跟随配置。
      runtime.forgetSessionThinkingLevel(sessionId);
      await startRound(runtime, { sessionId, runtimeSessionRef: ref, runId: "run-3" });
    } finally {
      await runtime.dispose();
    }
    expect(bodies.map((body) => body.thinking)).toEqual([
      { type: "enabled" },
      { type: "disabled" },
      { type: "disabled" },
    ]);
  });
});