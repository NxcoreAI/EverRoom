import { describe, expect, it } from "vitest";
import { UnconfiguredAgentRuntime } from "@nxcore/agent-runtime";
import { loadConfig, type PiRuntimeConfig } from "../src/config.js";
import {
  createAgentRuntime,
  createBackgroundAgentRuntime,
  createCursorCompletionRuntime,
  isPiRuntimeConfigured,
} from "../src/modules/agent/runtime-factory.js";

function unconfiguredPiConfig(): PiRuntimeConfig {
  return {
    provider: "",
    model: "",
    baseUrl: "",
    apiKey: "",
    api: "openai-completions",
    maxTokens: 8192,
    contextWindow: 128000,
    temperature: 0.3,
    reasoning: "medium",
    sessionsDir: "/tmp/everroom-test/sessions",
    workingDirectory: "/tmp/everroom-test/workspace",
    agentDirectory: "/tmp/everroom-test/config",
  };
}

describe("UnconfiguredAgentRuntime", () => {
  it("start() yields run.started then run.failed with runtime_config_not_ready", async () => {
    const runtime = new UnconfiguredAgentRuntime();
    const run = await runtime.start({
      runId: "run-1",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "ping",
      pageLabel: "test",
      roomId: null,
    });
    const events: string[] = [];
    for await (const event of run.events) events.push(event.type);
    expect(events).toEqual(["run.started", "run.failed"]);
  });

  it("exposes the typed error message in run.failed payload", async () => {
    const runtime = new UnconfiguredAgentRuntime();
    const run = await runtime.start({
      runId: "run-1",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "ping",
      pageLabel: "test",
      roomId: null,
    });
    const payloads: unknown[] = [];
    for await (const event of run.events) payloads.push(event.payload);
    const failed = payloads[1] as { message?: string };
    expect(failed.message).toBe("runtime_config_not_ready");
  });

  it("resume() mirrors the failed-run shape", async () => {
    const runtime = new UnconfiguredAgentRuntime();
    const run = await runtime.resume({
      runId: "run-2",
      sessionId: "session-1",
      runtimeSessionRef: "ref",
      lastEventSeq: 3,
      prompt: "ping",
      pageLabel: "test",
      roomId: null,
    });
    expect(run.runtimeSessionRef).toBe("ref");
    const events: string[] = [];
    for await (const event of run.events) events.push(event.type);
    expect(events).toEqual(["run.started", "run.failed"]);
  });
});

describe("runtime factory degraded gates", () => {
  it("returns UnconfiguredAgentRuntime when primary pi fields are empty", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "",
      NXCORE_AI_MODEL: "",
      NXCORE_AI_BASE_URL: "",
      NXCORE_AI_API_KEY: "",
    });
    const runtime = createAgentRuntime(config, undefined as never);
    expect(runtime).toBeInstanceOf(UnconfiguredAgentRuntime);
  });

  it("returns UnconfiguredAgentRuntime when background pi fields are empty", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "",
      NXCORE_AI_MODEL: "",
      NXCORE_AI_BASE_URL: "",
      NXCORE_AI_API_KEY: "",
    });
    const runtime = createBackgroundAgentRuntime(config);
    expect(runtime).toBeInstanceOf(UnconfiguredAgentRuntime);
  });

  it("returns UnconfiguredAgentRuntime when cursor completion pi fields are empty", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "",
      NXCORE_AI_MODEL: "",
      NXCORE_AI_BASE_URL: "",
      NXCORE_AI_API_KEY: "",
      NXCORE_CURSOR_COMPLETION_AI_PROVIDER: "",
      NXCORE_CURSOR_COMPLETION_AI_MODEL: "",
      NXCORE_CURSOR_COMPLETION_AI_BASE_URL: "",
      NXCORE_CURSOR_COMPLETION_AI_API_KEY: "",
    });
    const runtime = createCursorCompletionRuntime(config);
    expect(runtime).toBeInstanceOf(UnconfiguredAgentRuntime);
  });

  it("fake mode still returns FakeAgentRuntime", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "fake",
    });
    const runtime = createBackgroundAgentRuntime(config);
    expect(runtime.id).toBe("fake");
  });

  it("isPiRuntimeConfigured requires all four fields", () => {
    const base = unconfiguredPiConfig();
    expect(isPiRuntimeConfigured(base)).toBe(false);
    expect(isPiRuntimeConfigured({ ...base, provider: "openai" })).toBe(false);
    expect(isPiRuntimeConfigured(null)).toBe(false);
    expect(isPiRuntimeConfigured({
      ...base,
      provider: "openai",
      model: "m",
      baseUrl: "https://x.example",
      apiKey: "k",
    })).toBe(true);
  });
});
