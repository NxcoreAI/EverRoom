import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import type { OfficeFile } from '@/office-proto/data'

import type { WorkspacePageKey, WorkspaceTab } from '../types'

/**
 * 工作空间功能页的公共 props。
 *
 * 页面不直接读 store（除了各自的局部交互），由 WorkspaceTabHost 注入上下文，
 * 这样同一页面在单测里可以用假数据渲染，并行开发时也不会互相踩 store。
 */
export interface WorkspacePageProps {
  tab: WorkspaceTab
  workspace: AgentWorkspace
  /** 本空间的全部工作会话（已按运行中优先 + 更新时间排序）。 */
  sessions: AgentSession[]
  /** 切到某个工作会话（= 该会话的对话页）。 */
  onOpenSession(sessionId: string): void
  /** 在当前工作空间右侧气泡窗里打开文件。 */
  onOpenFile(file: OfficeFile): void
  /** 切到另一个功能页。 */
  onOpenPage(page: WorkspacePageKey): void
  /** 新建工作（进入草稿会话）。 */
  onNewWork(): void
  /** 轻提示。 */
  onToast(message: string): void
}
