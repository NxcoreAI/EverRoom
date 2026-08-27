import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UnconfiguredAgentRuntime } from "@nxcore/agent-runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig, SubagentFrameworkConfig } from "../src/config.js";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { subagentInvocationEvents, subagentRevisions } from "../src/infrastructure/database/schema.js";
import { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import { SubagentRegistry } from "../src/modules/subagents/registry.js";
import {
  createSubagentSkillReadTool,
  SubagentResultCollector,
  SubagentRuntimeManager,
} from "../src/modules/subagents/runtime-manager.js";

const temporaryDirectories: string[] = [];
const logger = { info: () => undefined, warn: () => undefined };

async function createFixture(options: { inputSchema?: boolean; outputSchema?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "everroom-subagents-"));
  temporaryDirectories.push(root);
  const definitionsDir = join(root, "agents");
  const bundleDir = join(definitionsDir, "researcher");
  await mkdir(join(bundleDir, "skills", "summarize"), { recursive: true });
  await writeFile(join(bundleDir, "SYSTEM.md"), "你负责研究给定主题并返回准确摘要。\n", "utf8");
  await writeFile(join(bundleDir, "skills", "summarize", "SKILL.md"), [
    "---",
    "name: summarize",
    "description: Extract facts and produce a concise summary",
    "---",
    "",
    "# Summarize",
    "",
    "提取事实。",
    "",
  ].join("\n"), "utf8");
  if (options.inputSchema) {
    await writeFile(join(bundleDir, "input.schema.json"), JSON.stringify({
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    }), "utf8");
  }
  if (options.outputSchema) {
    await writeFile(join(bundleDir, "output.schema.json"), JSON.stringify({
      type: "object",
      properties: { answer: { type: "string", minLength: 1 } },
      required: ["answer"],
      additionalProperties: false,
    }), "utf8");
  }
  await writeFile(join(bundleDir, "agent.yaml"), [
    "schemaVersion: 1",
    "id: researcher",
    "name: Researcher",
    "description: Researches a bounded topic",
    "mode: dispatch_only",
    "systemPrompt: ./SYSTEM.md",
    "skills:",
    "  - ./skills/summarize",
    "mcp:",
    "  - server: search",
    "    includeTools: [search]",
    ...(options.inputSchema ? ["inputSchema: ./input.schema.json"] : []),
    ...(options.outputSchema ? ["outputSchema: ./output.schema.json"] : []),
    "policy:",
    "  allowedCallers: [primary-agent]",
    "  timeoutMs: 10000",
    "  maxConcurrency: 1",
    "  maxToolCalls: 8",
    "",
  ].join("\n"), "utf8");
  const config: SubagentFrameworkConfig = {
    enabled: true,
    definitionsDir,
    runtimeDir: join(root, "runtime"),
    defaultTimeoutMs: 30_000,
    maxConcurrent: 4,
  };
  const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  const registry = new SubagentRegistry(database.db, config, {
    search: { url: "https://mcp.example.test", headers: { Authorization: "test-secret" } },
  }, logger);
  return { root, bundleDir, config, database, registry };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("filesystem subagent framework", () => {
  it("loads bundles, snapshots skills and creates a new immutable revision after changes", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();
    const first = fixture.registry.get("researcher");
    expect(first).toMatchObject({ name: "Researcher", enabled: true });
    expect(first?.revision.version).toBe(1);
    expect(first?.revision.mcpServers).toEqual({
      search: {
        url: "https://mcp.example.test",
        headers: { Authorization: "test-secret" },
        includeTools: ["search"],
      },
    });
    expect(first?.revision.agentDirectory).toContain(first?.revision.digest);
    const readTool = createSubagentSkillReadTool(first!.revision);
    const runContext = {
      runId: "read-run",
      sessionId: "read-session",
      runtimeSessionRef: null,
      prompt: "read skill",
      pageLabel: "Subagent",
      roomId: null,
    };
    await expect(readTool.execute(runContext, {
      path: join(first!.revision.agentDirectory, "skills", "summarize", "SKILL.md"),
    })).resolves.toMatchObject({ content: expect.stringContaining("Extract facts") });
    await expect(readTool.execute(runContext, { path: join(fixture.root, "gateway.sqlite") }))
      .rejects.toThrow("subagent_skill_path_not_allowed");

    await fixture.registry.initialize();
    expect(fixture.database.db.select().from(subagentRevisions).all()).toHaveLength(1);

    await writeFile(join(fixture.bundleDir, "SYSTEM.md"), "你负责研究并且必须附带来源。\n", "utf8");
    await fixture.registry.initialize();
    const second = fixture.registry.get("researcher");
    expect(second?.revision.version).toBe(2);
    expect(second?.revision.id).not.toBe(first?.revision.id);
    expect(fixture.database.db.select().from(subagentRevisions).all()).toHaveLength(2);
    fixture.database.sqlite.close();
  });

  it("dispatches through an isolated runtime and rejects unauthorized or invalid input", async () => {
    const fixture = await createFixture({ inputSchema: true });
    await fixture.registry.initialize();
    const gatewayConfig = { agentRuntime: "fake" } as GatewayConfig;
    const runtimeManager = new SubagentRuntimeManager(gatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );
    expect(orchestrator.initialize()).toBe(0);

    await expect(orchestrator.dispatch({
      agentId: "researcher",
      task: "Research",
      input: {},
      idempotencyKey: "invalid-input",
      source: "primary_agent",
      parentRunId: "run-invalid",
    })).rejects.toThrow("subagent_input_schema_invalid");
    await expect(orchestrator.dispatch({
      agentId: "researcher",
      task: "Research",
      input: { topic: "EverRoom" },
      idempotencyKey: "invalid-caller",
      source: "scheduler",
    })).rejects.toThrow("subagent_caller_not_allowed");

    const invocation = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Research the EverRoom architecture",
      input: { topic: "EverRoom" },
      idempotencyKey: "valid-dispatch",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
    });
    expect(invocation).toMatchObject({
      agentDefinitionId: "researcher",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
      status: "completed",
    });
    expect(invocation.result?.text).toContain("Fake Runtime");
    expect(fixture.database.db.select().from(subagentInvocationEvents).all().length).toBeGreaterThan(3);

    const duplicate = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Research the EverRoom architecture",
      input: { topic: "EverRoom" },
      idempotencyKey: "valid-dispatch",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
    });
    expect(duplicate.id).toBe(invocation.id);

    const controller = new AbortController();
    const cancelledPromise = orchestrator.dispatch({
      agentId: "researcher",
      task: "A parent-owned task that will be cancelled",
      input: { topic: "Cancellation" },
      idempotencyKey: "cancelled-dispatch",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-2",
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelledPromise).resolves.toMatchObject({ status: "cancelled" });
    await orchestrator.dispose();
    fixture.database.sqlite.close();
  }, 15_000);

  it("accepts formal results only through the schema-validated submit tool and isolates concurrent runs", async () => {
    const fixture = await createFixture({ outputSchema: true });
    await fixture.registry.initialize();
    const revision = fixture.registry.get("researcher")!.revision;
    const collector = new SubagentResultCollector();
    const tool = collector.createTool(revision)!;
    const context = (runId: string) => ({
      runId,
      sessionId: runId,
      runtimeSessionRef: null,
      prompt: "submit",
      pageLabel: "Subagent",
      roomId: null,
    });

    await expect(tool.execute(context("run-unbound"), { answer: "unbound" }))
      .rejects.toThrow("subagent_result_invocation_mismatch");
    collector.prepare(revision.id, "run-invalid", {});
    await expect(tool.execute(context("run-invalid"), {}))
      .rejects.toThrow("subagent_result_schema_invalid");
    expect(collector.take(revision.id, "run-invalid")).toBeNull();

    collector.prepare(revision.id, "run-a", { topic: "A" });
    collector.prepare(revision.id, "run-b", { topic: "B" });
    await Promise.all([
      tool.execute(context("run-a"), { answer: "A" }),
      tool.execute(context("run-b"), { answer: "B" }),
    ]);
    expect(collector.take(revision.id, "run-b")).toEqual({ answer: "B" });
    expect(collector.take(revision.id, "run-a")).toEqual({ answer: "A" });
    collector.prepare(revision.id, "run-c", {});
    await expect(tool.execute(context("run-c"), { answer: "first" })).resolves.toBeDefined();
    await expect(tool.execute(context("run-c"), { answer: "second" }))
      .rejects.toThrow("subagent_result_already_submitted");

    fixture.database.sqlite.close();
  });

  it("does not parse a final text message as a formal result when submission is missing", async () => {
    const fixture = await createFixture({ outputSchema: true });
    await fixture.registry.initialize();
    const runtimeManager = new SubagentRuntimeManager(
      { agentRuntime: "fake" } as GatewayConfig,
      fixture.config,
    );
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );
    orchestrator.initialize();

    const invocation = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Return a JSON-looking answer",
      input: {},
      idempotencyKey: "missing-submit-result",
      source: "primary_agent",
      parentRunId: "parent-run",
    });
    expect(invocation).toMatchObject({
      status: "failed",
      result: null,
      errorMessage: "subagent_result_not_submitted",
    });

    await orchestrator.dispose();
    fixture.database.sqlite.close();
  });

  it("degrades to UnconfiguredAgentRuntime when pi fields are empty and invalidate() clears the cache", async () => {
    const fixture = await createFixture({});
    await fixture.registry.initialize();
    // pi 模式 + 空字段（env 全空 + runtime config 未保存的降级启动态）。
    const gatewayConfig = {
      agentRuntime: "pi",
      pi: {
        provider: "", model: "", baseUrl: "", apiKey: "",
        api: "openai-completions", maxTokens: 8192, contextWindow: 128000,
        temperature: 0.3, reasoning: "medium",
      },
    } as unknown as GatewayConfig;
    const runtimeManager = new SubagentRuntimeManager(gatewayConfig, fixture.config);
    const researcher = fixture.registry.get("researcher");
    expect(researcher).not.toBeNull();
    const runtime = runtimeManager.acquire(researcher!.revision);
    expect(runtime).toBeInstanceOf(UnconfiguredAgentRuntime);
    // 缓存命中：同一 revision 拿到同一实例
    expect(runtimeManager.acquire(researcher!.revision)).toBe(runtime);
    // 热应用后作废缓存：下次 acquire 重建（仍是占位——config 没变）
    await runtimeManager.invalidate();
    const rebuilt = runtimeManager.acquire(researcher!.revision);
    expect(rebuilt).not.toBe(runtime);
    fixture.database.sqlite.close();
  });
});
