import type { AgentSession, AgentWorkspace } from '@nxcore/agent-contract'

import type { OfficeFile } from '@/office-proto/data'

/* ───────────────── 主页标签 ───────────────── */

/** 主页侧栏的一级入口（只保留有真实数据能力的页面；知识库后端已移除，不迁移）。 */
export type HomePageKey = 'recent' | 'spaces' | 'files' | 'agent' | 'connectors' | 'settings'

export const HOME_PAGES: ReadonlyArray<{ key: HomePageKey; label: string }> = [
  { key: 'recent', label: '最近' },
  { key: 'spaces', label: '项目空间' },
  { key: 'files', label: '所有文件' },
  { key: 'agent', label: 'Agent' },
  { key: 'connectors', label: '连接器' },
  { key: 'settings', label: '设置' },
]

/* ───────────────── 工作空间标签 ───────────────── */

/** 工作空间侧栏的功能菜单（「新建工作」是即开的会话，不是页面）。 */
export type WorkspacePageKey = 'overview' | 'library' | 'outputs' | 'plan'

export const WORKSPACE_PAGES: ReadonlyArray<{ key: WorkspacePageKey; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'library', label: '资料库' },
  { key: 'outputs', label: '产物' },
  { key: 'plan', label: '计划' },
]

/**
 * 工作空间标签内的视图：
 * - page：功能页（概览/资料库/产物/计划）
 * - session：某个工作会话（= 一个 AgentSession）
 * - draft：新建工作草稿；首条消息发出后落成会话，视图切到 session
 */
export type WorkspaceTabView =
  | { kind: 'page'; page: WorkspacePageKey }
  | { kind: 'session'; sessionId: string }
  | { kind: 'draft' }

export const DEFAULT_WORKSPACE_VIEW: WorkspaceTabView = { kind: 'page', page: 'overview' }

/* ───────────────── 窗口级标签 ───────────────── */

export interface HomeTab {
  id: 'home'
  kind: 'home'
  /** 主页标签记住上次停留的页面（标签间切换不丢）。 */
  page: HomePageKey
}

export interface WorkspaceTab {
  id: string
  kind: 'workspace'
  workspaceId: string
  /** 空间必须存在才会被渲染（启动恢复时会校验）。 */
  view: WorkspaceTabView
}

export interface FileTab {
  id: string
  kind: 'file'
  file: OfficeFile
}

export type WindowTab = HomeTab | WorkspaceTab | FileTab

export const HOME_TAB_ID = 'home' as const
export const HOME_TAB: HomeTab = { id: HOME_TAB_ID, kind: 'home', page: 'recent' }

export const workspaceTabId = (workspaceId: string): string => `ws:${workspaceId}`
export const fileTabId = (fileId: string): string => `file:${fileId}`

/** 标签标题：主页固定、工作空间显示空间名、文件显示文件名。 */
export function tabTitle(tab: WindowTab, workspaces: readonly AgentWorkspace[]): string {
  if (tab.kind === 'home') return '主页'
  if (tab.kind === 'file') return tab.file.name
  return workspaces.find((workspace) => workspace.id === tab.workspaceId)?.name ?? '工作空间'
}

/** 标签图标语义（TabBar 只做渲染，不引具体 icon 组件）。 */
export type TabIconKind = 'home' | 'workspace' | 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md'

export function tabIconKind(tab: WindowTab): TabIconKind {
  if (tab.kind === 'home') return 'home'
  if (tab.kind === 'workspace') return 'workspace'
  return tab.file.kind
}

/* ───────────────── 工作会话（= AgentSession） ───────────────── */

export type WorkSessionStatus = 'running' | 'idle' | 'done'

export const WORK_SESSION_STATUS_META: Record<WorkSessionStatus, { label: string }> = {
  running: { label: '进行中' },
  idle: { label: '待开始' },
  done: { label: '已结束' },
}

/** 看板/工作列表共用的状态归一：interrupted 也归入已结束（可点开继续对话）。 */
export function workSessionStatus(session: AgentSession): WorkSessionStatus {
  if (session.status === 'running') return 'running'
  if (session.status === 'closed' || session.status === 'interrupted') return 'done'
  return 'idle'
}

/** 侧栏会话排序：运行中优先，然后按更新时间倒序。 */
export function sortWorkbenchSessions(sessions: readonly AgentSession[]): AgentSession[] {
  return [...sessions].sort((left, right) => {
    const leftRunning = left.status === 'running' ? 1 : 0
    const rightRunning = right.status === 'running' ? 1 : 0
    if (leftRunning !== rightRunning) return rightRunning - leftRunning
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  })
}

export function sessionsOfWorkspace(
  sessions: readonly AgentSession[],
  workspaceId: string | null,
): AgentSession[] {
  if (!workspaceId) return []
  return sortWorkbenchSessions(sessions.filter((session) => session.workspaceId === workspaceId))
}

export function runningSessionCount(
  sessions: readonly AgentSession[],
  workspaceId: string | null,
): number {
  if (!workspaceId) return 0
  return sessions.filter((session) => session.workspaceId === workspaceId && session.status === 'running').length
}

/** 会话显示标题：未命名会话用于草稿态的占位。 */
export function sessionDisplayTitle(session: AgentSession | null | undefined): string {
  const title = session?.title?.trim()
  if (title) return title
  return '新工作'
}

/** 相对时间：侧栏、概览动态、列表共用（刚刚 / 5 分钟 / 2 小时 / 昨天 / 10月20日）。 */
export function relativeTimeLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const delta = Date.now() - time
  if (delta < 60_000) return '刚刚'
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 48 * 60 * 60_000) return '昨天'
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** 「MM/DD」短日期（概览 meta 行的开始日）。 */
export function shortDateLabel(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getMonth() + 1}/${date.getDate()}`
}

/* ───────────────── 标签持久化 ───────────────── */

export interface PersistedWorkspaceTab {
  workspaceId: string
}

export const TABS_STORAGE_KEY = 'everroom:workbench:tabs:v1'

/** 只持久化「打开过的工作空间」与激活标签；文件标签不恢复（文件可能已删除/移动）。 */
export interface PersistedTabsState {
  workspaceIds: string[]
  activeTabId: string | null
}

export function readPersistedTabs(): PersistedTabsState {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY)
    if (!raw) return { workspaceIds: [], activeTabId: null }
    const parsed = JSON.parse(raw) as Partial<PersistedTabsState>
    return {
      workspaceIds: Array.isArray(parsed.workspaceIds)
        ? parsed.workspaceIds.filter((value): value is string => typeof value === 'string')
        : [],
      activeTabId: typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null,
    }
  } catch {
    return { workspaceIds: [], activeTabId: null }
  }
}

export function writePersistedTabs(state: PersistedTabsState): void {
  try {
    localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // localStorage 不可用时仅本次会话生效。
  }
}
