import * as Popover from '@radix-ui/react-popover';
import {
  CalendarDays,
  Check,
  CheckSquare2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Mail,
  Mic,
  Paperclip,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { localizedUiText, uiText } from '../../adapters';
import { roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';

type ScheduleView = 'day' | 'week' | 'month';
const SCHEDULE_TODAY = new Date();

function parseScheduleDate(value: string) {
  if (/^(今天|today)(?:\s|$)/iu.test(value)) return new Date(SCHEDULE_TODAY);
  if (/^(昨天|yesterday)(?:\s|$)/iu.test(value)) {
    const yesterday = new Date(SCHEDULE_TODAY);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }
  const fullDate = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (fullDate) return new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3]));
  const match = value.match(/(\d{1,2})-(\d{1,2})/);
  if (!match) return new Date(SCHEDULE_TODAY);
  return new Date(SCHEDULE_TODAY.getFullYear(), Number(match[1]) - 1, Number(match[2]));
}

function weekStart(value: Date) {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  start.setDate(start.getDate() + (start.getDay() === 0 ? -6 : 1 - start.getDay()));
  return start;
}

function localDateKey(value: Date): string {
  return `${String(value.getFullYear())}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function dateInView(date: Date, cursor: Date, view: ScheduleView) {
  if (view === 'day') return date.toDateString() === cursor.toDateString();
  if (view === 'week') {
    const start = weekStart(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return date >= start && date < end;
  }
  return date.getFullYear() === cursor.getFullYear() && date.getMonth() === cursor.getMonth();
}

export function SchedulePane({ room, onOpen }: { room: ContextRoomRecord; onOpen: (target: { kind: 'meeting' | 'task'; id: string }) => void }) {
  const { locale, t } = useLocale();
  const [view, setView] = useState<ScheduleView>('month');
  const [cursor, setCursor] = useState(new Date(SCHEDULE_TODAY));
  const scheduleItems = useMemo(() => [
    ...room.materials.filter((material) => material.type === '会议').map((meeting) => ({
      id: meeting.id, kind: 'meeting' as const, date: parseScheduleDate(meeting.time), time: meeting.time.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? '', title: meeting.title,
      subtitle: meeting.attendees?.join(locale === 'zh-CN' ? '、' : ', ') || localizedUiText(meeting.summary, t), description: localizedUiText(meeting.summary, t), location: meeting.location,
      attachments: room.fileItems.slice(0, 1).map((file) => ({ name: file.name, size: file.size })),
    })),
    ...room.actionItems.filter((task) => !task.completed && task.status !== '已完成').map((task) => ({
      id: task.id, kind: 'task' as const, date: parseScheduleDate(task.deadline), time: '', title: task.title,
      subtitle: t('contextRoom:activityPanes.ownerOwner', { owner: task.owner }), description: t('contextRoom:activityPanes.theSourceAndStatusWillSyncToThe'), location: undefined,
      attachments: [] as Array<{ name: string; size?: string }>,
    })),
  ], [locale, room, t]);
  const visibleItems = scheduleItems.filter((item) => dateInView(item.date, cursor, view));
  const groups = visibleItems.reduce<Map<string, typeof visibleItems>>((result, item) => {
    const key = localDateKey(item.date);
    result.set(key, [...(result.get(key) ?? []), item]);
    return result;
  }, new Map());
  const month = String(cursor.getMonth() + 1);
  const cursorLabel = view === 'month' ? t('contextRoom:activityPanes.monthYear', { year: cursor.getFullYear(), month }) : view === 'week' ? t('contextRoom:activityPanes.weekWeekOfMonth', { month, week: Math.ceil(cursor.getDate() / 7) }) : t('contextRoom:activityPanes.monthDay', { month, day: cursor.getDate() });
  const moveCursor = (delta: number) => setCursor((current) => { const next = new Date(current); if (view === 'month') next.setMonth(next.getMonth() + delta); else next.setDate(next.getDate() + delta * (view === 'week' ? 7 : 1)); return next; });

  return <div className="context-room-schedule-pane">
    <header><h2>{t('contextRoom:activityPanes.roomSchedule')}</h2><div>{(['day', 'week', 'month'] as const).map((item) => <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)}>{t(item === 'day' ? 'contextRoom:activityPanes.day' : item === 'week' ? 'contextRoom:activityPanes.week' : 'contextRoom:activityPanes.month')}</button>)}</div></header>
    {scheduleItems.length ? (
      <>
        <div className="context-room-schedule-date"><button type="button" aria-label={t('contextRoom:activityPanes.previousPeriod')} onClick={() => moveCursor(-1)}><ChevronLeft aria-hidden="true" /></button><span>{cursorLabel}</span><button type="button" aria-label={t('contextRoom:activityPanes.nextPeriod')} onClick={() => moveCursor(1)}><ChevronRight aria-hidden="true" /></button><button type="button" disabled={cursor.toDateString() === SCHEDULE_TODAY.toDateString()} onClick={() => setCursor(new Date(SCHEDULE_TODAY))}>{t('contextRoom:activityPanes.today')}</button></div>
        {[...groups.entries()].map(([date, items]) => <section className="context-room-schedule-group" key={date}>
          <header><span>{date === localDateKey(SCHEDULE_TODAY) ? t('contextRoom:activityPanes.today') : date}</span><b>{items.length}</b></header>
          {items.map((item) => <Popover.Root key={`${item.kind}-${item.id}`}><Popover.Trigger asChild><button type="button" className="context-room-schedule-item" data-icon-tone={item.kind === 'meeting' ? 'calendar' : 'task'}><span className="context-room-schedule-item-icon">{item.kind === 'meeting' ? <Mic aria-hidden="true" /> : <CheckSquare2 aria-hidden="true" />}</span><span><b>{item.title}</b><small>{item.subtitle}{item.location ? ` · ${item.location}` : ''}</small></span><time>{item.time}</time></button></Popover.Trigger><Popover.Portal><Popover.Content className="context-room-schedule-popover" side="right" align="start" sideOffset={8} collisionPadding={12}><header><h3>{item.title}</h3><Popover.Close aria-label={t('contextRoom:activityPanes.closeScheduleDetails')}><X aria-hidden="true" /></Popover.Close></header><p><CalendarDays aria-hidden="true" />{t(item.kind === 'meeting' ? 'contextRoom:activityPanes.meetingTime' : 'contextRoom:activityPanes.dueDate')}：{date} {item.time}</p><dl><div><dt>{t(item.kind === 'meeting' ? 'contextRoom:activityPanes.participants' : 'contextRoom:activityPanes.owner')}</dt><dd>{item.subtitle}</dd></div><div><dt>{t('contextRoom:activityPanes.description')}</dt><dd>{item.description}</dd></div></dl>{item.attachments.length ? <section className="context-room-schedule-attachments"><span>{t('contextRoom:activityPanes.attachments')}</span>{item.attachments.map((attachment) => <div key={attachment.name}><Paperclip aria-hidden="true" /><b>{attachment.name}</b><small>{attachment.size}</small></div>)}</section> : null}<Popover.Close asChild><button type="button" className="context-room-secondary" onClick={() => onOpen({ kind: item.kind, id: item.id })}>{t('contextRoom:activityPanes.openDetail', { detail: t(item.kind === 'meeting' ? 'contextRoom:activityPanes.meetingDetails' : 'contextRoom:activityPanes.taskDetails') })}</button></Popover.Close></Popover.Content></Popover.Portal></Popover.Root>)}
        </section>)}
        {!visibleItems.length ? (
          <PanelEmptyState
            icon={CalendarDays}
            title={t('contextRoom:activityPanes.noScheduleItemsInThisRange')}
            description={t('contextRoom:activityPanes.changeTheDateRangeToSeeOtherMeetings')}
          />
        ) : null}
      </>
    ) : (
      <PanelEmptyState
        icon={CalendarDays}
        title={t('contextRoom:activityPanes.noScheduleItemsYet')}
        description={t('contextRoom:activityPanes.meetingsAndIncompleteTasksInThisRoomAppear')}
      />
    )}
  </div>;
}

export function TasksPane({ room, onSelect, onToggle }: { room: ContextRoomRecord; onSelect: (id: string) => void; onToggle: (id: string) => void }) {
  const { t } = useLocale();
  const [completedOpen, setCompletedOpen] = useState(false);
  const completed = room.actionItems.filter((item) => item.completed || item.status === '已完成');
  const pending = room.actionItems.filter((item) => !item.completed && item.status !== '已完成');
  const renderTask = (task: ContextRoomRecord['actionItems'][number], done: boolean) => (
    <div className={`context-room-task-row${done ? ' is-done' : ''}`} key={task.id}>
      <button
        type="button"
        className="context-room-task-check"
        aria-label={t('contextRoom:activityPanes.taskAction', { action: t(done ? 'contextRoom:activityPanes.markIncomplete' : 'contextRoom:activityPanes.complete'), title: task.title })}
        onClick={() => onToggle(task.id)}
      >
        <span>{done ? <Check aria-hidden="true" /> : null}</span>
      </button>
      <button
        type="button"
        className="context-room-task-main"
        onClick={() => onSelect(task.id)}
      >
        <b>{task.title}</b>
        <span className="context-room-task-source">
          {task.source?.name ?? t('contextRoom:activityPanes.ownerOwner', { owner: t(uiText(task.owner)) })}
        </span>
        <span className="context-room-task-meta">
          <span>{t(uiText(task.owner))}</span>
          <span><CalendarDays aria-hidden="true" />{t('contextRoom:activityPanes.dueDeadline', { deadline: t(uiText(task.deadline)) })}</span>
        </span>
      </button>
    </div>
  );

  return (
    <div className="context-room-task-pane">
      <header>
        <h2>{t('contextRoom:activityPanes.roomTasks')}</h2>
        <span className="context-room-task-progress" data-icon-tone={roomKindTone(room.kind)}>
          {completed.length}/{room.actionItems.length}
        </span>
      </header>
      {room.actionItems.length ? (
        <>
          <section className="context-room-task-section">
            <h3>{t('contextRoom:activityPanes.incomplete')} <span>{pending.length}</span></h3>
            {pending.map((task) => renderTask(task, false))}
          </section>
          <section className="context-room-task-section context-room-task-completed">
            <button
              type="button"
              className="context-room-task-section-toggle"
              aria-expanded={completedOpen}
              onClick={() => setCompletedOpen((value) => !value)}
            >
              <ChevronDown aria-hidden="true" />
              {t('contextRoom:activityPanes.completed')}
              <span>{completed.length}</span>
            </button>
            {completedOpen ? completed.map((task) => renderTask(task, true)) : null}
          </section>
        </>
      ) : (
        <PanelEmptyState
          icon={CheckSquare2}
          title={t('contextRoom:activityPanes.noTasksYet')}
          description={t('contextRoom:activityPanes.actionItemsExtractedByAgentAndRoomTasks')}
        />
      )}
    </div>
  );
}

export function MailsPane({ room, onSelect }: { room: ContextRoomRecord; onSelect: (id: string) => void }) {
  const { t } = useLocale();
  const mails = room.materials.filter((material) => material.type === '邮件');
  return <div className="context-room-mail-pane"><header><h2>{t('contextRoom:activityPanes.roomEmail')}</h2><span>{mails.length}</span></header>{mails.length ? mails.map((mail) => <button type="button" className={mail.unread ? 'is-unread' : ''} key={mail.id} onClick={() => onSelect(mail.id)}><Mail aria-hidden="true" /><span><span className="context-room-mail-meta"><b>{mail.folder === 'sent' ? mail.recipient ?? t('contextRoom:activityPanes.to') : mail.sender ?? t('contextRoom:objectDetail.defaultSender')}</b><time>{mail.time}</time></span><strong>{mail.title}</strong><small>{localizedUiText(mail.summary, t)}</small></span></button>) : <PanelEmptyState icon={Mail} title={t('contextRoom:activityPanes.noEmailYet')} description={t('contextRoom:activityPanes.emailRelatedToThisRoomAppearsHere')} />}</div>;
}
