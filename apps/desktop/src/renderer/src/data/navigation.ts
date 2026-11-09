/**
 * 旧版主导航的数据残留（2026-11 收敛）。
 *
 * workbench 改版后侧栏/页面结构由 `workbench/types.ts` 的 WORKSPACE_PAGES 与
 * HomePage 定义；本文件只剩两个仍被 Agent 链路引用的符号：
 * - `PageId`：agentNavigation 的目标页面联合类型（历史会话链接里仍可能出现旧值，
 *   故保留全量字面量，解析失败自然回退 home）。
 * - `pageLabelKey`：旧中文/英文页面名 → i18n key 的映射（历史会话的 sourcePageLabel
 *   是裸字符串，渲染时经它翻译；查不到原样返回，由调用方兜底显示）。
 */

export type PageId =
  | 'home'
  | 'office'
  | 'office-document'
  | 'rooms'
  | 'docs'
  | 'recording'
  | 'sources'
  | 'files'
  | 'inspiration'
  | 'wiki'
  | 'diary'
  | 'schedules'
  | 'agent-connections'
  | 'settings'

/** 旧版页面名（历史数据里的裸字符串）→ i18n key。 */
const LEGACY_PAGE_LABEL_KEYS: Record<string, string> = {
  '首页': 'surface:navigation.home',
  'Home': 'surface:navigation.home',
  'Context Room': 'surface:navigation.contextRoom',
  '文档': 'surface:navigation.documents',
  'Documents': 'surface:navigation.documents',
  '现实感知': 'surface:navigation.realityPerception',
  'Reality perception': 'surface:navigation.realityPerception',
  '数据源': 'surface:navigation.sources',
  'Sources': 'surface:navigation.sources',
  '文件': 'surface:navigation.files',
  'Files': 'surface:navigation.files',
  '灵感': 'surface:navigation.inspiration',
  'Inspiration': 'surface:navigation.inspiration',
  'Wiki': 'surface:navigation.wiki',
  '办公室': 'surface:navigation.office',
  'Office': 'surface:navigation.office',
  'Agent 状态': 'surface:navigation.office',
  'Agent status': 'surface:navigation.office',
  '日记': 'surface:navigation.diary',
  'Diary': 'surface:navigation.diary',
  '设置': 'surface:navigation.settings',
  'Settings': 'surface:navigation.settings',
}

export function pageLabelKey(value: string): string {
  return LEGACY_PAGE_LABEL_KEYS[value] ?? value
}
