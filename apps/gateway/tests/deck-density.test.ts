import type { SubagentInvocation } from "@nxcore/agent-contract";
import { describe, expect, it, vi } from "vitest";

import { DECK_COMPOSER_AGENT_ID, normalizeDeckDraftSpec } from "../src/modules/subagents/deck-draft.js";
import {
  DECK_DENSITY_TASK_LABEL,
  densityOutlineOf,
  normalizeDensityPlan,
} from "../src/modules/subagents/deck-density.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";

const ORDERED_IDS = ["blk_claim_main", "blk_data_users", "blk_evidence_case", "blk_visual_arch"];

function densityFixture(): Record<string, unknown> {
  return {
    kind: "density-plan",
    pages: [
      { pageNo: 0, blockIds: [], layoutHint: "cover title", densityBudget: "sparse" },
      { pageNo: 1, blockIds: ["blk_claim_main"], layoutHint: "title body", densityBudget: "normal" },
      {
        pageNo: 2,
        blockIds: ["blk_data_users", "blk_evidence_case"],
        layoutHint: "chart body_list",
        densityBudget: "dense",
      },
      { pageNo: 3, blockIds: ["blk_visual_arch"], layoutHint: "image", densityBudget: "normal", splitFrom: 2 },
    ],
  };
}

describe("normalizeDensityPlan（跨字段校验）", () => {
  it("合法计划通过：封面空块 + 覆盖完整 + 拆分链向前引用", () => {
    const plan = normalizeDensityPlan(densityFixture(), ORDERED_IDS);
    expect(plan).not.toBeNull();
    expect(plan!.pages).toHaveLength(4);
    expect(plan!.pages[3]!.splitFrom).toBe(2);
  });

  it("页号不连续 / 未知块 / 页内重复 / 未覆盖块 拒绝", () => {
    const gapped = densityFixture();
    (gapped.pages as Array<Record<string, unknown>>)[2]!.pageNo = 5;
    expect(normalizeDensityPlan(gapped, ORDERED_IDS)).toBeNull();

    const unknown = densityFixture();
    ((unknown.pages as Array<Record<string, unknown>>)[1]!.blockIds as string[]).push("blk_ghost");
    expect(normalizeDensityPlan(unknown, ORDERED_IDS)).toBeNull();

    const duplicated = densityFixture();
    ((duplicated.pages as Array<Record<string, unknown>>)[1]!.blockIds as string[]).push("blk_claim_main");
    expect(normalizeDensityPlan(duplicated, ORDERED_IDS)).toBeNull();

    const uncovered = densityFixture();
    (uncovered.pages as unknown[]).pop();
    expect(normalizeDensityPlan(uncovered, ORDERED_IDS)).toBeNull();
  });

  it("非法 budget / 空 layoutHint / splitFrom 指向自身或之后 拒绝", () => {
    const badBudget = densityFixture();
    (badBudget.pages as Array<Record<string, unknown>>)[1]!.densityBudget = "medium";
    expect(normalizeDensityPlan(badBudget, ORDERED_IDS)).toBeNull();

    const noHint = densityFixture();
    (noHint.pages as Array<Record<string, unknown>>)[1]!.layoutHint = " ";
    expect(normalizeDensityPlan(noHint, ORDERED_IDS)).toBeNull();

    const backSplit = densityFixture();
    (backSplit.pages as Array<Record<string, unknown>>)[1]!.splitFrom = 1;
    expect(normalizeDensityPlan(backSplit, ORDERED_IDS)).toBeNull();
  });

  it("kind 不符拒绝", () => {
    expect(normalizeDensityPlan({ ...densityFixture(), kind: "audience-reorder" }, ORDERED_IDS)).toBeNull();
  });
});

describe("densityOutlineOf", () => {
  it("页标题取首块预览，封面页回退'封面'", () => {
    const spec = normalizeDeckDraftSpec({
      kind: "deck-draft",
      title: "DeckGen",
      blocks: [
        { id: "blk_claim_main", kind: "claim", content: "核心主张：分阶段可控。" },
        { id: "blk_data_users", kind: "data", content: "周活 1200。", sourceRefs: ["everroom://room/r1/d1/b2"] },
        { id: "blk_evidence_case", kind: "evidence", content: "案例支撑。", sourceRefs: ["everroom://room/r1/d1/b1"] },
        { id: "blk_visual_arch", kind: "visual", content: "架构图。" },
      ],
    })!;
    const plan = normalizeDensityPlan(densityFixture(), ORDERED_IDS)!;
    const outline = densityOutlineOf(spec, plan);
    expect(outline[0]!.title).toBe("封面");
    expect(outline[1]!.title).toContain("核心主张");
    expect(outline[2]!.previews).toHaveLength(2);
    expect(outline[3]!.splitFrom).toBe(2);
  });
});

describe("deck_density 工具", () => {
  const baseRun = {
    runId: "run-1",
    sessionId: "session-1",
    roomId: "room-1",
    prompt: "排一下页",
    pageLabel: "Room",
    runtimeSessionRef: null,
    responseLanguage: "zh-CN",
  };

  function reorderInvocationFixture(): SubagentInvocation {
    return {
      id: "inv-reorder-1",
      agentDefinitionId: DECK_COMPOSER_AGENT_ID,
      agentRevisionId: "revision-1",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
      task: "受众重排",
      input: {
        task: "audience-reorder",
        audienceProfileId: "judge",
        draftSpec: {
          title: "DeckGen 项目汇报",
          thesis: "六阶段可干预流水线",
          blocks: [
            { id: "blk_claim_main", kind: "claim", content: "核心主张：分阶段可控。" },
            { id: "blk_data_users", kind: "data", content: "周活 1200。", sourceRefs: ["everroom://room/r1/d1/b2"] },
            { id: "blk_evidence_case", kind: "evidence", content: "案例支撑。", sourceRefs: ["everroom://room/r1/d1/b1"] },
            { id: "blk_visual_arch", kind: "visual", content: "架构图。" },
          ],
        },
      },
      status: "completed",
      result: {
        structuredOutput: {
          kind: "audience-reorder",
          profileId: "judge",
          rhetoric: "pyramid",
          orderedBlockIds: ORDERED_IDS,
          perBlock: {
            blk_claim_main: { detail: "expand" },
            blk_data_users: { detail: "keep" },
            blk_evidence_case: { detail: "keep" },
            blk_visual_arch: { detail: "keep" },
          },
          rationale: "评委版结论先行。",
        },
        text: "",
      },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } as unknown as SubagentInvocation;
  }

  function densityInvocationFixture(result: Record<string, unknown>): SubagentInvocation {
    return {
      id: "inv-density-1",
      agentDefinitionId: DECK_COMPOSER_AGENT_ID,
      agentRevisionId: "revision-1",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
      task: DECK_DENSITY_TASK_LABEL,
      input: null,
      status: "completed",
      result: { structuredOutput: result, text: "" },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    } as unknown as SubagentInvocation;
  }

  function registryWith(agentIds: string[]): SubagentRegistry {
    return {
      get: (id: string) => (agentIds.includes(id) ? { id } : null),
      listAvailable: () => [],
      listAll: () => [],
    } as unknown as SubagentRegistry;
  }

  it("回读 deck_reorder 结果 → 调度 → 返回 pages 与生成指引", async () => {
    const orchestrator = {
      dispatch: vi.fn(async () => densityInvocationFixture(densityFixture())),
      getInvocation: vi.fn(() => reorderInvocationFixture()),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> };
    const tools = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), orchestrator, {});
    const tool = tools.find((item) => item.name === "deck_density");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      baseRun as never,
      { reorderInvocationId: "inv-reorder-1", pageBudget: 8 } as never,
      undefined,
    );
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload.status).toBe("completed");
    expect(payload.kind).toBe("density-plan");
    expect(payload.pageCount).toBe(4);
    expect(payload.pageBudget).toBe(8);
    expect(payload.pages[0]).toMatchObject({ pageNo: 0, densityBudget: "sparse" });
    expect(payload.nextAction).toContain("context_room_slides_create");
    const input = orchestrator.dispatch.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(input.task).toBe("density-plan");
    expect(input.pageBudget).toBe(8);
    expect((input.audiencePlan as { orderedBlockIds: string[] }).orderedBlockIds).toEqual(ORDERED_IDS);
    expect(((input.draftSpec as { blocks: unknown[] }).blocks)).toHaveLength(4);
  });

  it("deck_reorder 结果缺失/跨会话返回不可重试错误；DensityPlan 非法返回可重试错误", async () => {
    const missing = {
      dispatch: vi.fn(),
      getInvocation: vi.fn(() => null),
    } as unknown as SubagentOrchestrator;
    const toolsA = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), missing, {});
    const toolA = toolsA.find((item) => item.name === "deck_density")!;
    const failed = await toolA.execute(
      baseRun as never,
      { reorderInvocationId: "inv-none" } as never,
      undefined,
    );
    const payloadA = JSON.parse((failed as { content: string }).content);
    expect(payloadA.errorCode).toBe("deck_density_reorder_unavailable");
    expect(payloadA.retryable).toBe(false);

    const broken = {
      dispatch: vi.fn(async () => densityInvocationFixture({ kind: "density-plan", pages: [] })),
      getInvocation: vi.fn(() => reorderInvocationFixture()),
    } as unknown as SubagentOrchestrator;
    const toolsB = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), broken, {});
    const toolB = toolsB.find((item) => item.name === "deck_density")!;
    const invalid = await toolB.execute(
      baseRun as never,
      { reorderInvocationId: "inv-reorder-1" } as never,
      undefined,
    );
    const payloadB = JSON.parse((invalid as { content: string }).content);
    expect(payloadB.errorCode).toBe("deck_density_result_invalid");
    expect(payloadB.retryable).toBe(true);
  });
});
