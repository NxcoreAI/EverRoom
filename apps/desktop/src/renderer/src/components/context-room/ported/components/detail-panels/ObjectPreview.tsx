import { CheckSquare2, ChevronRight, Mail, Mic } from 'lucide-react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { localizedUiText, uiText } from '../../adapters';
import { roomKindIcon, roomKindTone } from '../utils';

function EmptyState({ children }: { children: string }) {
  return <div className="context-room-workspace-empty">{children}</div>;
}

export type WorkspaceObjectPreview =
  | { kind: 'task'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'meeting'; id: string }
  | { kind: 'related-room'; id: string };

export function ObjectPreview({
  room,
  rooms,
  selection,
  onOpenRoom,
}: {
  room: ContextRoomRecord;
  rooms: ContextRoomRecord[];
  selection: WorkspaceObjectPreview;
  onOpenRoom: (roomId: string) => void;
}) {
  const { locale, t } = useLocale();
  if (selection.kind === 'related-room') {
    const relatedRoom = rooms.find((item) => item.id === selection.id);
    if (!relatedRoom) return <EmptyState>{t('contextRoom:objectPreview.relatedRoomNotFound')}</EmptyState>;
    const people = new Set(room.people.map((person) => person.name));
    const sharedPeople = relatedRoom.people.filter((person) => people.has(person.name));
    const Icon = roomKindIcon(relatedRoom.kind);
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header data-icon-tone={roomKindTone(relatedRoom.kind)}>
          <Icon aria-hidden="true" />
          <div>
            <span>{t('contextRoom:objectPreview.relatedRoom')}</span>
            <h1>{relatedRoom.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.relationshipBasis')}</dt>
            <dd>
              {sharedPeople.length
                ? t('contextRoom:objectPreview.sharedPeoplePeople', { people: sharedPeople.map((person) => person.name).join(locale === 'zh-CN' ? '、' : ', ') })
                : t('contextRoom:objectPreview.bothAreKindRooms', { kind: t(uiText(room.kind)) })}
            </dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.currentStatus')}</dt>
            <dd>{t(uiText(relatedRoom.status))}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.resourceScope')}</dt>
            <dd>{t('contextRoom:objectPreview.countItems', { count: relatedRoom.materials.length + relatedRoom.fileItems.length })}</dd>
          </div>
        </dl>
        <button
          type="button"
          className="context-room-primary context-room-object-preview-action"
          onClick={() => onOpenRoom(relatedRoom.id)}
        >
          {t('contextRoom:objectPreview.openRoom')}
          <ChevronRight aria-hidden="true" />
        </button>
      </article>
    );
  }

  if (selection.kind === 'task') {
    const task = room.actionItems.find((item) => item.id === selection.id);
    if (!task) return <EmptyState>{t('contextRoom:objectPreview.taskNotFoundOrDoesNotBelongTo')}</EmptyState>;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header>
          <CheckSquare2 aria-hidden="true" />
          <div>
            <span>{t('contextRoom:objectPreview.taskDetails')}</span>
            <h1>{task.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.status')}</dt>
            <dd>{t(uiText(task.status))}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.owner')}</dt>
            <dd>{t(uiText(task.owner))}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.dueDate')}</dt>
            <dd>{t(uiText(task.deadline))}</dd>
          </div>
        </dl>
      </article>
    );
  }

  if (selection.kind === 'meeting') {
    const meeting = room.materials.find((item) => item.id === selection.id && item.type === '会议');
    if (!meeting) return <EmptyState>{t('contextRoom:objectPreview.meetingNotFoundOrDoesNotBelongTo')}</EmptyState>;
    return (
      <article className="context-room-object-preview" data-testid="context-room-object-preview">
        <header data-icon-tone="calendar">
          <Mic aria-hidden="true" />
          <div>
            <span>{t('contextRoom:objectPreview.meetingDetails')}</span>
            <h1>{meeting.title}</h1>
          </div>
        </header>
        <dl>
          <div>
            <dt>{t('contextRoom:objectPreview.time')}</dt>
            <dd>{meeting.time}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.attendees')}</dt>
            <dd>{meeting.attendees?.join(locale === 'zh-CN' ? '、' : ', ') || t('contextRoom:objectPreview.notRecorded')}</dd>
          </div>
          <div>
            <dt>{t('contextRoom:objectPreview.meetingNotes')}</dt>
            <dd>{localizedUiText(meeting.summary, t)}</dd>
          </div>
        </dl>
      </article>
    );
  }

  const mail = room.materials.find((item) => item.id === selection.id && item.type === '邮件');
  if (!mail) return <EmptyState>{t('contextRoom:objectPreview.emailNotFoundOrDoesNotBelongTo')}</EmptyState>;
  return (
    <article className="context-room-object-preview" data-testid="context-room-object-preview">
      <header>
        <Mail aria-hidden="true" />
        <div>
          <span>{t('contextRoom:objectPreview.emailPreview')}</span>
          <h1>{mail.title}</h1>
        </div>
      </header>
      <dl>
        <div>
          <dt>{t('contextRoom:objectPreview.updated')}</dt>
          <dd>{mail.time}</dd>
        </div>
        <div>
          <dt>{t('contextRoom:objectPreview.emailBody')}</dt>
          <dd>{localizedUiText(mail.summary, t)}</dd>
        </div>
      </dl>
    </article>
  );
}
