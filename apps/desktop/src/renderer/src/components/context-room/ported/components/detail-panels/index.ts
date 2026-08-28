export { MemoryPane } from './MemoryPane'
export { RelationsPane } from './RelationsPane'
export { MailsPane, SchedulePane, TasksPane } from './ActivityPanes'
/** 面板内详情子视图的选中对象：任务/会议/邮件各有归属面板，文档始终占右侧内容区。 */
export type WorkspaceObjectPreview =
  | { kind: 'task'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'meeting'; id: string };
export { OverviewDashboard } from './OverviewDashboard'
export { WikiPane } from './WikiPane'
