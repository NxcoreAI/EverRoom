import type { SubagentInvocation } from "@nxcore/agent-contract";
import { describe, expect, it, vi } from "vitest";

import { normalizeDeckDraftSpec, DECK_COMPOSER_AGENT_ID, type DeckDraftSpec } from "../src/modules/subagents/deck-draft.js";
import {
  DECK_REORDER_TASK_LABEL,
  normalizeAudiencePlan,
  audienceOutlineOf,
  audienceProfileOf,
} from "../src/modules/subagents/deck-reorder.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";

function specFixture(): DeckDraftSpec {
  const normalized = normalizeDeckDraftSpec({
    kind: "deck-draft",
    title: "DeckGen 项目汇报",
    thesis: "六阶段可干预流水线",
    blocks: [
      { id: "blk_claim_main", kind: "claim", content: "核心主张。" },
      { id: "blk_evidence_case", kind: "evidence", content: "案例支撑。", sourceRefs: ["everroom://room/r1/d1/b1"] },
      { id: "blk_data_users", kind: "data", content: "周活 1200。", sourceRefs: ["everroom://room/r1/d1/b2"] },
      { id: "blk_visual_arch", kind: "visual", content: "架构图。" },
      { id: "blk_quote_user", kind: "quote", content: "用户反馈。", sourceRefs: ["everroom://memory/r1/m1"] },
    ],
  });
  if (!normalized) throw new Error("fixture invalid");
  return normalized;
}

function planFixture(): Record<string, unknown> {
  return {
    kind: "audience-reorder",
    profileId: "judge",
    rhetoric: "pyramid",
    orderedBlockIds: ["blk_claim_main", "blk_data_users", "blk_evidence_case", "blk_visual_arch"],
    perBlock: {
      blk_claim_main: { detail: "expand" },
      blk_data_users: { detail: "keep" },
      blk_evidence_case: { detail: "keep" },
      blk_visual_arch: { detail: "shrink", note: "评委更关注验证" },
      blk_quote_user: { detail: "cut", note: "对评委说服力弱" },
    },
    rationale: "评委版先给结论与数据，架构图降权，用户引述砍掉。",
  };
}

describe("normalizeAudiencePlan（跨字段校验）", () => {
  it("合法计划通过；orderedBlockIds 恰为非 cut 块集合", () => {
    const plan = normalizeAudiencePlan(planFixture(), specFixture(), "judge");
    expect(plan).not.toBeNull();
    expect(plan!.rhetoric).toBe("pyramid");
    expect(plan!.perBlock.blk_quote_user!.detail).toBe("cut");
  });

  it("profileId 与输入不符 / kind 不符 拒绝", () => {
    expect(normalizeAudiencePlan(planFixture(), specFixture(), "investor")).toBeNull();
    const wrongKind = { ...planFixture(), kind: "deck-draft" };
    expect(normalizeAudiencePlan(wrongKind, specFixture(), "judge")).toBeNull();
  });

  it("未知块 id / 重复 / cut 块出现在 ordered / 非 cut 块缺席 拒绝", () => {
    const unknown = { ...planFixture(), orderedBlockIds: ["blk_claim_main", "blk_ghost"] };
    expect(normalizeAudiencePlan(unknown, specFixture(), "judge")).toBeNull();

    const duplicated = { ...planFixture(), orderedBlockIds: ["blk_claim_main", "blk_claim_main", "blk_data_users", "blk_evidence_case", "blk_visual_arch"] };
    expect(normalizeAudiencePlan(duplicated, specFixture(), "judge")).toBeNull();

    const cutInOrder = {
      ...planFixture(),
      orderedBlockIds: ["blk_claim_main", "blk_data_users", "blk_evidence_case", "blk_visual_arch", "blk_quote_user"],
    };
    expect(normalizeAudiencePlan(cutInOrder, specFixture(), "judge")).toBeNull();

    const missing = {
      ...planFixture(),
      orderedBlockIds: ["blk_claim_main", "blk_data_users", "blk_evidence_case"],
      perBlock: {
        ...(planFixture().perBlock as Record<string, unknown>),
        blk_visual_arch: { detail: "keep" },
      },
    };
    expect(normalizeAudiencePlan(missing, specFixture(), "judge")).toBeNull();
  });

  it("非法 rhetoric / perBlock 键越界 拒绝", () => {
    expect(normalizeAudiencePlan({ ...planFixture(), rhetoric: "chronological" }, specFixture(), "judge")).toBeNull();
    const foreignKey = {
      ...planFixture(),
      perBlock: {
        ...(planFixture().perBlock as Record<string, unknown>),
        blk_other: { detail: "keep" },
      },
    };
    expect(normalizeAudiencePlan(foreignKey, specFixture(), "judge")).toBeNull();
  });
});

describe("audienceOutlineOf + audienceProfileOf", () => {
  it("outline 按计划顺序编号并带详略与 note", () => {
    const plan = normalizeAudiencePlan(planFixture(), specFixture(), "judge")!;
    const outline = audienceOutlineOf(specFixture(), plan);
    expect(outline.map((entry) => entry.id)).toEqual(plan.orderedBlockIds);
    expect(outline[0]).toMatchObject({ order: 1, id: "blk_claim_main", detail: "expand" });
    expect(outline[3]!.note).toBe("评委更关注验证");
  });

  it("画像与修辞模板可查；未知 id 为 null", () => {
    expect(audienceProfileOf("judge")?.label).toBe("比赛评委");
    expect(audienceProfileOf("ghost")).toBeNull();
  });
});

describe("deck_reorder 工具", () => {
  const baseRun = {
    runId: "run-1",
    sessionId: "session-1",
    roomId: "room-1",
    prompt: "出评委版",
    pageLabel: "Room",
    runtimeSessionRef: null,
    responseLanguage: "zh-CN",
  };

  const draftDocumentMarkdown = [
    "> **核心主张**：六阶段可干预流水线",
    "",
    "## 内容块",
    "",
    "### 1. [论点] blk_claim_main",
    "",
    "核心主张。",
    "",
    "### 2. [论据] blk_evidence_case",
    "",
    "案例支撑。",
    "^[调研笔记](everroom://room/r1/d1/b1)",
    "",
    "### 3. [数据] blk_data_users",
    "",
    "周活 1200。",
    "^[b2](everroom://room/r1/d1/b2)",
    "",
    "### 4. [图示] blk_visual_arch",
    "",
    "架构图。",
    "",
    "### 5. [引述] blk_quote_user",
    "",
    "用户反馈。",
    "^[用户反馈记忆](everroom://memory/r1/m1)",
    "",
  ].join("\n");

  function reorderInvocationFixture(result: Record<string, unknown>): SubagentInvocation {
    return {
      id: "inv-reorder-1",
      agentDefinitionId: DECK_COMPOSER_AGENT_ID,
      agentRevisionId: "revision-1",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
      task: DECK_REORDER_TASK_LABEL,
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

  it("documentId 路径：解析草稿文档 → 调度 → 返回 outline/cutBlocks/nextAction", async () => {
    const orchestrator = {
      dispatch: vi.fn(async () => reorderInvocationFixture(planFixture())),
      getInvocation: vi.fn(() => null),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> };
    const tools = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), orchestrator, {
      resolveDocumentForDraft: () => ({
        document: { id: "doc-draft", title: "DeckGen 项目汇报 · PPT草稿", version: 2, roomId: "room-1" },
        blocks: [],
        markdown: draftDocumentMarkdown,
      }),
    });
    const tool = tools.find((item) => item.name === "deck_reorder");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      baseRun as never,
      { profileId: "judge", documentId: "doc-draft" } as never,
      undefined,
    );
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload.status).toBe("completed");
    expect(payload.kind).toBe("audience-reorder");
    expect(payload.profileLabel).toBe("比赛评委");
    expect(payload.outline).toHaveLength(4);
    expect(payload.outline[0]).toMatchObject({ id: "blk_claim_main", detail: "expand" });
    expect(payload.cutBlocks).toEqual([
      { id: "blk_quote_user", kind: "quote", note: "对评委说服力弱" },
    ]);
    expect(payload.nextAction).toContain("context_room_slides_create");
    // 派发输入携带解析后的草稿块
    const input = orchestrator.dispatch.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(input.task).toBe("audience-reorder");
    expect(input.audienceProfileId).toBe("judge");
    expect((input.draftSpec as { blocks: unknown[] }).blocks).toHaveLength(5);
  });

  it("未传 documentId/invocationId 拒绝；草稿文档不可解析返回不可重试错误", async () => {
    const orchestrator = {
      dispatch: vi.fn(),
      getInvocation: vi.fn(() => null),
    } as unknown as SubagentOrchestrator;
    const tools = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), orchestrator, {});
    const tool = tools.find((item) => item.name === "deck_reorder")!;
    await expect(tool.execute(baseRun as never, { profileId: "judge" } as never, undefined))
      .rejects.toThrow("deck_reorder_draft_required");

    const brokenDoc = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), orchestrator, {
      resolveDocumentForDraft: () => ({
        document: { id: "doc-x", title: "普通文档", version: 1, roomId: "room-1" },
        blocks: [],
        markdown: "# 不是草稿格式的文档\n\n正文。",
      }),
    });
    const brokenTool = brokenDoc.find((item) => item.name === "deck_reorder")!;
    const broken = await brokenTool.execute(
      baseRun as never,
      { profileId: "judge", documentId: "doc-x" } as never,
      undefined,
    );
    const payload = JSON.parse((broken as { content: string }).content);
    expect(payload.errorCode).toBe("deck_reorder_draft_unparseable");
    expect(payload.retryable).toBe(false);
  });
});
