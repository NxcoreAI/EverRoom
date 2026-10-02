import type { SubagentInvocation } from "@nxcore/agent-contract";
import { describe, expect, it, vi } from "vitest";

import {
  DECK_COMPOSER_AGENT_ID,
  deckSourceIndexOf,
  normalizeDeckDraftSpec,
  parseDeckDraftBody,
  renderDeckDraftMarkdown,
} from "../src/modules/subagents/deck-draft.js";
import { createDocWriterDraftResolver } from "../src/modules/subagents/doc-writer-content.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";

function deckSpecFixture(): Record<string, unknown> {
  return {
    kind: "deck-draft",
    title: "DeckGen 项目汇报",
    thesis: "把 PPT 生成从一次性黑盒变成六阶段可干预流水线",
    blocks: [
      { id: "blk_claim_main", kind: "claim", content: "核心主张：分阶段可控生成优于一次性黑盒。" },
      {
        id: "blk_evidence_case",
        kind: "evidence",
        content: "已有试点案例支撑该主张。",
        sourceRefs: ["everroom://room/r1/d1/b1"],
      },
      {
        id: "blk_data_users",
        kind: "data",
        content: "周活 1200，环比 +18%。",
        sourceRefs: ["everroom://room/r1/d1/b2"],
      },
      { id: "blk_visual_arch", kind: "visual", content: "画六步流水线架构图：泳道按 素材/草稿/重排/编排/生成 分。" },
      {
        id: "blk_quote_user",
        kind: "quote",
        content: "用户反馈：终于能改了。",
        sourceRefs: ["everroom://memory/r1/m1"],
      },
    ],
  };
}

function deckInvocationFixture(overrides?: Partial<SubagentInvocation>): SubagentInvocation {
  return {
    id: "inv-deck-1",
    agentDefinitionId: DECK_COMPOSER_AGENT_ID,
    agentRevisionId: "revision-1",
    source: "primary_agent",
    parentSessionId: "session-1",
    parentRunId: "run-1",
    task: "生成 PPT 草稿",
    input: {
      materialSources: [{ roomId: "r1", documentId: "d1", blockId: "b1", label: "调研笔记" }],
      memoryIndex: [{ roomId: "r1", memoryId: "m1", label: "用户反馈记忆" }],
    },
    status: "completed",
    result: { structuredOutput: deckSpecFixture(), text: "" },
    errorCode: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as SubagentInvocation;
}

function registryWith(agentIds: string[]): SubagentRegistry {
  return {
    get: (id: string) => (agentIds.includes(id) ? { id } : null),
    listAvailable: () => [],
    listAll: () => [],
  } as unknown as SubagentRegistry;
}

describe("normalizeDeckDraftSpec（DraftSpec 跨字段校验）", () => {
  it("合法 DraftSpec 通过并保留结构", () => {
    const normalized = normalizeDeckDraftSpec(deckSpecFixture());
    expect(normalized).not.toBeNull();
    expect(normalized!.title).toBe("DeckGen 项目汇报");
    expect(normalized!.thesis).toContain("六阶段");
    expect(normalized!.blocks).toHaveLength(5);
    expect(normalized!.blocks[2]!.sourceRefs).toEqual(["everroom://room/r1/d1/b2"]);
  });

  it("data/quote/evidence 缺 sourceRefs 拒绝", () => {
    const bad = deckSpecFixture();
    (bad.blocks as Array<Record<string, unknown>>)[2]!.sourceRefs = [];
    expect(normalizeDeckDraftSpec(bad)).toBeNull();
  });

  it("sourceRefs URI 形态非法拒绝", () => {
    const bad = deckSpecFixture();
    (bad.blocks as Array<Record<string, unknown>>)[2]!.sourceRefs = ["https://example.com/x"];
    expect(normalizeDeckDraftSpec(bad)).toBeNull();
  });

  it("重复块 id / 非法 id / 非法 kind 拒绝", () => {
    const duplicated = deckSpecFixture();
    (duplicated.blocks as Array<Record<string, unknown>>)[3]!.id = "blk_claim_main";
    expect(normalizeDeckDraftSpec(duplicated)).toBeNull();

    const badId = deckSpecFixture();
    (badId.blocks as Array<Record<string, unknown>>)[0]!.id = "1st_claim";
    expect(normalizeDeckDraftSpec(badId)).toBeNull();

    const badKind = deckSpecFixture();
    (badKind.blocks as Array<Record<string, unknown>>)[0]!.kind = "section";
    expect(normalizeDeckDraftSpec(badKind)).toBeNull();
  });

  it("块数不足 / 缺 title 拒绝", () => {
    const tooFew = deckSpecFixture();
    (tooFew.blocks as unknown[]).length = 3;
    expect(normalizeDeckDraftSpec(tooFew)).toBeNull();

    const noTitle = deckSpecFixture();
    delete noTitle.title;
    expect(normalizeDeckDraftSpec(noTitle)).toBeNull();
  });
});

describe("renderDeckDraftMarkdown + deckSourceIndexOf", () => {
  it("块标题行编码 序号/[类型]/id，溯源标记使用登记 label", () => {
    const normalized = normalizeDeckDraftSpec(deckSpecFixture())!;
    const index = deckSourceIndexOf(deckInvocationFixture().input);
    const markdown = renderDeckDraftMarkdown(normalized, index.labels);
    expect(markdown).toContain("> **核心主张**：");
    expect(markdown).toContain("### 2. [论据] blk_evidence_case");
    expect(markdown).toContain("^[调研笔记](everroom://room/r1/d1/b1)");
    expect(markdown).toContain("^[用户反馈记忆](everroom://memory/r1/m1)");
    expect(markdown).not.toMatch(/^# /);
  });

  it("未登记 label 回退路径末段短 id", () => {
    const normalized = normalizeDeckDraftSpec(deckSpecFixture())!;
    const markdown = renderDeckDraftMarkdown(normalized, new Map());
    expect(markdown).toContain("^[b2](everroom://room/r1/d1/b2)");
  });
});

describe("parseDeckDraftBody（草稿文档确定性解析回块结构）", () => {
  it("与 renderDeckDraftMarkdown 互逆：解析恢复 thesis/块/溯源", () => {
    const normalized = normalizeDeckDraftSpec(deckSpecFixture())!;
    const index = deckSourceIndexOf(deckInvocationFixture().input);
    const parsed = parseDeckDraftBody(renderDeckDraftMarkdown(normalized, index.labels));
    expect(parsed).not.toBeNull();
    expect(parsed!.thesis).toBe(normalized.thesis);
    expect(parsed!.blocks.map((block) => block.id)).toEqual(normalized.blocks.map((block) => block.id));
    expect(parsed!.blocks[1]!.sourceRefs).toEqual(["everroom://room/r1/d1/b1"]);
    // 溯源标记从正文剥离
    expect(parsed!.blocks[1]!.content).not.toContain("everroom://");
  });

  it("容忍用户编辑：序号增删、标题间空行、内容改写", () => {
    const markdown = [
      "> **核心主张**：用户改过的主张。",
      "",
      "### [论点] blk_claim_main",
      "",
      "用户改写过的内容。",
      "",
      "### 99. [数据] blk_data_users",
      "",
      "改过的数字表述。",
      "^[调研笔记](everroom://room/r1/d1/b1)",
      "",
    ].join("\n");
    const parsed = parseDeckDraftBody(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed!.thesis).toBe("用户改过的主张。");
    expect(parsed!.blocks).toHaveLength(2);
    expect(parsed!.blocks[1]!.kind).toBe("data");
    expect(parsed!.blocks[1]!.sourceRefs).toEqual(["everroom://room/r1/d1/b1"]);
  });

  it("无块标题 / 空块 / 重复 id / 非法溯源 URI 拒绝", () => {
    expect(parseDeckDraftBody("## 内容块\n\n没有块标题的普通正文。")).toBeNull();
    expect(parseDeckDraftBody("### [论点] blk_a\n\n### [论点] blk_a\n\n内容")).toBeNull();
    expect(parseDeckDraftBody("### [论点] blk_a\n\n内容^[x](https://evil.example/a)")).toBeNull();
  });
});

describe("write_append 引用转交（createDocWriterDraftResolver 的 deck 分支）", () => {
  it("deck invocation 归一为 draft-create 且 chunks 含草稿正文", () => {
    const invocation = deckInvocationFixture();
    const resolver = createDocWriterDraftResolver({ getInvocation: () => invocation });
    const draft = resolver("inv-deck-1", { runId: "run-1" });
    expect(draft).not.toBeNull();
    expect(draft!.kind).toBe("draft-create");
    expect(draft!.title).toBe("DeckGen 项目汇报");
    expect(draft!.chunks.length).toBeGreaterThan(0);
    expect(draft!.chunks.join("")).toContain("blk_evidence_case");
  });

  it("跨 run / 非 primary_agent / 非完成态 一律拒绝", () => {
    const resolverFor = (overrides: Partial<SubagentInvocation>) =>
      createDocWriterDraftResolver({ getInvocation: () => deckInvocationFixture(overrides) });
    expect(resolverFor({ parentRunId: "run-other" })("inv-deck-1", { runId: "run-1" })).toBeNull();
    expect(resolverFor({ source: "internal_workflow" })("inv-deck-1", { runId: "run-1" })).toBeNull();
    expect(resolverFor({ status: "running" })("inv-deck-1", { runId: "run-1" })).toBeNull();
  });

  it("结构化输出不合法（缺 sourceRefs）时转交拒绝", () => {
    const broken = deckSpecFixture();
    (broken.blocks as Array<Record<string, unknown>>)[2]!.sourceRefs = [];
    const resolver = createDocWriterDraftResolver({
      getInvocation: () => deckInvocationFixture({ result: { structuredOutput: broken, text: "" } }),
    });
    expect(resolver("inv-deck-1", { runId: "run-1" })).toBeNull();
  });
});

describe("deck_draft 工具", () => {
  const baseRun = {
    runId: "run-1",
    sessionId: "session-1",
    roomId: "room-1",
    prompt: "帮我把这个 Room 做成比赛答辩 PPT",
    pageLabel: "Room",
    runtimeSessionRef: null,
    responseLanguage: "zh-CN",
  };

  function buildTools(invocation: Partial<SubagentInvocation>) {
    const orchestrator = {
      dispatch: vi.fn(async () => deckInvocationFixture(invocation)),
      getInvocation: vi.fn(() => null),
    } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> };
    const tools = createSubagentPiTools(registryWith([DECK_COMPOSER_AGENT_ID]), orchestrator, {
      roomExists: () => true,
      resolveRoomMemoryItems: () => [],
    });
    return { tools, orchestrator };
  }

  it("注册 deck_draft；完成调度返回摘要与 write 落库指引", async () => {
    const { tools, orchestrator } = buildTools({});
    const tool = tools.find((item) => item.name === "deck_draft");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      baseRun as never,
      { instruction: "为比赛答辩生成草稿", roomId: "room-1" } as never,
      undefined,
    );
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload.status).toBe("completed");
    expect(payload.kind).toBe("deck-draft");
    expect(payload.title).toBe("DeckGen 项目汇报");
    expect(payload.blockCount).toBe(5);
    expect(payload.blocksByKind).toEqual({ claim: 1, evidence: 1, data: 1, visual: 1, quote: 1 });
    expect(payload.nextAction).toContain("context_room_write_begin");
    expect(payload.nextAction).toContain(`chunkIndex=0..${payload.chunkCount - 1}`);
    expect(orchestrator.dispatch).toHaveBeenCalledTimes(1);
  });

  it("派发输入携带 task/roomId/instruction，且不透传未填写字段", async () => {
    const { tools, orchestrator } = buildTools({});
    const tool = tools.find((item) => item.name === "deck_draft")!;
    await tool.execute(
      baseRun as never,
      { instruction: "生成投资人版草稿" } as never,
      undefined,
    );
    const input = orchestrator.dispatch.mock.calls[0]![0]!.input as Record<string, unknown>;
    expect(input.task).toBe("deck-draft");
    expect(input.roomId).toBe("room-1");
    expect(input.instruction).toBe("生成投资人版草稿");
    expect(input).not.toHaveProperty("material");
    expect(input).not.toHaveProperty("materialSources");
    expect(input).not.toHaveProperty("previousDraft");
  });

  it("结构化结果不合法时返回可重试错误而非抛出", async () => {
    const broken = deckSpecFixture();
    (broken.blocks as Array<Record<string, unknown>>)[2]!.sourceRefs = [];
    const { tools } = buildTools({ result: { structuredOutput: broken, text: "" } });
    const tool = tools.find((item) => item.name === "deck_draft")!;
    const result = await tool.execute(
      baseRun as never,
      { instruction: "生成草稿" } as never,
      undefined,
    );
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload.errorCode).toBe("deck_draft_result_invalid");
    expect(payload.retryable).toBe(true);
  });

  it("未绑定且未显式传 Room 时拒绝", async () => {
    const { tools } = buildTools({});
    const tool = tools.find((item) => item.name === "deck_draft")!;
    await expect(tool.execute(
      { ...baseRun, roomId: null } as never,
      { instruction: "生成草稿" } as never,
      undefined,
    )).rejects.toThrow("ROOM_SELECTION_REQUIRED");
  });
});
