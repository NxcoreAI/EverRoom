import type { LucideIcon } from 'lucide-react'
import {
  BookOpen,
  BookOpenText,
  Brain,
  Building2,
  FileText,
  FolderOpen,
  FolderSync,
  Home,
  AudioLines,
  NotebookPen,
  ListTodo,
  Lightbulb,
  PlugZap,
  Settings,
  FilePenLine,
} from 'lucide-react'
import type { DesktopPageMode } from '../../../shared/page-mode'

export type PageId = 'home' | 'office' | 'office-document' | 'office-test' | 'rooms' | 'docs' | 'recording' | 'sources' | 'files' | 'inspiration' | 'memory' | 'wiki' | 'connectors' | 'diary' | 'schedules' | 'settings'

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
      { id: 'inspiration', label: 'surface:navigation.inspiration', icon: Lightbulb, tone: 'orange' },
      { id: 'memory', label: 'surface:navigation.memory', icon: Brain, tone: 'orange' },
      { id: 'wiki', label: 'surface:navigation.wiki', icon: BookOpenText, tone: 'indigo' },
      { id: 'connectors', label: 'surface:navigation.connectors', icon: PlugZap, tone: 'green' },
    ],
  },
  {
    id: 'execution',
    label: 'surface:navigation.execution',
    items: [
      { id: 'office', label: 'surface:navigation.office', icon: Building2, tone: 'blue' },
      { id: 'diary', label: 'surface:navigation.diary', icon: NotebookPen, tone: 'blue' },
      { id: 'schedules', label: 'surface:navigation.schedules', icon: ListTodo, tone: 'orange' },
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

const officeTestItem: NavigationItem = {
  id: 'office-test',
  label: 'surface:navigation.officeTest',
  icon: FilePenLine,
  tone: 'indigo',
}

const officeDocumentItem: NavigationItem = {
  id: 'office-document',
  label: 'surface:navigation.officeDocument',
  icon: FilePenLine,
  tone: 'indigo',
}

export function navigationSectionsForMode(
  mode: DesktopPageMode,
  includeOfficeTest = false,
): NavigationSection[] {
  const disabledPage: PageId = mode === 'sources' ? 'connectors' : 'sources'
  return navigationSections
    .map((section) => ({
      ...section,
      items: [
        ...section.items.filter((item) => item.id !== disabledPage),
        ...(includeOfficeTest && section.id === 'execution' ? [officeTestItem] : []),
      ],
    }))
    .filter((section) => section.items.length > 0)
}

export const pageLabels: Record<PageId, string> = Object.fromEntries(
  [...navigationSections.flatMap((section) => section.items), officeTestItem, officeDocumentItem]
    .map((item) => [item.id, item.label])
) as Record<PageId, string>

export const pageIcons: Record<PageId, LucideIcon> = Object.fromEntries(
  [...navigationSections.flatMap((section) => section.items), officeTestItem, officeDocumentItem]
    .map((item) => [item.id, item.icon])
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
  '灵感': 'surface:navigation.inspiration',
  'Inspiration': 'surface:navigation.inspiration',
  '记忆': 'surface:navigation.memory',
  'Memory': 'surface:navigation.memory',
  'Wiki': 'surface:navigation.wiki',
  '连接器': 'surface:navigation.connectors',
  'Connectors': 'surface:navigation.connectors',
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
