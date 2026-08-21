import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Clock3, MoreVertical, Pencil, Trash2 } from 'lucide-react';
import { useLocale } from '../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../types';
import { localizedRoomSummary } from '../adapters';
import { useRoomUpdatedTime } from '../roomUpdatedTime';
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
  const updatedTime = useRoomUpdatedTime(room);

  return (
    <article className="context-room-home-card context-room-my-card">
      <button
        type="button"
        aria-label={t('contextRoom:roomCard.openContextRoomTitle', { title: room.title })}
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
              <span className="context-room-home-card-origin" title={t('contextRoom:roomCard.createdAutomaticallyDuringClassificationOpenToClaimIt')}>
                {t('contextRoom:roomCard.autoCreated')}
              </span>
            ) : null}
          </strong>
          <span className="context-room-home-card-brief">{localizedRoomSummary(room.brief.background, room.generatedContext?.overview, t)}</span>
          <span className="context-room-home-card-time">
            <Clock3 aria-hidden="true" />
            {updatedTime}
          </span>
        </span>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="context-room-card-menu-button"
            aria-label={t('contextRoom:roomCard.moreActionsForTitle', { title: room.title })}
            title={t('contextRoom:roomCard.moreActions')}
          >
            <MoreVertical aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="context-room-card-menu" sideOffset={6} align="end">
            <DropdownMenu.Item onSelect={onRename}>
              <Pencil aria-hidden="true" />
              {t('contextRoom:roomCard.rename')}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="danger" onSelect={onDelete}>
              <Trash2 aria-hidden="true" />
              {t('contextRoom:roomCard.delete')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </article>
  );
}
