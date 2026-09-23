import * as Popover from '@radix-ui/react-popover';
import {
  CalendarClock,
  CalendarDays,
  Check,
  CheckSquare2,
  ChevronDown,
  Mail,
  Mic,
  Paperclip,
  Plus,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RoomOverviewClaim } from '@nxcore/agent-contract';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { localizedUiText, uiText } from '../../adapters';
import { useRoomOverviewProjection } from '../../hooks/useRoomOverviewProjection';
import { useRoomMails } from '../../hooks/useRoomMails';
import { CalendarProviderIcon } from '../CalendarProviderIcon';
import { MailProviderIcon } from '../MailProviderIcon';
import { ObjectDetailView, type DetailObject } from '../ObjectDetailView';
import {
  ROOM_OVERVIEW_CHANGED_EVENT,
  type RoomOverviewChangedDetail,
} from '../../../roomOverviewChange';
import { ConnectorMailDetailPanel, useConnectorMailDetail } from './ConnectorMailDetail';
import { parseDisplayDate, paddedDateKey } from './MaterialsPane';
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
  return null;
}

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

function localDateKey(value: Date): string {
  return `${String(value.getFullYear())}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/**
 * 概览投影 hook 已抽到 hooks/useRoomOverviewProjection.ts（日程/待办/动态共用）。
 */

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
  // 原型日程区：全量平铺按日期分组（升序），不做日/周/月范围过滤。
  const groups = [...scheduleItems]
    .sort((left, right) => left.date.getTime() - right.date.getTime())
    .reduce<Map<string, typeof scheduleItems>>((result, item) => {
      const key = localDateKey(item.date);
      result.set(key, [...(result.get(key) ?? []), item]);
      return result;
    }, new Map());

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
    <header><CalendarDays aria-hidden="true" /><h2>{t('contextRoom:todoPane.scheduleSection')}</h2></header>
    {scheduleItems.length ? (
      <>
        {[...groups.entries()].map(([date, items]) => <section className="context-room-schedule-group" key={date}>
          <header><span>{date === localDateKey(SCHEDULE_TODAY) ? t('contextRoom:activityPanes.today') : date}</span><b>{items.length}</b></header>
          {items.map((item) => <Popover.Root key={`${item.kind}-${item.id}`}><Popover.Trigger asChild><button type="button" className="context-room-schedule-item" data-icon-tone={item.kind === 'meeting' ? 'calendar' : 'task'} data-connector-source={item.connector ? item.sourceKind : undefined}><span className="context-room-schedule-item-icon">{item.kind === 'meeting' ? (item.connector ? <CalendarProviderIcon provider={item.provider} /> : <Mic aria-hidden="true" />) : <CheckSquare2 aria-hidden="true" />}</span><span><b>{item.title}</b><small>{item.subtitle}{item.location ? ` · ${item.location}` : ''}</small></span><time>{item.time}</time></button></Popover.Trigger><Popover.Portal><Popover.Content className="context-room-schedule-popover" side="right" align="start" sideOffset={8} collisionPadding={12}><header><h3>{item.title}</h3><Popover.Close aria-label={t('contextRoom:activityPanes.closeScheduleDetails')}><X aria-hidden="true" /></Popover.Close></header><p><CalendarProviderIcon provider={item.connector ? item.provider : undefined} />{t(item.kind === 'meeting' ? 'contextRoom:activityPanes.meetingTime' : 'contextRoom:activityPanes.dueDate')}：{date} {item.time}</p><dl><div><dt>{t(item.kind === 'meeting' ? 'contextRoom:activityPanes.participants' : 'contextRoom:activityPanes.owner')}</dt><dd>{item.subtitle}</dd></div><div><dt>{t('contextRoom:activityPanes.description')}</dt><dd>{item.description}</dd></div></dl>{item.attachments.length ? <section className="context-room-schedule-attachments"><span>{t('contextRoom:activityPanes.attachments')}</span>{item.attachments.map((attachment) => <div key={attachment.name}><Paperclip aria-hidden="true" /><b>{attachment.name}</b><small>{attachment.size}</small></div>)}</section> : null}{item.connector ? null : <Popover.Close asChild><button type="button" className="context-room-secondary" onClick={() => onOpen({ kind: item.kind, id: item.id })}>{t('contextRoom:activityPanes.openDetail', { detail: t(item.kind === 'meeting' ? 'contextRoom:activityPanes.meetingDetails' : 'contextRoom:activityPanes.taskDetails') })}</button></Popover.Close>}</Popover.Content></Popover.Portal></Popover.Root>)}
        </section>)}
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
  const [createOpen, setCreateOpen] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskDeadline, setNewTaskDeadline] = useState('');
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
  // 本地任务延期：基于现有截止（"待排期"按今天）顺延 N 天，写回快照。
  const postponeTask = (taskId: string, days: number) =>
    onUpdateRoom((current) => ({
      ...current,
      actionItems: current.actionItems.map((item) => {
        if (item.id !== taskId) return item;
        const base = parseScheduleDate(item.deadline);
        base.setDate(base.getDate() + days);
        return {
          ...item,
          deadline: `${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`,
        };
      }),
    }));
  // 新建本地任务：写房间快照（随现有同步持久化），owner 记为"我"。
  const createTask = (title: string, deadline: string) =>
    onUpdateRoom((current) => ({
      ...current,
      actionItems: [
        ...current.actionItems,
        {
          id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          title,
          status: '未开始',
          owner: '我',
          deadline: deadline || '待排期',
        },
      ],
    }));
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
      {!done ? (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              type="button"
              className="context-room-task-postpone"
              aria-label={t('contextRoom:activityPanes.postponeTitle', { title: task.title })}
              title={t('contextRoom:activityPanes.postpone')}
            >
              <CalendarClock aria-hidden="true" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="context-room-task-postpone-popover" side="left" align="center" sideOffset={6} collisionPadding={12} aria-label={t('contextRoom:activityPanes.postponeDeadline')}>
              <strong>{t('contextRoom:activityPanes.postponeDeadline')}</strong>
              {([1, 3, 7] as const).map((days) => (
                <Popover.Close asChild key={days}>
                  <button type="button" onClick={() => postponeTask(task.id, days)}>
                    {t('contextRoom:activityPanes.postponeDays', { count: days })}
                  </button>
                </Popover.Close>
              ))}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      ) : null}
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
        <CheckSquare2 aria-hidden="true" />
        <h2>{t('contextRoom:todoPane.tasksSection')}</h2>
        <span className="context-room-pane-head-count">{room.actionItems.length + localTasks.length}</span>
        <Popover.Root
          open={createOpen}
          onOpenChange={(nextOpen) => {
            setCreateOpen(nextOpen);
            if (!nextOpen) {
              setNewTaskTitle('');
              setNewTaskDeadline('');
            }
          }}
        >
          <Popover.Trigger asChild>
            <button type="button" className="context-room-task-create" aria-label={t('contextRoom:activityPanes.newTask')}>
              <Plus aria-hidden="true" />
              {t('contextRoom:activityPanes.newTask')}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="context-room-task-create-popover" side="bottom" align="end" sideOffset={8} collisionPadding={12} aria-label={t('contextRoom:activityPanes.newTask')}>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const title = newTaskTitle.trim();
                  if (!title) return;
                  createTask(title, newTaskDeadline);
                  setCreateOpen(false);
                  setNewTaskTitle('');
                  setNewTaskDeadline('');
                }}
              >
                <label htmlFor="context-room-new-task-title">{t('contextRoom:activityPanes.taskTitleLabel')}</label>
                <input
                  id="context-room-new-task-title"
                  autoFocus
                  maxLength={200}
                  value={newTaskTitle}
                  placeholder={t('contextRoom:activityPanes.newTaskTitlePlaceholder')}
                  onChange={(event) => setNewTaskTitle(event.target.value)}
                />
                <label htmlFor="context-room-new-task-deadline">{t('contextRoom:activityPanes.dueDate')}</label>
                <input
                  id="context-room-new-task-deadline"
                  type="date"
                  value={newTaskDeadline}
                  onChange={(event) => setNewTaskDeadline(event.target.value)}
                />
                <footer>
                  <Popover.Close asChild>
                    <button type="button">{t('contextRoom:resource.cancel')}</button>
                  </Popover.Close>
                  <button type="submit" className="is-primary" disabled={!newTaskTitle.trim()}>
                    {t('contextRoom:activityPanes.create')}
                  </button>
                </footer>
              </form>
              <Popover.Arrow className="context-room-document-create-arrow" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
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
                  <button
                    type="button"
                    className="context-room-task-check"
                    disabled
                    title={t('contextRoom:activityPanes.connectorTaskReadOnly')}
                  >
                    <span />
                  </button>
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

/** 待办邮件区的行：连接器邮件与本地快照邮件统一结构。 */
interface MailRow {
  key: string;
  title: string;
  subtitle: string;
  timeLabel: string;
  sortTime: number;
  unread?: boolean;
  provider?: string;
  open: WorkspaceObjectPreview;
}

/**
 * 待办 / 邮件：连接器邮件与本地快照邮件合并平铺（同主题同日去重，保留连接器
 * 版本），按时间倒序；邮件详情在分区内整区替换展示（返回即回列表）。
 */
export function MailPane({
  room,
  onOpen,
  detail,
  onCloseDetail,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  onOpen: (target: WorkspaceObjectPreview) => void;
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { locale, t } = useLocale();
  const { mails: connectorMails } = useRoomMails(room.id);

  const connectorMailKeys = useMemo(() => new Set(connectorMails.flatMap((mail) => {
    const when = mail.sentAt ? new Date(mail.sentAt) : null;
    if (!when || Number.isNaN(when.getTime())) return [];
    return [`${mail.subject.trim().toLocaleLowerCase()}\x00${paddedDateKey(when)}`];
  })), [connectorMails]);

  const rows = useMemo<MailRow[]>(() => {
    const connectorRows: MailRow[] = connectorMails.map((mail) => ({
      key: `mail:${mail.sourceId}`,
      title: mail.subject,
      subtitle: mail.senderName ?? mail.senderAddress ?? t('contextRoom:objectDetail.defaultSender'),
      timeLabel: mail.sentAt && !Number.isNaN(Date.parse(mail.sentAt))
        ? new Date(mail.sentAt).toLocaleDateString(locale)
        : '',
      sortTime: Date.parse(mail.sentAt ?? '') || 0,
      provider: mail.provider ?? undefined,
      open: { kind: 'connector-mail', sourceId: mail.sourceId },
    }));
    const localRows: MailRow[] = room.materials
      .filter((material) => material.type === '邮件')
      .filter((mail) => {
        const when = parseDisplayDate(mail.time);
        if (!when) return true;
        return !connectorMailKeys.has(`${mail.title.trim().toLocaleLowerCase()}\x00${paddedDateKey(when)}`);
      })
      .map((mail) => ({
        key: `lmail:${mail.id}`,
        title: mail.title,
        subtitle: mail.sender ?? localizedUiText(mail.summary, t),
        timeLabel: mail.time,
        sortTime: parseDisplayDate(mail.time)?.getTime() ?? 0,
        unread: mail.unread,
        open: { kind: 'mail', id: mail.id } as const,
      }));
    return [...connectorRows, ...localRows]
      .sort((left, right) => (left.sortTime !== right.sortTime
        ? right.sortTime - left.sortTime
        : left.title.localeCompare(right.title, locale)));
  }, [connectorMailKeys, connectorMails, locale, room.materials, t]);

  const localMailObject = detail?.kind === 'mail'
    ? room.materials.find((material) => material.id === detail.id && material.type === '邮件') ?? null
    : null;
  if (detail?.kind === 'mail' && localMailObject && onCloseDetail) {
    return (
      <div className="context-room-page context-room-object-page">
        <ObjectDetailView
          embedded
          room={room}
          object={{ kind: 'mail', value: localMailObject }}
          onBack={onCloseDetail}
          onUpdateRoom={onUpdateRoom}
        />
      </div>
    );
  }

  const connectorMailDetail = detail?.kind === 'connector-mail' ? detail : null;
  const mailDetailState = useConnectorMailDetail(room.id, connectorMailDetail?.sourceId ?? null);
  if (connectorMailDetail && onCloseDetail) {
    return <ConnectorMailDetailPanel state={mailDetailState} locale={locale} onClose={onCloseDetail} />;
  }

  return (
    <div className="context-room-mail-pane">
      <header>
        <Mail aria-hidden="true" />
        <h2>{t('contextRoom:todoPane.mailSection')}</h2>
        <span className="context-room-pane-head-count">{rows.length}</span>
      </header>
      <div className="context-room-mail-list" role="list">
        {rows.map((row) => (
          <button
            type="button"
            role="listitem"
            key={row.key}
            className={`context-room-mail-item${row.unread ? ' is-unread' : ''}`}
            onClick={() => onOpen(row.open)}
          >
            <span className="context-room-mail-item-icon">
              {row.provider ? <MailProviderIcon provider={row.provider} /> : <Mail aria-hidden="true" />}
            </span>
            <span className="context-room-mail-item-main">
              <b>{row.title}</b>
              <small>{row.subtitle}</small>
            </span>
            <time>{row.timeLabel}</time>
          </button>
        ))}
        {!rows.length ? (
          <PanelEmptyState
            compact
            icon={Mail}
            title={t('contextRoom:todoPane.noMailsYet')}
            description={t('contextRoom:todoPane.mailsInThisRoomWillAppearHere')}
          />
        ) : null}
      </div>
    </div>
  );
}
