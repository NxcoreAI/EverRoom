import { describe, expect, it } from "vitest";
import { loadConfig, type PiRuntimeConfig } from "../src/config.js";
import { createCursorCompletionRuntime } from "../src/modules/agent/runtime-factory.js";

describe("cursor completion runtime configuration", () => {
  it("uses the dedicated cursor completion model instead of the main Agent model", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-main",
      NXCORE_AI_BASE_URL: "https://api.openai.com/v1",
      NXCORE_AI_API_KEY: "main-key",
      NXCORE_CURSOR_COMPLETION_AI_PROVIDER: "deepseek",
      NXCORE_CURSOR_COMPLETION_AI_MODEL: "deepseek-chat",
      NXCORE_CURSOR_COMPLETION_AI_BASE_URL: "https://api.deepseek.com",
      NXCORE_CURSOR_COMPLETION_AI_API_KEY: "completion-key",
      NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS: "512",
      NXCORE_CURSOR_COMPLETION_AI_REASONING: "off",
    });

    const runtime = createCursorCompletionRuntime(config) as unknown as {
      config: PiRuntimeConfig;
    };

    expect(runtime.config).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "completion-key",
      maxTokens: 512,
      reasoning: "off",
    });
  });
});
