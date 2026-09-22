import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  documents,
  roomDocumentLinks,
  rooms,
  routeMindmaps,
} from "../src/infrastructure/database/schema.js";
import type { GatewayDatabase } from "../src/infrastructure/database/client.js";
import {
  RouteMindmapService,
  RouteMindmapServiceError,
} from "../src/modules/knowledge/route-mindmap-service.js";
import type { ProjectionGraph } from "../src/modules/knowledge/emergence-projection.js";

const temporaryDirectories: string[] = [];
const logger = { info: () => undefined, warn: () => undefined };

interface DispatchCall {
  agentId: string;
  task: string;
  input: Record<string, unknown>;
}

function fakeGraph(): ProjectionGraph {
  return {
    nodes: new Map([
      ["room:r1", { id: "room:r1", nodeType: "room", label: "Room甲", sourceGraph: "roomGraph", roomRef: null, updatedAt: null, groupKey: "g1" }],
      ["entity:e1", { id: "entity:e1", nodeType: "entity", label: "实体一", sourceGraph: "entityFacts", roomRef: null, updatedAt: null, groupKey: "g2" }],
      ["doc:d2", { id: "doc:d2", nodeType: "document", label: "旧文档", sourceGraph: "linkGraph", roomRef: null, updatedAt: null, groupKey: "g3" }],
    ]),
    edges: [
      { from: "room:r1", to: "entity:e1", relationType: "提及", edgeLevel: "original", confidence: 0.9, weight: 1 },
    ],
  } as ProjectionGraph;
}

const DEFAULT_OPTIONS = [
  { label: "A 路线", note: "从内部到公众逐层展开" },
  { label: "B 路线", note: "倒排发布日程" },
  { label: "C 路线", note: "先讲最难回答的问题" },
];
const EXPAND_OPTIONS = [
  { label: "A1 分岔", note: null },
  { label: "A2 分岔", note: null },
  { label: "A3 分岔", note: null },
];

interface HarnessOptions {
  material?: ProjectionGraph | null;
  plannerRounds?: Array<Array<{ label: string; note: string | null }>>;
  plannerPending?: boolean;
  /** 第 N 次（0 基）route-planner 派发起挂起，等 releasePlanner() 放行。 */
  hangFromRound?: number;
  writerMarkdown?: string | null;
}

interface Harness {
  service: RouteMindmapService;
  db: GatewayDatabase;
  dispatchCalls: DispatchCall[];
  written: Array<{ documentId: string; markdown: string }>;
  releasePlanner: () => void;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "everroom-route-mindmap-"));
  temporaryDirectories.push(root);
  const database = createDatabase(join(root, "gateway.sqlite"), resolve("drizzle"));
  const db = database.db;
  db.insert(rooms).values({ id: "room-1", title: "Room甲" }).run();
  db.insert(documents).values({
    id: "doc-1",
    title: "新产品发布方案",
    contentJson: { type: "doc", content: [] },
  }).run();
  db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: "doc-1" }).run();

  const dispatchCalls: DispatchCall[] = [];
  const written: Array<{ documentId: string; markdown: string }> = [];
  let plannerRound = 0;
  let gatePromise: Promise<void> | null = null;
  let gateResolve: (() => void) | null = null;
  let gateReleased = false;
  const orchestrator = {
    dispatch: async (request: { agentId: string; task: string; input: Record<string, unknown>; idempotencyKey: string }) => {
      dispatchCalls.push({ agentId: request.agentId, task: request.task, input: request.input });
      if (request.agentId === "route-planner") {
        if (options.hangFromRound !== undefined && plannerRound >= options.hangFromRound && !gateReleased) {
          if (!gatePromise) gatePromise = new Promise<void>((resolve) => { gateResolve = resolve; });
          await gatePromise;
        }
        if (options.plannerPending) await new Promise(() => {});
        const rounds = options.plannerRounds ?? [DEFAULT_OPTIONS, EXPAND_OPTIONS];
        const roundOptions = rounds[Math.min(plannerRound, rounds.length - 1)];
        plannerRound += 1;
        return {
          status: "completed",
          result: { structuredOutput: { kind: "route-options", options: roundOptions } },
        };
      }
      return {
        status: "completed",
        result: { structuredOutput: { kind: "document-draft", contentMarkdown: options.writerMarkdown ?? "## 开头\n\n正文第一段。" } },
      };
    },
  };
  const service = new RouteMindmapService({
    db,
    orchestrator: orchestrator as never,
    emergence: {
      buildGraph: async () => (options.material === undefined ? fakeGraph() : options.material) as ProjectionGraph,
    },
    documents: {
      syncExternalMarkdown: async (input: { documentId: string; markdown: string }) => {
        written.push({ documentId: input.documentId, markdown: input.markdown });
        return {} as never;
      },
    },
    log: logger as never,
  });
  return { service, db, dispatchCalls, written, releasePlanner: () => { gateReleased = true; gateResolve?.(); } };
}

/** 等待后台 fire-and-forget 派发把行落到终态（微任务循环，不依赖计时器）。 */
async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(await predicate()).toBe(true);
}

const active = (harness: Harness) => async () =>
  (await harness.service.get("room-1", "doc-1", 0)).status === "active";
const writingDone = (harness: Harness) => async () =>
  (await harness.service.get("room-1", "doc-1", 0)).writing === false;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RouteMindmapService", () => {
  it("start：建行→初始两层（根=标题+选项）→active", async () => {
    const harness = await createHarness();
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    const view = await harness.service.get("room-1", "doc-1", 2);
    expect(view.status).toBe("active");
    expect(view.graph?.root.label).toBe("新产品发布方案");
    expect(view.graph?.root.children).toHaveLength(3);
    expect(view.selectionPath).toEqual(["route:root"]);
    expect(harness.dispatchCalls).toHaveLength(1);
    expect(harness.dispatchCalls[0]?.input.task).toBe("initial");
  });

  it("start 幂等：active 再 start 不重复派发", async () => {
    const harness = await createHarness();
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 3 });
    expect(harness.dispatchCalls).toHaveLength(1);
  });

  it("空素材：failed(route_no_material)，不派发", async () => {
    const harness = await createHarness({ material: { nodes: new Map(), edges: [] } as ProjectionGraph });
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(async () => (await harness.service.get("room-1", "doc-1", 0)).status === "failed");
    const view = await harness.service.get("room-1", "doc-1", 2);
    expect(view.status).toBe("failed");
    expect(view.error).toBe("route_no_material");
    expect(harness.dispatchCalls).toHaveLength(0);
  });

  it("expand：子节点选中+续生一层；已有子级只换 selectionPath", async () => {
    const harness = await createHarness();
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    let view = await harness.service.get("room-1", "doc-1", 2);
    const firstChild = view.graph!.root.children![0]!;
    expect(firstChild.ref).toBe("route:b0");
    expect(firstChild.label).toBe("A 路线");

    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 3 });
    await until(async () =>
      (await harness.service.get("room-1", "doc-1", 4)).graph?.root.children![0]?.children?.length === 3,
    );
    view = await harness.service.get("room-1", "doc-1", 5);
    expect(view.selectionPath).toEqual(["route:root", "route:b0"]);
    expect(harness.dispatchCalls).toHaveLength(2);
    expect(harness.dispatchCalls[1]?.input).toMatchObject({ task: "expand", targetLabel: "A 路线" });

    // 已有子级：再点同节点只选中，不派发。
    view = await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 6 });
    expect(view.selectionPath).toEqual(["route:root", "route:b0"]);
    expect(harness.dispatchCalls).toHaveLength(2);
  });

  it("深度上限：第四层为末梢，点选不再续生", async () => {
    const harness = await createHarness();
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 2 });
    await until(active(harness));
    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0-0", requestVersion: 3 });
    await until(async () =>
      (await harness.service.get("room-1", "doc-1", 4)).graph?.root.children![0]!.children![0]?.children?.length === 3,
    );
    expect(harness.dispatchCalls).toHaveLength(3);
    // 第四层叶子（path 含根共四段）：409 拒绝，不再派发。
    await expect(
      harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0-0-0", requestVersion: 5 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(harness.dispatchCalls).toHaveLength(3);
  });

  it("back：截断路径；图保留，换路重选不派发", async () => {
    const harness = await createHarness();
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 3 });
    await until(async () =>
      (await harness.service.get("room-1", "doc-1", 4)).graph?.root.children![0]?.children?.length === 3,
    );
    const grandchild = (await harness.service.get("room-1", "doc-1", 5)).graph!.root.children![0]!.children![0]!;
    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: grandchild.ref, requestVersion: 6 });
    await until(active(harness));
    let view = await harness.service.get("room-1", "doc-1", 7);
    expect(view.selectionPath).toHaveLength(3);

    view = await harness.service.back("room-1", { documentId: "doc-1", toDepth: 0, requestVersion: 7 });
    expect(view.selectionPath).toEqual(["route:root"]);
    // 全图未删：b0 的子层仍在。
    expect(view.graph!.root.children![0]!.children).toHaveLength(3);
    // 重新选 b0：不再派发（3 = initial + b0 + 孙节点那次）。
    view = await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 8 });
    expect(view.selectionPath).toEqual(["route:root", "route:b0"]);
    expect(harness.dispatchCalls).toHaveLength(3);
  });

  it("expanding 进行中再动=拒绝", async () => {
    const harness = await createHarness({ plannerPending: true });
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    // plannerPending：初始派发挂起 → 行停在 expanding（inFlight 占位）。
    await until(() => harness.dispatchCalls.length === 1);
    const row = harness.db
      .select({ status: routeMindmaps.status })
      .from(routeMindmaps)
      .where(eq(routeMindmaps.documentId, "doc-1"))
      .get();
    expect(row?.status).toBe("expanding");
    await expect(
      harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:root", requestVersion: 2 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/route_(busy|not_generated)/) });
    await expect(
      harness.service.finalize("room-1", { documentId: "doc-1", requestVersion: 3 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/route_(busy|not_finalizable|not_generated)/) });
  });

  it("生成中（expanding）back 放行：路径立即截断，在飞续生完成后不改写截断路径", async () => {
    const harness = await createHarness({ hangFromRound: 1 });
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    let view = await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 2 });
    expect(view.status).toBe("expanding");
    expect(view.selectionPath).toEqual(["route:root", "route:b0"]);

    view = await harness.service.back("room-1", { documentId: "doc-1", toDepth: 0, requestVersion: 3 });
    expect(view.selectionPath).toEqual(["route:root"]);
    expect(view.status).toBe("expanding");

    harness.releasePlanner();
    await until(async () => (await harness.service.get("room-1", "doc-1", 4)).status === "active");
    view = await harness.service.get("room-1", "doc-1", 5);
    expect(view.selectionPath).toEqual(["route:root"]);
    expect(view.graph!.root.children![0]!.children).toHaveLength(3);
  });

  it("skip：无行时落 skipped 行；start 补生成", async () => {
    const harness = await createHarness();
    let view = await harness.service.skip("room-1", { documentId: "doc-1", requestVersion: 1 });
    expect(view.status).toBe("active");
    expect(view.skipped).toBe(true);
    expect(view.graph).toBeNull();

    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 2 });
    await until(async () => {
      const current = await harness.service.get("room-1", "doc-1", 3);
      return current.status === "active" && current.skipped === false && current.graph !== null;
    });
    view = await harness.service.get("room-1", "doc-1", 4);
    expect(view.graph?.root.children).toHaveLength(3);
  });

  it("finalize：锁 finalized→doc-writer 写正文→syncExternalMarkdown 落库", async () => {
    const harness = await createHarness({ writerMarkdown: "## 方案\n\n按路线展开的正文。" });
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 3 });
    await until(async () =>
      (await harness.service.get("room-1", "doc-1", 4)).graph?.root.children![0]?.children?.length === 3,
    );

    const view = await harness.service.finalize("room-1", { documentId: "doc-1", requestVersion: 5 });
    expect(view.status).toBe("finalized");
    expect(view.writing).toBe(true);
    await until(writingDone(harness));
    const done = await harness.service.get("room-1", "doc-1", 6);
    expect(done.error).toBeNull();
    expect(harness.written).toHaveLength(1);
    expect(harness.written[0]?.markdown).toContain("按路线展开的正文");
    const writerCall = harness.dispatchCalls.find((call) => call.agentId === "doc-writer");
    expect(writerCall?.input).toMatchObject({ task: "draft-create", documentName: "新产品发布方案" });
    expect(String(writerCall?.input.instruction)).toContain("A 路线");

    // finalized 后只读：再 expand 被拒。
    await expect(
      harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b1", requestVersion: 8 }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/route_(finalized|busy)/) });
  });

  it("finalize 未选路径=409 route_path_empty", async () => {
    const harness = await createHarness();
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    await expect(
      harness.service.finalize("room-1", { documentId: "doc-1", requestVersion: 3 }),
    ).rejects.toMatchObject({ message: "route_path_empty" });
  });

  it("写正文失败→error 态可重试（再次 finalize 重派）", async () => {
    const harness = await createHarness({ writerMarkdown: "" });
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(active(harness));
    await harness.service.expand("room-1", { documentId: "doc-1", nodeRef: "route:b0", requestVersion: 3 });
    await until(async () =>
      (await harness.service.get("room-1", "doc-1", 4)).graph?.root.children![0]?.children?.length === 3,
    );

    await harness.service.finalize("room-1", { documentId: "doc-1", requestVersion: 5 });
    await until(writingDone(harness));
    const failed = await harness.service.get("room-1", "doc-1", 7);
    expect(failed.status).toBe("finalized");
    expect(failed.error).toBe("route_writing_empty_draft");
    expect(harness.written).toHaveLength(0);

    const retry = await harness.service.finalize("room-1", { documentId: "doc-1", requestVersion: 8 });
    expect(retry.writing).toBe(true);
    await until(() => harness.dispatchCalls.filter((call) => call.agentId === "doc-writer").length === 2);
    expect(harness.dispatchCalls.filter((call) => call.agentId === "doc-writer")).toHaveLength(2);
  });

  it("重启对账：expanding 死行收敛 failed，start 保图重派", async () => {
    const harness = await createHarness({ plannerPending: true });
    await harness.service.start("room-1", { documentId: "doc-1", requestVersion: 1 });
    await until(() => harness.dispatchCalls.length === 1);
    await until(() =>
      harness.db.select({ generationKey: routeMindmaps.generationKey }).from(routeMindmaps)
        .where(eq(routeMindmaps.documentId, "doc-1")).get()?.generationKey != null,
    );

    // 新实例（重启语义，inFlight 清零）：get 触发对账，孤儿行收敛 failed。
    const restarted = new RouteMindmapService({
      db: harness.db,
      orchestrator: { dispatch: async () => ({ status: "completed", result: { structuredOutput: { kind: "route-options", options: DEFAULT_OPTIONS } } }) } as never,
      emergence: { buildGraph: async () => fakeGraph() as ProjectionGraph },
      documents: { syncExternalMarkdown: async () => ({}) as never },
      log: logger as never,
    });
    const view = await restarted.get("room-1", "doc-1", 9);
    expect(view.status).toBe("failed");
    expect(view.error).toBe("route_invocation_lost");
  });

  it("get：无行=missing 视图带文档标题", async () => {
    const harness = await createHarness();
    const view = await harness.service.get("room-1", "doc-1", 1);
    expect(view.status).toBe("missing");
    expect(view.title).toBe("新产品发布方案");
    expect(view.graph).toBeNull();
  });

  it("Room 不存在/文档不存在分别 404", async () => {
    const harness = await createHarness();
    await expect(
      harness.service.start("room-2", { documentId: "doc-1", requestVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      harness.service.get("room-1", "doc-missing", 1),
    ).rejects.toBeInstanceOf(RouteMindmapServiceError);
  });
});
