import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("defaults packaged configuration to the remote HTTP runtime", () => {
    const config = loadConfig(["--token", "0123456789abcdef"], {});

    expect(config.agentRuntime).toBe("remote-http");
    expect(config.remoteAgent).toEqual({
      baseUrl: "http://192.168.1.27:8280/ai/api",
      token: null,
      mcpWebSocketUrl: "ws://192.168.1.27:8280/ai/api/device-mcp",
    });
    expect(config.pi).toBeNull();
  });

  it("validates an explicitly configured remote MCP WebSocket", () => {
    const configured = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_REMOTE_AGENT_MCP_WS_URL: "ws://agent.example.test/device-mcp",
    });
    expect(configured.remoteAgent?.mcpWebSocketUrl).toBe("ws://agent.example.test/device-mcp");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_REMOTE_AGENT_MCP_WS_URL: "http://agent.example.test/device-mcp",
    })).toThrow("NXCORE_REMOTE_AGENT_MCP_WS_URL");

    const disabled = loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_REMOTE_AGENT_MCP_WS_URL: "",
    });
    expect(disabled.remoteAgent?.mcpWebSocketUrl).toBeNull();
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
  });

  it("rejects incomplete or unsafe Pi endpoint configuration", () => {
    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
    })).toThrow("Pi runtime requires");

    expect(() => loadConfig(["--token", "0123456789abcdef"], {
      NXCORE_AGENT_RUNTIME: "pi",
      NXCORE_AI_PROVIDER: "openai",
      NXCORE_AI_MODEL: "gpt-test",
      NXCORE_AI_BASE_URL: "file:///tmp/model",
      NXCORE_AI_API_KEY: "test-key",
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
});
