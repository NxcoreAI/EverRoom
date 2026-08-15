import { describe, expect, it } from "vitest";
import { FakeAgentRuntime } from "../src/fake-runtime.js";

describe("FakeAgentRuntime", () => {
  it("streams a deterministic response and completes", async () => {
    const runtime = new FakeAgentRuntime();
    const run = await runtime.start({
      runId: "run-1",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "测试消息",
      pageLabel: "首页",
      roomId: null,
    });
    const events = [];
    for await (const event of run.events) events.push(event);

    expect(events.at(0)?.type).toBe("run.started");
    expect(events.some((event) => event.type === "message.delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("emits cancellation when stopped", async () => {
    const runtime = new FakeAgentRuntime();
    const run = await runtime.start({
      runId: "run-2",
      sessionId: "session-1",
      runtimeSessionRef: null,
      prompt: "停止测试",
      pageLabel: "首页",
      roomId: null,
    });
    await runtime.cancel(run.runId);
    const events = [];
    for await (const event of run.events) events.push(event);

    expect(events.at(-1)?.type).toBe("run.cancelled");
  });
});
