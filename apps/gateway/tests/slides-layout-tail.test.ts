import { createCanvas } from "@napi-rs/canvas";
import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// 自审回投要先渲染本页 PNG：测试里把 soffice/sips 换成桩，只验流程与载荷。
vi.mock("../src/modules/slides-style/render.js", () => ({
  pptxToPng: vi.fn(async () => Buffer.from("png-bytes")),
}));
vi.mock("../src/modules/subagents/screenshot-jpeg.js", () => ({
  pngBase64ToJpegBase64: vi.fn(async (png: string) => png),
}));
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { runLayouterTail, type LayouterTailDeps } from "../src/modules/subagents/slides-layout-tail.js";
import type { SlidesProgressTracker } from "../src/modules/subagents/slides-progress-tracker.js";
import { semanticCases } from "./fixtures/slides-semantic.js";
import { pptxToPng } from "../src/modules/slides-style/render.js";

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
    completeDeck: ReturnType<typeof vi.fn>;
  };
  progress: {
    arm: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    disarm: ReturnType<typeof vi.fn>;
  };
  dispatches: Array<{ input: Record<string, unknown>; key: string }>;
  /** 自审回投（带 currentTree + 渲染图附件）的调用记录。 */
  selfReviews: Array<{ input: Record<string, unknown>; key: string; attachments?: unknown[] }>;
  settled: string[];
  trashed: string[];
}

function makeHarness(
  treesPerDispatch: Array<unknown | "FAIL">,
  persistentlyFailingPages: Set<number> = new Set(),
): Harness {
  const dispatches: Array<{ input: Record<string, unknown>; key: string }> = [];
  const selfReviews: Array<{ input: Record<string, unknown>; key: string; attachments?: unknown[] }> = [];
  let dispatchCursor = 0;
  const bridge = {
    generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
    renderPptx: vi.fn().mockResolvedValue(Buffer.from("pptx-bytes")),
    fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
    renderPage: vi.fn().mockResolvedValue(""),
    completeDeck: vi.fn().mockResolvedValue({ ok: true }),
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
    readMaterialBlob: vi.fn().mockResolvedValue(null),
    fetchImageHead: vi.fn().mockResolvedValue(null),
    makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
    dispatchPage: async (input, key, _parentRunId, attachments) => {
      // 自审回投：带 currentTree 的调用不消耗"每页一张树"的游标，默认原样返回。
      if (input.currentTree) {
        selfReviews.push({ input, key, ...(attachments ? { attachments } : {}) });
        return invocationWithTree(input.currentTree);
      }
      dispatches.push({ input, key });
      const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
      if (persistentlyFailingPages.has(pageIndex)) throw new Error("subagent_concurrency_limit");
      const entry = treesPerDispatch[dispatchCursor++] ?? treesPerDispatch[treesPerDispatch.length - 1];
      dispatchCursor = Math.min(dispatchCursor, treesPerDispatch.length - 1);
      if (entry === "FAIL") throw new Error("subagent_concurrency_limit");
      if (entry === "RUN_FAIL") {
        return { status: "failed", result: null, error_code: "runtime_error" } as unknown as SubagentInvocation;
      }
      return invocationWithTree(entry);
    },
  };
  return { deps, bridge, progress, dispatches, selfReviews, settled, trashed };
}

const CONTENT_TREE = {
  version: 2,
  role: "content",
  composition: "swiss",
  nodes: [
    { type: "text", token: "h1", text: "小标题", slot: { col: [1, 8], row: [1, 2] } },
    { type: "shape", shape: "rect", fill: "tone:primary", slot: { col: [1, 2], row: [3, 3] } },
    {
      type: "component",
      name: "pointList",
      items: [{ label: "要点", body: "要点内容" }, { label: "要点二", body: "要点内容" }],
      slot: { col: [1, 7], row: [4, 8] },
    },
    { type: "image", url: "https://example.com/a.jpg", slot: { col: [9, 12], row: [1, 8] } },
  ],
};

/** 同 CONTENT_TREE 的另一副骨架（槽位与节点类型都不同），用于相邻页重排。 */
const CONTENT_TREE_ALT = {
  version: 2,
  role: "content",
  composition: "swiss",
  nodes: [
    { type: "text", token: "h2", text: "小标题", slot: { col: [1, 4], row: [1, 8] } },
    {
      type: "component",
      name: "stats",
      items: [{ value: "42", label: "指标甲" }, { value: "7", label: "指标乙" }],
      slot: { col: [5, 9], row: [1, 4] },
    },
    {
      type: "component",
      name: "pointList",
      items: [{ label: "要点", body: "要点内容" }, { label: "要点二", body: "要点内容" }],
      slot: { col: [5, 9], row: [5, 8] },
    },
    { type: "icon", name: "bolt", slot: { col: [10, 12], row: [1, 2] } },
  ],
};

const CHART_TREE = {
  version: 2,
  role: "data",
  composition: "hero-data",
  nodes: [
    { type: "text", token: "hero", text: "2.7", slot: { col: [1, 4], row: [1, 3] } },
    {
      type: "component",
      name: "stats",
      items: [{ value: "42", label: "指标甲" }, { value: "7", label: "指标乙" }],
      slot: { col: [1, 4], row: [4, 6] },
    },
    { type: "shape", shape: "rect", fill: "tone:primary", slot: { col: [1, 2], row: [7, 7] } },
    {
      type: "chart",
      kind: "bar",
      categories: ["2025", "2026"],
      series: [{ name: "收入", values: [1, 2] }],
      slot: { col: [5, 12], row: [1, 8] },
    },
  ],
};

const QUOTE_TREE = {
  version: 2,
  role: "quote",
  composition: "poster",
  dark: true,
  nodes: [{ type: "text", token: "display", text: "一句话", align: "center", slot: { col: [1, 12], row: [2, 6] } }],
};

function planOf(trees: unknown[]): Record<string, unknown> {
  return {
    title: "测试演示",
    pages: trees.map((tree, index) => ({
      title: `第 ${index + 1} 页`,
      role: (tree as { role?: string }).role,
      density: "standard",
      layoutVersion: 2,
      composition: (tree as { composition?: string }).composition ?? "swiss",
      copy: { message: `第 ${index + 1} 页`, supporting: ["要点一", "要点二"], facts: [], speakerNotes: "讲稿" },
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
  it("does not create a deck or dispatch when already cancelled", async () => {
    const harness = makeHarness([QUOTE_TREE]);
    const controller = new AbortController();
    controller.abort();
    const result = await runLayouterTail(harness.deps, { ...tailArgs(planOf([QUOTE_TREE]), harness), signal: controller.signal });
    expect(JSON.parse(result.content).status).toBe("cancelled");
    expect(harness.bridge.generate).not.toHaveBeenCalled();
    expect(harness.dispatches).toHaveLength(0);
    expect(harness.trashed).toEqual([]);
  });

  it("cancels queued writes, preserves the in-flight successful page and resumes only the missing page", async () => {
    const harness = makeHarness([QUOTE_TREE, QUOTE_TREE]);
    const controller = new AbortController();
    const checkpoints: NonNullable<Parameters<typeof runLayouterTail>[1]["existingDeck"]>[] = [];
    harness.bridge.fillPage.mockImplementationOnce(async () => {
      // Cancellation arrives while the bridge is writing. This write finishes,
      // while the next queued write must never start.
      controller.abort();
      return { ok: true, applied: true };
    });
    const plan = planOf([QUOTE_TREE, QUOTE_TREE]);
    const result = await runLayouterTail(harness.deps, { ...tailArgs(plan, harness), signal: controller.signal,
      onCheckpoint: deck => checkpoints.push(deck) });
    expect(JSON.parse(result.content)).toMatchObject({ status: "cancelled", appliedPages: [0] });
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
    expect(harness.trashed).toEqual([]);
    expect(harness.settled).toEqual([]);
    expect(harness.bridge.completeDeck.mock.calls.every(([args]) => args.completed === false)).toBe(true);
    expect(checkpoints.at(-1)).toMatchObject({ appliedPages: [0] });

    const resumed = makeHarness([QUOTE_TREE]);
    const resumedResult = await runLayouterTail(resumed.deps, { ...tailArgs(plan, resumed), existingDeck: checkpoints.at(-1)! });
    expect(JSON.parse(resumedResult.content).status).toBe("completed");
    expect(resumed.bridge.generate).not.toHaveBeenCalled();
    expect(resumed.bridge.fillPage).toHaveBeenCalledTimes(1);
    expect(resumed.bridge.fillPage.mock.calls[0]![0].slideIndex).toBe(1);
    expect(resumed.dispatches.every(call => call.input.pageIndex === 1)).toBe(true);
  });

  it("cancels a stream that never supplies its first page", async () => {
    const harness = makeHarness([QUOTE_TREE]);
    const controller = new AbortController();
    let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const pages: NonNullable<Parameters<typeof runLayouterTail>[1]["stream"]>["pages"] = {
      [Symbol.asyncIterator]: () => ({ next: () => { reading(); return new Promise(() => {}); } }),
    };
    const resultPromise = runLayouterTail(harness.deps, { ...tailArgs(planOf([QUOTE_TREE]), harness), signal: controller.signal,
      stream: { totalPages: 1, outline: ["第一页"], pages } });
    await started;
    controller.abort();
    expect(JSON.parse((await resultPromise).content).status).toBe("cancelled");
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
  });

  it("returns blocked without retry, placeholder replacement or archiving", async () => {
    const harness = makeHarness([]);
    const dispatch = vi.fn(async () => ({ status: "completed", result: { structuredOutput: {
      status: "blocked", reason: "缺少数据", attempts: ["检查已有来源"], requestedAction: "提供原始表格",
    } } } as unknown as SubagentInvocation));
    harness.deps.dispatchPage = dispatch;
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([QUOTE_TREE, QUOTE_TREE]), harness));
    expect(JSON.parse(result.content)).toMatchObject({ status: "blocked", blockedPages: [
      { pageIndex: 0, requestedAction: "提供原始表格" }, { pageIndex: 1, requestedAction: "提供原始表格" },
    ] });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
  });

  it("settles restored pages even when a resumed stream ends before supplying new content", async () => {
    const harness = makeHarness([]);
    const plan = planOf([QUOTE_TREE, QUOTE_TREE]);
    const result = await runLayouterTail(harness.deps, { ...tailArgs(plan, harness),
      existingDeck: { fileEntryId: "old-deck", originalName: "deck.pptx", totalPages: 2, appliedPages: [0] },
      stream: { totalPages: 2, outline: ["第一页", "第二页"], pages: { async *[Symbol.asyncIterator]() {} } },
    });
    expect(JSON.parse(result.content)).toMatchObject({ status: "partial", fileEntryId: "old-deck", appliedPages: [0], failedPages: [1] });
    expect(harness.bridge.generate).not.toHaveBeenCalled();
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
  });

  it("semantic mode accepts simple text and identical adjacent layouts without richness or diversity rerolls", async () => {
    const page = semanticCases[0]!.page;
    const harness = makeHarness([]);
    const calls: Record<string, unknown>[] = [];
    const validateInput = new Ajv({ strict: false }).compile(JSON.parse(readFileSync(resolve("../../agents/slides-layouter/schemas/input.schema.json"), "utf8")));
    harness.deps.dispatchPage = async input => {
      calls.push(input);
      expect(validateInput(input), JSON.stringify(validateInput.errors)).toBe(true);
      const tree = input.currentTree ?? { version: 2, role: "content", composition: "swiss", notes: page.notes,
        nodes: page.blocks.map((b, i) => ({ type: "text", token: i === 0 ? "h1" : "body", text: (b as any).text, slot: { col: [1, 12], row: [i * 2 + 1, i * 2 + 2] } })),
      };
      return { status: "completed", result: { structuredOutput: { tree,
        designIntent: input.currentTree ? "自审后的表述" : `第 ${String(input.pageIndex)} 页：先标题，再并列收益`,
        bindings: page.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i}`] })),
      } } } as any;
    };
    const plan = { title: "test", pages: [{ content: page, neighbors: [{ role: "content", message: page.message }] }, { content: page }] };
    const result = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(4); // Two designs and two image reviews; no forced decoration/reroll.
    expect(calls.every(c => !c.skeleton && !c.form && !c.composition)).toBe(true);
    expect(calls.filter(c => !c.currentTree).every(c => c.previousDesignIntent === undefined)).toBe(true);
    const reviews = calls.filter(c => c.currentTree);
    expect(reviews).toHaveLength(2);
    for (const review of reviews) {
      expect(review.previousDesignIntent).toBe(`第 ${String(review.pageIndex)} 页：先标题，再并列收益`);
    }
    expect(result.visualValidation).toEqual(["reviewed", "reviewed"]);
  });

  it("semantic binding failure retries complete content and leaves draft recoverable", async () => {
    const page = semanticCases[0]!.page;
    const harness = makeHarness([CONTENT_TREE]);
    const plan = { title: "test", pages: [{ content: page }] };
    const result = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(result.status).toBe("failed");
    expect(harness.dispatches).toHaveLength(2);
    expect(harness.dispatches[1]!.input.content).toEqual(page);
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
  });

  it("semantic pages never land an empty fallback deck: invalid trees fail recoverably", async () => {
    // 语义页两轮都交不出合法树：整页判失败可重试，不落「内容生成中断」的假成功页。
    const page = semanticCases[0]!.page;
    const harness = makeHarness([]);
    harness.deps.dispatchPage = async () => ({ status: "completed", result: { structuredOutput: { tree: { version: 1 } } } } as any);
    const plan = { title: "test", pages: [{ content: page }] };
    const result = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(result.status).toBe("failed");
    expect(result.retryable).toBe(true);
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
  });

  it("先落首版、自审修正后补落同一页，且补落的就是重新渲染过的修正树", async () => {
    const png = createCanvas(320, 180).toBuffer("image/png");
    vi.mocked(pptxToPng).mockResolvedValueOnce(png).mockResolvedValueOnce(png);
    const page = semanticCases[0]!.page;
    const harness = makeHarness([]);
    harness.deps.dispatchPage = async input => {
      const tree = { version: 2, role: "content", composition: "swiss", nodes: page.blocks.map((b, i) => ({
        type: "text", token: i === 0 ? "h1" : "body", text: (b as any).text,
        align: input.currentTree ? "center" : "left", slot: { col: [1, 12], row: [i * 2 + 1, i * 2 + 2] },
      })) };
      return { status: "completed", result: { structuredOutput: { tree, designIntent: "突出标题", bindings: page.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i}`] })) } } } as any;
    };
    const plan = { title: "test", pages: [{ content: page }] };
    const result = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(result.status).toBe("completed");
    expect(result.visualValidation).toEqual(["revised-rendered"]);
    const bridge = harness.deps.bridge as any;
    expect(bridge.renderPptx).toHaveBeenCalledTimes(2);
    // 首版先落（用户先看到页），自审修正后再补落同一页：两次都是 slideIndex 0。
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(2);
    expect(harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex)).toEqual([0, 0]);
    expect(JSON.parse(bridge.renderPptx.mock.calls[1][0].pages[0])).toEqual(JSON.parse(harness.bridge.fillPage.mock.calls[1]![0].specJson));
  });

  it("三页直落：占位页一次建满、按页序替换、逐页进度、回收草稿与落定风格", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.fileEntryId).toBe("file-1");
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes.slice().sort()).toEqual([0, 1, 2]);
    expect(harness.progress.notify.mock.calls.map((call: unknown[]) => call[1]).sort()).toEqual([0, 1, 2]);
    // 占位页一次建满：deck 一开始就有 N 页骨架，落页只做「按页序替换」。
    expect((harness.bridge.generate.mock.calls[0]![0] as { pages: string[] }).pages.length).toBe(3);
    // 进度快照带落定页号集合（完成顺序 ≠ 页序，卡按集合打勾）。
    expect(harness.progress.notify.mock.calls.at(-1)![2]).toEqual([0, 1, 2]);
    expect(payload.appliedPages).toEqual([0, 1, 2]);
    expect(harness.progress.arm.mock.calls[0]![0]).toBe("slides-generate:run-1");
    expect(harness.progress.disarm).toHaveBeenCalledWith("slides-generate:run-1");
    expect(harness.trashed).toEqual(["draft-1"]);
    expect(harness.settled).toEqual(["style-1"]);
    expect(harness.dispatches.every((d) => d.input.deckToken === "run-1:layout")).toBe(true);
    expect(payload.warnings).toEqual([]);
  });

  it("全部页落定后发最终 page_applied 全量快照并补发 done（deferDone 真完成时机）", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE]);
    const onUpdate = vi.fn();
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness),
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    // 骨架入库阶段不广播 done：generate 请求带 deferDone。
    expect(harness.bridge.generate).toHaveBeenCalledWith(expect.objectContaining({ deferDone: true }));
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({
      stage: "page_applied",
      completed: true,
      doneCount: 2,
      totalPages: 2,
      roomId: "room-1",
      documentId: "draft-1",
      fileEntryId: "file-1",
      fileName: "deck.pptx",
    });
    expect(typeof final.details.updatedAt).toBe("number");
    expect(final.details.failedPages).toBeUndefined();
    expect(harness.bridge.completeDeck).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "file-1",
      completed: true,
      appliedPages: 2,
      totalPages: 2,
    }));
  });

  it("落页失败页进 failedPages 且补发 partial done（不做假完成）", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE]);
    harness.bridge.fillPage.mockImplementation(async (input: { slideIndex: number }) =>
      input.slideIndex === 0 ? { ok: false, applied: false, error: "桌面端拒绝" } : { ok: true, applied: true });
    const onUpdate = vi.fn();
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness),
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("partial");
    expect(payload.failedPages).toEqual([0]);
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({ stage: "page_applied", completed: false, doneCount: 1, failedPages: [0] });
    expect(harness.bridge.completeDeck).toHaveBeenCalledWith(expect.objectContaining({
      completed: false,
      appliedPages: 1,
      failedPages: [0],
    }));
  });

  it("流式落页：首页树就绪即落页，不等后页树齐", async () => {
    let page1Resolved = false;
    let releasePage1: ((invocation: SubagentInvocation) => void) | null = null;
    const bridge = {
      generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
      fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
      renderPage: vi.fn().mockResolvedValue(""),
    };
    const progress = { arm: vi.fn(), notify: vi.fn(), disarm: vi.fn(), setRelay: vi.fn() };
    const deps: LayouterTailDeps = {
      progress: progress as unknown as SlidesProgressTracker,
      bridge: bridge as never,
      readMaterialBlob: vi.fn().mockResolvedValue(null),
      fetchImageHead: vi.fn().mockResolvedValue(null),
      makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
      dispatchPage: (input: Record<string, unknown>) => {
        const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
        if (pageIndex === 0) return Promise.resolve(invocationWithTree(CONTENT_TREE));
        return new Promise<SubagentInvocation>((resolve) => {
          releasePage1 = (invocation) => {
            page1Resolved = true;
            resolve(invocation);
          };
        });
      },
    };
    const plan = planOf([CONTENT_TREE, CHART_TREE]);
    const runPromise = runLayouterTail(deps, {
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
      styleSessions: { patch: () => {} },
      pageImagesStore: null,
      trashDraft: async () => {},
    });
    await vi.waitFor(() => expect(bridge.fillPage).toHaveBeenCalledWith(expect.objectContaining({ slideIndex: 0 })));
    // 第 2 页树仍挂起时首页已落——落页与取树流水线化的直接证据。
    expect(page1Resolved).toBe(false);
    releasePage1!(invocationWithTree(CHART_TREE));
    const result = await runPromise;
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    const appliedIndexes = bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1]);
    expect(progress.notify.mock.calls.map((call: unknown[]) => call[1])).toEqual([0, 1]);
  });

  it("完成顺序落页：后页先就绪就先落，不排队等前页（head-of-line 消除）", async () => {
    let releaseSlowPage: ((invocation: SubagentInvocation) => void) | null = null;
    const bridge = {
      generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
      fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
      renderPage: vi.fn().mockResolvedValue(""),
    };
    const progress = { arm: vi.fn(), notify: vi.fn(), disarm: vi.fn(), setRelay: vi.fn() };
    const deps: LayouterTailDeps = {
      progress: progress as unknown as SlidesProgressTracker,
      bridge: bridge as never,
      readMaterialBlob: vi.fn().mockResolvedValue(null),
      fetchImageHead: vi.fn().mockResolvedValue(null),
      makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
      dispatchPage: (input: Record<string, unknown>) => {
        const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
        // 第 1 页最慢（模拟长 validate/预览自纠），第 2、3 页先就绪。
        if (pageIndex === 0) {
          return new Promise<SubagentInvocation>((resolve) => {
            releaseSlowPage = resolve;
          });
        }
        return Promise.resolve(invocationWithTree(pageIndex === 1 ? CHART_TREE : QUOTE_TREE));
      },
    };
    const plan = planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const runPromise = runLayouterTail(deps, {
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
      styleSessions: { patch: () => {} },
      pageImagesStore: null,
      trashDraft: async () => {},
    });
    // 首页树还挂着，第 2、3 页已经各自落进自己的页号——落页不再被前页堵住。
    await vi.waitFor(() => expect(bridge.fillPage).toHaveBeenCalledTimes(2));
    expect(bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex)).toEqual([1, 2]);
    expect(progress.notify.mock.calls.at(-1)![2]).toEqual([1, 2]);
    releaseSlowPage!(invocationWithTree(CONTENT_TREE));
    const payload = JSON.parse((await runPromise).content);
    expect(payload.status).toBe("completed");
    expect(payload.appliedPages).toEqual([0, 1, 2]);
    expect(bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex)).toEqual([1, 2, 0]);
  });

  it("素材分辨率不足时丢图并告警，避免低清图铺满页面", async () => {
    const canvas = createCanvas(300, 168);
    const buffer = canvas.toBuffer("image/png");
    const tiny = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const harness = makeHarness([CONTENT_TREE]);
    harness.deps.readMaterialBlob = vi.fn(async () => tiny);
    const plan = {
      title: "封面测试",
      pages: [{
        title: "封面",
        role: "cover",
        density: "sparse",
        points: ["封面"],
        materials: [{ url: `everroom-material://${"a".repeat(64)}`, desc: "低清图" }],
      }],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(harness.dispatches[0]!.input.materials).toBeUndefined();
    expect(payload.warnings.join("")).toContain("分辨率不足");
  });

  it("v2 页面：layouter 输入带 layoutVersion/copy/composition，且不传 points", async () => {
    const v2Tree = {
      version: 2,
      role: "data",
      composition: "hero-data",
      footer: { pageNumbers: true },
      nodes: [
        { type: "text", token: "hero", text: "2.7", slot: { col: [1, 4], row: [1, 3] } },
        { type: "stats", items: [{ value: "2.83", unit: "万亿元", label: "2020 年 GDP" }, { value: "3.87", unit: "万亿元", label: "2025 年 GDP" }], slot: { col: [5, 8], row: [1, 3] } },
      ],
    };
    const harness = makeHarness([v2Tree]);
    const plan = {
      title: "v2 deck",
      pages: [{
        title: "数据页",
        role: "data",
        density: "dense",
        points: ["兜底要点"],
        layoutVersion: 2,
        composition: "hero-data",
        emphasis: "number",
        intent: "建立规模事实。",
        takeaway: "两个量级。",
        copy: { message: "从 2.7 亿到 3.87 万亿元", supporting: [], facts: [], speakerNotes: "讲稿".repeat(20) },
        data: { stats: [{ value: "2.83", unit: "万亿元", label: "2020 年 GDP" }] },
        neighbors: [{ pageIndex: 1, composition: "editorial", takeaway: "下一句" }],
        budget: { prose: 60, copy: 120, notes: 260 },
      }],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(harness.dispatches[0]!.input.layoutVersion).toBe(2);
    expect(harness.dispatches[0]!.input.composition).toBe("hero-data");
    expect(harness.dispatches[0]!.input.copy).toMatchObject({ message: "从 2.7 亿到 3.87 万亿元" });
    expect(harness.dispatches[0]!.input.points).toBeUndefined();
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
  });

  it("布局代理失败页落确定性兜底并告警，整册仍完成", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE], new Set([0]));
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.warnings.some((w: string) => /第 1 页布局代理未交合格树/.test(w))).toBe(true);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(3);
  });

  it("代理交回 v1 树时按 v2 兜底页落页（布局只有 v2 一种格式）", async () => {
    const v1Tree = {
      role: "content",
      title: "旧语法页",
      direction: "column",
      children: [{ type: "text", variant: "body", text: "v1 语法" }],
    };
    const harness = makeHarness([v1Tree]);
    const page = {
      title: "旧语法页",
      role: "content",
      density: "standard",
      layoutVersion: 2,
      composition: "swiss",
      copy: { message: "旧语法页", supporting: ["要点一", "要点二"], facts: [], speakerNotes: "讲稿" },
    };
    const result = await runLayouterTail(harness.deps, tailArgs({ title: "v1 兜底测试", pages: [page] }, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings.some((w: string) => /交回的是 v1 树/.test(w))).toBe(true);
    const specJson = String((harness.bridge.fillPage.mock.calls[0]![0] as { specJson: string }).specJson);
    expect(specJson).toContain("旧语法页");
    expect(specJson).toContain("要点一");
  });

  it("相邻页同构触发一次重排：重排 dispatch 带邻页签名并重落该页", async () => {
    const rerolled = CONTENT_TREE_ALT;
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
      version: 2,
      role: "quote",
      composition: "poster",
      dark: true,
      nodes: [{ type: "text", token: "display", text: "带 emoji 🎉 的树", slot: { col: [1, 6], row: [2, 4] } }],
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
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(0);
    expect(harness.trashed).toEqual([]);
  });

  it("布局代理未交树先减配重试：砍半要点/去图表行/降密度，重试树被采用", async () => {
    const harness = makeHarness(["RUN_FAIL", CHART_TREE, CONTENT_TREE]);
    const plan = {
      title: "测试演示",
      pages: [
        { title: "密集数据页", role: "data", density: "dense",
          layoutVersion: 2, composition: "hero-data",
          copy: {
            message: "入境游客量级",
            supporting: ["要点一", "要点二", "要点三", "要点四"],
            facts: [{ label: "入境过夜游客", value: "1308.20", unit: "万人次" }],
            speakerNotes: "环形图表现构成",
          },
          data: { stats: [{ value: "1308.20", unit: "万人次", label: "入境过夜游客" }], chart: { kind: "bar", categories: ["甲", "乙"], series: [{ name: "系列", values: [1, 2] }] } } },
        { title: "正常页", role: "content", density: "standard", layoutVersion: 2, composition: "swiss", copy: { message: "正常页", supporting: ["要点一", "要点二"], facts: [], speakerNotes: "讲稿" } },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings.some((w: string) => /第 1 页布局代理减配重试后收敛/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /未交合格树/.test(w))).toBe(false);
    const trimmed = harness.dispatches.find((d) => d.key.includes(":trimmed"));
    expect(trimmed).toBeDefined();
    expect(trimmed!.input.density).toBe("sparse");
    expect((trimmed!.input.copy as { supporting: string[] }).supporting).toEqual(["要点一", "要点二"]);
    expect((trimmed!.input.data as Record<string, unknown>).chart).toBeUndefined();
    expect((trimmed!.input.copy as Record<string, unknown>).speakerNotes).toBeUndefined();
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    // 减配重试让第 1 页变慢，第 2 页因此先落——落页按完成顺序，不再被前页堵住。
    expect(appliedIndexes.slice().sort()).toEqual([0, 1]);
    expect(appliedIndexes).toEqual([1, 0]);
  });

  it("减配重试仍不收敛才落结构化兜底：pointList 条目 + stats KPI，不再是圆点文本墙", async () => {
    const harness = makeHarness(["RUN_FAIL"]);
    const plan = {
      title: "测试演示",
      pages: [
        { title: "入境游客数据页", role: "data", density: "dense",
          layoutVersion: 2, composition: "hero-data",
          copy: {
            message: "入境游客与外汇收入",
            supporting: [
              "地标：平安金融中心 592.5 米，为深圳第一高楼。",
              "山海：梧桐山 943.7 米为深圳第一高峰。",
              "人文：世界之窗汇聚 130 余个微缩景观。",
              "湾区：湾区之光摩天轮位于宝安欢乐港湾。",
            ],
            facts: [],
            speakerNotes: "讲稿",
          },
          data: { stats: [
            { value: "1308.20", unit: "万人次", label: "入境过夜游客（+34.0%）" },
            { value: "110.67", unit: "亿美元", label: "旅游外汇收入（+51.2%）" },
          ] } },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings.some((w: string) => /第 1 页布局代理未交合格树/.test(w))).toBe(true);
    expect(harness.dispatches.some((d) => d.key.includes(":trimmed"))).toBe(true);
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
    const specJson = String((harness.bridge.fillPage.mock.calls[0]![0] as { specJson: string }).specJson);
    expect(specJson).toContain("地标");
    expect(specJson).toContain("人文");
    expect(specJson).toContain("1308.20");
    expect(specJson).toContain("入境过夜游客（+34.0%）");
    // 不再产出圆点 bullet 文本墙
    expect(specJson).not.toContain('"bullet":true');
  });

  it("layouter 输入带风格卡确定性快照（composition/motif/decoration/componentDefaults，体积 ≤1200）", async () => {
    const styleParams = {
      composition: "poster",
      darkCover: false,
      motif: { kind: "color-band" },
      palette: {
        background: "#0e0d0c",
        surface: "#1a1917",
        primary: "#e8c468",
        accent: "#e85d3d",
        text: "#f7f4ec",
        textMuted: "#a8a399",
        onDarkText: "#f7f4ec",
        chartSeries: ["#e8c468", "#e85d3d", "#5b8def", "#8a94a8", "#c9a063", "#6e6a61"],
      },
      typography: { fontHeading: "Songti SC, Georgia", fontBody: "PingFang SC", headingBold: true },
      spacing: { margin: 64, gutter: 24, cardPadding: 20, cornerRadius: 16 },
      decoration: { cardShadow: "soft", divider: "none", imageFit: "contain" },
    };

    const v2Tree = {
      version: 2,
      role: "cover",
      composition: "poster",
      nodes: [{ type: "text", token: "display", text: "海报标题", slot: { col: [1, 8], row: [1, 3] } }],
    };
    const harness = makeHarness([v2Tree]);
    const plan = {
      title: "海报 deck",
      pages: [{
        title: "海报页",
        role: "cover",
        density: "standard",
        layoutVersion: 2,
        composition: "poster",
        copy: { message: "海报标题", supporting: [], facts: [], speakerNotes: "讲稿" },
      }],
    };
    await runLayouterTail(harness.deps, { ...tailArgs(plan, harness), styleParams });

    interface StyleTokensSnapshot {
      composition: string;
      darkCover: boolean;
      motif: Record<string, unknown>;
      palette: { accent: string; primary: string; chartSeries: string[]; [key: string]: unknown };
      typeScale: Record<string, number>;
      fonts: { heading?: string; [key: string]: unknown };
      decoration: Record<string, unknown>;
      componentDefaults: Record<string, unknown>;
    }
    expect(harness.dispatches.length).toBeGreaterThan(0);
    const raw = harness.dispatches[0]!.input.styleTokens;
    expect(raw).toBeDefined();
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(1200);
    const tokens = raw as unknown as StyleTokensSnapshot;
    expect(tokens.composition).toBe("poster");
    expect(tokens.darkCover).toBe(false);
    expect(tokens.motif).toEqual({ kind: "color-band" });
    expect(tokens.decoration).toMatchObject({ cardShadow: "soft", divider: "none", imageFit: "contain" });
    expect(tokens.palette.accent).toBe("#e85d3d");
    expect(tokens.palette.primary).toBe("#e8c468");
    // chartSeries 只留 4 只，避免 token 快照膨胀。
    expect(tokens.palette.chartSeries).toEqual(["#e8c468", "#e85d3d", "#5b8def", "#8a94a8"]);
    // 组件默认值 = 风格卡 design 轴：cardShadow 有值 → card；divider none → gap；poster → airy；accent 与 primary 不同 → accent。
    expect(tokens.componentDefaults).toEqual({
      surface: "card",
      separator: "gap",
      align: "start",
      density: "airy",
      numeral: "serif",
      accent: "accent",
    });
    // 字体名只保留首字体（OOXML 单字体），超 40 字截断由 styleTokensFrom 处理。
    expect(tokens.fonts.heading).toBe("Songti SC");
    expect(tokens.typeScale.hero).toEqual(expect.any(Number));
  });

  it("自审回投输入同样带 styleTokens（看渲染图时也要守住风格卡）", async () => {
    const styleParams = {
      composition: "poster",
      darkCover: false,
      motif: { kind: "color-band" },
      palette: { background: "#0e0d0c", surface: "#1a1917", primary: "#e8c468", accent: "#e85d3d", text: "#f7f4ec", textMuted: "#a8a399", onDarkText: "#f7f4ec" },
      typography: { fontHeading: "Songti SC", fontBody: "PingFang SC", headingBold: true },
      spacing: { margin: 64, gutter: 24, cardPadding: 20, cornerRadius: 16 },
      decoration: { cardShadow: "soft", divider: "none", imageFit: "contain" },
    };
    const harness = makeHarness([CONTENT_TREE]);
    await runLayouterTail(harness.deps, { ...tailArgs(planOf([CONTENT_TREE]), harness), styleParams });
    const reviews = harness.selfReviews.map((entry) => entry.input);
    expect(reviews.length).toBeGreaterThan(0);
    const tokens = reviews[0]!.styleTokens as { composition?: string; decoration?: Record<string, unknown> } | undefined;
    expect(tokens).toBeDefined();
    expect(tokens!.composition).toBe("poster");
    expect(tokens!.decoration).toMatchObject({ divider: "none", imageFit: "contain" });
  });

  // 自审（2026-10-22，2026-10-24 调整为落页后）：审页代理已砍——每页写完立刻把
  // **自己的渲染图**投回同一个布局代理（视觉档模型）自查。落页优先：先落首版让用户看到页，
  // 修正后的树再补落同一页。这里验两件事：
  // ①每页都回投过且附件是图片；②回投发生在该页首版落定之后（先交付，后提质）。
  it("先落页、后自审：每页带着渲染图回投，且在该页落页之后", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE]);
    const events: string[] = [];
    harness.bridge.fillPage.mockImplementation(async ({ slideIndex }: { slideIndex: number }) => {
      events.push(`land:${String(slideIndex)}`);
      return { ok: true, applied: true };
    });
    const baseDispatch = harness.deps.dispatchPage;
    harness.deps.dispatchPage = async (input, key, parentRunId, attachments) => {
      if (input.currentTree) events.push(`self-review:${String((input as { pageIndex?: number }).pageIndex ?? -1)}`);
      return baseDispatch(input, key, parentRunId, attachments);
    };

    await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness));

    expect(harness.selfReviews).toHaveLength(2);
    for (const review of harness.selfReviews) {
      const attachment = review.attachments?.[0] as { kind?: string; dataUrl?: string } | undefined;
      expect(attachment?.kind).toBe("image");
      expect(attachment?.dataUrl).toMatch(/^data:image\/(png|jpeg);base64,/);
      // 回投必须带上"当前这棵树"，否则模型没有要审的对象。
      expect((review.input.currentTree as { version?: number }).version).toBe(2);
    }
    // 第 1 页：先落页，再回投自审（落页优先，自审只提质）。
    expect(events.indexOf("land:0")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("self-review:0")).toBeGreaterThan(events.indexOf("land:0"));
  });

  it("deck 未打开导致落页失败：明确 not_open 原因与可重试标记", async () => {
    const harness = makeHarness([CONTENT_TREE]);
    harness.bridge.fillPage.mockImplementation(async () => {
      throw new Error("该 PPT 当前不是以可编辑的 PPT 产物打开的，无法应用编辑。请在 Room 产物库中重新以可编辑方式打开后再试。");
    });
    const updates: Array<Record<string, unknown>> = [];
    const plan = planOf([CONTENT_TREE]);
    const result = JSON.parse((await runLayouterTail(harness.deps, {
      ...tailArgs(plan, harness),
      onUpdate: (update) => updates.push(update.details as Record<string, unknown>),
    })).content);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("slides_layout_apply_failed");
    expect(result.landingBlocked).toBe("deck_not_open");
    expect(String(result.message)).toContain("not_open");
    expect(updates.at(-1)).toMatchObject({ landingBlocked: "deck_not_open" });
    const warnings = (updates.at(-1)?.warnings as string[] | undefined) ?? [];
    expect(warnings.join("；")).toContain("not_open");
  });

  it("existingDeck：复用同一个 deck 续落，只补未落定的页", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE]);
    const plan = planOf([CONTENT_TREE, CHART_TREE]);
    const first = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(first.status).toBe("completed");
    expect(first.appliedPages).toEqual([0, 1]);
    expect(harness.bridge.generate).toHaveBeenCalledTimes(1);
    harness.dispatches.length = 0;

    const second = JSON.parse((await runLayouterTail(harness.deps, {
      ...tailArgs(plan, harness),
      runId: "run-2",
      existingDeck: { fileEntryId: "file-1", originalName: "deck.pptx", appliedPages: [0], totalPages: 2 },
    })).content);
    expect(second.status).toBe("completed");
    expect(second.appliedPages).toEqual([0, 1]);
    // 不再建第二个 deck；只补第 2 页的布局与落页。
    expect(harness.bridge.generate).toHaveBeenCalledTimes(1);
    expect(harness.dispatches).toHaveLength(1);
    const lastFill = harness.bridge.fillPage.mock.calls.at(-1)![0] as { fileId: string; slideIndex: number };
    expect(lastFill).toMatchObject({ fileId: "file-1", slideIndex: 1 });
  });

  // 2026-10-20 事故回归：遗留 invocation 占满全局子代理并发窗口，整册页全部拿不到
  // 布局树却落兜底版式回 completed。页级退避 2s+6s（单页约 8s），用例保持 2~4 页。
  it("全部页布局代理并发不可用：不交付兜底整册，回报可重试失败", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE], new Set([0, 1]));
    const onUpdate = vi.fn();
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs(planOf([CONTENT_TREE, CHART_TREE]), harness),
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.errorCode).toBe("slides_layout_agents_unavailable");
    expect(payload.retryable).toBe(true);
    expect(payload.failedPages).toEqual([0, 1]);
    expect(payload.fileEntryId).toBe("file-1");
    expect(payload.warnings.some((w: string) => w.includes("布局代理并发不可用"))).toBe(true);
    // 已落页保留（兜底版式写入 deck），重试可复用；但绝不静默报成功。
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(2);
    expect(harness.bridge.completeDeck).toHaveBeenCalledWith(expect.objectContaining({ completed: false }));
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({ stage: "page_applied", completed: false, failedPages: [0, 1] });
    // 代理不可用不是「树不合格」：不派 reroll、不审页、不回草稿、不落定风格会话。
    expect(harness.dispatches.every((d) => !d.key.includes("reroll:"))).toBe(true);
    expect(harness.settled).toEqual([]);
  }, 30_000);

  it("过半页不可用即判定失败，不静默成功（容差边界 ceil(4/2)=2）", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE, CONTENT_TREE], new Set([0, 2]));
    const result = await runLayouterTail(
      harness.deps,
      tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE, CONTENT_TREE]), harness),
    );
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.errorCode).toBe("slides_layout_agents_unavailable");
    expect(payload.retryable).toBe(true);
    expect(payload.failedPages).toEqual(expect.arrayContaining([0, 2]));
    expect(payload.warnings.some((w: string) => w.includes("布局代理并发不可用"))).toBe(true);
  }, 30_000);
});
