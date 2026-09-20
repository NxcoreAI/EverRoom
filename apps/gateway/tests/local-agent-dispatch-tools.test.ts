import { describe, expect, it } from "vitest";
import type {
  LocalAgentDelegationContext,
  LocalAgentInvocationTarget,
  RuntimeCapabilities,
} from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import {
  createLocalAgentDispatchTools,
  type LocalAgentDispatchSource,
} from "../src/modules/local-agents/dispatch-tools.js";
import type {
  CreateLocalAgentDispatchInput,
  LocalAgentDispatchRecord,
  LocalAgentDispatchStatus,
} from "../src/modules/local-agents/dispatch-store.js";
import type { LocalAgentDispatchMaterialRecord } from "../src/infrastructure/database/schema.js";

const codexTarget: LocalAgentInvocationTarget = {
  id: "codex:/usr/local/bin/codex",
  provider: "codex",
  displayName: "Codex",
  executablePath: "/usr/local/bin/codex",
  workingDirectory: "/tmp/everroom-sandbox/codex",
  permissionProfile: "inspect",
  card: {
    name: "Codex",
    description: "OpenAI Codex CLI",
    version: "1.0.0",
    supportedInterfaces: [],
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [],
  },
};

class FakeLocalRuntime implements AgentRuntime {
  readonly id = "fake-local";
  readonly starts: StartRuntimeRunInput[] = [];
  readonly cancels: string[] = [];
  /** events 传 null 时每次 start 得到一个不结束的独立队列，供取消/超时/并发用例驱动。 */
  readonly openQueues: AsyncEventQueue<RuntimeEvent>[] = [];

  constructor(private readonly events: RuntimeEvent[] | null) {}

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input);
    const events = new AsyncEventQueue<RuntimeEvent>();
    if (this.events === null) {
      this.openQueues.push(events);
    } else {
      for (const event of this.events) events.push(event);
      events.end();
    }
    return { runId: input.runId, runtimeSessionRef: `fake-${input.runId}`, events };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("not supported");
  }

  async sendInput(): Promise<void> {}

  async cancel(runId: string): Promise<void> {
    this.cancels.push(runId);
    for (const queue of this.openQueues) {
      queue.push({ type: "run.cancelled", payload: {} });
      queue.end();
    }
    this.openQueues.length = 0;
  }

  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {}
}

class FakeDispatchStore {
  readonly records = new Map<string, LocalAgentDispatchRecord>();
  private seq = 0;

  create(input: CreateLocalAgentDispatchInput): LocalAgentDispatchRecord {
    this.seq += 1;
    const now = new Date();
    const payload = input.packagePayload as LocalAgentDelegationContext;
    const sameRun = [...this.records.values()].filter((record) => record.parentRunId === input.parentRunId);
    const record: LocalAgentDispatchRecord = {
      id: `dispatch-${this.seq}`,
      sessionId: input.sessionId,
      parentRunId: input.parentRunId,
      agentId: input.agentId,
      displayName: input.displayName,
      provider: input.provider,
      assignment: input.assignment,
      sharedGoal: input.sharedGoal ?? null,
      constraints: input.constraints,
      materials: input.materials,
      packageJson: JSON.stringify(input.packagePayload),
      packageDigest: payload.provenance.digest,
      packageVersion: Math.max(0, ...sameRun.map((item) => item.packageVersion)) + 1,
      status: "pending",
      resultText: null,
      errorCode: null,
      errorMessage: null,
      subRunId: input.subRunId,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return record;
  }

  markRunning(id: string): void { this.records.get(id)!.status = "running"; }

  complete(id: string, resultText: string): void {
    const record = this.records.get(id)!;
    record.status = "completed";
    record.resultText = resultText;
  }

  fail(id: string, status: LocalAgentDispatchStatus, errorCode: string): void {
    const record = this.records.get(id)!;
    record.status = status;
    record.errorCode = errorCode;
  }

  get(id: string): LocalAgentDispatchRecord | null {
    return this.records.get(id) ?? null;
  }

  seed(record: Partial<LocalAgentDispatchRecord> & Pick<LocalAgentDispatchRecord, "id" | "parentRunId">): LocalAgentDispatchRecord {
    const full: LocalAgentDispatchRecord = {
      sessionId: "session-1",
      agentId: codexTarget.id,
      displayName: "Codex",
      provider: "codex",
      assignment: "前置任务",
      sharedGoal: null,
      constraints: [],
      materials: [] as LocalAgentDispatchMaterialRecord[],
      packageJson: "{}",
      packageDigest: "d".repeat(64),
      packageVersion: 1,
      status: "completed",
      resultText: "前置任务产出内容",
      errorCode: null,
      errorMessage: null,
      subRunId: "sub-seed",
      startedAt: new Date(),
      completedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...record,
    };
    this.records.set(full.id, full);
    return full;
  }
}

function dispatchSource(): LocalAgentDispatchSource {
  return {
    priorMessages: [
      { role: "user", authorAgentId: null, content: "帮我评审并改写说明", createdAt: "2026-09-20T00:00:00.000Z" },
      { role: "assistant", authorAgentId: "main", content: "好的，我来分派。", createdAt: "2026-09-20T00:00:01.000Z" },
    ],
    promptAttachments: [],
    selectedText: "被选中的实现片段",
  };
}

function runInput(): StartRuntimeRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    runtimeSessionRef: null,
    prompt: "用户请求",
    pageLabel: "Home",
    roomId: null,
    referencedLocalAgents: [codexTarget],
  };
}

function makeTools(runtime: FakeLocalRuntime, store: FakeDispatchStore, options?: {
  source?: LocalAgentDispatchSource;
  timeoutMs?: number;
  maxConcurrentPerRun?: number;
}) {
  const [tool] = createLocalAgentDispatchTools({
    registry: { resolve: () => runtime },
    store,
    ...(options?.source !== undefined ? { resolveDispatchSource: () => options.source } : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxConcurrentPerRun !== undefined ? { maxConcurrentPerRun: options.maxConcurrentPerRun } : {}),
  });
  if (!tool) throw new Error("tool missing");
  return tool;
}

describe("createLocalAgentDispatchTools", () => {
  it("宣告并行模式并在描述中约束转述口吻", () => {
    const tool = makeTools(new FakeLocalRuntime([]), new FakeDispatchStore());
    expect(tool.executionMode).toBe("parallel");
    expect(tool.description).toContain("禁止");
    expect(tool.description).toContain("转述口吻");
    expect(tool.description).toContain("priorTaskOutputs");
  });

  it("分派分工、封印 v2 子包并落库 completed（含 task id 回执）", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "message.completed", payload: { role: "assistant", content: "评审结论：风险可控。" } },
      { type: "run.completed", payload: {} },
    ]);
    const store = new FakeDispatchStore();
    const tool = makeTools(runtime, store, { source: dispatchSource() });

    const result = await tool.execute(runInput(), {
      agentId: codexTarget.id,
      assignment: "评审该实现的风险点，输出结论与依据。",
      sharedGoal: "完成技术评审与说明改写",
      constraints: ["只关注正确性与安全"],
      materials: [{ kind: "selection" }, { kind: "text", title: "方案要点", text: "方案正文……" }],
    });

    expect(result.content).toContain("评审结论：风险可控。");
    expect(result.content).toMatch(/\[local_agent_dispatch_task_id:dispatch-\d+\]$/u);
    expect(result.details).toMatchObject({
      agentId: codexTarget.id,
      provider: "codex",
      displayName: "Codex",
      assignment: "评审该实现的风险点，输出结论与依据。",
      sharedGoal: "完成技术评审与说明改写",
      constraints: ["只关注正确性与安全"],
      packageVersion: 1,
      status: "completed",
    });
    expect(runtime.starts[0]?.prompt).toBe("评审该实现的风险点，输出结论与依据。");
    const delegation = runtime.starts[0]?.delegationContext;
    expect(delegation).toMatchObject({
      schemaVersion: 2,
      targetAgentId: codexTarget.id,
      assignment: { text: "评审该实现的风险点，输出结论与依据。", sharedGoal: "完成技术评审与说明改写", constraints: ["只关注正确性与安全"] },
      grant: { workspaceAccess: "read-only", approvals: "disabled", mutationAllowed: false },
    });
    expect(delegation?.materials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "selection", agentOutput: false }),
        expect.objectContaining({ kind: "note", title: "方案要点", agentOutput: false }),
      ]),
    );
    expect(delegation?.materials.every((material) => !material.agentOutput)).toBe(true);
    expect(delegation?.provenance.digest).toMatch(/^[a-f0-9]{64}$/u);

    const record = store.records.get("dispatch-1")!;
    expect(record.status).toBe("completed");
    expect(record.resultText).toBe("评审结论：风险可控。");
    expect(record.materials.map((material) => material.kind)).toEqual(
      expect.arrayContaining(["selection", "note"]),
    );
  });

  it("materials 显式声明时只带入声明项，未声明对话则子包对话为空", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "message.completed", payload: { role: "assistant", content: "完成。" } },
      { type: "run.completed", payload: {} },
    ]);
    const tool = makeTools(runtime, new FakeDispatchStore(), { source: dispatchSource() });

    await tool.execute(
      { ...runInput(), attachments: [{ filename: "a.txt", mimeType: "text/plain", kind: "document", text: "附件内容" }] },
      { agentId: codexTarget.id, assignment: "任务", materials: [{ kind: "selection" }] },
    );

    const delegation = runtime.starts[0]?.delegationContext;
    expect(delegation?.conversation.messages).toEqual([]);
    expect(delegation?.conversation.truncated).toBe(false);
    expect(delegation?.attachments).toEqual([]);
    expect(delegation?.materials).toEqual([expect.objectContaining({ kind: "selection" })]);
  });

  it("materials 省略时默认带入对话/选区/附件与当前文档", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "message.completed", payload: { role: "assistant", content: "完成。" } },
      { type: "run.completed", payload: {} },
    ]);
    const store = new FakeDispatchStore();
    const tool = makeTools(runtime, store, { source: dispatchSource() });

    await tool.execute(
      {
        ...runInput(),
        attachments: [{ filename: "spec.md", mimeType: "text/markdown", kind: "document", text: "规格内容" }],
        activeDocument: { roomId: "room-1", documentId: "doc-1", title: "实现说明", version: 3, defaultAnchor: "end" },
      },
      { agentId: codexTarget.id, assignment: "任务" },
    );

    const delegation = runtime.starts[0]?.delegationContext;
    expect(delegation?.conversation.messages).toHaveLength(2);
    expect(delegation?.selection?.text).toBe("被选中的实现片段");
    expect(delegation?.attachments).toHaveLength(1);
    expect(delegation?.resources.activeDocument).toMatchObject({ documentId: "doc-1", title: "实现说明" });
    expect(store.get("dispatch-1")?.materials.map((material) => material.kind)).toEqual(
      expect.arrayContaining(["transcript", "selection", "attachment", "active_document"]),
    );
  });

  it("priorTaskOutputs 引用同 run 的完成产出，注入 agent_output 材料并递增版本", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "message.completed", payload: { role: "assistant", content: "改写完成。" } },
      { type: "run.completed", payload: {} },
    ]);
    const store = new FakeDispatchStore();
    const prior = store.seed({ id: "dispatch-prior", parentRunId: "run-1", displayName: "Codex" });
    const tool = makeTools(runtime, store);

    const result = await tool.execute(runInput(), {
      agentId: codexTarget.id,
      assignment: "依据评审意见改写说明。",
      priorTaskOutputs: [{ taskId: prior.id, usage: "作为改写依据" }],
    });

    const delegation = runtime.starts[0]?.delegationContext;
    expect(delegation?.materials).toEqual([
      expect.objectContaining({
        kind: "agent_output",
        agentOutput: true,
        sourceDispatchId: "dispatch-prior",
        text: expect.stringContaining("用途：作为改写依据"),
      }),
    ]);
    expect(result.details).toMatchObject({
      packageVersion: 2,
      priorOutputs: [{ taskId: "dispatch-prior", displayName: "Codex", chars: expect.any(Number) }],
    });
    const record = store.get("dispatch-1")!;
    expect(record.materials[0]).toMatchObject({ kind: "agent_output", agentOutput: true, sourceDispatchId: "dispatch-prior" });
  });

  it("priorTaskOutputs 引用其他 run 的任务时报错", async () => {
    const store = new FakeDispatchStore();
    store.seed({ id: "dispatch-other", parentRunId: "run-other" });
    const tool = makeTools(new FakeLocalRuntime([]), store);

    await expect(tool.execute(runInput(), {
      agentId: codexTarget.id,
      assignment: "任务",
      priorTaskOutputs: [{ taskId: "dispatch-other", usage: "用途" }],
    })).rejects.toThrow("local_agent_dispatch_prior_task_not_found");
  });

  it("rejects an agentId that was not @ mentioned on the run", async () => {
    const tool = makeTools(new FakeLocalRuntime([]), new FakeDispatchStore());

    const input = runInput();
    delete input.referencedLocalAgents;
    await expect(tool.execute(input, { agentId: codexTarget.id, assignment: "任务" }))
      .rejects.toThrow("local_agent_dispatch_target_not_referenced");

    await expect(tool.execute(runInput(), { agentId: "codex:/other/bin/codex", assignment: "任务" }))
      .rejects.toThrow("local_agent_dispatch_target_not_referenced");
  });

  it("surfaces a failed local run as a tool error and records failure", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "run.failed", payload: { message: "cli exited" } },
    ]);
    const store = new FakeDispatchStore();
    const tool = makeTools(runtime, store);

    await expect(tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务" }))
      .rejects.toThrow("cli exited");
    expect(store.get("dispatch-1")).toMatchObject({ status: "failed", errorCode: "cli exited" });
  });

  it("cancels the sub run when the tool signal aborts and records cancelled", async () => {
    const runtime = new FakeLocalRuntime(null);
    const store = new FakeDispatchStore();
    const tool = makeTools(runtime, store);

    const controller = new AbortController();
    const pending = tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务" }, controller.signal);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    controller.abort();
    await expect(pending).rejects.toThrow("local_agent_run_cancelled");
    expect(runtime.cancels[0]).toBe(runtime.starts[0]?.runId);
    expect(store.get("dispatch-1")).toMatchObject({ status: "cancelled", errorCode: "local_agent_run_cancelled" });
  });

  it("超时后取消子 run 并落库 timed_out", async () => {
    const runtime = new FakeLocalRuntime(null);
    const store = new FakeDispatchStore();
    const tool = makeTools(runtime, store, { timeoutMs: 20 });

    await expect(tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务" }))
      .rejects.toThrow("local_agent_dispatch_timeout");
    expect(runtime.cancels).toHaveLength(1);
    expect(store.get("dispatch-1")).toMatchObject({ status: "timed_out", errorCode: "local_agent_dispatch_timeout" });
  });

  it("同一 run 并发分发超过上限时拒绝", async () => {
    const runtime = new FakeLocalRuntime(null);
    const store = new FakeDispatchStore();
    const tool = makeTools(runtime, store, { maxConcurrentPerRun: 2 });

    const first = tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务一" });
    const second = tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务二" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await expect(tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务三" }))
      .rejects.toThrow("local_agent_dispatch_concurrency_limit");

    runtime.openQueues.forEach((queue, index) => {
      queue.push({ type: "message.completed", payload: { content: `完成${index + 1}` } });
      queue.push({ type: "run.completed", payload: {} });
      queue.end();
    });
    await expect(first).resolves.toMatchObject({ content: expect.stringContaining("完成1") });
    await expect(second).resolves.toMatchObject({ content: expect.stringContaining("完成2") });
    // 释放后可再次分发
    const third = tool.execute(runInput(), { agentId: codexTarget.id, assignment: "任务三" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    runtime.openQueues.forEach((queue) => {
      queue.push({ type: "message.completed", payload: { content: "完成三" } });
      queue.push({ type: "run.completed", payload: {} });
      queue.end();
    });
    await expect(third).resolves.toMatchObject({ content: expect.stringContaining("完成三") });
  });
});
