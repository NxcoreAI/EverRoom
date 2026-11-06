import type { PiAgentRuntimeTool } from "@nxcore/agent-runtime-pi";

/**
 * doc-writer 的研究工具面（用户决策：与主 Agent 同等的工具使用）。
 * 收录读取/分析类工具；**拒绝**写入类（write/patch/纠正/待办日程创建）、
 * 调度类（agent_dispatch/agent_catalog——防子 Agent 自递归与池自锁）、
 * 通知类。策略集中在 allowlist，装配方传什么都先过滤再合并。
 */
const DOCUMENT_TOOL_ALLOWLIST = new Set([
  "document_list",
  "document_read",
]);

const ANALYSIS_TOOL_ALLOWLIST = new Set([
  "content_analysis",
]);

const WEB_SEARCH_TOOL_ALLOWLIST = new Set(["web_search"]);

function filterTools(
  tools: PiAgentRuntimeTool[],
  allowlist: Set<string>,
): PiAgentRuntimeTool[] {
  return tools.filter((tool) => allowlist.has(tool.name));
}

export function createDocWriterAgentTools(deps: {
  /** createDocumentPiTools 的产物（文档只读子集）。 */
  documentTools: PiAgentRuntimeTool[];
  /** createSubagentPiTools 的产物（分析类；agent_dispatch 等被剔除）。 */
  analysisTools: PiAgentRuntimeTool[];
  /** createWebSearchPiTools 的产物（未配置时传空数组）。 */
  webSearchTools: PiAgentRuntimeTool[];
}): PiAgentRuntimeTool[] {
  return [
    ...filterTools(deps.documentTools, DOCUMENT_TOOL_ALLOWLIST),
    ...filterTools(deps.analysisTools, ANALYSIS_TOOL_ALLOWLIST),
    ...filterTools(deps.webSearchTools, WEB_SEARCH_TOOL_ALLOWLIST),
  ];
}