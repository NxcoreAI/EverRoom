import { describe, expect, it } from "vitest";
import type { LocalAgentInvocationTarget, RuntimeCapabilities } from "@nxcore/agent-contract";
import {
  AsyncEventQueue,
  type AgentRuntime,
  type ResumeRuntimeRunInput,
  type RuntimeEvent,
  type RuntimeRun,
  type StartRuntimeRunInput,
} from "@nxcore/agent-runtime";
import { createLocalAgentDispatchTools } from "../src/modules/local-agents/dispatch-tools.js";

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

  constructor(private readonly events: RuntimeEvent[]) {}

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: true, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    this.starts.push(input);
    const events = new AsyncEventQueue<RuntimeEvent>();
    for (const event of this.events) events.push(event);
    events.end();
    return { runId: input.runId, runtimeSessionRef: `fake-${input.runId}`, events };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("not supported");
  }

  async sendInput(): Promise<void> {}
  async cancel(runId: string): Promise<void> { this.cancels.push(runId); }
  async deleteSession(): Promise<void> {}
  async dispose(): Promise<void> {}
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

describe("createLocalAgentDispatchTools", () => {
  it("delegates the task, relays the assistant answer, and seals a delegation context", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "message.completed", payload: { role: "assistant", content: "审查结论：实现可行。" } },
      { type: "run.completed", payload: {} },
    ]);
    const [tool] = createLocalAgentDispatchTools({ resolve: () => runtime });
    if (!tool) throw new Error("tool missing");

    const result = await tool.execute(runInput(), { agentId: codexTarget.id, task: "审查这个实现" });

    expect(result.content).toBe("审查结论：实现可行。");
    expect(result.details).toMatchObject({ agentId: codexTarget.id, provider: "codex" });
    expect(runtime.starts).toHaveLength(1);
    expect(runtime.starts[0]?.prompt).toBe("审查这个实现");
    expect(runtime.starts[0]?.sessionId).toBe("session-1");
    const delegation = runtime.starts[0]?.delegationContext;
    expect(delegation).toMatchObject({
      schemaVersion: 1,
      targetAgentId: codexTarget.id,
      task: { text: "审查这个实现" },
      grant: { workspaceAccess: "read-only", approvals: "disabled", mutationAllowed: false },
    });
    expect(delegation?.provenance.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects an agentId that was not @ mentioned on the run", async () => {
    const runtime = new FakeLocalRuntime([]);
    const [tool] = createLocalAgentDispatchTools({ resolve: () => runtime });
    if (!tool) throw new Error("tool missing");

    const input = runInput();
    delete input.referencedLocalAgents;
    await expect(tool.execute(input, { agentId: codexTarget.id, task: "任务" }))
      .rejects.toThrow("local_agent_dispatch_target_not_referenced");

    await expect(tool.execute(runInput(), { agentId: "codex:/other/bin/codex", task: "任务" }))
      .rejects.toThrow("local_agent_dispatch_target_not_referenced");
  });

  it("dispatches to any one of the mentioned targets by agentId", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "message.completed", payload: { role: "assistant", content: "已修复。" } },
      { type: "run.completed", payload: {} },
    ]);
    const [tool] = createLocalAgentDispatchTools({ resolve: () => runtime });
    if (!tool) throw new Error("tool missing");
    const claudeTarget: LocalAgentInvocationTarget = {
      ...codexTarget,
      id: "claude:/usr/local/bin/claude",
      provider: "claude",
      displayName: "Claude Code",
    };

    const input = { ...runInput(), referencedLocalAgents: [codexTarget, claudeTarget] };
    const result = await tool.execute(input, { agentId: claudeTarget.id, task: "修复问题" });

    expect(result.details).toMatchObject({ agentId: claudeTarget.id, provider: "claude" });
    expect(runtime.starts[0]?.delegationContext).toMatchObject({ targetAgentId: claudeTarget.id });
  });

  it("surfaces a failed local run as a tool error", async () => {
    const runtime = new FakeLocalRuntime([
      { type: "run.failed", payload: { message: "cli exited" } },
    ]);
    const [tool] = createLocalAgentDispatchTools({ resolve: () => runtime });
    if (!tool) throw new Error("tool missing");

    await expect(tool.execute(runInput(), { agentId: codexTarget.id, task: "任务" })).rejects.toThrow("cli exited");
  });

  it("cancels the sub run when the tool signal aborts", async () => {
    const events = new AsyncEventQueue<RuntimeEvent>();
    const runtime = new FakeLocalRuntime([]);
    const queue = events;
    const start = runtime.start.bind(runtime);
    runtime.start = async (input) => {
      const run = await start(input);
      return { ...run, events: queue };
    };
    const [tool] = createLocalAgentDispatchTools({ resolve: () => runtime });
    if (!tool) throw new Error("tool missing");

    const controller = new AbortController();
    const pending = tool.execute(runInput(), { agentId: codexTarget.id, task: "任务" }, controller.signal);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    controller.abort();
    queue.push({ type: "run.cancelled", payload: {} });
    queue.end();
    await expect(pending).rejects.toThrow("local_agent_run_cancelled");
    expect(runtime.cancels.length).toBe(1);
    expect(runtime.cancels[0]).toBe(runtime.starts[0]?.runId);
  });
});
