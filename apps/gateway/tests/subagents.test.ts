import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { UnconfiguredAgentRuntime, type AgentRuntime, type RuntimeEvent, type StartRuntimeRunInput } from "@nxcore/agent-runtime";
import { FakeAgentRuntime } from "@nxcore/agent-runtime/testing";
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

async function createFixture(options: {
  inputSchema?: boolean;
  outputSchema?: boolean;
  /** 追加到 agent.yaml 的 policy 子句（如 model 覆盖）。 */
  policyLines?: string[];
} = {}) {
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
    ...(options.policyLines ?? []),
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

describe("shipped slides-planner bundle", () => {
  it("冒烟期放宽墙钟、长链路不设工具预算：planner 1800s / 显式输出上限", async () => {
    const root = await mkdtemp(join(tmpdir(), "everroom-subagents-shipped-"));
    temporaryDirectories.push(root);
    const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
    const registry = new SubagentRegistry(database.db, {
      enabled: true,
      definitionsDir: resolve("../../agents"),
      runtimeDir: join(root, "runtime"),
      defaultTimeoutMs: 30_000,
      maxConcurrent: 4,
    }, {}, logger);
    await registry.initialize();
    const planner = registry.get("slides-planner");
    expect(planner).not.toBeNull();
    expect(planner!.revision.policy).toMatchObject({
      timeoutMs: 1_800_000,
      model: { reasoning: "off", maxTokens: 32_768 },
    });
    expect(planner!.revision.policy.maxToolCalls).toBeUndefined();
    // arrange 的素材命中由网关预取、长 deck 由网关分批：输入契约必须接住两者。
    const inputSchema = planner!.revision.inputSchema as { properties?: Record<string, unknown> } | null;
    expect(inputSchema?.properties).toHaveProperty("materialHits");
    expect(inputSchema?.properties).toHaveProperty("arrangeBatch");
    // 布局代理与主 Agent 同底座（主模型）：输出上限显式给 128k（整页 v2 树 + 校验修复轮）；
    // 思考档按 bundle 配置。工具调用不设硬上限——长链路「读资料 → 多轮校验/提交」
    // 不能半路被预算 abort。
    const layouter = registry.get("slides-layouter");
    expect(layouter).not.toBeNull();
    expect(layouter!.revision.policy).toMatchObject({
      timeoutMs: 1_800_000,
      model: { reasoning: "low", maxTokens: 131_072 },
    });
    expect(layouter!.revision.policy.maxToolCalls).toBeUndefined();
    // 修复器同样不设工具预算；builder/styler 走 background 档，必须显式抬输出上限。
    expect(registry.get("slides-editor")!.revision.policy).toMatchObject({ timeoutMs: 900_000 });
    expect(registry.get("slides-editor")!.revision.policy.maxToolCalls).toBeUndefined();
    expect(registry.get("slides-builder")!.revision.policy).toMatchObject({
      timeoutMs: 1_800_000,
      model: { maxTokens: 32_768 },
    });
    expect(registry.get("slides-styler")!.revision.policy).toMatchObject({
      timeoutMs: 600_000,
      model: { maxTokens: 32_768 },
    });
  });
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

  it("parses policy.model overrides and rejects invalid reasoning levels", async () => {
    const fixture = await createFixture({
      policyLines: ["  model:", "    reasoning: low", "    contextWindow: 96000", "    maxTokens: 16384"],
    });
    await fixture.registry.initialize();
    expect(fixture.registry.get("researcher")?.revision.policy.model).toEqual({
      reasoning: "low",
      contextWindow: 96_000,
      maxTokens: 16_384,
    });
    fixture.database.sqlite.close();

    const invalid = await createFixture({ policyLines: ["  model:", "    reasoning: turbo"] });
    // 非法 bundle 在 initialize 中被拒绝并跳过（warn 记录），不会进入注册表。
    await invalid.registry.initialize();
    expect(invalid.registry.get("researcher")).toBeNull();
    invalid.database.sqlite.close();
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

  it("listInvocationTree：按 run 收拢两层调用树，附带展示名并按创建时间排序", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();
    const runtimeManager = new SubagentRuntimeManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );

    const parent = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Parent task",
      input: { topic: "EverRoom" },
      idempotencyKey: "tree-parent",
      source: "primary_agent",
      parentSessionId: "session-tree",
      parentRunId: "run-tree",
    });
    const child = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Child task",
      input: { topic: "EverRoom" },
      idempotencyKey: "tree-child",
      source: "primary_agent",
      parentSessionId: "session-tree",
      parentRunId: parent.id,
    });

    const tree = orchestrator.listInvocationTree("run-tree");
    expect(tree.map((node) => [node.id, node.agentName, node.parentRunId])).toEqual([
      [parent.id, "Researcher", "run-tree"],
      [child.id, "Researcher", parent.id],
    ]);
    expect(orchestrator.listInvocationTree("run-missing")).toEqual([]);

    await orchestrator.dispose();
    fixture.database.sqlite.close();
  }, 15_000);

  it("listInvocationTree：附带每个子代理自己最近的上下文用量与压缩态", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();
    const runtimeManager = new SubagentRuntimeManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );

    const parent = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Parent task",
      input: { topic: "EverRoom" },
      idempotencyKey: "usage-parent",
      source: "primary_agent",
      parentSessionId: "session-usage",
      parentRunId: "run-usage",
    });
    const child = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Child task",
      input: { topic: "EverRoom" },
      idempotencyKey: "usage-child",
      source: "primary_agent",
      parentSessionId: "session-usage",
      parentRunId: parent.id,
    });

    // 子 run 的 context.usage / context.compaction 事件本就会随 consumeEvents 落库。
    const insertEvent = (invocationId: string, type: string, payload: unknown) => {
      const seq = (orchestrator.listInvocationEvents(invocationId).at(-1)?.seq ?? 0) + 1;
      fixture.database.db.insert(subagentInvocationEvents).values({
        id: `${invocationId}-${seq}-${type}`,
        invocationId,
        seq,
        type,
        payload,
        createdAt: new Date(),
      }).run();
    };
    insertEvent(parent.id, "context.usage", {
      tokens: 41_200,
      contextWindow: 128_000,
      percent: 32.2,
      segments: [{ key: "systemPrompt", tokens: 5_200 }],
    });
    insertEvent(parent.id, "context.compaction", { active: false, reason: "threshold" });
    insertEvent(parent.id, "context.compaction", { active: true, reason: "threshold" });
    insertEvent(child.id, "context.usage", { tokens: null, contextWindow: 128_000, percent: null });

    const tree = orchestrator.listInvocationTree("run-usage");
    const parentNode = tree.find((node) => node.id === parent.id)!;
    expect(parentNode.contextUsage).toEqual({
      tokens: 41_200,
      contextWindow: 128_000,
      percent: 32.2,
      segments: [{ key: "systemPrompt", tokens: 5_200 }],
    });
    expect(parentNode.contextCompacting).toBe(true);
    const childNode = tree.find((node) => node.id === child.id)!;
    // 压缩刚结束的快照：tokens 未知但窗口已知，原样透传给圆环（只剩轨道）。
    expect(childNode.contextUsage).toEqual({ tokens: null, contextWindow: 128_000, percent: null });
    expect(childNode.contextCompacting).toBeUndefined();

    await orchestrator.dispose();
    fixture.database.sqlite.close();
  }, 15_000);

  it("listInvocationEvents：按 seq 升序返回执行事件，afterSeq 增量过滤", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();

    class ToolEmittingRuntime implements AgentRuntime {
      readonly id = "fake-tools";
      async getCapabilities() {
        return { streaming: true, reasoning: true, tools: true, steering: false, resume: false };
      }
      async start(input: StartRuntimeRunInput) {
        const runId = input.runId;
        return {
          runId,
          runtimeSessionRef: `fake-${runId}`,
          events: (async function* generate(): AsyncGenerator<RuntimeEvent> {
            yield { type: "run.started", payload: {} };
            yield { type: "tool.requested", payload: { toolCallId: "call-1", name: "wiki_search", args: { query: "EverRoom" } } };
            yield { type: "tool.completed", payload: { toolCallId: "call-1", name: "wiki_search", result: { results: [1, 2, 3] } } };
            yield { type: "message.completed", payload: { role: "assistant", content: "完成。" } };
            yield { type: "run.completed", payload: {} };
          })(),
        };
      }
      async resume(): Promise<never> { throw new Error("no resume"); }
      async sendInput(): Promise<never> { throw new Error("no steering"); }
      async cancel(): Promise<void> {}
      async deleteSession(): Promise<void> {}
      async dispose(): Promise<void> {}
    }

    const runtimeManager = new SubagentRuntimeManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );
    // 事件结构无关运行时实现：直接替换为带工具事件的桩运行时。
    (runtimeManager as unknown as { runtimes: Map<string, AgentRuntime> }).runtimes.set(
      fixture.registry.get("researcher")!.revision.id,
      new ToolEmittingRuntime(),
    );

    const invocation = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Emit tool events",
      input: { topic: "EverRoom" },
      idempotencyKey: "events-dispatch",
      source: "primary_agent",
      parentSessionId: "session-events",
      parentRunId: "run-events",
    });
    expect(invocation.status).toBe("completed");

    const all = orchestrator.listInvocationEvents(invocation.id);
    expect(all.map((event) => event.type)).toEqual([
      "run.started",
      "tool.requested",
      "tool.completed",
      "message.completed",
      "run.completed",
    ]);
    expect(all[1]!.payload).toMatchObject({ toolCallId: "call-1", name: "wiki_search", args: { query: "EverRoom" } });

    const later = orchestrator.listInvocationEvents(invocation.id, all[1]!.seq);
    expect(later.map((event) => event.type)).toEqual(["tool.completed", "message.completed", "run.completed"]);
    expect(orchestrator.listInvocationEvents("unknown-invocation")).toEqual([]);

    await orchestrator.dispose();
    fixture.database.sqlite.close();
  }, 15_000);

  it("子 run 不再绑定 Room：dispatch input 的 roomId 不再透传到 runtime.start", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();

    class RecordingFakeRuntime extends FakeAgentRuntime {
      readonly startedInputs: StartRuntimeRunInput[] = [];
      override async start(input: StartRuntimeRunInput): Promise<Awaited<ReturnType<AgentRuntime["start"]>>> {
        this.startedInputs.push(input);
        return super.start(input);
      }
    }
    class RecordingRuntimeManager extends SubagentRuntimeManager {
      private readonly recording = new RecordingFakeRuntime();
      override acquire(_revision: Parameters<SubagentRuntimeManager["acquire"]>[0]): AgentRuntime {
        return this.recording;
      }
    }
    const runtimeManager = new RecordingRuntimeManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );
    orchestrator.initialize();

    const recording = (runtimeManager as RecordingRuntimeManager)["recording"];
    await orchestrator.dispatch({
      agentId: "researcher",
      task: "Research",
      input: { topic: "EverRoom", roomId: "room-9" },
      idempotencyKey: "room-passthrough",
      source: "primary_agent",
      parentRunId: "run-room",
    });
    // 去 Room：即使调用方仍带历史 roomId 字段，子 run 也不再绑定房间（文档工具走工作区）。
    expect(recording.startedInputs.at(-1)?.roomId).toBeNull();
    // 结构化输入同时以 runtimeMetadata 交给工具（planner 据此区分 draft/arrange）。
    // 原始 input 原样保留在元数据里，只是不再解读 roomId。
    expect(recording.startedInputs.at(-1)?.runtimeMetadata).toMatchObject({
      subagentAgentId: "researcher",
      subagentInput: { topic: "EverRoom", roomId: "room-9" },
    });

    await orchestrator.dispatch({
      agentId: "researcher",
      task: "Research",
      input: { topic: "EverRoom" },
      idempotencyKey: "room-absent",
      source: "primary_agent",
      parentRunId: "run-noroom",
    });
    expect(recording.startedInputs.at(-1)?.roomId).toBeNull();

    await orchestrator.dispose();
    fixture.database.sqlite.close();
  }, 15_000);

  it("透传 dispatch attachments 到 runtime.start（多模态看图通道），input JSON 不携带", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();

    class RecordingFakeRuntime extends FakeAgentRuntime {
      readonly startedInputs: StartRuntimeRunInput[] = [];
      override async start(input: StartRuntimeRunInput): Promise<Awaited<ReturnType<AgentRuntime["start"]>>> {
        this.startedInputs.push(input);
        return super.start(input);
      }
    }
    class RecordingRuntimeManager extends SubagentRuntimeManager {
      private readonly recording = new RecordingFakeRuntime();
      override acquire(_revision: Parameters<SubagentRuntimeManager["acquire"]>[0]): AgentRuntime {
        return this.recording;
      }
    }
    const runtimeManager = new RecordingRuntimeManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(
      fixture.database.db,
      fixture.config,
      fixture.registry,
      runtimeManager,
      logger,
    );
    orchestrator.initialize();

    const recording = (runtimeManager as RecordingRuntimeManager)["recording"];
    const attachment = { filename: "page.png", mimeType: "image/png", kind: "image" as const, dataUrl: "data:image/png;base64,aGk=" };
    const invocation = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Review",
      input: { pageIndex: 3 },
      attachments: [attachment],
      idempotencyKey: "attachment-passthrough",
      source: "primary_agent",
      parentRunId: "run-attach",
    });
    expect(recording.startedInputs.at(-1)?.attachments).toEqual([attachment]);
    // 落库 input 不含 base64 附件。
    expect(JSON.stringify(invocation.input)).not.toContain("data:image/png");

    await orchestrator.dispatch({
      agentId: "researcher",
      task: "Research",
      input: { topic: "plain" },
      idempotencyKey: "attachment-absent",
      source: "primary_agent",
      parentRunId: "run-noattach",
    });
    expect(recording.startedInputs.at(-1)?.attachments).toBeUndefined();

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

  it.each((["failed", "timed_out", "cancelled", "interrupted"] as const).flatMap(ending =>
    [true, false].map(submitted => ({ ending, submitted }))))(
    "handles closing $ending with submitted=$submitted without overriding cancellation",
    async ({ ending, submitted }) => {
      const fixture = await createFixture({ outputSchema: true });
      await fixture.registry.initialize();
      const revision = fixture.registry.get("researcher")!.revision;
      revision.policy.timeoutMs = 30;
      const collector = new SubagentResultCollector();
      const submit = collector.createTool(revision)!;
      class ClosingRuntime extends FakeAgentRuntime {
        override async start(input: StartRuntimeRunInput): Promise<Awaited<ReturnType<AgentRuntime["start"]>>> {
          return {
            runId: input.runId,
            runtimeSessionRef: `closing-${input.runId}`,
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              if (submitted) await submit.execute({ ...input, runtimeSessionRef: null }, { answer: "validated answer" });
              if (ending === "timed_out") {
                await new Promise(resolve => setTimeout(resolve, 60));
              } else {
                yield { type: `run.${ending}`, payload: { message: "closing request failed" } } as RuntimeEvent;
              }
            })(),
          };
        }
      }
      class ClosingManager extends SubagentRuntimeManager {
        override acquire(): AgentRuntime { return new ClosingRuntime(); }
        override prepareSubmittedResult(revisionId: string, runId: string, input: unknown) { collector.prepare(revisionId, runId, input); }
        override takeSubmittedResult(revisionId: string, runId: string) { return collector.take(revisionId, runId); }
      }
      const manager = new ClosingManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
      const orchestrator = new SubagentOrchestrator(fixture.database.db, fixture.config, fixture.registry, manager, logger);
      const invocation = await orchestrator.dispatch({
        agentId: "researcher", task: "Submit then fail closing reply", input: {},
        idempotencyKey: `closing-${ending}`, source: "primary_agent", parentRunId: "parent",
      });
      if (!submitted || ending === "cancelled" || ending === "interrupted") {
        expect(invocation).toMatchObject({ status: ending, result: null });
      } else {
        expect(invocation).toMatchObject({ status: "completed", errorCode: null, errorMessage: null, result: { structuredOutput: { answer: "validated answer" } } });
      }
      await orchestrator.dispose();
      fixture.database.sqlite.close();
    },
  );

  it("dispatch timeoutMs 只能收紧 policy：分批单批使用更短上限", async () => {
    const fixture = await createFixture();
    await fixture.registry.initialize();
    const revision = fixture.registry.get("researcher")!.revision;
    revision.policy.timeoutMs = 5_000;
    class HangingRuntime extends FakeAgentRuntime {
      override async start(input: StartRuntimeRunInput): Promise<Awaited<ReturnType<AgentRuntime["start"]>>> {
        return {
          runId: input.runId,
          runtimeSessionRef: `hang-${input.runId}`,
          events: (async function* (): AsyncGenerator<RuntimeEvent> {
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            yield { type: "run.completed", payload: {} } as RuntimeEvent;
          })(),
        };
      }
    }
    class HangingManager extends SubagentRuntimeManager {
      override acquire(): AgentRuntime { return new HangingRuntime(); }
    }
    const manager = new HangingManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
    const orchestrator = new SubagentOrchestrator(fixture.database.db, fixture.config, fixture.registry, manager, logger);
    const started = Date.now();
    const invocation = await orchestrator.dispatch({
      agentId: "researcher",
      task: "Bounded batch dispatch",
      input: {},
      idempotencyKey: "timeout-override",
      source: "primary_agent",
      parentRunId: "parent",
      timeoutMs: 50,
    });
    expect(invocation.status).toBe("timed_out");
    // 50ms 超时后框架最多再等 2s 收尾（runtime cancel grace）；关键是远早于 policy 5s。
    expect(Date.now() - started).toBeLessThan(3_500);
    await orchestrator.dispose();
    fixture.database.sqlite.close();
  });

  it.each(["valid", "repair", "forged", "cancel-before", "cancel-during"] as const)(
    "finishes on a validated submission without a closing model call: %s",
    async (scenario) => {
      const fixture = await createFixture({ outputSchema: true });
      await fixture.registry.initialize();
      const revision = fixture.registry.get("researcher")!.revision;
      const collector = new SubagentResultCollector();
      const submit = collector.createTool(revision)!;
      const controller = new AbortController();
      let closingRequest = false;
      let stops = 0;
      class SubmittedRuntime extends FakeAgentRuntime {
        override async cancel() {
          stops++;
          if (scenario === "cancel-during" && stops === 1) controller.abort();
        }
        override async start(input: StartRuntimeRunInput): Promise<Awaited<ReturnType<AgentRuntime["start"]>>> {
          return { runId: input.runId, runtimeSessionRef: "submitted-run", events: (async function* (): AsyncGenerator<RuntimeEvent> {
            if (scenario === "repair") {
              await expect(submit.execute({ ...input, runtimeSessionRef: null }, {})).rejects.toThrow("subagent_result_schema_invalid");
              yield { type: "tool.completed", payload: { name: "subagent_submit_result", result: { details: { accepted: false } } } };
            }
            if (scenario !== "forged") await submit.execute({ ...input, runtimeSessionRef: null }, { answer: "validated answer" });
            if (scenario === "cancel-before") controller.abort();
            yield { type: "context.usage", payload: { runUsage: { input: 100, output: 20 } } };
            yield { type: "tool.completed", payload: { name: "subagent_submit_result", result: { details: { accepted: true } } } };
            closingRequest = true;
            yield { type: scenario === "cancel-before" ? "run.cancelled" : "run.failed", payload: { message: "unnecessary closing request" } };
          })() };
        }
      }
      class SubmittedManager extends SubagentRuntimeManager {
        override acquire(): AgentRuntime { return new SubmittedRuntime(); }
        override prepareSubmittedResult(revisionId: string, runId: string, input: unknown) { collector.prepare(revisionId, runId, input); }
        override takeSubmittedResult(revisionId: string, runId: string) { return collector.take(revisionId, runId); }
      }
      const manager = new SubmittedManager({ agentRuntime: "fake" } as GatewayConfig, fixture.config);
      const orchestrator = new SubagentOrchestrator(fixture.database.db, fixture.config, fixture.registry, manager, logger);
      const observedUsage: unknown[] = [];
      const invocation = await orchestrator.dispatch({ agentId: "researcher", task: "Submit", input: {}, idempotencyKey: scenario, source: "primary_agent", parentRunId: "parent", signal: controller.signal,
        onUsage: (_id, usage) => observedUsage.push(usage) });
      if (scenario === "valid" || scenario === "repair") {
        expect(invocation).toMatchObject({ status: "completed", result: { structuredOutput: { answer: "validated answer" } } });
        expect(closingRequest).toBe(false);
        expect(stops).toBe(1);
        expect(observedUsage).toEqual([{ input: 100, output: 20 }]);
      } else {
        expect(invocation).toMatchObject({ status: scenario === "forged" ? "failed" : "cancelled", result: null });
      }
      await orchestrator.dispose();
      fixture.database.sqlite.close();
    },
  );

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

/**
 * 2026-10-27 事故回归：runtime config 会被周期性重推（桌面端同步 / 中转会话刷新），
 * 旧实现在 invalidate() 里直接 dispose 全部缓存 runtime，等于每隔几分钟腰斩一次
 * 长任务——论文模版解析跑到一半就变 cancelled。现在改为「在跑的先标记待回收，
 * 跑完再 dispose」。
 */
describe("subagent runtime invalidate 不打断在跑的调用", () => {
  it("忙碌中的 runtime 延迟到 release 才 dispose", async () => {
    const disposed: string[] = [];
    const runtimeOf = (id: string) => ({
      id,
      dispose: async () => { disposed.push(id); },
      cancel: async () => undefined,
    });
    // 私有字段无法从类型面直接构造：只取 invalidate/release 两个方法（原型上），
    // 其余状态按运行时形状手工装一遍。
    const manager = Object.create(SubagentRuntimeManager.prototype) as unknown as {
      runtimes: Map<string, unknown>;
      users: Map<string, number>;
      retiring: Map<string, unknown>;
      resultCollector: { clear: () => void };
      invalidate(): Promise<void>;
      release(revisionId: string): void;
    };
    manager.runtimes = new Map();
    manager.users = new Map();
    manager.retiring = new Map();
    manager.resultCollector = { clear: () => undefined };

    const busy = runtimeOf("busy");
    manager.runtimes.set("revision-busy", busy as never);
    manager.users.set("revision-busy", 1);
    const idle = runtimeOf("idle");
    manager.runtimes.set("revision-idle", idle as never);

    await manager.invalidate();

    // 空闲的立即回收；忙碌的留着继续跑
    expect(disposed).toContain("idle");
    expect(disposed).not.toContain("busy");
    expect(manager.retiring.has("revision-busy")).toBe(true);
    expect(manager.runtimes.size).toBe(0);

    manager.release("revision-busy");
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toContain("busy");
    expect(manager.retiring.size).toBe(0);
  });

  it("release 到仍有其他调用时先不回收", async () => {
    const disposed: string[] = [];
    // 私有字段无法从类型面直接构造：只取 invalidate/release 两个方法（原型上），
    // 其余状态按运行时形状手工装一遍。
    const manager = Object.create(SubagentRuntimeManager.prototype) as unknown as {
      runtimes: Map<string, unknown>;
      users: Map<string, number>;
      retiring: Map<string, unknown>;
      resultCollector: { clear: () => void };
      invalidate(): Promise<void>;
      release(revisionId: string): void;
    };
    manager.runtimes = new Map();
    manager.users = new Map();
    manager.retiring = new Map();
    manager.resultCollector = { clear: () => undefined };

    manager.runtimes.set("r1", { dispose: async () => { disposed.push("r1"); } } as never);
    manager.users.set("r1", 2);
    await manager.invalidate();
    manager.release("r1");
    expect(disposed).toHaveLength(0);
    manager.release("r1");
    await Promise.resolve();
    await Promise.resolve();
    expect(disposed).toEqual(["r1"]);
  });
});
