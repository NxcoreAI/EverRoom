import type { SubagentInvocation } from "@nxcore/agent-contract";
import { describe, expect, it, vi } from "vitest";

import {
  APPEND_CHUNK_MAX_BYTES,
  createDocWriterResultValidator,
  splitIntoAppendChunks,
} from "../src/modules/subagents/document-draft.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { createSubagentPiTools, inferMaterialSourcesFromReads } from "../src/modules/subagents/tools.js";

function registryWith(agentIds: string[]): SubagentRegistry {
  return {
    get: (id: string) => (agentIds.includes(id) ? { id } : null),
    listAvailable: () => [],
    listAll: () => [],
  } as unknown as SubagentRegistry;
}

function orchestratorReturning(invocation: Partial<SubagentInvocation>): SubagentOrchestrator & {
  dispatch: ReturnType<typeof vi.fn>;
} {
  return {
    dispatch: vi.fn(async () => ({
      id: "invocation-1",
      agentDefinitionId: "doc-writer",
      agentRevisionId: "revision-1",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
      task: "起草新文档正文",
      input: null,
      status: "completed",
      result: { text: "" },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...invocation,
    })),
  } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> };
}

function orchestratorRejecting(errorCode: string): SubagentOrchestrator {
  return {
    dispatch: vi.fn(async () => {
      throw new Error(errorCode);
    }),
  } as unknown as SubagentOrchestrator;
}

const baseRun = {
  runId: "run-1",
  sessionId: "session-1",
  roomId: "room-1",
  prompt: "改一下周报",
  pageLabel: "文档",
  runtimeSessionRef: null,
};

const snapshotFixture = {
  document: { id: "doc-1", title: "周报", version: 3, roomId: "room-1" },
  blocks: [
    { blockId: "b1", type: "heading", ordinal: 1, depth: 0, textPreview: "周报" },
    { blockId: "b2", type: "paragraph", ordinal: 2, depth: 0, textPreview: "本周进展顺利。" },
    { blockId: "b2-child", type: "text", ordinal: 3, depth: 1, textPreview: "嵌套文本" },
  ],
  markdown: "# 周报\n\n本周进展顺利。",
};

describe("splitIntoAppendChunks", () => {
  it("小文本不切分", () => {
    expect(splitIntoAppendChunks("短文")).toEqual(["短文"]);
    expect(splitIntoAppendChunks("")).toEqual([]);
  });

  it("拼接不变量：chunks.join('') 与原文逐字节一致（含超大段落与超长行降级）", () => {
    const paragraph = "这是第一段，表达一个完整的意思。\n\n";
    const longLine = "超".repeat(APPEND_CHUNK_MAX_BYTES + 1_000);
    const markdown = paragraph.repeat(200) + longLine + "\n\n" + "结尾段落。";
    const chunks = splitIntoAppendChunks(markdown, 4 * 1024);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(markdown);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(4 * 1024);
    }
  });

  it("总量超 2MiB 抛错", () => {
    expect(() => splitIntoAppendChunks("风".repeat(2 * 1024 * 1024 + 1))).toThrow("doc_writer_output_too_large");
  });
});

describe("createDocWriterResultValidator", () => {
  const validator = createDocWriterResultValidator();

  it("draft-edit 回显 baseVersion 不一致时拒绝", () => {
    expect(() => validator(
      { task: "draft-edit", baseVersion: 3, blockIndex: [{ blockId: "b1" }] },
      { kind: "draft-edit", baseVersion: 4, hunks: [{ operation: "replace", target: { blockId: "b1" } }] },
    )).toThrow("doc_writer_base_version_mismatch");
  });

  it("hunk 目标不在 blockIndex 时拒绝", () => {
    expect(() => validator(
      { task: "draft-edit", baseVersion: 3, blockIndex: [{ blockId: "b1" }] },
      {
        kind: "draft-edit",
        baseVersion: 3,
        hunks: [{ operation: "replace", target: { fromBlockId: "b1", toBlockId: "ghost" } }],
      },
    )).toThrow("doc_writer_hunk_target_not_in_snapshot");
  });

  it("合法 draft-edit 结果通过；rewrite 与 draft-create 不要求 blockIndex 回显", () => {
    expect(() => validator(
      { task: "draft-edit", baseVersion: 3, blockIndex: [{ blockId: "b1" }, { blockId: "b2" }] },
      {
        kind: "draft-edit",
        baseVersion: 3,
        hunks: [{ operation: "replace", target: { blockId: "b1" }, markdown: "新内容" }],
        digest: { summary: "改了标题" },
      },
    )).not.toThrow();
    expect(() => validator({ task: "rewrite" }, { kind: "rewrite", replacementText: "新片段" })).not.toThrow();
  });
});

describe("createSubagentPiTools document_draft", () => {
  it("仅在 doc-writer 注册于 registry 时挂载", () => {
    expect(createSubagentPiTools(registryWith(["doc-writer"]), orchestratorReturning({}))
      .map((tool) => tool.name)).toContain("document_draft");
    expect(createSubagentPiTools(registryWith([]), orchestratorReturning({}))
      .map((tool) => tool.name)).not.toContain("document_draft");
  });

  it("draft-create：组装 instruction/material/writingStyle 并返回 title 与摘要（M3/V2：正文不回传）", async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-create",
          title: "接口设计文档",
          appendChunks: ["## 背景与目标\n\n本文档……", "## 接口清单\n\n……"],
          digest: { outline: ["背景与目标", "接口清单"], charCount: 800, summary: "接口设计初稿" },
        },
      },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      writingStyleProvider: { getGenerationPromptSection: () => "<writing_style>\n短句收尾。\n</writing_style>" },
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草接口设计文档",
      material: "素材摘录",
    } as never, undefined);

    const dispatchInput = orchestrator.dispatch.mock.calls[0]![0] as Record<string, unknown>;
    expect(dispatchInput).toMatchObject({
      agentId: "doc-writer",
      task: "起草新文档正文",
      source: "primary_agent",
      parentSessionId: "session-1",
      parentRunId: "run-1",
    });
    const input = dispatchInput.input as Record<string, unknown>;
    expect(input.task).toBe("draft-create");
    expect(input.instruction).toBe("起草接口设计文档");
    expect(input.material).toBe("素材摘录");
    expect(input.writingStyle).toContain("短句收尾");

    const payload = JSON.parse((result as { content: string }).content);
    expect(payload).toMatchObject({
      status: "completed",
      kind: "draft-create",
      title: "接口设计文档",
      chunkCount: 2,
      digest: { summary: "接口设计初稿" },
    });
    // M3/V2：正文与全文均不进入主 Agent 上下文。
    expect(payload).not.toHaveProperty("appendChunks");
    expect(payload).not.toHaveProperty("baseVersion");
  });

  it("draft-create：contentMarkdown 单串返回分块计数（字节精确性由 resolver 测试覆盖）", async () => {
    const body = "## 第一节\n\n内容甲。\n\n## 第二节\n\n内容乙。";
    const orchestrator = orchestratorReturning({
      result: { text: "", structuredOutput: { kind: "draft-create", title: "T", contentMarkdown: body, digest: { summary: "s" } } },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {});
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草",
    } as never, undefined);
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload.chunkCount).toBe(splitIntoAppendChunks(body).length);
    expect(payload.appendChunkBytes).toBe(Buffer.byteLength(body, "utf8"));
  });

  it("draft-edit：组装权威快照，成功后代发读凭证并返回 hunks 与 baseVersion", async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-edit",
          baseVersion: 3,
          hunks: [{ operation: "replace", target: { blockId: "b2" }, markdown: "本周进展顺利，指标全部达标。" }],
          digest: { summary: "更新了进展段" },
        },
      },
    });
    const issued: Array<unknown> = [];
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      resolveDocumentForDraft: () => snapshotFixture,
      issueDraftReadReceipt: (context, documentId, version, blockIds) => {
        issued.push({ context, documentId, version, blockIds });
        return { readReceipt: "receipt-1", expiresAt: "2026-09-02T00:00:00.000Z" };
      },
      writingStyleProvider: { getGenerationPromptSection: () => null },
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(baseRun as never, {
      task: "draft-edit",
      instruction: "更新进展描述",
      documentId: "doc-1",
    } as never, undefined);

    const input = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    // 组装只含顶层块（depth===0），blockId/textPreview 保真。
    expect(input.blockIndex).toEqual([
      { blockId: "b1", type: "heading", ordinal: 1, textPreview: "周报" },
      { blockId: "b2", type: "paragraph", ordinal: 2, textPreview: "本周进展顺利。" },
    ]);
    expect(input.documentMarkdown).toBe(snapshotFixture.markdown);
    expect(input.baseVersion).toBe(3);
    expect(input.writingStyle).toBeUndefined();

    // 代发凭证：主 run 上下文 + 权威版本 + 顶层 blockIds（§5.3）。
    expect(issued).toEqual([{
      context: { agentSessionId: "session-1", runId: "run-1", roomId: "room-1" },
      documentId: "doc-1",
      version: 3,
      blockIds: ["b1", "b2"],
    }]);

    const payload = JSON.parse((result as { content: string }).content);
    expect(payload).toMatchObject({
      status: "completed",
      kind: "draft-edit",
      baseVersion: 3,
      documentId: "doc-1",
      roomId: "room-1",
      hunkCount: 1,
      hunksSummary: [{ operation: "replace", target: { blockId: "b2" } }],
    });
    // M3/V2：hunk 正文不回传，仅摘要（operation/target）。
    expect(payload).not.toHaveProperty("hunks");
    expect(JSON.stringify(payload.hunksSummary)).not.toContain("指标全部达标");
  });

  it("draft-edit：生成期间版本漂移返回 DOCUMENT_CONFLICT 且不签凭证", async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-edit",
          baseVersion: 3,
          hunks: [{ operation: "replace", target: { blockId: "b2" }, markdown: "新内容" }],
          digest: { summary: "s" },
        },
      },
    });
    let reads = 0;
    let issued = 0;
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      // 第 1 次 = 组装（version 3），第 2 次 = dispatch 后复核（version 4）——生成期间文档被他人修改。
      resolveDocumentForDraft: () => {
        reads += 1;
        return { ...snapshotFixture, document: { ...snapshotFixture.document, version: reads <= 1 ? 3 : 4 } };
      },
      issueDraftReadReceipt: () => {
        issued += 1;
        return { readReceipt: "r", expiresAt: "x" };
      },
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(baseRun as never, {
      task: "draft-edit",
      instruction: "改",
      documentId: "doc-1",
    } as never, undefined);
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload).toMatchObject({
      status: "conflict",
      errorCode: "DOCUMENT_CONFLICT",
      retryable: true,
      expectedVersion: 3,
      currentVersion: 4,
    });
    expect(issued).toBe(0);
  });

  it("并发拒绝映射为可重试结构化错误，不向上抛", async () => {
    const tools = createSubagentPiTools(
      registryWith(["doc-writer"]),
      orchestratorRejecting("subagent_concurrency_limit"),
    );
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草",
    } as never, undefined);
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload).toMatchObject({ status: "failed", errorCode: "subagent_concurrency_limit", retryable: true });
  });

  it("previousInvocationId 回读本会话上一稿注入 previousDraft；跨会话回退为普通生成", async () => {
    const makePrior = (parentSessionId: string): SubagentInvocation => ({
      id: "prior-inv",
      agentDefinitionId: "doc-writer",
      agentRevisionId: "rev-1",
      source: "primary_agent",
      parentSessionId,
      parentRunId: "run-0",
      task: "起草新文档正文",
      input: { task: "draft-create" },
      status: "completed",
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-create",
          title: "上一稿标题",
          appendChunks: ["## 旧第一节\n\n旧内容。"],
          digest: { summary: "s" },
        },
      },
      errorCode: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    const runTool = async (prior: SubagentInvocation | null) => {
      const dispatch = vi.fn(async (_input: Record<string, unknown>) => ({
        id: "invocation-2",
        agentDefinitionId: "doc-writer",
        agentRevisionId: "revision-1",
        source: "primary_agent",
        parentSessionId: "session-1",
        parentRunId: "run-1",
        task: "起草新文档正文",
        input: null,
        status: "completed",
        result: {
          text: "",
          structuredOutput: { kind: "draft-create", title: "T", contentMarkdown: "新稿", digest: { summary: "s" } },
        },
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      } as unknown as SubagentInvocation));
      const orchestrator = {
        dispatch,
        getInvocation: (id: string) => (id === "prior-inv" ? prior : null),
      } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> };
      const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {});
      const tool = tools.find((candidate) => candidate.name === "document_draft")!;
      const result = await tool.execute(baseRun as never, {
        task: "draft-create",
        instruction: "再简洁一点",
        previousInvocationId: "prior-inv",
      } as never, undefined);
      return {
        input: (dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input,
        payload: JSON.parse((result as { content: string }).content),
      };
    };

    // 本会话上一稿：注入 previousDraft（标题 + 正文）。
    const same = await runTool(makePrior("session-1"));
    expect(same.input.previousInvocationId).toBe("prior-inv");
    expect(same.input.previousDraft).toContain("上一稿标题");
    expect(same.input.previousDraft).toContain("旧内容");
    expect(same.payload.previousDraftApplied).toBe(true);

    // 跨会话 / 不存在的 invocation：不注入，回普通生成。
    const foreign = await runTool(makePrior("session-other"));
    expect(foreign.input).not.toHaveProperty("previousDraft");
    expect(foreign.payload.previousDraftApplied).toBe(false);
    const missing = await runTool(null);
    expect(missing.input).not.toHaveProperty("previousDraft");
    expect(missing.payload.previousDraftApplied).toBe(false);
  });

  it("draft-edit：dispatch 期设 agent-modification 软租约，结束（成功/失败）后清除", async () => {
    const leaseCalls: Array<{ documentId: string; value: string | null }> = [];
    const makeTools = (dispatchImpl: () => Promise<unknown>) => {
      const orchestrator = {
        dispatch: vi.fn(dispatchImpl as never),
      } as unknown as SubagentOrchestrator & { dispatch: ReturnType<typeof vi.fn> };
      const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
        resolveDocumentForDraft: () => snapshotFixture,
        setDocumentModificationLease: (documentId, value) => {
          leaseCalls.push({ documentId, value });
        },
      });
      return tools.find((candidate) => candidate.name === "document_draft")!;
    };

    // 成功路径：dispatch 返回后即清除（patch_begin 接管前置 NULL）。
    const ok = makeTools(async () => ({
      id: "inv-lease-1",
      agentDefinitionId: "doc-writer",
      status: "completed",
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-edit",
          baseVersion: 3,
          hunks: [{ operation: "replace", target: { blockId: "b2" }, markdown: "新" }],
          digest: { summary: "s" },
        },
      },
      errorCode: null,
      errorMessage: null,
    }) as unknown as SubagentInvocation);
    await ok.execute(baseRun as never, {
      task: "draft-edit",
      instruction: "改",
      documentId: "doc-1",
    } as never, undefined);
    expect(leaseCalls).toEqual([
      { documentId: "doc-1", value: "agent-modification:run-1" },
      { documentId: "doc-1", value: null },
    ]);

    // 失败路径（并发拒绝）：catch 返回错误负载，finally 同样清除。
    leaseCalls.length = 0;
    const rejected = makeTools(async () => {
      throw new Error("subagent_concurrency_limit");
    });
    await rejected.execute(baseRun as never, {
      task: "draft-edit",
      instruction: "改",
      documentId: "doc-1",
    } as never, undefined);
    expect(leaseCalls).toEqual([
      { documentId: "doc-1", value: "agent-modification:run-1" },
      { documentId: "doc-1", value: null },
    ]);
  });

  it("draft-create：无文档目标，不设租约", async () => {
    const leaseCalls: Array<unknown> = [];
    const orchestrator = orchestratorReturning({
      result: { text: "", structuredOutput: { kind: "draft-create", title: "T", contentMarkdown: "正文", digest: { summary: "s" } } },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      setDocumentModificationLease: (...args: unknown[]) => leaseCalls.push(args),
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草",
    } as never, undefined);
    expect(leaseCalls).toEqual([]);
  });

  it("终态非 completed / 结构化结果缺失时返回结构化错误", async () => {
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestratorReturning({
      status: "timed_out",
      errorCode: "timeout",
      result: null,
    }));
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草",
    } as never, undefined);
    const payload = JSON.parse((result as { content: string }).content);
    expect(payload).toMatchObject({ status: "timed_out", errorCode: "timeout", retryable: true });
  });

  it("materialSources 透传给 doc-writer，跨 Room 来源被拒绝", async () => {
    const orchestrator = orchestratorReturning({
      result: { text: "", structuredOutput: { kind: "draft-create", title: "T", appendChunks: ["正文"], digest: { summary: "s" } } },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {});
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草",
      materialSources: [
        { roomId: "room-1", documentId: "doc-2", blockId: "b7", label: "访谈记录", textPreview: "访谈结论……" },
      ],
    } as never, undefined);
    const input = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.materialSources).toEqual([
      { roomId: "room-1", documentId: "doc-2", blockId: "b7", label: "访谈记录", textPreview: "访谈结论……" },
    ]);

    await expect(tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "起草",
      materialSources: [
        { roomId: "room-other", documentId: "doc-2", blockId: "b7" },
      ],
    } as never, undefined)).rejects.toThrow(/ROOM_SELECTION_MISMATCH/);
  });

  it("materialSources 对 draft-edit 同样透传（为既有文档补建索引）", async () => {    const snapshot = {
      document: { id: "doc-1", title: "存量文档", version: 3, roomId: "room-1" },
      markdown: "# 存量文档\n\n原段正文\n",
      blocks: [{ blockId: "b1", type: "paragraph", ordinal: 0, depth: 0, textPreview: "原段正文" }],
    };
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-edit",
          baseVersion: 3,
          hunks: [{ operation: "replace", target: { blockId: "b1" }, markdown: "原段正文^[访谈记录](everroom://room/room-1/doc-2/b7)" }],
          digest: { summary: "补挂索引" },
        },
      },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      resolveDocumentForDraft: () => snapshot,
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(baseRun as never, {
      task: "draft-edit",
      instruction: "仅为确有来源支撑的存量段落补挂索引标记，正文保持原样",
      documentId: "doc-1",
      roomId: "room-1",
      materialSources: [
        { roomId: "room-1", documentId: "doc-2", blockId: "b7", label: "访谈记录" },
      ],
    } as never, undefined);
    const input = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.materialSources).toEqual([
      { roomId: "room-1", documentId: "doc-2", blockId: "b7", label: "访谈记录" },
    ]);
  });

  it("主 agent 只传 material 未传 materialSources 时，网关兜底推断注入", async () => {
    const orchestrator = orchestratorReturning({
      result: { text: "", structuredOutput: { kind: "draft-create", title: "T", appendChunks: ["正文"], digest: { summary: "s" } } },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      inferMaterialSources: (_runId, _roomId, material) => [{
        roomId: "room-1",
        documentId: "doc-2",
        blockId: "b7",
        label: "PyTorch 深度学习框架入门",
        textPreview: `来源块预览（素材开头：${material.slice(0, 8)}）`,
      }],
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "写总结",
      material: "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护。",
    } as never, undefined);
    const input = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.materialSources).toEqual([
      { roomId: "room-1", documentId: "doc-2", blockId: "b7", label: "PyTorch 深度学习框架入门", textPreview: "来源块预览（素材开头：PyTorch ）" },
    ]);
  });

  it("显式 materialSources 抑制兜底推断", async () => {
    const orchestrator = orchestratorReturning({
      result: { text: "", structuredOutput: { kind: "draft-create", title: "T", appendChunks: ["正文"], digest: { summary: "s" } } },
    });
    const inferMaterialSources = vi.fn();
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, { inferMaterialSources });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(baseRun as never, {
      task: "draft-create",
      instruction: "写总结",
      material: "素材文本",
      materialSources: [{ roomId: "room-1", documentId: "doc-2", blockId: "b7" }],
    } as never, undefined);
    expect(inferMaterialSources).not.toHaveBeenCalled();
    const input = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.materialSources).toEqual([{ roomId: "room-1", documentId: "doc-2", blockId: "b7" }]);
  });

  it("inferMaterialSourcesFromReads 只取 material 中真实出现的同 Room 顶层块", () => {
    const reads = {
      documentsReadByRun: (runId: string) => runId === "run-1"
        ? [
          { roomId: "room-1", documentId: "doc-2", version: 3 },
          { roomId: "room-1", documentId: "doc-3", version: 1 },
          { roomId: "room-other", documentId: "doc-x", version: 1 },
        ]
        : [],
    };
    const readDocument = (documentId: string) => ({
      document: { title: `文档 ${documentId}` },
      blocks: [
        { blockId: `${documentId}-b1`, depth: 0, textPreview: "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护，支持动态计算图。" },
        { blockId: `${documentId}-b2`, depth: 1, textPreview: "嵌套块不应入选" },
        { blockId: `${documentId}-b3`, depth: 0, textPreview: "与素材无关的段落" },
      ],
    });
    const material = "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护，支持动态计算图。\n综上……";
    const entries = inferMaterialSourcesFromReads(reads, readDocument, "run-1", "room-1", material);
    // doc-2 命中 b1；doc-3 同样命中其 b1（内容相同）；跨 Room 的 doc-x 被过滤；嵌套/无关块不进。
    expect(entries).toEqual([
      { roomId: "room-1", documentId: "doc-2", blockId: "doc-2-b1", label: "文档 doc-2", textPreview: readDocument("doc-2").blocks[0]!.textPreview },
      { roomId: "room-1", documentId: "doc-3", blockId: "doc-3-b1", label: "文档 doc-3", textPreview: readDocument("doc-3").blocks[0]!.textPreview },
    ]);
    // material 过短不推断。
    expect(inferMaterialSourcesFromReads(reads, readDocument, "run-1", "room-1", "太短")).toEqual([]);
    // 读取抛错的文档被跳过。
    expect(inferMaterialSourcesFromReads(
      reads,
      () => { throw new Error("boom"); },
      "run-1",
      "room-1",
      material,
    )).toEqual([]);
  });

  it("memoryIndex 由 gateway 从 Room 权威数据注入", async () => {
    const orchestrator = orchestratorReturning({
      result: { text: "", structuredOutput: { kind: "draft-create", title: "T", appendChunks: ["正文"], digest: { summary: "s" } } },
    });
    const resolveRoomMemoryItems = vi.fn(() => [
      { id: "room-1-memory-1", content: "偏好静默更新".repeat(60), type: "偏好" },
      { id: "room-1-memory-2", content: "每周五发周报", type: "指令" },
    ]);
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, { resolveRoomMemoryItems });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(baseRun as never, { task: "draft-create", instruction: "起草" } as never, undefined);
    expect(resolveRoomMemoryItems).toHaveBeenCalledWith("room-1");
    const input = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.memoryIndex).toEqual([
      { memoryId: "room-1-memory-1", contentPreview: "偏好静默更新".repeat(60).slice(0, 200), type: "偏好" },
      { memoryId: "room-1-memory-2", contentPreview: "每周五发周报", type: "指令" },
    ]);
  });
});
