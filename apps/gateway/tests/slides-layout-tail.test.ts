import { describe, expect, it, vi } from "vitest";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { runLayouterTail, type LayouterTailDeps } from "../src/modules/subagents/slides-layout-tail.js";
import type { SlidesProgressTracker } from "../src/modules/subagents/slides-progress-tracker.js";

function invocationWithTree(tree: unknown, status = "completed"): SubagentInvocation {
  return {
    status,
    result: { structuredOutput: { status: "done", tree } },
  } as unknown as SubagentInvocation;
}

interface Harness {
  deps: LayouterTailDeps;
  bridge: {
    generate: ReturnType<typeof vi.fn>;
    fillPage: ReturnType<typeof vi.fn>;
  };
  progress: {
    arm: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    disarm: ReturnType<typeof vi.fn>;
  };
  dispatches: Array<{ input: Record<string, unknown>; key: string }>;
  settled: string[];
  trashed: string[];
}

function makeHarness(
  treesPerDispatch: Array<unknown | "FAIL">,
  persistentlyFailingPages: Set<number> = new Set(),
): Harness {
  const dispatches: Array<{ input: Record<string, unknown>; key: string }> = [];
  let dispatchCursor = 0;
  const bridge = {
    generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
    fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
    renderPage: vi.fn().mockResolvedValue(""),
  };
  const progress = {
    arm: vi.fn(),
    notify: vi.fn(),
    disarm: vi.fn(),
    setRelay: vi.fn(),
  };
  const settled: string[] = [];
  const trashed: string[] = [];
  const deps: LayouterTailDeps = {
    progress: progress as unknown as SlidesProgressTracker,
    bridge: bridge as never,
    visualReviewer: null,
    readMaterialBlob: vi.fn().mockResolvedValue(null),
    fetchImageHead: vi.fn().mockResolvedValue(null),
    makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
    dispatchPage: async (input, key) => {
      dispatches.push({ input, key });
      const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
      if (persistentlyFailingPages.has(pageIndex)) throw new Error("subagent_concurrency_limit");
      const entry = treesPerDispatch[dispatchCursor++] ?? treesPerDispatch[treesPerDispatch.length - 1];
      dispatchCursor = Math.min(dispatchCursor, treesPerDispatch.length - 1);
      if (entry === "FAIL") throw new Error("layouter_failed");
      return invocationWithTree(entry);
    },
  };
  return { deps, bridge, progress, dispatches, settled, trashed };
}

const CONTENT_TREE = {
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

const CHART_TREE = {
  role: "data",
  title: "数据页",
  direction: "column",
  children: [
    { type: "chart", kind: "bar", categories: ["2025", "2026"], series: [{ name: "收入", values: [1, 2] }] },
  ],
};

const QUOTE_TREE = {
  role: "quote",
  title: "引用页",
  direction: "column",
  pad: 32,
  children: [
    { type: "text", variant: "heading", text: "一句话", align: "center" },
  ],
};

function planOf(trees: unknown[]): Record<string, unknown> {
  return {
    title: "测试演示",
    pages: trees.map((tree, index) => ({
      title: (tree as { title?: string }).title ?? `第 ${index + 1} 页`,
      role: (tree as { role?: string }).role,
      density: "standard",
      points: ["要点一", "要点二"],
    })),
  };
}

function armPlanOf(plan: Record<string, unknown>) {
  return {
    title: "测试演示",
    pages: (plan.pages as Array<{ title?: string }>).map((page) => ({ title: page.title ?? "" })),
    warnings: [],
  } as never;
}

function tailArgs(plan: Record<string, unknown>, harness: Harness) {
  return {
    roomId: "room-1",
    sessionId: "session-1",
    runId: "run-1",
    parentRunId: "parent-1",
    instruction: "测试",
    plan,
    armPlan: armPlanOf(plan),
    styleParams: null,
    draftDocumentId: "draft-1",
    settle: { styleSessionIdToSettle: "style-1" },
    styleSessions: { patch: (id: string) => harness.settled.push(id) },
    pageImagesStore: null,
    trashDraft: async (id: string) => {
      harness.trashed.push(id);
    },
  };
}

describe("runLayouterTail", () => {
  it("三页直落：按页序落页、逐页进度、回收草稿与落定风格", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.fileEntryId).toBe("file-1");
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1, 2]);
    expect(harness.progress.notify.mock.calls.map((call: unknown[]) => call[1])).toEqual([0, 1, 2]);
    expect(harness.progress.arm.mock.calls[0]![0]).toBe("slides-generate:run-1");
    expect(harness.progress.disarm).toHaveBeenCalledWith("slides-generate:run-1");
    expect(harness.trashed).toEqual(["draft-1"]);
    expect(harness.settled).toEqual(["style-1"]);
    expect(harness.dispatches.every((d) => d.input.deckToken === "run-1:layout")).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("布局代理失败页落确定性兜底并告警，整册仍完成", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE], new Set([0]));
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.warnings.some((w: string) => /第 1 页布局代理未收敛/.test(w))).toBe(true);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(3);
  });

  it("相邻页同构触发一次重排：重排 dispatch 带邻页签名并重落该页", async () => {
    const rerolled = { ...CONTENT_TREE, direction: "column" };
    const harness = makeHarness([CONTENT_TREE, CONTENT_TREE, QUOTE_TREE, rerolled]);
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CONTENT_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.warnings.some((w: string) => /第 2 页与邻页结构雷同/.test(w))).toBe(true);
    const rerollDispatch = harness.dispatches.find((d) => d.key.includes("reroll:1"));
    expect(rerollDispatch).toBeDefined();
    expect(Array.isArray(rerollDispatch!.input.neighborSignatures)).toBe(true);
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes.filter((i) => i === 1).length).toBe(2);
  });

  it("带引擎硬闸缺陷的页落兜底版式，不级联失败（真机 2026-10-15 事故回归）", async () => {
    const emojiTree = {
      role: "content",
      title: "会失败的页",
      direction: "column",
      children: [{ type: "text", variant: "body", text: "带 emoji 🎉 的树" }],
    };
    const harness = makeHarness([emojiTree, CHART_TREE, QUOTE_TREE]);
    harness.bridge.fillPage.mockImplementation(async (input: { slideIndex: number }) =>
      input.slideIndex === 0 ? { ok: false, applied: false, error: "桌面端拒绝" } : { ok: true, applied: true });
    const plan = {
      title: "测试演示",
      pages: [
        { title: "会失败的页", points: ["要点一"], role: "content", density: "standard" },
        { title: "数据页", role: "data", density: "standard" },
        { title: "引用页", role: "quote", density: "standard" },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    // 首页落页仍失败（模拟引擎拒绝兜底外的场景）→ 后续页按追加语义继续，不再越界级联。
    expect(payload.status).toBe("partial");
    expect(payload.warnings.some((w: string) => /第 1 页布局树未收敛/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /第 1 页落页失败/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /slideIndex must be an integer/.test(w))).toBe(false);
    expect(payload.warnings.some((w: string) => /第 [23] 页落页失败/.test(w))).toBe(false);
    expect(payload.pages).toBe(2);
    // 第 2、3 页：首页失败后 deck 仍 1 页骨架 → slideIndex 各为 1、2（追加语义）。
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1, 2]);
  });

  it("建 deck 失败回 failed 不落任何页", async () => {
    const harness = makeHarness([CONTENT_TREE]);
    harness.bridge.generate.mockResolvedValueOnce({ fileEntryId: "" });
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
  });
});
