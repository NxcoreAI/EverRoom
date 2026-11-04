import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@nxcore/agent-contract";

import {
  buildWorkspaceInsightPrompt,
  composeWorkspaceInsight,
  evidenceStateLine,
  parseWorkspaceInsightComposition,
  templateWorkspaceInsightComposition,
  type WorkspaceInsightEvidence,
  type WorkspaceInsightEvidenceSession,
} from "../src/modules/workspace-insight/composer.js";
import { WorkspaceInsightService } from "../src/modules/workspace-insight/service.js";

function sessionFixture(overrides: Partial<WorkspaceInsightEvidenceSession> = {}): WorkspaceInsightEvidenceSession {
  return {
    id: "s-1",
    title: "整理连接器需求",
    status: "idle",
    updatedLabel: "12 分钟前",
    lastText: "连接器需求已按优先级重排。",
    ...overrides,
  };
}

function evidenceFixture(overrides: Partial<WorkspaceInsightEvidence> = {}): WorkspaceInsightEvidence {
  return {
    workspaceId: "ws-1",
    workspaceName: "锥光项目",
    sessions: [
      sessionFixture(),
      sessionFixture({ id: "s-2", title: "起草周报", status: "running", updatedLabel: "刚刚", lastText: null }),
      sessionFixture({ id: "s-3", title: "供应商比价", status: "interrupted", updatedLabel: "昨天", lastText: null }),
    ],
    inventory: { library: 8, artifacts: 3, total: 11 },
    ...overrides,
  };
}

describe("workspace-insight composer", () => {
  it("prompt 携带证据（id/标题/状态/正文）与「总结+建议」要求", () => {
    const prompt = buildWorkspaceInsightPrompt(evidenceFixture());
    expect(prompt).toContain("[id=s-1]");
    expect(prompt).toContain("《整理连接器需求》");
    expect(prompt).toContain("在跑");
    expect(prompt).toContain("资料库 8 份材料、3 份产物");
    expect(prompt).toContain("summary");
    expect(prompt).toContain("advice");
    expect(prompt).toContain("不要照抄");
  });

  it("parse：编造 sessionId 的建议被改为无指向；空建议丢弃；超长截断", () => {
    const evidence = evidenceFixture();
    const parsed = parseWorkspaceInsightComposition(JSON.stringify({
      summary: "三项工作并行：一项在跑、一项待续、一项有结果。",
      advice: [
        { text: "《起草周报》在跑，等结果即可。", sessionId: "s-2" },
        { text: "这条建议特别长".repeat(12), sessionId: "made-up-id" },
        { text: "   " },
        { text: "查收比价结论。", sessionId: null },
      ],
    }), evidence);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toContain("三项工作并行");
    expect(parsed!.advice).toHaveLength(2);
    expect(parsed!.advice[0]!.sessionId).toBe("s-2");
    // 编造的 sessionId 改为 null（建议保留），超长截断加省略号；第三、四条被条数上限丢弃。
    expect(parsed!.advice[1]!.sessionId).toBeNull();
    expect(parsed!.advice[1]!.text.endsWith("…")).toBe(true);
    expect(parsed!.advice[1]!.text).not.toContain("查收比价结论");
  });

  it("parse：无 summary 或非 JSON → null（走模板兜底）", () => {
    const evidence = evidenceFixture();
    expect(parseWorkspaceInsightComposition("not json", evidence)).toBeNull();
    expect(parseWorkspaceInsightComposition(JSON.stringify({ advice: [] }), evidence)).toBeNull();
  });

  it("模板兜底：状态分布 + 条件建议（在跑优先，其次中断）", () => {
    const composition = templateWorkspaceInsightComposition(evidenceFixture());
    expect(composition.summary).toContain("3 项工作");
    expect(composition.summary).toContain("资料库 11 个文件");
    expect(composition.advice[0]!.text).toContain("《起草周报》正在跑");
    expect(composition.advice[0]!.sessionId).toBe("s-2");
    expect(composition.advice.some((item) => item.text.includes("被中断过"))).toBe(true);
  });

  it("模板兜底：无在跑无中断、最近会话有正文 → 查看结果建议", () => {
    const composition = templateWorkspaceInsightComposition(evidenceFixture({
      sessions: [sessionFixture()],
    }));
    expect(composition.advice[0]!.text).toContain("有你没细看的结果");
    expect(composition.advice[0]!.sessionId).toBe("s-1");
  });

  it("模型不可用 → 模板兜底且 model=null；成功 → model 有值", async () => {
    const evidence = evidenceFixture();
    const unavailable = await composeWorkspaceInsight(evidence, {
      generate: async () => { throw new Error("no model slot"); },
      isModelUnavailable: () => true,
    });
    expect(unavailable.model).toBeNull();
    expect(unavailable.summary).toContain("3 项工作");

    const ok = await composeWorkspaceInsight(evidence, {
      generate: async () => JSON.stringify({
        summary: "今天推进顺利。",
        advice: [{ text: "看一眼结果。", sessionId: "s-1" }],
      }),
      modelName: "glm-4.7",
    });
    expect(ok.model).toBe("glm-4.7");
    expect(ok.summary).toBe("今天推进顺利。");
    expect(ok.advice[0]!.sessionId).toBe("s-1");
  });

  it("空会话证据 → 直接模板兜底（不调模型）", async () => {
    const generate = vi.fn(async () => "should not be called");
    const composition = await composeWorkspaceInsight(evidenceFixture({ sessions: [], inventory: null }), {
      generate: generate as unknown as (prompt: string) => Promise<string>,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(composition.model).toBeNull();
    expect(composition.summary).toBe("");
  });

  it("状态分布行：四类状态按序输出", () => {
    expect(evidenceStateLine(evidenceFixture().sessions)).toBe("1 项在跑，1 项待续，1 项有新结果");
  });
});

/* ───────────────── service：缓存指纹 + 单飞 ───────────────── */

function serviceFixture() {
  const baseSession: AgentSession = {
    id: "s-1",
    workspaceId: "ws-1",
    roomId: null,
    pageLabel: "Agent",
    runtimeId: "rt",
    title: "整理连接器需求",
    status: "idle",
    createdAt: "2026-11-04T02:00:00.000Z",
    updatedAt: "2026-11-04T02:00:00.000Z",
  } as AgentSession;
  const agent = {
    listSessions: vi.fn(() => [
      baseSession,
      { ...baseSession, id: "s-2", title: "起草周报", status: "running", updatedAt: "2026-11-04T03:00:00.000Z" },
    ]),
    getSnapshot: vi.fn((sessionId: string) => ({
      session: { ...baseSession, id: sessionId },
      participants: [],
      activeRun: null,
      messages: sessionId === "s-2"
        ? [{ id: "m-1", sessionId, runId: null, role: "assistant", content: "周报初稿完成。", createdAt: "2026-11-04T03:00:00.000Z" }]
        : [],
      lastEventSeq: 0,
    })),
  };
  const compose = vi.fn(async (_evidence: WorkspaceInsightEvidence) => ({
    summary: "两项工作：一项在跑，一项有结果。",
    advice: [{ text: "《起草周报》正在跑。", sessionId: "s-2" }],
    model: "glm-4.7",
  }));
  let clock = 1_000_000;
  const service = new WorkspaceInsightService({
    agent: agent as never,
    libraryCountSource: { catalogCounts: () => ({ library: 5, artifacts: 2, total: 7 }) },
    compose: compose as never,
    workspaceName: () => "锥光项目",
    now: () => clock,
    logger: () => {},
  });
  return {
    service,
    compose,
    agent,
    tick(minutes: number) {
      clock += minutes * 60_000;
    },
  };
}

describe("workspace-insight service", () => {
  it("证据来自 listSessions/workspaceId 过滤 + 最后 assistant 正文 + 资料库计数", async () => {
    const fixture = serviceFixture();
    await fixture.service.get("ws-1");
    const evidence = fixture.compose.mock.calls[0]![0] as WorkspaceInsightEvidence;
    expect(evidence.workspaceName).toBe("锥光项目");
    expect(evidence.sessions).toHaveLength(2);
    expect(evidence.sessions[0]!.id).toBe("s-2"); // updatedAt 倒序
    expect(evidence.sessions[0]!.lastText).toContain("周报初稿完成");
    expect(evidence.sessions[1]!.lastText).toBeNull();
    expect(evidence.inventory).toEqual({ library: 5, artifacts: 2, total: 7 });
  });

  it("同指纹 5 分钟内复用缓存；过期后重新提炼", async () => {
    const fixture = serviceFixture();
    const first = await fixture.service.get("ws-1");
    expect(first.cached).toBe(false);
    const second = await fixture.service.get("ws-1");
    expect(second.cached).toBe(true);
    expect(fixture.compose).toHaveBeenCalledTimes(1);

    fixture.tick(6); // 过期
    const third = await fixture.service.get("ws-1");
    expect(third.cached).toBe(false);
    expect(fixture.compose).toHaveBeenCalledTimes(2);
  });

  it("指纹变化（会话状态迁移）立即重新提炼", async () => {
    const fixture = serviceFixture();
    await fixture.service.get("ws-1");
    fixture.agent.listSessions.mockReturnValue([
      { id: "s-1", workspaceId: "ws-1", roomId: null, pageLabel: "Agent", runtimeId: "rt", title: "整理连接器需求", status: "closed", createdAt: "2026-11-04T02:00:00.000Z", updatedAt: "2026-11-04T04:00:00.000Z" },
    ] as never);
    const next = await fixture.service.get("ws-1");
    expect(next.cached).toBe(false);
    expect(fixture.compose).toHaveBeenCalledTimes(2);
  });

  it("force 跳过缓存直接提炼", async () => {
    const fixture = serviceFixture();
    await fixture.service.get("ws-1");
    const forced = await fixture.service.get("ws-1", { force: true });
    expect(forced.cached).toBe(false);
    expect(fixture.compose).toHaveBeenCalledTimes(2);
  });
});
