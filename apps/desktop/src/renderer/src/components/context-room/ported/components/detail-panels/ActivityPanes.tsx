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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoomMailDetail, RoomOverviewClaim, RoomOverviewProjection } from '@nxcore/agent-contract';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { localizedUiText, uiText } from '../../adapters';
import { useRoomMails } from '../../hooks/useRoomMails';
import { CalendarProviderIcon } from '../CalendarProviderIcon';
import { MailProviderIcon } from '../MailProviderIcon';
import { ObjectDetailView, type DetailObject } from '../ObjectDetailView';
import { MarkdownBody } from './MarkdownBody';
import {
  preferRoomOverviewProjection,
  ROOM_OVERVIEW_CHANGED_EVENT,
  type RoomOverviewChangedDetail,
} from '../../../roomOverviewChange';
import { roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';
import type { WorkspaceObjectPreview } from './index';

type RoomUpdater = (room: ContextRoomRecord) => ContextRoomRecord;

/** 把受控详情态解析成 ObjectDetailView 需要的对象；条目已删除或归属不符时返回 null 回落列表。 */
function resolvePaneDetailObject(room: ContextRoomRecord, detail: WorkspaceObjectPreview): DetailObject | null {
  if (detail.kind === 'task') {
    const value = room.actionItems.find((item) => item.id === detail.id);
    return value ? { kind: 'task', value } : null;
  }
  if (detail.kind === 'meeting') {
    const value = room.materials.find((item) => item.id === detail.id && item.type === '会议');
    return value ? { kind: 'meeting', value } : null;
  }
  const value = room.materials.find((item) => item.id === detail.id && item.type === '邮件');
  return value ? { kind: 'mail', value } : null;
}

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

/**
 * 概览投影（确定性日历/待办 claim 的数据源）：初次拉取 + 投影变更事件刷新，
 * 与 OverviewDashboard 同构。日程/待办面板共用。
 */
function useRoomOverviewProjection(roomId: string) {
  const [projection, setProjection] = useState<RoomOverviewProjection | null>(null);
  useEffect(() => {
    // node 测试环境无 window：投影保持 null，面板回退本地快照视图
    if (typeof window === "undefined") return;
    let cancelled = false;
    const load = async () => {
      const api = window.nxcore?.contextRooms;
      if (!api?.overview) return;
      try {
        const next = await api.overview(roomId);
        if (!cancelled) setProjection((current) => preferRoomOverviewProjection(current, next));
      } catch {
        // 投影不可用时维持本地快照视图（面板仍有会议/任务兜底）
      }
    };
    void load();
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<RoomOverviewChangedDetail>).detail;
      if (detail?.roomId && detail.roomId !== roomId) return;
      const next = detail?.projection;
      if (next) {
        setProjection((current) => preferRoomOverviewProjection(current, next));
        return;
      }
      void load();
    };
    window.addEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
    };
  }, [roomId]);
  return projection;
}

export function SchedulePane({
  room,
  onOpen,
  detail,
  onCloseDetail,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  onOpen: (target: { kind: 'meeting' | 'task'; id: string }) => void;
  /** 受控详情态：popover「打开详情」后由归属面板内展示，右区文档不受影响。 */
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { locale, t } = useLocale();
  const [view, setView] = useState<ScheduleView>('month');
  const [cursor, setCursor] = useState(new Date(SCHEDULE_TODAY));
  const overviewProjection = useRoomOverviewProjection(room.id);
  // 投影时间轴里的确定性日历 claim → 日历项（occurredAt = 事件开始时间，精确到分）。
  // 连接器（calendar-event）与本地（local-schedule，agent/用户创建）同列渲染，徽标区分。
  const connectorItems = useMemo(() => (overviewProjection?.timeline ?? []).flatMap((claim) => {
    const local = claim.evidence.some((source) => source.sourceKind === 'local-schedule');
    if (!local && !claim.evidence.some((source) => source.sourceKind === 'calendar-event')) return [];
    const when = claim.occurredAt ? new Date(claim.occurredAt) : null;
    if (!when || Number.isNaN(when.getTime())) return [];
    const title = (claim.data?.kind === 'timeline' ? claim.data.title : '') || claim.text;
    const sourceKind = local ? 'local-schedule' : 'calendar-event';
    // 连接器日程带服务商 slug（google_calendar 等）→ 列表打品牌图标；本地日程无。
    const provider = local || claim.data?.kind !== 'timeline' ? undefined : claim.data.provider || undefined;
    return [{
      id: claim.id, kind: 'meeting' as const, date: when, sourceKind, provider,
      time: when.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
      title,
      subtitle: t(`contextRoom:memory.sourceKind.${sourceKind}`),
      description: (claim.data?.kind === 'timeline' ? claim.data.description : null) || t(`contextRoom:memory.sourceKind.${sourceKind}`),
      location: undefined,
      attachments: [] as Array<{ name: string; size?: string }>,
      // 连接器/本地日程无详情对象：popover 不渲染「打开详情」
      connector: true as const,
    }];
  }), [locale, overviewProjection, t]);
  const scheduleItems = useMemo(() => {
    // 同名同日的 LLM 会议快照与投影日历事件视为同一事件，保留精确时间的投影版本
    const connectorKeys = new Set(connectorItems.map((item) => `${item.title.trim().toLocaleLowerCase()}\x00${localDateKey(item.date)}`));
    return [
      ...room.materials.filter((material) => material.type === '会议').map((meeting) => ({
        id: meeting.id, kind: 'meeting' as const, date: parseScheduleDate(meeting.time), sourceKind: undefined, time: meeting.time.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? '', title: meeting.title,
        subtitle: meeting.attendees?.join(locale === 'zh-CN' ? '、' : ', ') || localizedUiText(meeting.summary, t), description: localizedUiText(meeting.summary, t), location: meeting.location,
        attachments: meeting.attachments ?? [], connector: false as const,
      })).filter((meeting) => !connectorKeys.has(`${meeting.title.trim().toLocaleLowerCase()}\x00${localDateKey(meeting.date)}`)),
      ...room.actionItems.filter((task) => !task.completed && task.status !== '已完成').map((task) => ({
        id: task.id, kind: 'task' as const, date: parseScheduleDate(task.deadline), sourceKind: undefined, time: '', title: task.title,
        subtitle: t('contextRoom:activityPanes.ownerOwner', { owner: task.owner }), description: t('contextRoom:activityPanes.theSourceAndStatusWillSyncToThe'), location: undefined,
        attachments: [] as Array<{ name: string; size?: string }>, connector: false as const,
      })),
      ...connectorItems,
    ];
  }, [connectorItems, locale, room, t]);
  const visibleItems = scheduleItems.filter((item) => dateInView(item.date, cursor, view));
  const groups = visibleItems.reduce<Map<string, typeof visibleItems>>((result, item) => {
    const key = localDateKey(item.date);
    result.set(key, [...(result.get(key) ?? []), item]);
    return result;
  }, new Map());
  const month = String(cursor.getMonth() + 1);
  const cursorLabel = view === 'month' ? t('contextRoom:activityPanes.monthYear', { year: cursor.getFullYear(), month }) : view === 'week' ? t('contextRoom:activityPanes.weekWeekOfMonth', { month, week: Math.ceil(cursor.getDate() / 7) }) : t('contextRoom:activityPanes.monthDay', { month, day: cursor.getDate() });
  const moveCursor = (delta: number) => setCursor((current) => { const next = new Date(current); if (view === 'month') next.setMonth(next.getMonth() + delta); else next.setDate(next.getDate() + delta * (view === 'week' ? 7 : 1)); return next; });

  const detailObject = detail ? resolvePaneDetailObject(room, detail) : null;
  if (detail && detailObject && onCloseDetail) {
    return (
      <ObjectDetailView
        embedded
        room={room}
        object={detailObject}
        onBack={onCloseDetail}
        onUpdateRoom={onUpdateRoom}
      />
    );
  }

  return <div className="context-room-schedule-pane">
    <header><h2>{t('contextRoom:activityPanes.roomSchedule')}</h2><div>{(['day', 'week', 'month'] as const).map((item) => <button type="button" key={item} aria-pressed={view === item} onClick={() => setView(item)}>{t(item === 'day' ? 'contextRoom:activityPanes.day' : item === 'week' ? 'contextRoom:activityPanes.week' : 'contextRoom:activityPanes.month')}</button>)}</div></header>
    {scheduleItems.length ? (
      <>
        <div className="context-room-schedule-date"><button type="button" aria-label={t('contextRoom:activityPanes.previousPeriod')} onClick={() => moveCursor(-1)}><ChevronLeft aria-hidden="true" /></button><span>{cursorLabel}</span><button type="button" aria-label={t('contextRoom:activityPanes.nextPeriod')} onClick={() => moveCursor(1)}><ChevronRight aria-hidden="true" /></button><button type="button" disabled={cursor.toDateString() === SCHEDULE_TODAY.toDateString()} onClick={() => setCursor(new Date(SCHEDULE_TODAY))}>{t('contextRoom:activityPanes.today')}</button></div>
        {[...groups.entries()].map(([date, items]) => <section className="context-room-schedule-group" key={date}>
          <header><span>{date === localDateKey(SCHEDULE_TODAY) ? t('contextRoom:activityPanes.today') : date}</span><b>{items.length}</b></header>
          {items.map((item) => <Popover.Root key={`${item.kind}-${item.id}`}><Popover.Trigger asChild><button type="button" className="context-room-schedule-item" data-icon-tone={item.kind === 'meeting' ? 'calendar' : 'task'} data-connector-source={item.connector ? item.sourceKind : undefined}><span className="context-room-schedule-item-icon">{item.kind === 'meeting' ? (item.connector ? <CalendarProviderIcon provider={item.provider} /> : <Mic aria-hidden="true" />) : <CheckSquare2 aria-hidden="true" />}</span><span><b>{item.title}</b><small>{item.subtitle}{item.location ? ` · ${item.location}` : ''}</small></span><time>{item.time}</time></button></Popover.Trigger><Popover.Portal><Popover.Content className="context-room-schedule-popover" side="right" align="start" sideOffset={8} collisionPadding={12}><header><h3>{item.title}</h3><Popover.Close aria-label={t('contextRoom:activityPanes.closeScheduleDetails')}><X aria-hidden="true" /></Popover.Close></header><p><CalendarProviderIcon provider={item.connector ? item.provider : undefined} />{t(item.kind === 'meeting' ? 'contextRoom:activityPanes.meetingTime' : 'contextRoom:activityPanes.dueDate')}：{date} {item.time}</p><dl><div><dt>{t(item.kind === 'meeting' ? 'contextRoom:activityPanes.participants' : 'contextRoom:activityPanes.owner')}</dt><dd>{item.subtitle}</dd></div><div><dt>{t('contextRoom:activityPanes.description')}</dt><dd>{item.description}</dd></div></dl>{item.attachments.length ? <section className="context-room-schedule-attachments"><span>{t('contextRoom:activityPanes.attachments')}</span>{item.attachments.map((attachment) => <div key={attachment.name}><Paperclip aria-hidden="true" /><b>{attachment.name}</b><small>{attachment.size}</small></div>)}</section> : null}{item.connector ? null : <Popover.Close asChild><button type="button" className="context-room-secondary" onClick={() => onOpen({ kind: item.kind, id: item.id })}>{t('contextRoom:activityPanes.openDetail', { detail: t(item.kind === 'meeting' ? 'contextRoom:activityPanes.meetingDetails' : 'contextRoom:activityPanes.taskDetails') })}</button></Popover.Close>}</Popover.Content></Popover.Portal></Popover.Root>)}
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

export function TasksPane({
  room,
  onSelect,
  onToggle,
  detail,
  onCloseDetail,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { locale, t } = useLocale();
  const [completedOpen, setCompletedOpen] = useState(false);
  const [togglingActionId, setTogglingActionId] = useState<string | null>(null);
  const completed = room.actionItems.filter((item) => item.completed || item.status === '已完成');
  const pending = room.actionItems.filter((item) => !item.completed && item.status !== '已完成');
  // 确定性待办叠加：概览投影的 task claim 按来源分流——本地待办（local-task，
  // agent/用户创建）可勾选完成（IPC 写回 + 返回投影刷新）；连接器待办只读
  // （完成状态由连接器同步回写）。与本地任务同名的投影项去重（概览卡片同一约定）。
  const overviewProjection = useRoomOverviewProjection(room.id);
  const pendingTitles = new Set(pending.map((task) => task.title.trim().toLocaleLowerCase()));
  const projectionTasks = (overviewProjection?.nextSteps ?? []).filter((item) =>
    item.data?.kind === 'next_step' && item.data.itemType === 'task'
    && !pendingTitles.has(item.text.trim().toLocaleLowerCase()));
  const isLocalAction = (claim: RoomOverviewClaim) =>
    claim.evidence.some((source) => source.sourceKind === 'local-task');
  const localTasks = projectionTasks.filter(isLocalAction);
  const connectorTasks = projectionTasks.filter((claim) => !isLocalAction(claim));
  // 已完成的本地助手待办：投影保留为 status=completed 的 claim，进「已完成」分组
  // （可反勾恢复），不再打勾后凭空消失。
  const isCompletedClaim = (claim: RoomOverviewClaim) =>
    claim.data?.kind === 'next_step' && claim.data.status === 'completed';
  const localDoneTasks = localTasks.filter(isCompletedClaim);
  const localPendingTasks = localTasks.filter((claim) => !isCompletedClaim(claim));
  // 本地待办勾选：投影里的 local-task 都未完成，勾选即 complete；返回的新投影
  // 走 ROOM_OVERVIEW_CHANGED（preferRoomOverviewProjection 语义）刷新面板。
  const toggleLocalTask = async (claim: RoomOverviewClaim, completed = true) => {
    const api = window.nxcore?.contextRooms;
    const actionId = claim.data?.kind === 'next_step' ? claim.data.actionId : null;
    if (!api?.completeLocalAction || !actionId) return;
    setTogglingActionId(actionId);
    try {
      const result = await api.completeLocalAction(room.id, actionId, completed);
      window.dispatchEvent(new CustomEvent<RoomOverviewChangedDetail>(ROOM_OVERVIEW_CHANGED_EVENT, {
        detail: { roomId: room.id, projection: result.overview },
      }));
    } catch {
      // 失败静默：行保持未完成，下次投影刷新仍与本地库一致
    } finally {
      setTogglingActionId(null);
    }
  };
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

  const detailObject = detail ? resolvePaneDetailObject(room, detail) : null;
  if (detail && detailObject && onCloseDetail) {
    return (
      <ObjectDetailView
        embedded
        room={room}
        object={detailObject}
        onBack={onCloseDetail}
        onUpdateRoom={onUpdateRoom}
      />
    );
  }

  return (
    <div className="context-room-task-pane">
      <header>
        <h2>{t('contextRoom:activityPanes.roomTasks')}</h2>
        <span className="context-room-task-progress" data-icon-tone={roomKindTone(room.kind)}>
          {completed.length + localDoneTasks.length}/{room.actionItems.length + localTasks.length}
        </span>
      </header>
      {room.actionItems.length + localTasks.length + connectorTasks.length ? (
        <>
          <section className="context-room-task-section">
            <h3>{t('contextRoom:activityPanes.incomplete')} <span>{pending.length + localPendingTasks.length + connectorTasks.length}</span></h3>
            {pending.map((task) => renderTask(task, false))}
            {localPendingTasks.map((item) => {
              const dueAt = item.data?.kind === 'next_step' ? item.data.dueAt : null;
              const actionId = item.data?.kind === 'next_step' ? item.data.actionId : null;
              return (
                <div className="context-room-task-row" key={item.id} data-action-source="local-task">
                  <button
                    type="button"
                    className="context-room-task-check"
                    disabled={!actionId || togglingActionId === actionId}
                    aria-label={t('contextRoom:activityPanes.taskAction', { action: t('contextRoom:activityPanes.complete'), title: item.text })}
                    onClick={() => void toggleLocalTask(item)}
                  >
                    <span />
                  </button>
                  <div className="context-room-task-main">
                    <b>{item.text}</b>
                    <span className="context-room-task-source">{t('contextRoom:memory.sourceKind.local-task')}</span>
                    <span className="context-room-task-meta">
                      <span>{t('contextRoom:memory.sourceKind.local-task')}</span>
                      <span><CalendarDays aria-hidden="true" />{dueAt ? new Date(dueAt).toLocaleDateString(locale) : ''}</span>
                    </span>
                  </div>
                </div>
              );
            })}
            {connectorTasks.map((item) => {
              const dueAt = item.data?.kind === 'next_step' ? item.data.dueAt : null;
              return (
                <div className="context-room-task-row" key={item.id} data-connector-source="todo">
                  <span className="context-room-task-check" aria-hidden="true"><span /></span>
                  <div className="context-room-task-main">
                    <b>{item.text}</b>
                    <span className="context-room-task-source">{t('contextRoom:memory.sourceKind.todo')}</span>
                    <span className="context-room-task-meta">
                      <span>{t('contextRoom:memory.sourceKind.todo')}</span>
                      <span><CalendarDays aria-hidden="true" />{dueAt ? new Date(dueAt).toLocaleDateString(locale) : ''}</span>
                    </span>
                  </div>
                </div>
              );
            })}
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
              <span>{completed.length + localDoneTasks.length}</span>
            </button>
            {completedOpen ? (
              <>
                {completed.map((task) => renderTask(task, true))}
                {localDoneTasks.map((item) => {
                  const dueAt = item.data?.kind === 'next_step' ? item.data.dueAt : null;
                  const actionId = item.data?.kind === 'next_step' ? item.data.actionId : null;
                  return (
                    <div className="context-room-task-row is-done" key={item.id} data-action-source="local-task">
                      <button
                        type="button"
                        className="context-room-task-check"
                        disabled={!actionId || togglingActionId === actionId}
                        aria-label={t('contextRoom:activityPanes.taskAction', { action: t('contextRoom:activityPanes.markIncomplete'), title: item.text })}
                        onClick={() => void toggleLocalTask(item, false)}
                      >
                        <span><Check aria-hidden="true" /></span>
                      </button>
                      <div className="context-room-task-main">
                        <b>{item.text}</b>
                        <span className="context-room-task-source">{t('contextRoom:memory.sourceKind.local-task')}</span>
                        <span className="context-room-task-meta">
                          <span>{t('contextRoom:memory.sourceKind.local-task')}</span>
                          <span><CalendarDays aria-hidden="true" />{dueAt ? new Date(dueAt).toLocaleDateString(locale) : ''}</span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </>
            ) : null}
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

/** 连接器邮件详情（邮件面板下半区）：身份头 + 元信息 + 正文滚动区。 */
function MailDetailPanel({
  state,
  locale,
  onClose,
}: {
  state: { loading: boolean; detail: RoomMailDetail | null; error: boolean };
  locale: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  if (state.loading) {
    return (
      <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
        <p className="context-room-mail-detail-hint">{t('contextRoom:activityPanes.loadingMailBody')}</p>
      </aside>
    );
  }
  if (state.error || !state.detail) {
    return (
      <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
        <p className="context-room-mail-detail-hint">{t('contextRoom:activityPanes.mailBodyUnavailable')}</p>
      </aside>
    );
  }
  const detail = state.detail;
  const when = detail.sentAt && !Number.isNaN(Date.parse(detail.sentAt))
    ? new Date(detail.sentAt).toLocaleString(locale)
    : null;
  return (
    <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
      <header>
        <MailProviderIcon provider={detail.provider} />
        <div className="context-room-mail-detail-title">
          <strong title={detail.subject}>{detail.subject}</strong>
          <small>
            {detail.senderName ?? t('contextRoom:objectDetail.defaultSender')}
            {detail.senderAddress ? ` <${detail.senderAddress}>` : ''}
          </small>
        </div>
        <button type="button" aria-label={t('contextRoom:activityPanes.closeMailDetail')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <p className="context-room-mail-detail-meta">
        {when ? <time>{t('contextRoom:activityPanes.sentAt')}：{when}</time> : null}
        {detail.hasAttachments ? (
          <span><Paperclip aria-hidden="true" />{t('contextRoom:activityPanes.hasAttachments')}</span>
        ) : null}
      </p>
      <div className="context-room-mail-detail-body">
        <MarkdownBody markdown={detail.body} />
      </div>
    </aside>
  );
}

export function MailsPane({
  room,
  onSelect,
  detail,
  onCloseDetail,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  onSelect: (id: string) => void;
  /** 受控详情态：详情在邮箱面板内展示（替代原全屏弹窗）。 */
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { locale, t } = useLocale();
  // 连接器邮件叠加：路由引擎归类的 Gmail/Outlook 邮件（专用全量端点，sentAt 倒序）。
  // 本地 LLM 快照邮件按「主题 + 同日」去重，保留真实发件人/时间的连接器版本。
  const { mails: connectorMails } = useRoomMails(room.id);
  // 下半区详情：点击连接器邮件拉取全文（会话内缓存，Room 切换即失效）。
  const [selectedMailId, setSelectedMailId] = useState<string | null>(null);
  const [mailDetailState, setMailDetailState] = useState<{ loading: boolean; detail: RoomMailDetail | null; error: boolean }>({
    loading: false,
    detail: null,
    error: false,
  });
  const mailDetailCache = useRef(new Map<string, RoomMailDetail>());
  const mailDetailSeq = useRef(0);

  useEffect(() => {
    setSelectedMailId(null);
    setMailDetailState({ loading: false, detail: null, error: false });
    mailDetailCache.current.clear();
    mailDetailSeq.current += 1;
  }, [room.id]);

  const openConnectorMail = useCallback(async (sourceId: string) => {
    setSelectedMailId(sourceId);
    const cached = mailDetailCache.current.get(sourceId);
    if (cached) {
      setMailDetailState({ loading: false, detail: cached, error: false });
      return;
    }
    const seq = mailDetailSeq.current + 1;
    mailDetailSeq.current = seq;
    setMailDetailState({ loading: true, detail: null, error: false });
    try {
      const fetched = await window.nxcore?.contextRooms?.readMail(room.id, sourceId);
      if (!fetched) throw new Error('mail_detail_unavailable');
      mailDetailCache.current.set(sourceId, fetched);
      if (mailDetailSeq.current === seq) {
        setMailDetailState({ loading: false, detail: fetched, error: false });
      }
    } catch {
      if (mailDetailSeq.current === seq) {
        setMailDetailState({ loading: false, detail: null, error: true });
      }
    }
  }, [room.id]);

  const detailObject = detail ? resolvePaneDetailObject(room, detail) : null;
  if (detail && detailObject && onCloseDetail) {
    return (
      <ObjectDetailView
        embedded
        room={room}
        object={detailObject}
        onBack={onCloseDetail}
        onUpdateRoom={onUpdateRoom}
      />
    );
  }
  const connectorKeys = new Set(connectorMails.flatMap((mail) => {
    const when = mail.sentAt ? new Date(mail.sentAt) : null;
    return when && !Number.isNaN(when.getTime())
      ? [`${mail.subject.trim().toLocaleLowerCase()}\x00${localDateKey(when)}`]
      : [];
  }));
  const mails = room.materials.filter((material) => material.type === '邮件')
    .filter((mail) => !connectorKeys.has(`${mail.title.trim().toLocaleLowerCase()}\x00${localDateKey(parseScheduleDate(mail.time))}`));
  const connectorRows = connectorMails.map((mail) => {
    const when = mail.sentAt ? new Date(mail.sentAt) : null;
    const time = when && !Number.isNaN(when.getTime()) ? when.toLocaleString(locale) : '';
    return { mail, time, sender: mail.senderName ?? mail.senderAddress ?? t('contextRoom:objectDetail.defaultSender') };
  });
  return (
    <div className={`context-room-mail-pane${selectedMailId ? ' has-detail' : ''}`}>
      <header><h2>{t('contextRoom:activityPanes.roomEmail')}</h2><span>{mails.length + connectorRows.length}</span></header>
      {mails.length + connectorRows.length ? (
        <>
          <div className="context-room-mail-list">
            {mails.map((mail) => (
              <button type="button" className={mail.unread ? 'is-unread' : ''} key={mail.id} onClick={() => onSelect(mail.id)}>
                <Mail aria-hidden="true" />
                <span>
                  <span className="context-room-mail-meta"><b>{mail.folder === 'sent' ? mail.recipient ?? t('contextRoom:activityPanes.to') : mail.sender ?? t('contextRoom:objectDetail.defaultSender')}</b><time>{mail.time}</time></span>
                  <strong>{mail.title}</strong>
                  <small>{localizedUiText(mail.summary, t)}</small>
                </span>
              </button>
            ))}
            {connectorRows.map(({ mail, time, sender }) => (
              <button
                type="button"
                key={`mail-${mail.sourceId}`}
                data-connector-source="mail"
                aria-pressed={selectedMailId === mail.sourceId}
                className={selectedMailId === mail.sourceId ? 'is-selected' : ''}
                onClick={() => void openConnectorMail(mail.sourceId)}
              >
                <MailProviderIcon provider={mail.provider} />
                <span>
                  <span className="context-room-mail-meta"><b>{sender}</b><time>{time}</time></span>
                  <strong>{mail.subject}</strong>
                  <small>{mail.snippet ?? ''}</small>
                </span>
              </button>
            ))}
          </div>
          {selectedMailId ? (
            <MailDetailPanel
              state={mailDetailState}
              locale={locale}
              onClose={() => setSelectedMailId(null)}
            />
          ) : null}
        </>
      ) : (
        <PanelEmptyState icon={Mail} title={t('contextRoom:activityPanes.noEmailYet')} description={t('contextRoom:activityPanes.emailRelatedToThisRoomAppearsHere')} />
      )}
    </div>
  );
}
