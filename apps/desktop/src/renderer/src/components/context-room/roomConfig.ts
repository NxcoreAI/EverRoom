import {
  BarChart3,
  Bookmark,
  BookOpen,
  CalendarDays,
  CheckSquare2,
  FileText,
  Flag,
  Mail,
  MessageSquare,
  Share2,
  Target,
  UserRound,
  Zap,
  type LucideIcon,
} from 'lucide-react'

import type { RoomKind, RoomPane } from './types'

export type ContextIconTone =
  | 'ai'
  | 'calendar'
  | 'communication'
  | 'data'
  | 'document'
  | 'memory'
  | 'people'
  | 'room'
  | 'task'

export const ROOM_KINDS: RoomKind[] = ['项目', '主题', '人物', '长期目标', '议题', '事件']

export const ROOM_KIND_CONFIG: Record<RoomKind, { icon: LucideIcon; tone: ContextIconTone }> = {
  项目: { icon: Target, tone: 'room' },
  主题: { icon: BookOpen, tone: 'document' },
  人物: { icon: UserRound, tone: 'people' },
  长期目标: { icon: Flag, tone: 'memory' },
  议题: { icon: MessageSquare, tone: 'ai' },
  事件: { icon: Zap, tone: 'calendar' },
}

export const PANE_ITEMS: Array<{
  id: RoomPane
  label: string
  icon: LucideIcon
  tone: ContextIconTone
}> = [
  { id: 'overview', label: '概览', icon: BarChart3, tone: 'room' },
  { id: 'documents', label: '云文档', icon: FileText, tone: 'document' },
  { id: 'relations', label: '关系', icon: Share2, tone: 'data' },
  { id: 'memories', label: '记忆', icon: Bookmark, tone: 'memory' },
  { id: 'schedule', label: '日程', icon: CalendarDays, tone: 'calendar' },
  { id: 'tasks', label: '任务', icon: CheckSquare2, tone: 'task' },
  { id: 'mails', label: '邮件', icon: Mail, tone: 'communication' },
]
