import { describe, expect, it } from "vitest";

import type { AgentRuntimeActivity } from "../src/modules/agent/resolver.js";
import type { AgentResolver } from "../src/modules/agent/resolver.js";
import { AgentStatusService } from "../src/modules/agent/status-service.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";

const FAILED_RUN = {
  id: "run-1",
  task: "整理今天的会议记录",
  pageLabel: "办公室",
  status: "failed" as const,
  startedAt: "2026-08-25T01:00:00.000Z",
  completedAt: "2026-08-25T01:02:00.000Z",
};

function serviceWith(activity: AgentRuntimeActivity): AgentStatusService {
  const resolver = {
    list: () => [{ id: "main", name: "主 Agent", description: "整理资料", kind: "builtin", configDirectory: "/tmp/main" }],
    getActivity: () => activity,
  } as unknown as AgentResolver;
  const subagents = {
    listInvocations: () => [],
    listDefinitions: () => [],
  } as unknown as SubagentOrchestrator;
  return new AgentStatusService(resolver, subagents);
}

describe("AgentStatusService 办公室骑手状态", () => {
  // 失败一次不该让鹈鹕无限期停在路肩：运行一结束就回海，失败只留在「最近活动」里。
  it("运行失败后 Agent 回海待命，但最近活动仍保留失败记录", () => {
    const snapshot = serviceWith({ activeRuns: [], lastRun: FAILED_RUN }).snapshot();
    const [agent] = snapshot.agents;

    expect(agent!.state).toBe("idle");
    expect(snapshot.summary.idle).toBe(1);
    expect(snapshot.summary.error).toBe(0);
    // 记录层面仍是失败：状态文案、时间戳都给得到。
    expect(agent!.lastRun?.status).toBe("failed");
    expect(agent!.currentRun).toBeNull();
    expect(agent!.updatedAt).toBe("2026-08-25T01:02:00.000Z");
  });

  it("仍在跑的运行照旧是 running", () => {
    const snapshot = serviceWith({
      activeRuns: [{ ...FAILED_RUN, status: "running", completedAt: null }],
      lastRun: FAILED_RUN,
    }).snapshot();
    const [agent] = snapshot.agents;

    expect(agent!.state).toBe("running");
    expect(agent!.activeRunCount).toBe(1);
    expect(snapshot.summary.running).toBe(1);
    expect(snapshot.summary.idle).toBe(0);
  });

  it("没有运行历史时也是待命", () => {
    const snapshot = serviceWith({ activeRuns: [], lastRun: null }).snapshot();
    expect(snapshot.agents[0]!.state).toBe("idle");
    expect(snapshot.agents[0]!.updatedAt).toBeNull();
  });
});
