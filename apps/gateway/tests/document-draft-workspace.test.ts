import type { SubagentInvocation } from "@nxcore/agent-contract";
import { describe, expect, it, vi } from "vitest";

import { DocumentReadAuthority } from "../src/modules/documents/capabilities/read-authority.js";
import type { SubagentOrchestrator } from "../src/modules/subagents/orchestrator.js";
import type { SubagentRegistry } from "../src/modules/subagents/registry.js";
import { createSubagentPiTools } from "../src/modules/subagents/tools.js";

/**
 * 回归：Room 维度已在 Phase 2i 从数据模型删除，文稿一律工作区级
 * （document.roomId 恒为 null），主 Agent run 也不再携带 Room。
 * document_draft 的 draft-edit / draft-continue 曾硬性要求 roomId，
 * 导致「改既有文档」在无 Room 工作区永远失败（ROOM_SELECTION_REQUIRED），
 * 而新建草稿（draft-create）正常——正是用户在 PDF/文档页遇到的故障。
 */

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
      task: "产出文档修改提案",
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

/** 无 Room 的主 Agent run（新工作台/Office 页发起：不带 rooms / selectedRoomId / activeDocument）。 */
const roomlessRun = {
  runId: "run-1",
  sessionId: "session-1",
  prompt: "在文末追加一章",
  pageLabel: "文档",
  runtimeSessionRef: null,
};

/** 工作区级文稿快照：roomId 为 null（Phase 2i 之后所有文稿的形状）。 */
const workspaceSnapshot = {
  document: { id: "doc-1", title: "产品方案", version: 3, roomId: null },
  blocks: [
    { blockId: "b1", type: "heading", ordinal: 1, depth: 0, textPreview: "产品方案" },
    { blockId: "b2", type: "paragraph", ordinal: 2, depth: 0, textPreview: "第一章。" },
  ],
  markdown: "# 产品方案\n\n第一章。",
};

describe("document_draft：工作区级文稿（无 Room）", () => {
  it("draft-edit 无需 Room：返回 baseVersion 与 hunk 摘要", async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-edit",
          baseVersion: 3,
          hunks: [{ operation: "replace", target: { blockId: "b2" }, markdown: "第一章（修订）。" }],
          digest: { summary: "修订第一章" },
        },
      },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      resolveDocumentForDraft: () => workspaceSnapshot,
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(roomlessRun as never, {
      task: "draft-edit",
      instruction: "修订第一章",
      documentId: "doc-1",
    } as never, undefined);

    const payload = JSON.parse((result as { content: string }).content) as Record<string, unknown>;
    expect(payload).toMatchObject({
      status: "completed",
      kind: "draft-edit",
      baseVersion: 3,
      documentId: "doc-1",
      hunkCount: 1,
    });
    // 子 run 不再按 Room 绑定：dispatch input 不得携带 roomId。
    const dispatchInput = (orchestrator.dispatch.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(dispatchInput).not.toHaveProperty("roomId");
  });

  it("draft-continue 无需 Room：返回分块计数", async () => {
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-continue",
          appendChunks: ["\n\n第二章。"],
          digest: { summary: "追加第二章" },
        },
      },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      resolveDocumentForDraft: () => workspaceSnapshot,
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const result = await tool.execute(roomlessRun as never, {
      task: "draft-continue",
      instruction: "追加第二章",
      documentId: "doc-1",
    } as never, undefined);

    const payload = JSON.parse((result as { content: string }).content) as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "completed", kind: "draft-continue", chunkCount: 1 });
  });

  it("代发读凭证与主 run 同 scope：document_patch_begin 的 requireLatest 可直接复用", async () => {
    const reads = new DocumentReadAuthority();
    const orchestrator = orchestratorReturning({
      result: {
        text: "",
        structuredOutput: {
          kind: "draft-edit",
          baseVersion: 3,
          hunks: [{ operation: "replace", target: { blockId: "b2" }, markdown: "第一章（修订）。" }],
          digest: { summary: "修订第一章" },
        },
      },
    });
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestrator, {
      resolveDocumentForDraft: () => workspaceSnapshot,
      issueDraftReadReceipt: (context, documentId, version, blockIds) =>
        reads.issue(context as never, documentId, version, blockIds),
    });
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    await tool.execute(roomlessRun as never, {
      task: "draft-edit",
      instruction: "修订第一章",
      documentId: "doc-1",
    } as never, undefined);

    // 主 run 的文档工具 context 无 Room 维度（Phase 2i）；draft-edit 代发凭证
    // 与 document_read 同 scope（sessionId+runId），patch_begin 的 requireLatest 直接可复用。
    expect(() => reads.requireLatest(
      { agentSessionId: "session-1", runId: "run-1" },
      "doc-1",
      3,
    )).not.toThrow();
  });

  it("工具参数与描述中不再出现 Room", () => {
    const tools = createSubagentPiTools(registryWith(["doc-writer"]), orchestratorReturning({}), {});
    const tool = tools.find((candidate) => candidate.name === "document_draft")!;
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(properties).not.toHaveProperty("roomId");
    expect(tool.description).not.toMatch(/ROOM_SELECTION|Context Room|\bRoom\b/);
  });
});
