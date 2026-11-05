import type { OfficeFile } from '@/office-proto/data'

/**
 * 「Agent 产物就绪 → 自动展示」的窗口事件（Workbench 派发，WorkspaceTabHost 消费）。
 *
 * 为什么走窗口事件而不是 store：气泡窗状态机（useWorkspaceBubble）是组件级、
 * 每个工作空间标签一份，store 放不下；已有的 everroom:workbench-toggle-bubble
 * 同因走同一条路。
 *
 * payload 带 tabId 定向：只有产物归属的工作空间标签响应，别的标签不动。
 */
export const OPEN_AGENT_FILE_EVENT = 'everroom:open-agent-file'

export interface OpenAgentFileDetail {
  /** 目标工作空间标签 id（事件只应被该标签消费）。 */
  tabId: string
  /** 归属工作空间 id（校验用；与 tabId 一一对应）。 */
  workspaceId: string
  /** 已转换好的文件对象（realCatalog 形态，气泡窗直接开编辑器）。 */
  file: OfficeFile
}

export function dispatchOpenAgentFile(detail: OpenAgentFileDetail): void {
  window.dispatchEvent(new CustomEvent<OpenAgentFileDetail>(OPEN_AGENT_FILE_EVENT, { detail }))
}

export function isWorkspaceBubbleTarget(
  detail: OpenAgentFileDetail,
  tabId: string,
): boolean {
  return detail.tabId === tabId
}
