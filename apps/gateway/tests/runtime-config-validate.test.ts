import { describe, expect, it, vi } from "vitest";
import {
  aiFieldsConfigured,
  embeddingAiFields,
  isEmbeddingConfigured,
  isPrimaryConfigured,
  primaryAiFields,
  testAiConnection,
  testEmbeddingConnection,
  vlmAiFields,
} from "../src/modules/runtime-config/validate.js";

function config(overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    primary: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      ...overrides,
    },
  };
}

function embeddingConfig(overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    knowledge: {
      embedding: {
        provider: "openai-compatible",
        model: "text-embedding-test",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-embed",
        ...overrides,
      },
    },
  };
}

describe("runtime config validity", () => {
  it("treats a complete primary section as configured", () => {
    expect(isPrimaryConfigured(config())).toBe(true);
  });

  it("treats empty-string placeholders as not configured", () => {
    expect(isPrimaryConfigured(config({ baseUrl: "" }))).toBe(false);
    expect(isPrimaryConfigured(config({ apiKey: "" }))).toBe(false);
  });

  it("treats a missing primary section as not configured", () => {
    expect(isPrimaryConfigured({})).toBe(false);
  });

  it("extracts trimmed fields and normalizes missing keys to empty strings", () => {
    expect(primaryAiFields({ primary: { model: "  m  " } })).toEqual({
      provider: "",
      model: "m",
      baseUrl: "",
      apiKey: "",
    });
  });
});

describe("runtime config connection test", () => {
  it("rejects without network when required fields are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testAiConnection(primaryAiFields(config({ apiKey: "" })));
    expect(result.valid).toBe(false);
    expect(result.error).toBe("runtime_config_test_incomplete");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports valid on any 2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const result = await testAiConnection(primaryAiFields(config()));
    expect(result.valid).toBe(true);
    vi.unstubAllGlobals();
  });

  it("surfaces provider error messages on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Invalid API key" } }),
      { status: 401 },
    )));
    const result = await testAiConnection(primaryAiFields(config()));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("runtime_config_test_http_401");
    expect(result.error).toContain("Invalid API key");
    vi.unstubAllGlobals();
  });

  it("reports unreachable on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    const result = await testAiConnection(primaryAiFields(config()));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("runtime_config_test_unreachable");
    vi.unstubAllGlobals();
  });
});

describe("runtime config embedding fields", () => {
  it("extracts fields from knowledge.embedding and normalizes missing keys", () => {
    expect(embeddingAiFields(embeddingConfig({ model: "  vec  " }))).toEqual({
      provider: "openai-compatible",
      model: "vec",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-embed",
    });
  });

  it("normalizes a missing knowledge section to empty fields", () => {
    expect(embeddingAiFields({})).toEqual({ provider: "", model: "", baseUrl: "", apiKey: "" });
  });

  it("treats partial embedding config as not configured", () => {
    expect(isEmbeddingConfigured(embeddingAiFields(embeddingConfig()))).toBe(true);
    expect(isEmbeddingConfigured(embeddingAiFields(embeddingConfig({ apiKey: "" })))).toBe(false);
    expect(isEmbeddingConfigured(embeddingAiFields(embeddingConfig({ model: "" })))).toBe(false);
  });

  it("extracts vlm fields and normalizes a missing section", () => {
    expect(vlmAiFields({ vlm: { provider: "openai-compatible", model: " qwen-vl-max ", baseUrl: " https://api.example.com/v1 ", apiKey: "sk-vlm" } })).toEqual({
      provider: "openai-compatible",
      model: "qwen-vl-max",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-vlm",
    });
    expect(vlmAiFields({})).toEqual({ provider: "", model: "", baseUrl: "", apiKey: "" });
    expect(aiFieldsConfigured(vlmAiFields({ vlm: { model: "m", baseUrl: "", apiKey: "k" } }))).toBe(false);
  });
});

describe("runtime config embedding connection test", () => {
  it("rejects without network when required fields are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await testEmbeddingConnection(embeddingAiFields(embeddingConfig({ apiKey: "" })));
    expect(result.valid).toBe(false);
    expect(result.error).toBe("runtime_config_test_incomplete");
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("reports valid with dimensions on a 2xx response carrying a vector", async () => {
    let requestBody: unknown;
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ data: [{ embedding: Array.from({ length: 1536 }, () => 0.1) }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await testEmbeddingConnection(embeddingAiFields(embeddingConfig()), 1536);
    expect(result.valid).toBe(true);
    expect(result.dimensions).toBe(1536);
    expect(requestBody).toMatchObject({
      model: "text-embedding-test",
      input: "ping",
      dimensions: 1536,
    });
    vi.unstubAllGlobals();
  });

  it("rejects a 2xx response missing the embedding vector", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const result = await testEmbeddingConnection(embeddingAiFields(embeddingConfig()));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("runtime_config_test_invalid_response");
    vi.unstubAllGlobals();
  });

  it("surfaces provider error messages on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: "Invalid embedding key" } }),
      { status: 401 },
    )));
    const result = await testEmbeddingConnection(embeddingAiFields(embeddingConfig()));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("runtime_config_test_http_401");
    expect(result.error).toContain("Invalid embedding key");
    vi.unstubAllGlobals();
  });

  it("reports unreachable on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection refused"); }));
    const result = await testEmbeddingConnection(embeddingAiFields(embeddingConfig()));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("runtime_config_test_unreachable");
    vi.unstubAllGlobals();
  });
});
