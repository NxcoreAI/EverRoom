import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
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
import { createDatabase } from "../src/infrastructure/database/client.js";
import { RuntimeConfigManager } from "../src/runtime-config.js";
import { SecretStore } from "../src/security/secret-store.js";

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

// ── set() 幂等短路（真实 manager + sqlite）─────────────────────────────────

const dedupeDirs: string[] = [];
const dedupeDbs: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const database of dedupeDbs.splice(0)) database.close();
  await Promise.all(dedupeDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function dedupeManager(): Promise<{ manager: RuntimeConfigManager; secrets: SecretStore }> {
  const root = await mkdtemp(join(tmpdir(), "everroom-rc-dedupe-"));
  dedupeDirs.push(root);
  await mkdir(join(root, "security"), { recursive: true });
  const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  dedupeDbs.push(database.sqlite);
  const secrets = new SecretStore(join(root, "security", "credentials.enc"), randomBytes(32).toString("base64url"));
  const manager = new RuntimeConfigManager(
    database.db,
    secrets,
    resolve("runtime-config.default.json"),
    null,
    null,
  );
  return { manager, secrets };
}

describe("runtime config set idempotency", () => {
  const saasPayload = {
    schemaVersion: 1,
    primary: {
      provider: "openai-compatible",
      model: "test-model",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
    },
  };

  it("同 payload 重复保存短路：版本不递增、onChange 只发一次；变更正常生效", async () => {
    const { manager } = await dedupeManager();
    let emissions = 0;
    manager.onChange(() => { emissions += 1; });

    const first = manager.set("saas", saasPayload);
    expect(emissions).toBe(1);

    // 键序不同的等价 payload（两条保存链路来源不同）同样命中短路。
    const second = manager.set("saas", {
      primary: { ...saasPayload.primary },
      schemaVersion: 1,
    });
    expect(second.configVersion).toBe(first.configVersion);
    expect(emissions).toBe(1);

    const third = manager.set("saas", {
      ...saasPayload,
      primary: { ...saasPayload.primary, model: "another-model" },
    });
    expect(third.configVersion).toBeGreaterThan(first.configVersion);
    expect(emissions).toBe(2);
  });

  it("仅轮换搜索密钥不短路：新密钥真实落库（apiKey 比较前已剥除、走 secrets 通道）", async () => {
    const { manager, secrets } = await dedupeManager();
    let emissions = 0;
    manager.onChange(() => { emissions += 1; });
    const base = {
      schemaVersion: 1,
      primary: {
        provider: "openai-compatible",
        model: "test-model",
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
      },
      webSearch: {
        provider: "openai-compatible",
        model: "search-model",
        baseUrl: "https://api.example.com/v1",
        apiKey: "key-one",
      },
    };
    manager.set("user", base);
    expect(secrets.get("search:user")).toBe("key-one");
    expect(emissions).toBe(1);

    // 只换搜索密钥：剥除 apiKey 后 payload 与库中相同，但密钥不同必须生效。
    manager.set("user", { ...base, webSearch: { ...base.webSearch, apiKey: "key-two" } });
    expect(secrets.get("search:user")).toBe("key-two");
    expect(emissions).toBe(2);

    // 删除搜索密钥同样不能被短路吞掉。
    manager.set("user", { ...base, webSearch: { ...base.webSearch, apiKey: { operation: "delete" } } });
    expect(secrets.get("search:user")).toBeUndefined();
    expect(emissions).toBe(3);
  });

  it("user 源重存相同配置仍切回 user 选中（保存 BYOK 即切源的唯一机制）", async () => {
    const { manager } = await dedupeManager();
    const userPayload = {
      schemaVersion: 1,
      primary: {
        provider: "openai-compatible",
        model: "byok-model",
        baseUrl: "https://byok.example.com/v1",
        apiKey: "sk-byok",
      },
    };
    manager.set("user", userPayload);
    manager.set("saas", saasPayload);
    manager.selectSource("saas");
    expect(manager.snapshot().selectedSource).toBe("saas");

    let emissions = 0;
    manager.onChange(() => { emissions += 1; });
    manager.set("user", userPayload);
    expect(emissions).toBe(1);
    const snapshot = manager.snapshot();
    expect(snapshot.selectedSource).toBe("user");
    expect(snapshot.config.primary?.model).toBe("byok-model");

    // 切回后再重复保存相同 user 配置：此时允许短路。
    manager.set("user", userPayload);
    expect(emissions).toBe(1);
  });
});
