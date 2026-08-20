import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Clock3, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { useLocale } from '../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../types';
import { roomKindIcon, roomKindTone } from './utils';

export function RoomCard({
  room,
  onOpen,
  onRename,
  onDelete,
}: {
  room: ContextRoomRecord;
  onOpen: (roomId: string) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useLocale();
  const Icon = roomKindIcon(room.kind);

  return (
    <article className="context-room-home-card context-room-my-card">
      <button
        type="button"
        aria-label={t('打开 Context Room「{title}」', { title: room.title })}
        className="context-room-card-open"
        onClick={() => onOpen(room.id)}
      >
        <span className="context-room-home-card-icon" data-icon-tone={roomKindTone(room.kind)}>
          <Icon aria-hidden="true" strokeWidth={1.8} />
        </span>
        <span className="context-room-home-card-body">
          <strong>
            {room.title}
            {room.origin === 'auto' ? (
              <span className="context-room-home-card-origin" title={t('资料归类时自动创建，打开即认领')}>
                {t('自动创建')}
              </span>
            ) : null}
          </strong>
          <span className="context-room-home-card-brief">{room.brief.background}</span>
          <span className="context-room-home-card-time">
            <Clock3 aria-hidden="true" />
            {room.lastViewed}
          </span>
        </span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="context-room-card-menu-button"
            aria-label={t('{title} 更多操作', { title: room.title })}
            title={t('更多操作')}
          >
            <MoreVertical aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="context-room-card-menu" sideOffset={6} align="end">
            <DropdownMenu.Item onSelect={onRename}>
              <Pencil aria-hidden="true" />
              {t('重命名')}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="danger" onSelect={onDelete}>
              <Trash2 aria-hidden="true" />
              {t('删除')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </article>
  );
}
