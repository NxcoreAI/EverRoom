import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  Brain,
  FileText,
  FolderSync,
  Home,
  ListChecks,
  Mic,
  Settings,
} from 'lucide-react'

export type PageId = 'home' | 'rooms' | 'docs' | 'recording' | 'sources' | 'memory' | 'tasks' | 'settings'

export interface NavigationItem {
  id: PageId
  label: string
  icon: LucideIcon
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
      { id: 'home', label: '首页', icon: Home },
      { id: 'rooms', label: 'Context Room', icon: BookOpen },
      { id: 'docs', label: '文档', icon: FileText },
      { id: 'recording', label: '录音转写', icon: Mic },
    ],
  },
  {
    id: 'context',
    label: '上下文',
    items: [
      { id: 'sources', label: '数据源', icon: FolderSync },
      { id: 'memory', label: '记忆', icon: Brain },
    ],
  },
  {
    id: 'execution',
    label: '执行',
    items: [{ id: 'tasks', label: '任务', icon: ListChecks }],
  },
  {
    id: 'system',
    label: '系统',
    items: [{ id: 'settings', label: '设置', icon: Settings }],
  },
]

export const pageLabels: Record<PageId, string> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.label]))
) as Record<PageId, string>

export const pageIcons: Record<PageId, LucideIcon> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.icon]))
) as Record<PageId, LucideIcon>
