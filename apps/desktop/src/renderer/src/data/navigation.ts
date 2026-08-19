import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  BookOpenText,
  Brain,
  FileText,
  FolderOpen,
  FolderSync,
  Home,
  ListChecks,
  AudioLines,
  NotebookPen,
  Settings,
} from 'lucide-react'

export type PageId =
  | 'home'
  | 'rooms'
  | 'docs'
  | 'recording'
  | 'sources'
  | 'files'
  | 'memory'
  | 'wiki'
  | 'tasks'
  | 'diary'
  | 'settings'
  | 'connector-debug'

export interface NavigationItem {
  id: PageId
  label: string
  icon: LucideIcon
  tone: 'blue' | 'cyan' | 'green' | 'indigo' | 'orange' | 'slate'
}

export interface NavigationSection {
  id: string
  label: string
  items: NavigationItem[]
}

export const navigationSections: NavigationSection[] = [
  {
    id: 'core',
    label: '核心工作',
    items: [
      { id: 'home', label: '首页', icon: Home, tone: 'slate' },
      { id: 'rooms', label: 'Context Room', icon: BookOpen, tone: 'blue' },
      { id: 'docs', label: '文档', icon: FileText, tone: 'indigo' },
      { id: 'recording', label: '智能感知', icon: AudioLines, tone: 'cyan' },
    ],
  },
  {
    id: 'context',
    label: '上下文',
    items: [
      { id: 'sources', label: '数据源', icon: FolderSync, tone: 'cyan' },
      { id: 'files', label: '文件', icon: FolderOpen, tone: 'green' },
      { id: 'memory', label: '记忆', icon: Brain, tone: 'orange' },
      { id: 'wiki', label: 'Wiki', icon: BookOpenText, tone: 'indigo' },
    ],
  },
  {
    id: 'execution',
    label: '执行',
    items: [{ id: 'tasks', label: '任务', icon: ListChecks, tone: 'green' }],
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { id: 'diary', label: '日记', icon: NotebookPen, tone: 'blue' },
      { id: 'settings', label: '设置', icon: Settings, tone: 'slate' },
    ],
  },
]

export const pageLabels: Record<PageId, string> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.label]))
) as Record<PageId, string>
pageLabels['connector-debug'] = '连接器调试'

export const pageIcons: Record<PageId, LucideIcon> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.icon]))
) as Record<PageId, LucideIcon>
