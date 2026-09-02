/**
 * doc-writer 子 Agent 的 internal_workflow 调度封装（doc-writer-subagent-plan §8/M2）：
 * 编辑器划词改写（原 context-room 的 selection-rewrite task）迁入 doc-writer 的
 * rewrite task。REST 契约不变，仅改派目标；与 ContextRoomAgentDispatcher 同构
 * （统一 agentId/source/task 文案/idempotencyKey + provider 注入）。
 */
import { randomUUID } from "node:crypto";
import type { SubagentInvocation } from "@nxcore/agent-contract";
import { SELECTION_REWRITE_OPERATION_GRACE_MS } from "../agent/service.js";
import { DOC_WRITER_AGENT_ID, DOC_WRITER_TASK_LABELS } from "./document-draft.js";
import type { SubagentOrchestrator } from "./orchestrator.js";

export { DOC_WRITER_AGENT_ID };

export interface DocWriterDispatchInput {
  /** M2 只承接 rewrite（编辑器静默流）；draft 任务经主 Agent 的 document_draft 工具。 */
  task: "rewrite";
  taskInput: Record<string, unknown>;
  /** 稳定键用于幂等去重；缺省每次新调用。 */
  idempotencyKey?: string;
}

export interface DocWriterDispatcher {
  /** 立即返回 invocationId，不等待终态；调用方轮询 /v1/subagent-invocations/:id。 */
  dispatchDetached(input: DocWriterDispatchInput): Promise<string>;
}

export class DocWriterAgentDispatcher implements DocWriterDispatcher {
  constructor(
    private readonly orchestrator: SubagentOrchestrator,
    /** 写作风格注入段：对 rewrite task 无条件附加（doc-writer 全部 task 都是写作任务，
     *  无信号门），provider 自查生成开关，关闭返回 null 不附字段。 */
    private readonly writingStyleProvider: { getGenerationPromptSection(): string | null } | null = null,
  ) {}

  async dispatchDetached(input: DocWriterDispatchInput): Promise<string> {
    const writingStyle = this.writingStyleProvider?.getGenerationPromptSection() ?? null;
    return this.orchestrator.startDetached({
      agentId: DOC_WRITER_AGENT_ID,
      task: DOC_WRITER_TASK_LABELS[input.task],
      input: {
        task: input.task,
        ...input.taskInput,
        ...(writingStyle ? { writingStyle } : {}),
      },
      idempotencyKey: input.idempotencyKey ?? `doc-writer:${randomUUID()}`,
      source: "internal_workflow",
      parentSessionId: null,
      parentRunId: null,
    });
  }
}

/**
 * 校验 document.selection-rewrite 操作的子 Agent 调用溯源（自 room-agent.ts 迁入并换绑）：
 * 必须是 doc-writer 子 Agent 的 internal_workflow 调用、已 completed、在宽限期内，
 * 且（入参带 roomId 时）与操作目标 Room 一致。
 * 对齐 agent/service.ts 中主 Agent 会话溯源的 completedSelectionRewriteMatches 规则。
 */
export function isSelectionRewriteInvocationAuthorized(
  invocation: SubagentInvocation | null | undefined,
  options: { capabilityId: string; roomId: string; now?: Date },
): boolean {
  if (!invocation || options.capabilityId !== "document.selection-rewrite") return false;
  if (invocation.agentDefinitionId !== DOC_WRITER_AGENT_ID) return false;
  if (invocation.source !== "internal_workflow") return false;
  if (invocation.status !== "completed" || !invocation.completedAt) return false;
  const completedAt = new Date(invocation.completedAt).getTime();
  if (!Number.isFinite(completedAt)) return false;
  const now = options.now?.getTime() ?? Date.now();
  if (now - completedAt > SELECTION_REWRITE_OPERATION_GRACE_MS) return false;
  const input = invocation.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const inputRoomId = (input as Record<string, unknown>).roomId;
    if (typeof inputRoomId === "string" && inputRoomId !== options.roomId) return false;
  }
  return true;
}
