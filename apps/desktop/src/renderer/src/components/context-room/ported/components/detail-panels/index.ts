export { MemoryPane } from './MemoryPane'
export { RelationsPane } from './RelationsPane'
export { SchedulePane, TasksPane } from './ActivityPanes'
export { ActivityPane } from './ActivityPane'
export { TodoPane } from './TodoPane'
export { MaterialsPane } from './MaterialsPane'
export { LinkGraphPane } from './LinkGraphPane'
/** 面板内详情子视图的选中对象：任务/会议/邮件各有归属面板，文档始终占右侧内容区。 */
export type WorkspaceObjectPreview =
  | { kind: 'task'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'meeting'; id: string }
  | { kind: 'connector-mail'; sourceId: string };
export { OverviewDashboard } from './OverviewDashboard'
export { WikiPane } from './WikiPane'
export { ThoughtsPane } from './ThoughtsPane'
