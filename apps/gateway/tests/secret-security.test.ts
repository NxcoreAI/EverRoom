import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRuntime, ResumeRuntimeRunInput, RuntimeRun, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import type { GatewayConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { agentEvents, agentMessages, agentRuns, runtimeConfigStore } from "../src/infrastructure/database/schema.js";
import { AgentEventBroker } from "../src/modules/agent/event-broker.js";
import { AgentService } from "../src/modules/agent/service.js";
import { McpConfigManager } from "../src/modules/agent/mcp-routes.js";
import { RuntimeConfigManager } from "../src/runtime-config.js";
import {
  redactDelta,
  redactSecrets,
  redactText,
  registerSecret,
  resetSecretRedactionForTests,
} from "../src/security/secret-redaction.js";
import { SecretStore } from "../src/security/secret-store.js";
import { createGatewayLogger } from "../src/server/logger.js";

const directories: string[] = [];
const databases: Array<{ close(): void }> = [];
const key = () => randomBytes(32).toString("base64url");

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "everroom-secret-test-"));
  directories.push(path);
  return path;
}

afterEach(async () => {
  resetSecretRedactionForTests();
  for (const database of databases.splice(0)) database.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("secret storage", () => {
  it("encrypts roundtrips, rejects tampering and wrong or missing keys, and uses private permissions", async () => {
    const root = await directory();
    const path = join(root, "credentials.enc");
    const masterKey = key();
    const canary = "canary-store-51";
    const store = new SecretStore(path, masterKey);
    store.set("mcp:test:env:TOKEN", canary);

    expect(new SecretStore(path, masterKey).get("mcp:test:env:TOKEN")).toBe(canary);
    expect(await readFile(path, "utf8")).not.toContain(canary);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(() => new SecretStore(path, key())).toThrow("secret_store_decryption_failed");
    const beforeUnavailable = await readFile(path, "utf8");
    const unavailable = new SecretStore(path, undefined);
    expect(unavailable.isAvailable()).toBe(false);
    expect(unavailable.get("mcp:test:env:TOKEN")).toBeUndefined();
    expect(() => unavailable.set("mcp:test:env:OTHER", "blocked")).toThrow("secret_store_unavailable");
    expect(await readFile(path, "utf8")).toBe(beforeUnavailable);

    const envelope = JSON.parse(await readFile(path, "utf8")) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    await writeFile(path, JSON.stringify(envelope));
    expect(() => new SecretStore(path, masterKey)).toThrow("secret_store_decryption_failed");
  });

  it("preserves legacy plaintext for later migration when storage is unavailable", async () => {
    const root = await directory();
    const configPath = join(root, "agent", "mcp.json");
    const encryptedPath = join(root, "security", "credentials.enc");
    await mkdir(join(root, "agent"), { recursive: true });
    await mkdir(join(root, "security"), { recursive: true });
    const encrypted = JSON.stringify({ version: 1, iv: "iv", ciphertext: "ciphertext", tag: "tag" });
    await writeFile(encryptedPath, encrypted);
    await writeFile(configPath, JSON.stringify({
      mcpServers: { alpha: { command: "npx", env: { TOKEN: "legacy-plaintext-51" } } },
    }));
    const runtime = { mcp: { mcpServers: {} as Record<string, unknown> } };
    const config = { mcpConfigPath: configPath, pi: runtime, backgroundPi: null } as unknown as GatewayConfig;
    const manager = new McpConfigManager(config, new SecretStore(encryptedPath, undefined));

    expect(manager.snapshot().servers.alpha?.env).toEqual({ TOKEN: { configured: false } });
    expect(runtime.mcp.mcpServers).toEqual({ alpha: { command: "npx" } });
    expect(await readFile(configPath, "utf8")).toContain("legacy-plaintext-51");
    expect(await readFile(encryptedPath, "utf8")).toBe(encrypted);

    const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
    databases.push(database.sqlite);
    database.db.insert(runtimeConfigStore).values({
      source: "user",
      payload: {
        schemaVersion: 1,
        webSearch: { provider: "openai-compatible", api: "openai-completions", model: "search", baseUrl: "https://search.test/v1", apiKey: "legacy-search-plaintext-51" },
      },
      schemaVersion: 1,
      configVersion: 1,
      updatedAt: new Date(),
    }).run();
    const runtimeConfig = new RuntimeConfigManager(
      database.db,
      new SecretStore(encryptedPath, undefined),
      resolve("runtime-config.default.json"),
    );
    const stored = database.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, "user")).get();
    expect(JSON.stringify(stored?.payload)).toContain("legacy-search-plaintext-51");
    expect(runtimeConfig.snapshot().config.webSearch?.apiKey).not.toBe("legacy-search-plaintext-51");
    expect(runtimeConfig.snapshot().webSearchCredential.configured).toBe(false);
  });

  it("migrates MCP plaintext without leaking and supports keep, set, delete, rename, list, and server delete", async () => {
    const root = await directory();
    const configPath = join(root, "agent", "mcp.json");
    const encryptedPath = join(root, "security", "credentials.enc");
    const canary = "canary-mcp-old-51";
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: { alpha: { command: "npx", env: { TOKEN: canary }, headers: { Authorization: "canary-header-51" } } },
    }));
    const runtime = { mcp: { mcpServers: {} as Record<string, unknown> } };
    const config = { mcpConfigPath: configPath, pi: runtime, backgroundPi: null } as unknown as GatewayConfig;
    const manager = new McpConfigManager(config, new SecretStore(encryptedPath, key()));

    expect(manager.snapshot().servers.alpha).toMatchObject({
      env: { TOKEN: { configured: true } },
      headers: { Authorization: { configured: true } },
    });
    expect(JSON.stringify(manager.snapshot())).not.toContain(canary);
    expect(await readFile(configPath, "utf8")).not.toContain(canary);
    expect(await readFile(encryptedPath, "utf8")).not.toContain(canary);

    manager.update({
      beta: {
        previousName: "alpha", command: "npx",
        env: { TOKEN: { operation: "keep" }, NEXT: { operation: "set", value: "canary-mcp-new-51" } },
        headers: { Authorization: { operation: "keep" } },
      },
    });
    expect(runtime.mcp.mcpServers).toMatchObject({
      beta: { env: { TOKEN: canary, NEXT: "canary-mcp-new-51" }, headers: { Authorization: "canary-header-51" } },
    });
    manager.update({
      beta: { command: "npx", env: { TOKEN: { operation: "delete" }, NEXT: { operation: "keep" } } },
    });
    expect(manager.snapshot().servers.beta?.env).toEqual({ NEXT: { configured: true } });
    manager.update({});
    expect(manager.snapshot().servers).toEqual({});
    expect(runtime.mcp.mcpServers).toEqual({});
  });

  it("migrates Search plaintext and supports add, rotate, delete, and source fallback", async () => {
    const root = await directory();
    const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
    databases.push(database.sqlite);
    database.db.insert(runtimeConfigStore).values({
      source: "user",
      payload: {
        schemaVersion: 1,
        webSearch: { provider: "openai-compatible", api: "openai-completions", model: "search", baseUrl: "https://search.test/v1", apiKey: "canary-search-legacy-51" },
      },
      schemaVersion: 1,
      configVersion: 1,
      updatedAt: new Date(),
    }).run();
    const encryptedPath = join(root, "credentials.enc");
    const manager = new RuntimeConfigManager(
      database.db,
      new SecretStore(encryptedPath, key()),
      resolve("runtime-config.default.json"),
      { provider: "openai-compatible", api: "openai-completions", model: "env", baseUrl: "https://env.test/v1", apiKey: "canary-search-env-51" },
    );
    const migrated = database.db.select().from(runtimeConfigStore).where(eq(runtimeConfigStore.source, "user")).get();
    expect(JSON.stringify(migrated?.payload)).not.toContain("canary-search-legacy-51");
    expect(await readFile(encryptedPath, "utf8")).not.toContain("canary-search-legacy-51");
    expect(manager.snapshot(true).config.webSearch).not.toHaveProperty("apiKey");
    expect(manager.snapshot(true).webSearchCredential).toEqual({ configured: true, source: "user" });

    manager.set("saas", {
      schemaVersion: 1,
      webSearch: { provider: "openai-compatible", api: "openai-completions", model: "saas", baseUrl: "https://saas.test/v1", apiKey: "canary-search-saas-51" },
    });
    manager.set("user", {
      schemaVersion: 1,
      webSearch: { provider: "openai-compatible", api: "openai-completions", model: "user", baseUrl: "https://user.test/v1", apiKey: { operation: "set", value: "canary-search-new-51" } },
    });
    expect(manager.snapshot().config.webSearch?.apiKey).toBe("canary-search-new-51");
    manager.set("user", {
      schemaVersion: 1,
      webSearch: { provider: "openai-compatible", api: "openai-completions", model: "user", baseUrl: "https://user.test/v1", apiKey: { operation: "set", value: "canary-search-rotated-51" } },
    });
    expect(manager.snapshot().config.webSearch?.apiKey).toBe("canary-search-rotated-51");
    expect(redactText("canary-search-new-51")).not.toContain("canary-search-new-51");
    manager.set("user", {
      schemaVersion: 1,
      webSearch: { provider: "openai-compatible", api: "openai-completions", model: "user", baseUrl: "https://user.test/v1", apiKey: { operation: "delete" } },
    });
    expect(manager.snapshot().webSearchCredential.source).toBe("saas");
    manager.clear("saas");
    expect(manager.snapshot().webSearchCredential.source).toBe("env");
  });
});

describe("secret redaction", () => {
  it("removes registered values, encoded values, nested sensitive fields, Errors, split deltas, and gateway file logs", async () => {
    const root = await directory();
    const canary = "canary / nested+51";
    registerSecret(canary);
    const nested = redactSecrets({
      tool: { args: { query: `https://test/?key=${encodeURIComponent(canary)}` }, result: { token: canary } },
      error: new Error(`failed ${canary}`),
    });
    expect(JSON.stringify(nested)).not.toContain(canary);
    expect(JSON.stringify(nested)).not.toContain(encodeURIComponent(canary));
    const parts = ["canary /", " nested", "+51"].map((part) => redactDelta("run-1", part)).join("");
    expect(parts).not.toContain(canary);

    const gateway = await createGatewayLogger(root, "info");
    gateway.logger.info({ nested, raw: canary, url: `https://test/?key=${encodeURIComponent(canary)}` }, `error ${canary}`);
    await gateway.close();
    const names = await readdir(join(root, "logs"));
    const logs = (await Promise.all(names.map((name) => readFile(join(root, "logs", name), "utf8")))).join("\n");
    expect(logs).not.toContain(canary);
    expect(logs).not.toContain(encodeURIComponent(canary));
  });

  it("keeps Date instances intact so API timestamps serialize as ISO strings", () => {
    const createdAt = new Date("2026-08-27T13:00:00.000Z");
    const payload = redactSecrets({ run: { id: "r1", createdAt, startedAt: null }, list: [createdAt] });
    expect(payload.run.createdAt).toBeInstanceOf(Date);
    expect(payload.list[0]).toBe(createdAt);
    expect(JSON.stringify(payload)).toContain("2026-08-27T13:00:00.000Z");
  });

  it("redacts prompts, tool args/results, split output, DB messages/events, WebSocket frames, chat, and timeline snapshots", async () => {
    const root = await directory();
    const canary = "canary-agent-output-51";
    registerSecret(canary);
    class CanaryRuntime implements AgentRuntime {
      readonly id = "canary-runtime";
      async getCapabilities(): Promise<RuntimeCapabilities> { return { streaming: true, reasoning: false, tools: true, steering: false, resume: false }; }
      async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
        async function* events() {
          yield { type: "run.started" as const, payload: {} };
          yield { type: "tool.requested" as const, payload: { toolCallId: "tool-1", name: "test", args: { nested: canary } } };
          yield { type: "tool.completed" as const, payload: { toolCallId: "tool-1", name: "test", args: { value: canary }, result: { url: `https://test/?key=${encodeURIComponent(canary)}` } } };
          yield { type: "message.delta" as const, payload: { delta: canary.slice(0, 9) } };
          yield { type: "message.delta" as const, payload: { delta: canary.slice(9) } };
          yield { type: "message.completed" as const, payload: { role: "assistant", content: `answer ${canary}` } };
          yield { type: "run.completed" as const, payload: {} };
        }
        return { runId: input.runId, runtimeSessionRef: "canary-session", events: events() };
      }
      async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> { throw new Error("unsupported"); }
      async sendInput(): Promise<void> {}
      async cancel(): Promise<void> {}
      async deleteSession(): Promise<void> {}
      async dispose(): Promise<void> {}
    }
    const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
    databases.push(database.sqlite);
    const broker = new AgentEventBroker();
    const service = new AgentService(database.db, new CanaryRuntime(), broker);
    await service.initialize();
    const session = service.createSession({ pageLabel: "test" });
    const frames: string[] = [];
    broker.subscribe(session.id, { readyState: 1, send: (data) => frames.push(data) });
    const run = await service.startRun(session.id, { prompt: `prompt ${canary}`, idempotencyKey: "canary-run-51" });
    const deadline = Date.now() + 2_000;
    while (service.getRun(run.id)?.status === "accepted" || service.getRun(run.id)?.status === "running") {
      if (Date.now() > deadline) throw new Error("canary run timed out");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    const persisted = JSON.stringify({
      runs: database.db.select().from(agentRuns).all(),
      messages: database.db.select().from(agentMessages).all(),
      events: database.db.select().from(agentEvents).all(),
    });
    const publicData = JSON.stringify({ snapshot: service.getSnapshot(session.id), frames });
    expect(persisted).not.toContain(canary);
    expect(persisted).not.toContain(encodeURIComponent(canary));
    expect(publicData).not.toContain(canary);
    expect(publicData).not.toContain(encodeURIComponent(canary));
    await service.dispose();
  });
});
