import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults to the isolated fake runtime", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {});

    expect(config.agentRuntime).toBe("fake");
    expect(config.externalCallUserId).toBe("local-user");
    expect(config.externalCallWorkspaceId).toBe("local-workspace");
    expect(config.pi).toBeNull();
    expect(config.cursorCompletionPi).toBeNull();
    expect(config.backgroundPi).toBeNull();
    expect(config.subagents).toMatchObject({
      enabled: true,
      definitionsDir: resolve("../..", "agents"),
      defaultTimeoutMs: 300_000,
      maxConcurrent: 4,
    });
  });

  it("loads server-owned external call budget identity", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_EXTERNAL_CALL_USER_ID: "user-a",
      NXCORE_EXTERNAL_CALL_WORKSPACE_ID: "workspace-a",
    });
    expect(config.externalCallUserId).toBe("user-a");
    expect(config.externalCallWorkspaceId).toBe("workspace-a");
  });

  it("loads the filesystem subagent directory and execution limits", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_SUBAGENTS_DIR: "./fixtures/agents",
      NXCORE_SUBAGENTS_ENABLED: "false",
      NXCORE_SUBAGENT_TIMEOUT_MS: "45000",
      NXCORE_SUBAGENT_MAX_CONCURRENT: "7",
    });

    expect(config.subagents).toEqual({
      enabled: false,
      definitionsDir: resolve("./fixtures/agents"),
      runtimeDir: join(config.dataDir, "agent", "subagents"),
      defaultTimeoutMs: 45_000,
      maxConcurrent: 7,
    });
  });

  it("prefers command line arguments over environment variables", () => {
    const config = loadConfig(
      ["--host", "127.0.0.2", "--port", "4321", "--data-dir", ".data/test", "--token", "0123456789abcdef"],
      { NXCORE_GATEWAY_PORT: "9999" },
    );

    expect(config.host).toBe("127.0.0.2");
    expect(config.port).toBe(4321);
    expect(config.authToken).toBe("0123456789abcdef");
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig(["--port", "invalid"], {})).toThrow("Invalid gateway port");
  });

  it("accepts the package-manager argument delimiter", () => {
    const config = loadConfig(["--", "--port", "4321", "--token", "0123456789abcdef"], {});

    expect(config.port).toBe(4321);
  });

  it("keeps the fake runtime isolated from AI configuration", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "fake",
    });

    expect(config.agentRuntime).toBe("fake");
    expect(config.pi).toBeNull();
  });

  it("loads the isolated oo CLI connector target", () => {
    const dataDirectory = resolve("/tmp/everroom-test");
    const config = loadConfig(["--token", "0123456789abcdef", "--data-dir", dataDirectory], {
      NXCORE_CLI_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_CLI_CONNECTOR_RUNTIME_TOKEN: "runtime-secret",
      NXCORE_CLI_CONNECTOR_CLI_PATH: "/opt/everroom/oo",
    });

    expect(config.cliConnector).toEqual({
      executable: "/opt/everroom/oo",
      baseUrl: "http://127.0.0.1:3000",
      runtimeToken: "runtime-secret",
      configDirectory: join(dataDirectory, "open-connector", "oo-config"),
      dataDirectory: join(dataDirectory, "open-connector", "oo-data"),
    });
  });

  it("requires HTTPS for non-loopback connector runtimes", () => {
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_CLI_CONNECTOR_URL: "http://connector.example.com",
    })).toThrow("plain HTTP is only allowed for loopback")
  });

  it("accepts legacy Nango variables while ignoring native connector variables", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      OO_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_OPEN_CONNECTOR_URL: "http://127.0.0.1:3000",
      NXCORE_NANGO_URL: "http://127.0.0.1:3003",
      NXCORE_NANGO_SECRET: "legacy-secret",
      NXCORE_NANGO_GMAIL_CONFIG_KEY: "legacy-gmail",
      NXCORE_NANGO_GOOGLE_CLIENT_ID: "legacy-google-id",
      NXCORE_CONNECTOR_POLL_MS: "120000",
    });

    expect(config.cliConnector).toBeNull();
    // P3：Nango env 全族忽略；link-A 编排恒可用，仅 poll 周期仍读 env
    expect(config.nangoConnector).toMatchObject({
      enabled: true,
      pollingIntervalMs: 120_000,
    });
  });

  it("keeps MemoryCore available independently of the Agent runtime", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "fake",
      NXCORE_MEMORY_ENABLED: "true",
    });

    expect(config.pi).toBeNull();
    expect(config.memory).toMatchObject({
      baseUrl: "http://127.0.0.1:8420",
      userId: "local-user",
    });
  });

  it("loads a validated Pi runtime configuration", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "deepseek",
      NXCORE_AI_MODEL: "deepseek-chat",
      NXCORE_AI_BASE_URL: "https://api.deepseek.com",
      NXCORE_AI_API_KEY: "test-key",
      NXCORE_AI_API: "openai-completions",
      NXCORE_AI_REASONING: "off",
    });

    expect(config.pi).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      reasoning: "off",
      temperature: 0.3,
    });
    expect(config.backgroundPi).toMatchObject({
      model: "deepseek-chat",
      maxTokens: 8192,
    });
    expect(config.diaryMaxTokens).toBe(16384);
    expect(config.cursorCompletionPi).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      maxTokens: 8192,
      reasoning: "off",
    });
  });

  it("loads an independent cursor completion model with per-field AI fallbacks", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-main",
      NXCORE_AI_BASE_URL: "https://api.openai.com/v1",
      NXCORE_AI_API_KEY: "main-key",
      NXCORE_AI_API: "openai-responses",
      NXCORE_AI_CONTEXT_WINDOW: "128000",
      NXCORE_CURSOR_COMPLETION_AI_PROVIDER: "deepseek",
      NXCORE_CURSOR_COMPLETION_AI_MODEL: "deepseek-chat",
      NXCORE_CURSOR_COMPLETION_AI_BASE_URL: "https://api.deepseek.com",
      NXCORE_CURSOR_COMPLETION_AI_API_KEY: "completion-key",
      NXCORE_CURSOR_COMPLETION_AI_API: "openai-completions",
      NXCORE_CURSOR_COMPLETION_AI_MAX_TOKENS: "512",
      NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE: "0.1",
      NXCORE_CURSOR_COMPLETION_AI_REASONING: "off",
    });

    expect(config.pi).toMatchObject({ model: "gpt-main", apiKey: "main-key" });
    expect(config.cursorCompletionPi).toMatchObject({
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "completion-key",
      api: "openai-completions",
      maxTokens: 512,
      contextWindow: 128000,
      temperature: 0.1,
      reasoning: "off",
    });
    expect(config.cursorCompletionPi?.sessionsDir).toContain("cursor-completion-pi-sessions");
  });

  it("rejects invalid cursor completion model values", () => {
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-main",
      NXCORE_AI_BASE_URL: "https://api.openai.com/v1",
      NXCORE_AI_API_KEY: "main-key",
      NXCORE_CURSOR_COMPLETION_AI_BASE_URL: "file:///tmp/model",
    })).toThrow("NXCORE_CURSOR_COMPLETION_AI_BASE_URL");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-main",
      NXCORE_AI_BASE_URL: "https://api.openai.com/v1",
      NXCORE_AI_API_KEY: "main-key",
      NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE: "3",
    })).toThrow("NXCORE_CURSOR_COMPLETION_AI_TEMPERATURE");
  });

  it("supports a stronger model and larger output budget for background summaries", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "qwen-turbo",
      NXCORE_AI_BACKGROUND_MODEL: "qwen-plus",
      NXCORE_AI_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      NXCORE_AI_API_KEY: "test-key",
      NXCORE_AI_MAX_TOKENS: "800",
      NXCORE_AI_BACKGROUND_MAX_TOKENS: "4096",
      NXCORE_DIARY_MAX_TOKENS: "12288",
    });

    expect(config.pi).toMatchObject({ model: "qwen-turbo", maxTokens: 800 });
    expect(config.backgroundPi).toMatchObject({ model: "qwen-plus", maxTokens: 4096 });
    expect(config.diaryMaxTokens).toBe(12288);
  });

  it("boots degraded when all primary AI env vars are empty and rejects partial configuration", () => {
    // 全空 = 降级启动（runtime config 接管），pi 对象保留空字段作为
    // applyRuntimeConfig 的原地 patch 目标。
    const degraded = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
    });
    expect(degraded.pi).toMatchObject({
      provider: "",
      model: "",
      baseUrl: "",
      apiKey: "",
    });
    expect(degraded.cursorCompletionPi).toMatchObject({
      provider: "",
      model: "",
      baseUrl: "",
      apiKey: "",
    });

    // 部分填写 = 配置事故，仍早失败。
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
    })).toThrow("Pi runtime requires: NXCORE_AI_MODEL, NXCORE_AI_BASE_URL, NXCORE_AI_API_KEY");

    // 四要素全齐 + 非 HTTP(S) URL → URL 校验照旧。
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-test",
      NXCORE_AI_BASE_URL: "file:///tmp/model",
      NXCORE_AI_API_KEY: "test-key",
    })).toThrow("expected an absolute HTTP(S) URL");
  });

  it("rejects partially-filled cursor completion AI configuration but tolerates fully-empty", () => {
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_CURSOR_COMPLETION_AI_MODEL: "qwen-flash",
    })).toThrow("Cursor completion Pi runtime requires");

    // 补全段全空（primary 也全空）→ 不抛，字段为空串占位。
    const degraded = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
    });
    expect(degraded.cursorCompletionPi?.baseUrl).toBe("");
  });

  it("loads VLM configuration only when all required values are present", () => {
    expect(loadConfig(["--token", "0123456789abcdef"], {}).vlm).toBeNull();
    expect(loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_VLM_BASE_URL: "https://vlm.example.test/v1",
      NXCORE_VLM_API_KEY: "test-key",
      NXCORE_VLM_MODEL: "vision-model",
    }).vlm).toEqual({
      baseUrl: "https://vlm.example.test/v1",
      apiKey: "test-key",
      model: "vision-model",
    });
    expect(loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_VLM_BASE_URL: "https://vlm.example.test/v1",
    }).vlm).toBeNull();
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_VLM_BASE_URL: "file:///tmp/model",
      NXCORE_VLM_API_KEY: "test-key",
      NXCORE_VLM_MODEL: "vision-model",
    })).toThrow("expected an absolute HTTP(S) URL");
  });

  it("loads Aliyun ASR only when explicitly enabled", () => {
    const disabled = loadConfig(["--token", "0123456789abcdef"], {});
    expect(disabled.asr).toBeNull();

    const enabled = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_ASR_PROVIDER: "aliyun",
      NXCORE_ASR_ALIYUN_API_KEY: "test-asr-key",
      NXCORE_ASR_ALIYUN_BASE_URL: "https://workspace.example.com/api/v1",
    });
    expect(enabled.asr).toMatchObject({
      apiKey: "test-asr-key",
      baseUrl: "https://workspace.example.com/api/v1",
      model: "qwen-audio-3.0-asr-flash-filetrans",
      oss: null,
    });

    const withOss = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_ASR_PROVIDER: "aliyun",
      NXCORE_ASR_ALIYUN_API_KEY: "test-asr-key",
      NXCORE_ASR_ALIYUN_OSS_REGION: "oss-cn-beijing",
      NXCORE_ASR_ALIYUN_OSS_BUCKET: "private-recordings",
      NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_ID: "test-oss-id",
      NXCORE_ASR_ALIYUN_OSS_ACCESS_KEY_SECRET: "test-oss-secret",
    });
    expect(withOss.asr?.oss).toMatchObject({
      region: "oss-cn-beijing",
      bucket: "private-recordings",
      prefix: "nxcore-asr",
    });
  });

  it("uses Aliyun credentials for web search instead of an unrelated main model key", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-main",
      NXCORE_AI_BASE_URL: "https://api.openai.com/v1",
      NXCORE_AI_API_KEY: "main-model-key",
      NXCORE_ASR_ALIYUN_API_KEY: "dashscope-key",
    });

    expect(config.webSearch).toMatchObject({
      apiKey: "dashscope-key",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
    });
  });

  it("rejects incomplete or unsafe Aliyun ASR configuration", () => {
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_ASR_PROVIDER: "aliyun",
    })).toThrow("NXCORE_ASR_ALIYUN_API_KEY");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_ASR_PROVIDER: "aliyun",
      NXCORE_ASR_ALIYUN_API_KEY: "test-key",
      NXCORE_ASR_ALIYUN_BASE_URL: "http://insecure.example.com/api/v1",
    })).toThrow("expected an absolute HTTPS URL");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_ASR_PROVIDER: "aliyun",
      NXCORE_ASR_ALIYUN_API_KEY: "test-key",
      NXCORE_ASR_ALIYUN_OSS_BUCKET: "missing-other-fields",
    })).toThrow("NXCORE_ASR_ALIYUN_OSS_REGION");
  });

  it("keeps link-A connector orchestration always enabled after Nango removal (P3)", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {});
    expect(config.nangoConnector).toMatchObject({ enabled: true, pollingIntervalMs: 300000 });
    expect(config.nangoConnector?.databasePath).toContain("connectors.sqlite");
  });

  it("falls back to NXCORE_AI_* for the knowledge arbitration LLM", () => {
    // 只配 NXCORE_AI_*（未配任何 NXCORE_KNOWLEDGE_LLM_*）→ ⑤ 仲裁可用
    const fromAi = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_KNOWLEDGE_ENABLED: "true",
      NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: "true",
      NXCORE_AI_BASE_URL: "https://api.deepseek.com",
      NXCORE_AI_API_KEY: "test-key",
      NXCORE_AI_MODEL: "deepseek-chat",
    });
    expect(fromAi.knowledge?.llm).toEqual({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      model: "deepseek-chat",
    });

    // 部分独立配置（仅 model）→ 其余项回退 NXCORE_AI_*
    const merged = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_KNOWLEDGE_ENABLED: "true",
      NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: "true",
      NXCORE_KNOWLEDGE_LLM_MODEL: "qwen-plus",
      NXCORE_AI_BASE_URL: "https://api.deepseek.com",
      NXCORE_AI_API_KEY: "test-key",
    });
    expect(merged.knowledge?.llm).toEqual({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
      model: "qwen-plus",
    });

    // 完全独立配置（不依赖 NXCORE_AI_*）→ ⑤ 也可用
    const standalone = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_KNOWLEDGE_ENABLED: "true",
      NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: "true",
      NXCORE_KNOWLEDGE_LLM_BASE_URL: "https://llm.example.test/v1",
      NXCORE_KNOWLEDGE_LLM_API_KEY: "test-key",
      NXCORE_KNOWLEDGE_LLM_MODEL: "qwen-plus",
    });
    expect(standalone.knowledge?.llm).toEqual({
      baseUrl: "https://llm.example.test/v1",
      apiKey: "test-key",
      model: "qwen-plus",
    });

    // 缺 model（两边都没有）→ ⑤ 不可用，但 ④ 仍可借 base/key 开启
    const incomplete = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_KNOWLEDGE_ENABLED: "true",
      NXCORE_KNOWLEDGE_ROOM_WIKIS_ENABLED: "true",
      NXCORE_AI_BASE_URL: "https://api.deepseek.com",
      NXCORE_AI_API_KEY: "test-key",
    });
    expect(incomplete.knowledge?.llm).toBeNull();
    expect(incomplete.knowledge?.embeddingLlm).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-key",
    });
  });
});
