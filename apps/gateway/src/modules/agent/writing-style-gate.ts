/**
 * 写作风格“生成侧”注入门控（writing-style-profile-plan §7.2 修订，2026-09-01）。
 *
 * 生成开关开启时，写作风格只在“文档写作轮”注入主 Agent 提示词，四个信号任一命中即视为写作轮：
 *   ① 编辑器有活动文档（input.context.activeDocument）
 *   ② 本轮带选区（input.context.selectedText）
 *   ③ 本轮请求明确要写/建文档（document-intent 的 requestsWorkspaceDocument 启发式）
 *   ④ 本会话此前已用过文档写作/修改工具（agent_events 中 tool.completed 的记录，
 *      由 AgentService.hasSessionUsedWritingTools 查询后传入）
 * 纯对话问答轮不注入——用户明确否决了“全部主 Agent 轮次（含纯对话）”的旧取舍。
 * 补全（cursor 子进程）与划词改写（context-room 子 Agent dispatch）天然只作用于文档，不经此门。
 */
import { requestsWorkspaceDocument } from "./document-intent.js";

/** 门控信号④的工具名集合：主 Agent 的文档写入与修改提案工具。 */
export const WRITING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "context_room_write_begin",
  "context_room_write_append",
  "context_room_write_commit",
  "context_room_patch_begin",
  "context_room_patch_hunk",
  "context_room_patch_commit",
]);

export function isWritingToolName(name: unknown): boolean {
  return typeof name === "string" && WRITING_TOOL_NAMES.has(name);
}

export interface WritingStyleGateInput {
  prompt: string;
  context?: {
    selectedText?: string | null | undefined;
    activeDocument?: { roomId?: string | null | undefined } | null | undefined;
  } | null | undefined;
}

export function shouldInjectGenerationWritingStyle(
  input: WritingStyleGateInput,
  sessionUsedWritingTools: boolean,
): boolean {
  if (sessionUsedWritingTools) return true;
  const context = input.context;
  if (context?.selectedText?.trim()) return true;
  if (context?.activeDocument?.roomId?.trim()) return true;
  return requestsWorkspaceDocument(input.prompt ?? "");
}
