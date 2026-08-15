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

import type { ContextRoomRecord } from '../../types';
import { roomKindTone } from '../utils';

function EmptyState({ children }: { children: string }) {
  return <div className="context-room-workspace-empty">{children}</div>;
}

type ScheduleView = 'day' | 'week' | 'month';
const SCHEDULE_TODAY = new Date(2026, 6, 9);

function parseScheduleDate(value: string) {
  const match = value.match(/(\d{1,2})-(\d{1,2})/);
  if (!match) return new Date(SCHEDULE_TODAY);
  return new Date(SCHEDULE_TODAY.getFullYear(), Number(match[1]) - 1, Number(match[2]));
}

function weekStart(value: Date) {
  const start = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  start.setDate(start.getDate() + (start.getDay() === 0 ? -6 : 1 - start.getDay()));
  return start;
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
  const [view, setView] = useState<ScheduleView>('month');
  const [cursor, setCursor] = useState(new Date(SCHEDULE_TODAY));
  const scheduleItems = useMemo(() => [
    ...room.materials.filter((material) => material.type === '会议').map((meeting) => ({
      id: meeting.id, kind: 'meeting' as const, date: parseScheduleDate(meeting.time), time: meeting.time.split(' ')[1] || '10:30', title: meeting.title,
      subtitle: meeting.attendees?.join('、') || meeting.summary, description: meeting.summary, location: meeting.location,
      attachments: room.fileItems.slice(0, 1).map((file) => ({ name: file.name, size: file.size })),
    })),
    ...room.actionItems.filter((task) => !task.completed && task.status !== '已完成').map((task) => ({
      id: task.id, kind: 'task' as const, date: parseScheduleDate(task.deadline), time: '', title: task.title,
      subtitle: `负责人 ${task.owner}`, description: '来源和状态会同步到 Room。', location: undefined,
      attachments: [] as Array<{ name: string; size?: string }>,
    })),
  ], [room]);
  const visibleItems = scheduleItems.filter((item) => dateInView(item.date, cursor, view));
  const groups = visibleItems.reduce<Map<string, typeof visibleItems>>((result, item) => {
    const key = item.date.toISOString().slice(0, 10);
    result.set(key, [...(result.get(key) ?? []), item]);
    return result;
  }, new Map());
  const month = String(cursor.getMonth() + 1);
  const cursorLabel = view === 'month' ? `${String(cursor.getFullYear())} 年 ${month} 月` : view === 'week' ? `${month} 月第 ${String(Math.ceil(cursor.getDate() / 7))} 周` : `${month} 月 ${String(cursor.getDate())} 日`;
  const moveCursor = (delta: number) => setCursor((current) => { const next = new Date(current); if (view === 'month') next.setMonth(next.getMonth() + delta); else next.setDate(next.getDate() + delta * (view === 'week' ? 7 : 1)); return next; });

  return <div className="context-room-schedule-pane">
    <header><h2>Room 日程</h2><div>{(['day', 'week', 'month'] as const).map((item) => <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)}>{item === 'day' ? '日' : item === 'week' ? '周' : '月'}</button>)}</div></header>
    <div className="context-room-schedule-date"><button type="button" aria-label="上一周期" onClick={() => moveCursor(-1)}><ChevronLeft aria-hidden="true" /></button><span>{cursorLabel}</span><button type="button" aria-label="下一周期" onClick={() => moveCursor(1)}><ChevronRight aria-hidden="true" /></button><button type="button" disabled={cursor.toDateString() === SCHEDULE_TODAY.toDateString()} onClick={() => setCursor(new Date(SCHEDULE_TODAY))}>今天</button></div>
    {[...groups.entries()].map(([date, items]) => <section className="context-room-schedule-group" key={date}>
      <header><span>{date === '2026-07-09' ? '今天' : date}</span><b>{items.length}</b></header>
      {items.map((item) => <Popover.Root key={`${item.kind}-${item.id}`}><Popover.Trigger asChild><button type="button" className="context-room-schedule-item" data-icon-tone={item.kind === 'meeting' ? 'calendar' : 'task'}><span className="context-room-schedule-item-icon">{item.kind === 'meeting' ? <Mic aria-hidden="true" /> : <CheckSquare2 aria-hidden="true" />}</span><span><b>{item.title}</b><small>{item.subtitle}{item.location ? ` · ${item.location}` : ''}</small></span><time>{item.time}</time></button></Popover.Trigger><Popover.Portal><Popover.Content className="context-room-schedule-popover" side="right" align="start" sideOffset={8} collisionPadding={12}><header><h3>{item.title}</h3><Popover.Close aria-label="关闭日程详情"><X aria-hidden="true" /></Popover.Close></header><p><CalendarDays aria-hidden="true" />{item.kind === 'meeting' ? '会议时间' : '截止时间'}：{date} {item.time}</p><dl><div><dt>{item.kind === 'meeting' ? '参与对象' : '负责人'}</dt><dd>{item.subtitle}</dd></div><div><dt>说明</dt><dd>{item.description}</dd></div></dl>{item.attachments.length ? <section className="context-room-schedule-attachments"><span>附件</span>{item.attachments.map((attachment) => <div key={attachment.name}><Paperclip aria-hidden="true" /><b>{attachment.name}</b><small>{attachment.size}</small></div>)}</section> : null}<Popover.Close asChild><button type="button" className="context-room-secondary" onClick={() => onOpen({ kind: item.kind, id: item.id })}>打开{item.kind === 'meeting' ? '会议详情' : '任务详情'}</button></Popover.Close></Popover.Content></Popover.Portal></Popover.Root>)}
    </section>)}
    {!visibleItems.length ? <EmptyState>该范围内暂无日程</EmptyState> : null}
  </div>;
}

export function TasksPane({ room, onSelect, onToggle }: { room: ContextRoomRecord; onSelect: (id: string) => void; onToggle: (id: string) => void }) {
  const [completedOpen, setCompletedOpen] = useState(false);
  const completed = room.actionItems.filter((item) => item.completed || item.status === '已完成');
  const pending = room.actionItems.filter((item) => !item.completed && item.status !== '已完成');
  const renderTask = (task: ContextRoomRecord['actionItems'][number], done: boolean) => (
    <div className={`context-room-task-row${done ? ' is-done' : ''}`} key={task.id}>
      <button
        type="button"
        className="context-room-task-check"
        aria-label={`${done ? '取消完成' : '完成'} ${task.title}`}
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
          {task.source?.name ?? `负责人 ${task.owner}`}
        </span>
        <span className="context-room-task-meta">
          <span>{task.owner}</span>
          <span><CalendarDays aria-hidden="true" />截止 {task.deadline}</span>
        </span>
      </button>
    </div>
  );

  return (
    <div className="context-room-task-pane">
      <header>
        <h2>Room 任务</h2>
        <span className="context-room-task-progress" data-icon-tone={roomKindTone(room.kind)}>
          {completed.length}/{room.actionItems.length}
        </span>
      </header>
      <section className="context-room-task-section">
        <h3>未完成 <span>{pending.length}</span></h3>
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
          已完成
          <span>{completed.length}</span>
        </button>
        {completedOpen ? completed.map((task) => renderTask(task, true)) : null}
      </section>
      {!room.actionItems.length ? <EmptyState>暂无任务</EmptyState> : null}
    </div>
  );
}

export function MailsPane({ room, onSelect }: { room: ContextRoomRecord; onSelect: (id: string) => void }) {
  const mails = room.materials.filter((material) => material.type === '邮件');
  return <div className="context-room-mail-pane"><header><h2>Room 邮件</h2><span>{mails.length}</span></header>{mails.length ? mails.map((mail) => <button type="button" className={mail.unread ? 'is-unread' : ''} key={mail.id} onClick={() => onSelect(mail.id)}><Mail aria-hidden="true" /><span><span className="context-room-mail-meta"><b>{mail.folder === 'sent' ? mail.recipient ?? '收件人' : mail.sender ?? '张总 · 星港科技'}</b><time>{mail.time}</time></span><strong>{mail.title}</strong><small>{mail.summary}</small></span></button>) : <EmptyState>暂无邮件</EmptyState>}</div>;
}
