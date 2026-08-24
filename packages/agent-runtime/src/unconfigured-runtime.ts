import type { RuntimeCapabilities } from "@nxcore/agent-contract";
import { AsyncEventQueue } from "./async-event-queue.js";
import type {
  AgentRuntime,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  RuntimeRun,
  StartRuntimeRunInput,
} from "./index.js";

/**
 * AI 未配置时的占位 runtime（降级启动）：所有 run 立即失败并给出
 * runtime_config_not_ready 错误码，等 runtime config 热应用后由
 * AgentResolver.reload 换成真实 Pi runtime。
 *
 * 与 FakeAgentRuntime 的区别：Fake 假装成功（假流式响应），只用于
 * 显式 fake 模式；这里必须失败，让上层拿到类型化错误而不是假答案。
 */
export class UnconfiguredAgentRuntime implements AgentRuntime {
  readonly id: string;

  constructor(id = "unconfigured") {
    this.id = id;
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return { streaming: true, reasoning: false, tools: false, steering: false, resume: false };
  }

  async start(input: StartRuntimeRunInput): Promise<RuntimeRun> {
    return this.failedRun(input.runId, input.runtimeSessionRef);
  }

  async resume(input: ResumeRuntimeRunInput): Promise<RuntimeRun> {
    return this.failedRun(input.runId, input.runtimeSessionRef);
  }

  async sendInput(): Promise<void> {}

  async cancel(): Promise<void> {}

  async deleteSession(): Promise<void> {}

  async dispose(): Promise<void> {}

  private failedRun(runId: string, runtimeSessionRef: string | null): RuntimeRun {
    const queue = new AsyncEventQueue<RuntimeEvent>();
    queue.push({ type: "run.started", payload: {} });
    // payload 形状与 pi runtime 的 run.failed 一致（{ message }），
    // AgentService 持久化 error = payload.message。
    queue.push({ type: "run.failed", payload: { message: "runtime_config_not_ready" } });
    queue.end();
    return {
      runId,
      runtimeSessionRef: runtimeSessionRef ?? this.id,
      events: queue,
    };
  }
}
