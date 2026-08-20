import {
  BarChart3,
  BookOpen,
  Bookmark,
  CalendarDays,
  CheckSquare2,
  FileText,
  Mail,
  Share2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLocale } from '../../../../i18n/LocaleContext';

export type DetailPane =
  | 'overview'
  | 'documents'
  | 'relations'
  | 'memories'
  | 'wiki'
  | 'schedule'
  | 'tasks'
  | 'mails';

export const DETAIL_TABS = [
  { id: 'overview', label: 'contextRoom:roomSidebar.overview', icon: BarChart3, tone: 'room' },
  { id: 'documents', label: 'contextRoom:roomSidebar.documents', icon: FileText, tone: 'document' },
  { id: 'relations', label: 'contextRoom:roomSidebar.relations', icon: Share2, tone: 'data' },
  { id: 'memories', label: 'contextRoom:roomSidebar.memories', icon: Bookmark, tone: 'memory' },
  { id: 'wiki', label: 'contextRoom:roomSidebar.wiki', icon: BookOpen, tone: 'data' },
  { id: 'schedule', label: 'contextRoom:roomSidebar.schedule', icon: CalendarDays, tone: 'calendar' },
  { id: 'tasks', label: 'contextRoom:roomSidebar.tasks', icon: CheckSquare2, tone: 'task' },
  { id: 'mails', label: 'contextRoom:roomSidebar.mail', icon: Mail, tone: 'communication' },
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
  const { t } = useLocale();
  return (
    <nav className="context-room-workspace-tabs" aria-label={t('contextRoom:roomSidebar.contextRoomDetail')}>
      {DETAIL_TABS.map(({ id, label, icon: Icon, tone }) => (
        <button
          key={id}
          type="button"
          data-pane-id={id}
          data-icon-tone={tone}
          aria-label={t(label)}
          aria-pressed={activePane === id}
          title={t(label)}
          onClick={() => onSelectPane(id)}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
      {footerAction ? (
        <button
          type="button"
          className="context-room-workspace-tabs-footer"
          aria-label={t(footerAction.label)}
          title={t(footerAction.label)}
          onClick={footerAction.onSelect}
        >
          <footerAction.icon aria-hidden="true" />
        </button>
      ) : null}
    </nav>
  );
}
