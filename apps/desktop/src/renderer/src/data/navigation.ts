import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  Brain,
  FileText,
  FolderSync,
  Home,
  ListChecks,
  Settings,
} from 'lucide-react'

export type PageId = 'home' | 'rooms' | 'docs' | 'sources' | 'memory' | 'tasks' | 'settings'

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
    ],
  },
  {
    id: 'context',
    label: '上下文',
    items: [
      { id: 'sources', label: '数据源', icon: FolderSync, tone: 'cyan' },
      { id: 'memory', label: '记忆', icon: Brain, tone: 'orange' },
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
    items: [{ id: 'settings', label: '设置', icon: Settings, tone: 'slate' }],
  },
]

export const pageLabels: Record<PageId, string> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.label]))
) as Record<PageId, string>

export const pageIcons: Record<PageId, LucideIcon> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.icon]))
) as Record<PageId, LucideIcon>
