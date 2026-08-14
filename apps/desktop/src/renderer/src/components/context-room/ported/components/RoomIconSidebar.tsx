import {
  BarChart3,
  Bookmark,
  CalendarDays,
  CheckSquare2,
  FileText,
  Mail,
  Share2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type DetailPane =
  | 'overview'
  | 'documents'
  | 'relations'
  | 'memories'
  | 'schedule'
  | 'tasks'
  | 'mails';

export const DETAIL_TABS = [
  { id: 'overview', label: '概览', icon: BarChart3, tone: 'room' },
  { id: 'documents', label: '文档', icon: FileText, tone: 'document' },
  { id: 'relations', label: '关系', icon: Share2, tone: 'data' },
  { id: 'memories', label: '记忆', icon: Bookmark, tone: 'memory' },
  { id: 'schedule', label: '日程', icon: CalendarDays, tone: 'calendar' },
  { id: 'tasks', label: '任务', icon: CheckSquare2, tone: 'task' },
  { id: 'mails', label: '邮件', icon: Mail, tone: 'communication' },
] as const;

export function RoomIconSidebar({
  activePane,
  onSelectPane,
  footerAction,
}: {
  activePane: DetailPane;
  onSelectPane: (pane: DetailPane) => void;
  footerAction?: {
    label: string;
    icon: LucideIcon;
    onSelect: () => void;
  };
}) {
  return (
    <nav className="context-room-workspace-tabs" aria-label="Context room detail">
      {DETAIL_TABS.map(({ id, label, icon: Icon, tone }) => (
        <button
          key={id}
          type="button"
          data-pane-id={id}
          data-icon-tone={tone}
          aria-label={label}
          aria-pressed={activePane === id}
          title={label}
          onClick={() => onSelectPane(id)}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
      {footerAction ? (
        <button
          type="button"
          className="context-room-workspace-tabs-footer"
          aria-label={footerAction.label}
          title={footerAction.label}
          onClick={footerAction.onSelect}
        >
          <footerAction.icon aria-hidden="true" />
        </button>
      ) : null}
    </nav>
  );
}
