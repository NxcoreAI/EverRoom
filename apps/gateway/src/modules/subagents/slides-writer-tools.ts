import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";

import { SLIDES_TOOL_NAMES } from "../documents/capabilities/office-plugin.js";

/**
 * slides-writer 的工具面：PPT 四件套（创建/逐页填充/读/编辑）+ doc-writer 同款
 * 素材自取只读面。**拒绝**写入类（write/patch）、调度类（agent_dispatch/
 * agent_catalog——防子 Agent 自递归）、通知类。策略集中在 allowlist，装配方传什么都先过滤再合并。
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
  ...SLIDES_TOOL_NAMES,
]);

const WEB_SEARCH_TOOL_ALLOWLIST = new Set(["web_search"]);

function filterTools(
  tools: PiAgentRuntimeTool[],
  allowlist: Set<string>,
): PiAgentRuntimeTool[] {
  return tools.filter((tool) => allowlist.has(tool.name));
}

export function createSlidesWriterAgentTools(deps: {
  /** createContextRoomAgentTools 的产物（记忆/会话/Room 上下文）。 */
  roomTools: PiAgentRuntimeTool[];
  /** createDocumentPiTools 的产物（PPT 四件套 + 文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
  /** createWebSearchPiTools 的产物（未配置时传空数组）。 */
  webSearchTools: PiAgentRuntimeTool[];
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.roomTools, ROOM_TOOL_ALLOWLIST),
    ...filterTools(deps.documentTools, DOCUMENT_TOOL_ALLOWLIST),
    ...filterTools(deps.webSearchTools, WEB_SEARCH_TOOL_ALLOWLIST),
  ];
}
