import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";

/**
 * doc-writer 的研究工具面（用户决策：与主 Agent 同等的工具使用）。
 * 收录检索/读取/分析类工具；**拒绝**写入类（write/patch/纠正/待办日程创建）、
 * 调度类（agent_dispatch/agent_catalog——防子 Agent 自递归与池自锁）、
 * 通知类。策略集中在两个 allowlist，装配方传什么都先过滤再合并。
 */
const ROOM_TOOL_ALLOWLIST = new Set([
  "memory_search",
  "conversation_search",
  "room_context_get",
]);

const DOCUMENT_TOOL_ALLOWLIST = new Set([
  "context_room_list",
  "context_room_document_list",
  "context_room_document_read",
]);

const ANALYSIS_TOOL_ALLOWLIST = new Set([
  "content_analysis",
  "room_analysis",
]);

const WEB_SEARCH_TOOL_ALLOWLIST = new Set(["web_search"]);

function filterTools(
  tools: PiAgentRuntimeTool[],
  allowlist: Set<string>,
): PiAgentRuntimeTool[] {
  return tools.filter((tool) => allowlist.has(tool.name));
}

export function createDocWriterAgentTools(deps: {
  /** createContextRoomAgentTools 的产物（记忆/会话/Room 上下文）。 */
  roomTools: PiAgentRuntimeTool[];
  /** createDocumentPiTools 的产物（文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
  /** createSubagentPiTools 的产物（分析类；agent_dispatch 等被剔除）。 */
  analysisTools: PiAgentRuntimeTool[];
  /** createWebSearchPiTools 的产物（未配置时传空数组）。 */
  webSearchTools: PiAgentRuntimeTool[];
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.roomTools, ROOM_TOOL_ALLOWLIST),
    ...filterTools(deps.documentTools, DOCUMENT_TOOL_ALLOWLIST),
    ...filterTools(deps.analysisTools, ANALYSIS_TOOL_ALLOWLIST),
    ...filterTools(deps.webSearchTools, WEB_SEARCH_TOOL_ALLOWLIST),
  ];
}
