import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { runLayouterTail } from "../src/modules/subagents/slides-layout-tail.js";
import type { LayouterTailDeps } from "../src/modules/subagents/slides-layout-tail.js";
import type { SlidesProgressTracker } from "../src/modules/subagents/slides-progress-tracker.js";
import { takeReviewManual } from "../src/modules/slides-layout/review-context.js";
import { createSlidesReviewerAgentTools } from "../src/modules/subagents/slides-agent-tools.js";

const AGENT_DIR = join(import.meta.dirname, "../../../agents/slides-reviewer");
const LAYOUTER_SKILL = join(import.meta.dirname, "../../../agents/slides-layouter/skills/layout-tree-skill/SKILL.md");

const PAGE_TREE = {
  role: "content",
  title: "页一",
  direction: "row",
  weights: [1.6, 1],
  children: [
    { type: "image", url: "https://example.com/a.jpg" },
    { direction: "column", gapScale: 1.5, children: [
      { type: "text", variant: "heading", text: "小标题" },
      { type: "text", variant: "body", text: "要点内容", bullet: true },
    ] },
  ],
};

const REVISED_TREE = { ...PAGE_TREE, direction: "column" };

function reviewInvocation(payload: Record<string, unknown>, status = "completed"): SubagentInvocation {
  return { status, result: { structuredOutput: payload } } as unknown as SubagentInvocation;
}

function invocationWithTree(tree: unknown): SubagentInvocation {
  return { status: "completed", result: { structuredOutput: { status: "done", tree } } } as unknown as SubagentInvocation;
}

interface ReviewHarnessOptions {
  reviewResult?: SubagentInvocation | "FAIL";
  withLegacyReviewer?: boolean;
}

function makeHarness(options: ReviewHarnessOptions = {}) {
  const dispatches: Array<{ input: Record<string, unknown>; attachments: unknown[] }> = [];
  const bridge = {
    generate: vi.fn(async () => ({ fileEntryId: "file-1", originalName: "deck.pptx" })),
    fillPage: vi.fn(async () => ({ ok: true, applied: true })),
    renderPage: vi.fn(async () => "cG5n"),
  };
  const progress = { arm: vi.fn(), notify: vi.fn(), disarm: vi.fn(), setRelay: vi.fn() };
  const legacyReviewer = options.withLegacyReviewer
    ? { forgetDeck: vi.fn(), reviewPage: vi.fn(async () => ({ status: "fail", issues: [], retriesExhausted: false })) }
    : null;
  const deps: LayouterTailDeps = {
    progress: progress as unknown as SlidesProgressTracker,
    bridge: bridge as never,
    visualReviewer: legacyReviewer as never,
    readMaterialBlob: vi.fn().mockResolvedValue(null),
    fetchImageHead: vi.fn().mockResolvedValue(null),
    makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
    dispatchPage: vi.fn(async () => invocationWithTree(PAGE_TREE)),
    dispatchReview: async (input, _key, _parent, attachments) => {
      dispatches.push({ input, attachments });
      if (options.reviewResult === "FAIL") throw new Error("subagent_concurrency_limit");
      return options.reviewResult ?? reviewInvocation({ status: "ok" });
    },
  };
  return { deps, bridge, progress, dispatches, legacyReviewer };
}

function tailArgs(plan: Record<string, unknown>) {
  return {
    roomId: "room-1",
    sessionId: "session-1",
    runId: "run-r1",
    parentRunId: null,
    instruction: "测试",
    plan,
    armPlan: { title: "测试", pages: (plan.pages as Array<{ title?: string }>).map((p) => ({ title: p.title ?? "" })), warnings: [] } as never,
    styleParams: null,
    draftDocumentId: "draft-1",
    settle: {},
    styleSessions: null,
    pageImagesStore: null,
    trashDraft: async () => {},
  };
}

const PLAN = {
  title: "测试演示",
  pages: [{ title: "页一", role: "content", density: "standard", points: ["要点一"] }],
};

describe("runLayouterTail 审页阶段", () => {
  it("reviewer ok：无重落无审页告警；输入极简且截图走 attachments", async () => {
    const harness = makeHarness();
    const result = await runLayouterTail(harness.deps, tailArgs(PLAN));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings).toEqual([]);
    expect(harness.dispatches).toHaveLength(1);
    const dispatch = harness.dispatches[0]!;
    expect(dispatch.input).toMatchObject({ task: "review", pageIndex: 0, totalPages: 1, title: "页一" });
    // 树与画法不进输入。
    expect(dispatch.input.currentTree).toBeUndefined();
    expect(dispatch.input.deckToken).toBeUndefined();
    expect(dispatch.attachments).toEqual([
      { filename: "page-1.png", mimeType: "image/png", kind: "image", dataUrl: "data:image/png;base64,cG5n" },
    ]);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
    // 收尾后说明书清理。
    expect(takeReviewManual(dispatch.input.manualToken)).toBeNull();
  });

  it("reviewer revised：修正树重落同页一次并告警", async () => {
    const harness = makeHarness({ reviewResult: reviewInvocation({ status: "revised", tree: REVISED_TREE }) });
    const result = await runLayouterTail(harness.deps, tailArgs(PLAN));
    const payload = JSON.parse(result.content);
    expect(payload.warnings).toEqual(["第 1 页经审页代理重排"]);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(2);
    const indexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(indexes).toEqual([0, 0]);
  });

  it("reviewer 失败：无旧复检器时告警跳过；说明书仍注册可查", async () => {
    const harness = makeHarness({ reviewResult: "FAIL" });
    const result = await runLayouterTail(harness.deps, tailArgs(PLAN));
    const payload = JSON.parse(result.content);
    expect(payload.warnings.some((w: string) => /第 1 页审页代理失败/.test(w))).toBe(true);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
  });

  it("reviewer 失败：有旧复检器时降级跑 VLM 封闭清单", async () => {
    const harness = makeHarness({ reviewResult: "FAIL", withLegacyReviewer: true });
    const result = await runLayouterTail(harness.deps, tailArgs(PLAN));
    const payload = JSON.parse(result.content);
    expect(payload.warnings.some((w: string) => /第 1 页视觉复检不通过/.test(w))).toBe(true);
    expect(harness.legacyReviewer!.reviewPage).toHaveBeenCalledTimes(1);
  });
});

describe("slides-reviewer agent 包完整性", () => {
  it("agent.yaml 声明技能与输入输出 schema；两份 schema 合法", () => {
    const yaml = readFileSync(join(AGENT_DIR, "agent.yaml"), "utf8");
    expect(yaml).toMatch(/^id: slides-reviewer$/m);
    expect(yaml).toMatch(/mode: dispatch_only/);
    expect(yaml).toMatch(/^\s+- \.\/skills\/layout-tree-skill$/m);
    const input = JSON.parse(readFileSync(join(AGENT_DIR, "schemas/input.schema.json"), "utf8"));
    const output = JSON.parse(readFileSync(join(AGENT_DIR, "schemas/output.schema.json"), "utf8"));
    expect(input.required).toContain("manualToken");
    expect(output.properties.status.enum).toEqual(["ok", "revised"]);
  });

  it("技能副本与 layouter 主份逐字一致（防镜像漂移）", () => {
    const copy = readFileSync(join(AGENT_DIR, "skills/layout-tree-skill/SKILL.md"), "utf8");
    const source = readFileSync(LAYOUTER_SKILL, "utf8");
    expect(copy).toBe(source);
  });

  it("工具面：说明书 + 布局树校验；说明书按 manualToken 取", () => {
    const tools = createSlidesReviewerAgentTools();
    expect(tools.map((t) => t.name)).toEqual(["slides_review_manual", "slides_layout_validate"]);
  });
});
