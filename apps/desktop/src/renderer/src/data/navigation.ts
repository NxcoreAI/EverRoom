import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  BookOpenText,
  Brain,
  FileText,
  FolderOpen,
  FolderSync,
  Home,
  AudioLines,
  NotebookPen,
  PlugZap,
  Settings,
} from 'lucide-react'

export type PageId = 'home' | 'rooms' | 'docs' | 'recording' | 'sources' | 'files' | 'memory' | 'wiki' | 'connectors' | 'diary' | 'settings'

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
    label: 'surface:navigation.coreWork',
    items: [
      { id: 'home', label: 'surface:navigation.home', icon: Home, tone: 'slate' },
      { id: 'rooms', label: 'surface:navigation.contextRoom', icon: BookOpen, tone: 'blue' },
      { id: 'docs', label: 'surface:navigation.documents', icon: FileText, tone: 'indigo' },
      { id: 'recording', label: 'surface:navigation.realityPerception', icon: AudioLines, tone: 'cyan' },
    ],
  },
  {
    id: 'context',
    label: 'surface:navigation.context',
    items: [
      { id: 'sources', label: 'surface:navigation.sources', icon: FolderSync, tone: 'cyan' },
      { id: 'files', label: 'surface:navigation.files', icon: FolderOpen, tone: 'green' },
      { id: 'memory', label: 'surface:navigation.memory', icon: Brain, tone: 'orange' },
      { id: 'wiki', label: 'surface:navigation.wiki', icon: BookOpenText, tone: 'indigo' },
      { id: 'connectors', label: 'surface:navigation.connectors', icon: PlugZap, tone: 'green' },
    ],
  },
  {
    id: 'execution',
    label: 'surface:navigation.execution',
    items: [
      { id: 'diary', label: 'surface:navigation.diary', icon: NotebookPen, tone: 'blue' },
    ],
  },
  {
    id: 'system',
    label: 'surface:navigation.system',
    items: [
      { id: 'settings', label: 'surface:navigation.settings', icon: Settings, tone: 'slate' },
    ],
  },
]

export const pageLabels: Record<PageId, string> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.label]))
) as Record<PageId, string>

export const pageIcons: Record<PageId, LucideIcon> = Object.fromEntries(
  navigationSections.flatMap((section) => section.items.map((item) => [item.id, item.icon]))
) as Record<PageId, LucideIcon>

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
  '记忆': 'surface:navigation.memory',
  'Memory': 'surface:navigation.memory',
  'Wiki': 'surface:navigation.wiki',
  '连接器': 'surface:navigation.connectors',
  'Connectors': 'surface:navigation.connectors',
  '日记': 'surface:navigation.diary',
  'Diary': 'surface:navigation.diary',
  '设置': 'surface:navigation.settings',
  'Settings': 'surface:navigation.settings',
}

export function pageLabelKey(value: string): string {
  return LEGACY_PAGE_LABEL_KEYS[value] ?? value
}
