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
import type { SemanticPage } from "../src/modules/subagents/slides-semantic-contract.js";
import { pptxToPng } from "../src/modules/slides-style/render.js";

function invocationWithTree(tree: unknown, status = "completed"): SubagentInvocation {
  // 语义模式提交须带 designIntent 与 bindings；树是 v2 时按同一推导规则自建内容绑定。
  const record = tree as Record<string, unknown> | null;
  const page = record && record.version === 2 ? semanticPageOfTree(record, 0) : null;
  return {
    status,
    result: { structuredOutput: {
      status: "done", tree,
      designIntent: "测试设计意图",
      ...(page ? { bindings: deriveBindings(page, tree) } : {}),
    } },
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
  dispatches: Array<{ input: Record<string, unknown>; key: string; session?: { sessionId: string; runtimeSessionRef: string | null } }>;
  /** 自审回投（带 currentTree + 渲染图附件）的调用记录。 */
  selfReviews: Array<{ input: Record<string, unknown>; key: string; attachments?: unknown[] }>;
  settled: string[];
  trashed: string[];
}

function makeHarness(
  treesPerDispatch: Array<unknown | "FAIL">,
  persistentlyFailingPages: Set<number> = new Set(),
): Harness {
  const dispatches: Array<{ input: Record<string, unknown>; key: string; session?: { sessionId: string; runtimeSessionRef: string | null } }> = [];
  const selfReviews: Array<{ input: Record<string, unknown>; key: string; attachments?: unknown[] }> = [];
  let dispatchCursor = 0;
  let refCounter = 0;
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
    dispatchPage: async (input, key, _parentRunId, attachments, session) => {
      // 自审回投：带 currentTree 的调用不消耗"每页一张树"的游标，默认原样返回。
      if (input.currentTree) {
        selfReviews.push({ input, key, ...(attachments ? { attachments } : {}) });
        return invocationWithTree(input.currentTree);
      }
      dispatches.push({ input, key, ...(session ? { session } : {}) });
      const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
      if (persistentlyFailingPages.has(pageIndex)) throw new Error("subagent_concurrency_limit");
      const entry = treesPerDispatch[dispatchCursor++] ?? treesPerDispatch[treesPerDispatch.length - 1];
      dispatchCursor = Math.min(dispatchCursor, treesPerDispatch.length - 1);
      if (entry === "FAIL") throw new Error("subagent_concurrency_limit");
      if (entry === "RUN_FAIL") {
        return { status: "failed", result: null, error_code: "runtime_error" } as unknown as SubagentInvocation;
      }
      // 模拟 pi 续会话：每次成功 run 返回新的会话 ref，链式传给下一页。
      refCounter += 1;
      return { ...invocationWithTree(entry), runtimeSessionRef: `ref-${refCounter}` } as SubagentInvocation;
    },
  };
  return { deps, bridge, progress, dispatches, selfReviews, settled, trashed };
}

/** 节点可见文本（text 节点原文；组件按条目的标签/标题串接）。 */
function visibleTextOfNode(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const record = node as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.items)) {
    return record.items.map((item) => {
      if (item === null || typeof item !== "object") return "";
      const entry = item as Record<string, unknown>;
      return [entry.label, entry.title, entry.text, entry.body].find((value) => typeof value === "string") ?? "";
    }).join("");
  }
  return "";
}

/** 内容块 → 树内承载节点：chart 按结构等价匹配，其余按可见文本包含匹配。 */
function deriveBindings(page: SemanticPage, tree: unknown): Array<{ blockId: string; paths: string[] }> {
  const nodes = Array.isArray((tree as { nodes?: unknown[] })?.nodes) ? (tree as { nodes: unknown[] }).nodes : [];
  return page.blocks.flatMap((block) => {
    const index = nodes.findIndex((node) => {
      const record = node as Record<string, unknown>;
      if (block.type === "chart") {
        return record.type === "chart"
          && JSON.stringify(record.categories) === JSON.stringify(block.labels)
          && JSON.stringify((record.series as Array<{ name: string; values: number[] }>).map(s => [s.name, s.values]))
            === JSON.stringify(block.series.map(s => [s.name, s.values]));
      }
      return block.type === "text" && visibleTextOfNode(node).includes(block.text);
    });
    return index >= 0 ? [{ blockId: block.id, paths: [`nodes/${index}`] }] : [];
  });
}

/** 从 v2 树推导语义内容页（message=首个文本节点；文本/组件条目/chart 各成 block；图片不派生，避免素材依赖）。 */
function semanticPageOfTree(tree: Record<string, unknown>, index: number): SemanticPage {
  const nodes = (Array.isArray(tree.nodes) ? tree.nodes : []) as Array<Record<string, unknown>>;
  const blocks: SemanticPage["blocks"] = [];
  let firstText: string | undefined;
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.type === "text" && typeof node.text === "string") {
      firstText ??= node.text;
      blocks.push({ id: `b${nodeIndex}`, type: "text", text: node.text, sourceRefs: [`src-${index}`],
        priority: blocks.length === 0 ? "primary" : "supporting", mustShow: true });
    } else if (node.type === "component" && Array.isArray(node.items)) {
      for (const [itemIndex, item] of (node.items as Array<Record<string, unknown>>).entries()) {
        const label = [item.label, item.title].find((value) => typeof value === "string" && value.trim());
        if (typeof label !== "string") continue;
        blocks.push({ id: `b${nodeIndex}-${itemIndex}`, type: "text", text: label, sourceRefs: [`src-${index}`],
          priority: "supporting", mustShow: true });
      }
    } else if (node.type === "chart") {
      blocks.push({ id: `b${nodeIndex}`, type: "chart",
        labels: node.categories as string[],
        series: node.series as { name: string; values: number[] }[],
        sourceRefs: [`src-${index}`], priority: "supporting", mustShow: true });
    }
  }
  return {
    id: `page-${index + 1}`, sourceRefs: [`src-${index}`],
    role: (typeof tree.role === "string" ? tree.role : "content") as SemanticPage["role"],
    message: firstText ?? `第 ${index + 1} 页`,
    blocks, relations: [], focusRefs: blocks.slice(0, 1).map(b => b.id),
    constraints: { verbatimRefs: [] }, notes: "", omissions: [],
  };
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
      content: semanticPageOfTree(tree as Record<string, unknown>, index),
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
    // 逐页追加模式：第 0 页骨架已随文件创建（不补）；第 1 页阻塞也补一页骨架保住页序。
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
    expect((harness.bridge.fillPage.mock.calls[0]![0] as { slideIndex: number }).slideIndex).toBe(1);
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

  it("主内容未采用组件时回投修订一次，采纳后统计采用率；修订不收敛则保留原页", async () => {
    const validateInput = new Ajv({ strict: false }).compile(JSON.parse(readFileSync(resolve("../../agents/slides-layouter/schemas/input.schema.json"), "utf8")));
    const mkBlock = (id: string, body: string) => ({ id, type: "text" as const, text: body, sourceRefs: ["src-1"], priority: "primary" as const, mustShow: true });
    const page = {
      id: "page-1", sourceRefs: ["src-1"], role: "content" as const, message: "推进节奏",
      blocks: [mkBlock("b1", "调研市场"), mkBlock("b2", "设计方案"), mkBlock("b3", "交付上线")],
      relations: [{ type: "precedes" as const, refs: ["b1", "b2", "b3"], basis: "先后推进" }],
      focusRefs: ["b1", "b2", "b3"], constraints: { verbatimRefs: [] }, notes: "", omissions: [],
    };
    const heading = { type: "text", token: "h2", text: "推进节奏", slot: { col: [1, 12], row: [1, 1] } };
    // 首轮：3 个独立 text 节点承载（短文本不触发等宽列检查；无组件触发采用修订）。
    const plainTree = { version: 2, role: "content", composition: "swiss", notes: "", nodes: [
      heading,
      { type: "text", token: "body", text: "调研市场", slot: { col: [1, 3], row: [3, 4] } },
      { type: "text", token: "body", text: "设计方案", slot: { col: [5, 8], row: [3, 5] } },
      { type: "text", token: "body", text: "交付上线", slot: { col: [9, 12], row: [3, 6] } },
    ] };
    // 修订轮：timeline 组件承载整组。
    const componentTree = { version: 2, role: "content", composition: "swiss", notes: "", nodes: [
      heading,
      { type: "component", name: "timeline", items: [
        { label: "调研市场", text: "调研市场" }, { label: "设计方案", text: "设计方案" }, { label: "交付上线", text: "交付上线" },
      ], slot: { col: [1, 12], row: [2, 8] } },
    ] };
    const outputs = [plainTree, componentTree, componentTree];
    const calls: Record<string, unknown>[] = [];
    const harness = makeHarness([]);
    harness.deps.dispatchPage = async input => {
      calls.push(input);
      expect(validateInput(input), JSON.stringify(validateInput.errors)).toBe(true);
      const tree = input.currentTree ?? outputs.shift()!;
      const bindings = tree === componentTree
        ? page.blocks.map(b => ({ blockId: b.id, paths: ["nodes/1"] }))
        : page.blocks.map((b, i) => ({ blockId: b.id, paths: [`nodes/${i + 1}`] }));
      return { status: "completed", result: { structuredOutput: { tree, designIntent: "标题在上", bindings } } } as any;
    };
    const plan = { title: "test", pages: [{ content: page }] };
    const result = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(result.status).toBe("completed");
    // 设计 → 采用修订 → 自审，共 3 次派发；修订反馈点名推荐组件。
    expect(calls).toHaveLength(3);
    expect(String((calls[1] as { revisionFeedback?: string }).revisionFeedback)).toContain("timeline");
    expect(result.warnings.join()).toContain("已按闸门提示修订");
    expect(result.componentAdoption).toMatchObject({
      eligibleGroups: 1,
      adoptedGroups: 1,
      componentUsage: { timeline: 1 },
    });
  });

  it("素材长宽比回填进 layouter 输入：模型按真实比例切框，不必盲猜", async () => {
    const png = new Uint8Array(createCanvas(1600, 900).toBuffer("image/png")).slice();
    const harness = makeHarness([]);
    harness.deps.readMaterialBlob = vi.fn(async () => png);
    const page = semanticCases[0]!.page;
    const calls: Record<string, unknown>[] = [];
    harness.deps.dispatchPage = async (input) => {
      calls.push(input);
      const tree = input.currentTree ?? {
        version: 2, role: "content", composition: "swiss", notes: page.notes,
        nodes: page.blocks.map((block, index) => ({
          type: "text", token: index === 0 ? "h1" : "body", text: (block as { text: string }).text,
          slot: { col: [1, 12], row: [index * 2 + 1, index * 2 + 2] },
        })),
      };
      return {
        status: "completed",
        result: { structuredOutput: { tree, designIntent: "标题在上，正文顺排", bindings: page.blocks.map((block, index) => ({ blockId: block.id, paths: [`nodes/${index}`] })) } },
      } as any;
    };
    const plan = {
      title: "test",
      pages: [{ content: page, materials: [{ url: `everroom-material://${"b".repeat(64)}`, desc: "封面图" }] }],
    };
    const result = JSON.parse((await runLayouterTail(harness.deps, tailArgs(plan, harness))).content);
    expect(result.status).toBe("completed");
    const design = calls.find(call => !call.currentTree)!;
    const material = (design.materials as Array<{ aspectRatio?: number }>)[0]!;
    expect(material.aspectRatio).toBeCloseTo(1600 / 900, 3);
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

  it("三页直落：文件只建 1 页骨架、逐页末尾追加、页序落页、回收草稿与落定风格", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.pages).toBe(3);
    expect(payload.fileEntryId).toBe("file-1");
    // 逐页追加：fillPage 严格按页序（slideIndex===当前页数即末尾追加），0 替换骨架、1/2 追加。
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([0, 1, 2]);
    expect(harness.progress.notify.mock.calls.map((call: unknown[]) => call[1]).sort()).toEqual([0, 1, 2]);
    // 文件初始只有第 1 页骨架：deck 随落页一页页长出来，不再一次铺满。
    expect((harness.bridge.generate.mock.calls[0]![0] as { pages: string[] }).pages.length).toBe(1);
    // 进度快照带落定页号集合（卡按集合打勾）。
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
      workspaceId: "ws-1",
      onUpdate,
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    // 骨架入库阶段不广播 done：generate 请求带 deferDone。
    expect(harness.bridge.generate).toHaveBeenCalledWith(expect.objectContaining({ deferDone: true }));
    // 骨架入会话所属工作区：漏传会落到默认工作区，用户在当前空间看不到产物。
    expect(harness.bridge.generate).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));
    const final = onUpdate.mock.calls.at(-1)?.[0] as { details: Record<string, unknown> };
    expect(final.details).toMatchObject({
      stage: "page_applied",
      completed: true,
      doneCount: 2,
      totalPages: 2,
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

  it("deck 续会话串行：前一页 dispatch 未完成后页不开始，落页按页序；会话 ref 链式传递、首轮带 deckOutline", async () => {
    let releaseSlowPage: ((invocation: SubagentInvocation) => void) | null = null;
    const bridge = {
      generate: vi.fn().mockResolvedValue({ fileEntryId: "file-1", originalName: "deck.pptx" }),
      fillPage: vi.fn().mockResolvedValue({ ok: true, applied: true }),
      renderPage: vi.fn().mockResolvedValue(""),
    };
    const progress = { arm: vi.fn(), notify: vi.fn(), disarm: vi.fn(), setRelay: vi.fn() };
    const pageCalls: Array<{ pageIndex: number; session?: { sessionId: string; runtimeSessionRef: string | null } }> = [];
    const deps: LayouterTailDeps = {
      progress: progress as unknown as SlidesProgressTracker,
      bridge: bridge as never,
      readMaterialBlob: vi.fn().mockResolvedValue(null),
      fetchImageHead: vi.fn().mockResolvedValue(null),
      makeKey: (runId, agentId, task) => `${runId}:${agentId}:${task}`,
      dispatchPage: (input, _key, _parentRunId, _attachments, session) => {
        const pageIndex = typeof input.pageIndex === "number" ? input.pageIndex : -1;
        pageCalls.push({ pageIndex, ...(session ? { session } : {}) });
        // 第 0 页挂起（模拟长设计）：串行门下第 1、2 页必须等它完成才能 dispatch。
        if (pageIndex === 0) {
          return new Promise<SubagentInvocation>((resolve) => {
            releaseSlowPage = (invocation) => resolve({ ...invocation, runtimeSessionRef: "ref-a" });
          });
        }
        return Promise.resolve({ ...invocationWithTree(pageIndex === 1 ? CHART_TREE : QUOTE_TREE), runtimeSessionRef: `ref-${pageIndex}` } as SubagentInvocation);
      },
    };
    const plan = planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const runPromise = runLayouterTail(deps, {
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
    // 首页还在设计：后页既没 dispatch 也没落页——串行门挡住。
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    expect(pageCalls.map((call) => call.pageIndex)).toEqual([0]);
    expect(bridge.fillPage).not.toHaveBeenCalled();
    releaseSlowPage!(invocationWithTree(CONTENT_TREE));
    const payload = JSON.parse((await runPromise).content);
    expect(payload.status).toBe("completed");
    expect(payload.appliedPages).toEqual([0, 1, 2]);
    // dispatch 严格按页序；落页按页序。
    expect(pageCalls.map((call) => call.pageIndex)).toEqual([0, 1, 2]);
    expect(bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex)).toEqual([0, 1, 2]);
    // 会话：全部同 deckSessionId；首页从 null 起，之后每页拿到前一页返回的 ref。
    expect(pageCalls[0]!.session).toEqual({ sessionId: "slides-deck:run-1", runtimeSessionRef: null });
    expect(pageCalls[1]!.session).toEqual({ sessionId: "slides-deck:run-1", runtimeSessionRef: "ref-a" });
    expect(pageCalls[2]!.session).toEqual({ sessionId: "slides-deck:run-1", runtimeSessionRef: "ref-1" });
  });

  it("deck 续会话输入瘦身：首 dispatch 带 deckOutline，后续页不带、也不再带 neighbors", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE]);
    const plan = planOf([{ ...CONTENT_TREE }, { ...CHART_TREE }, { ...QUOTE_TREE }]);
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    expect(JSON.parse(result.content).status).toBe("completed");
    const pageDispatches = harness.dispatches.filter((entry) => /^run-1:slides-layouter:page:\d+$/.test(entry.key));
    expect(pageDispatches).toHaveLength(3);
    expect(pageDispatches[0]!.input.deckOutline).toEqual([
      { pageIndex: 0, title: "第 1 页", role: "content", density: "standard" },
      { pageIndex: 1, title: "第 2 页", role: "data", density: "standard" },
      { pageIndex: 2, title: "第 3 页", role: "quote", density: "standard" },
    ]);
    for (const entry of pageDispatches.slice(1)) {
      expect(entry.input.deckOutline).toBeUndefined();
    }
    for (const entry of pageDispatches) {
      expect(entry.input.neighbors).toBeUndefined();
    }
  });

  it("素材分辨率不足时丢图并告警，避免低清图铺满页面", async () => {
    const canvas = createCanvas(300, 168);
    const buffer = canvas.toBuffer("image/png");
    const tiny = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const coverTree = { ...QUOTE_TREE, role: "cover" };
    const harness = makeHarness([coverTree]);
    harness.deps.readMaterialBlob = vi.fn(async () => tiny);
    const plan = {
      title: "封面测试",
      pages: [{
        title: "封面",
        role: "cover",
        density: "sparse",
        layoutVersion: 2,
        content: semanticPageOfTree(coverTree, 0),
        materials: [{ url: `everroom-material://${"a".repeat(64)}`, desc: "低清图" }],
      }],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(harness.dispatches[0]!.input.materials).toEqual([]);
    expect(payload.warnings.join("")).toContain("分辨率不足");
  });

  it("layouter 输入带 layoutVersion 与语义 content，且不再有旧模式字段", async () => {
    const harness = makeHarness([CHART_TREE]);
    const plan = planOf([CHART_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    const input = harness.dispatches[0]!.input;
    expect(input.layoutVersion).toBe(2);
    expect(input.content).toMatchObject({ role: "data", message: "2.7" });
    for (const legacyField of ["copy", "composition", "form", "skeleton", "units", "emphasis", "intent", "takeaway", "data", "budget", "points", "notes", "neighborSignatures"]) {
      expect(input).not.toHaveProperty(legacyField);
    }
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
  });

  it("缺少语义 content 的页明确失败：不 dispatch、不落页（旧内容模式已移除）", async () => {
    const harness = makeHarness([CONTENT_TREE]);
    const plan = {
      title: "缺内容测试",
      pages: [{ title: "第 1 页", role: "content", density: "standard", layoutVersion: 2 }],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.errorCode).toBe("slides_layout_pages_invalid");
    expect(String(payload.message)).toContain("缺少语义 content");
    expect(harness.dispatches).toHaveLength(0);
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
  });

  it("流式页源里缺少语义 content：该页跳过并保留占位，不回退旧模式", async () => {
    const harness = makeHarness([CONTENT_TREE]);
    const fullPage = { title: "第 1 页", density: "standard", layoutVersion: 2, content: semanticPageOfTree(CONTENT_TREE, 0) };
    const result = await runLayouterTail(harness.deps, {
      ...tailArgs({ title: "流式缺内容", pages: [{ title: "第 1 页" }, { title: "第 2 页" }] }, harness),
      armPlan: armPlanOf({ pages: [{ title: "第 1 页" }, { title: "第 2 页" }] }),
      stream: {
        totalPages: 2,
        outline: ["第 1 页", "第 2 页"],
        pages: (async function* () {
          yield { pageIndex: 0, page: fullPage };
          yield { pageIndex: 1, page: { title: "第 2 页", role: "content", density: "standard" } };
        })(),
      },
    });
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("partial");
    expect(payload.appliedPages).toEqual([0]);
    expect(payload.failedPages).toEqual([1]);
    expect(payload.warnings.join("")).toContain("缺少语义 content");
    // 只 dispatch 有语义内容的那一页；缺 content 页不进入布局代理。
    expect(harness.dispatches).toHaveLength(1);
  });

  it("布局代理失败页不落假成功页：占位保留、整册 partial", async () => {
    const harness = makeHarness([CONTENT_TREE, CHART_TREE, QUOTE_TREE], new Set([0]));
    const result = await runLayouterTail(harness.deps, tailArgs(planOf([CONTENT_TREE, CHART_TREE, QUOTE_TREE]), harness));
    const payload = JSON.parse(result.content);
    // 语义页失败不落兜底：第 1 页保留占位（初始骨架），整册 partial、failedPages 可重试。
    expect(payload.status).toBe("partial");
    expect(payload.pages).toBe(2);
    expect(payload.failedPages).toEqual([0]);
    expect(payload.warnings.some((w: string) => /第 1 页设计未通过/.test(w))).toBe(true);
    // 第 1 页骨架已随建文件存在（slideIndex 0 不补），第 2、3 页落页。
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(2);
    expect(harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex)).toEqual([1, 2]);
  });

  it("代理交回 v1 树时整页失败可重试（布局只有 v2 一种格式，不再落兜底页）", async () => {
    const v1Tree = {
      role: "content",
      title: "旧语法页",
      direction: "column",
      children: [{ type: "text", variant: "body", text: "v1 语法" }],
    };
    const harness = makeHarness([v1Tree]);
    const plan = planOf([CONTENT_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.retryable).toBe(true);
    expect(payload.warnings.some((w: string) => /交回的是 v1 树/.test(w))).toBe(true);
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
  });

  it("带引擎硬闸缺陷的页不落页、不级联失败（真机 2026-10-15 事故回归）", async () => {
    const emojiTree = {
      version: 2,
      role: "quote",
      composition: "poster",
      dark: true,
      nodes: [{ type: "text", token: "display", text: "带 emoji 🎉 的树", slot: { col: [1, 6], row: [2, 4] } }],
    };
    const harness = makeHarness([emojiTree, CHART_TREE, QUOTE_TREE]);
    const plan = {
      title: "测试演示",
      pages: [
        { title: "会失败的页", density: "standard", layoutVersion: 2, content: semanticPageOfTree(emojiTree, 0) },
        { title: "数据页", density: "standard", layoutVersion: 2, content: semanticPageOfTree(CHART_TREE, 1) },
        { title: "引用页", density: "standard", layoutVersion: 2, content: semanticPageOfTree(QUOTE_TREE, 2) },
      ],
    };
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    // 首页带 emoji 硬闸缺陷：不落页、保留可重试状态，后续页按页序继续，不越界级联。
    expect(payload.status).toBe("partial");
    expect(payload.warnings.some((w: string) => /第 1 页几何校验未通过/.test(w))).toBe(true);
    expect(payload.warnings.some((w: string) => /slideIndex must be an integer/.test(w))).toBe(false);
    expect(payload.pages).toBe(2);
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    expect(appliedIndexes).toEqual([1, 2]);
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

  it("布局代理未交树先带反馈重试一次：内容契约不变，重试树被采用", async () => {
    const harness = makeHarness(["RUN_FAIL", CHART_TREE, CONTENT_TREE]);
    const plan = planOf([CHART_TREE, CONTENT_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("completed");
    expect(payload.warnings.some((w: string) => /第 1 页布局代理重试后收敛/.test(w))).toBe(true);
    const retry = harness.dispatches.find((d) => d.key.includes(":retry"));
    expect(retry).toBeDefined();
    expect(String(retry!.input.revisionFeedback)).toContain("上次提交未通过");
    // 重试不裁剪内容：语义 content 原样完整携带。
    expect(retry!.input.content).toEqual((plan.pages as Array<{ content: unknown }>)[0]!.content);
    const appliedIndexes = harness.bridge.fillPage.mock.calls.map((call: unknown[]) => (call[0] as { slideIndex: number }).slideIndex);
    // 串行会话链下取树与落页都按页序：第 0 页重试完成前，第 1 页不开始。
    expect(appliedIndexes).toEqual([0, 1]);
  });

  it("重试仍不收敛：整页失败可重试，不落结构化兜底页", async () => {
    const harness = makeHarness(["RUN_FAIL"]);
    const plan = planOf([CHART_TREE]);
    const result = await runLayouterTail(harness.deps, tailArgs(plan, harness));
    const payload = JSON.parse(result.content);
    expect(payload.status).toBe("failed");
    expect(payload.retryable).toBe(true);
    expect(payload.warnings.some((w: string) => /第 1 页设计未通过/.test(w))).toBe(true);
    expect(harness.dispatches.some((d) => d.key.includes(":retry"))).toBe(true);
    expect(harness.bridge.fillPage).not.toHaveBeenCalled();
    expect(harness.trashed).toEqual([]);
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
    await runLayouterTail(harness.deps, { ...tailArgs(planOf([v2Tree]), harness), styleParams });

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
      numeral: "sans",
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
    // 已落页保留（占位骨架写入 deck），重试可复用；但绝不静默报成功。
    expect(harness.bridge.fillPage).toHaveBeenCalledTimes(1);
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
