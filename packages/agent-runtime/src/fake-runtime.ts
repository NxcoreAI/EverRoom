import { randomUUID } from "node:crypto";
import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import { AsyncEventQueue } from "./async-event-queue.js";
import type {
  AgentRuntime,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  RuntimeRun,
  StartRuntimeRunInput,
} from "./index.js";

interface ActiveFakeRun {
  queue: AsyncEventQueue<RuntimeEvent>;
  controller: AbortController;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly id = "fake";
  private readonly activeRuns = new Map<string, ActiveFakeRun>();

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: true, tools: false, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    const queue = new AsyncEventQueue<RuntimeEvent>();
    const controller = new AbortController();
    this.activeRuns.set(input.runId, { queue, controller });
    void this.generate(input, queue, controller.signal);
    return {
      runId: input.runId,
      runtimeSessionRef: input.runtimeSessionRef ?? `fake-${randomUUID()}`,
      events: queue,
    };
  }

  async resume(_input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    throw new Error("Fake runtime does not support resume");
  }

  async sendInput(): Promise<void> {
    throw new Error("Fake runtime does not support steering");
  }

  async cancel(runId: string): Promise<void> {
    this.activeRuns.get(runId)?.controller.abort(new Error("cancelled"));
  }

  async deleteSession(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const run of this.activeRuns.values()) run.controller.abort(new Error("disposed"));
    this.activeRuns.clear();
  }

  private async generate(
    input: StartRuntimeRunInput,
    queue: AsyncEventQueue<RuntimeEvent>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      queue.push({ type: "run.started", payload: {} });
      queue.push({ type: "reasoning.delta", payload: { delta: "正在整理当前页面上下文。" } });
      await delay(120, signal);
      queue.push({ type: "message.started", payload: { role: "assistant" } });

      const content = `这是 Fake Runtime 的流式响应。当前工作区是“${input.pageLabel}”。你刚才提出的是：“${input.prompt}”。协议链路已经打通，下一阶段会将这里替换为 Pi SDK。`;
      for (const character of content) {
        await delay(12, signal);
        queue.push({ type: "message.delta", payload: { delta: character } });
      }
      queue.push({ type: "message.completed", payload: { role: "assistant", content } });
      queue.push({ type: "run.completed", payload: {} });
    } catch {
      queue.push({ type: "run.cancelled", payload: {} });
    } finally {
      queue.end();
      this.activeRuns.delete(input.runId);
    }
  }
}
