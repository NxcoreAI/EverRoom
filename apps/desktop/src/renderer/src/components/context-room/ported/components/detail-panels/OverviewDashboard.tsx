import {
  BarChart3,
  Bookmark,
  CalendarDays,
  CheckSquare2,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  FileText,
  GitBranch,
  Info,
  Network,
  Zap,
} from 'lucide-react';
import type { RoomDocument } from '@nxcore/agent-contract';
import { useMemo, useState } from 'react';
import { useLocale, type Translate } from '../../../../../i18n/LocaleContext';

import { createContextRoomResourceLibrary } from '../../resources';
import { localizedUiText } from '../../adapters';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { useRoomUpdatedTime } from '../../roomUpdatedTime';
import { roomKindIcon, roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';
type WorkspaceObjectPreview =
  | { kind: 'meeting'; id: string }
  | { kind: 'task'; id: string };

type TimelineView = 'day' | 'week' | 'month';

// 时间轴的“今天”以会话启动时的真实日期为基准（原演示固定 2026-08-11 已移除）。
const REFERENCE_TODAY = new Date();

// 逐 Room 的 AI 状态文案覆盖表（原演示 Room 词条已移除）；缺省走下方真实数据派生。
const DASHBOARD_COPY: Record<
  string,
  { aiStatus: string; nextSteps: string[]; entities: Array<{ label: string; description: string }> }
> = {};

function parseRoomDate(value: string) {
  const date = new Date(REFERENCE_TODAY);
  date.setHours(0, 0, 0, 0);
  if (/^(今天|today)(?:\s|$)/iu.test(value)) return date;
  if (/^(昨天|yesterday)(?:\s|$)/iu.test(value)) {
    date.setDate(date.getDate() - 1);
    return date;
  }
  const match = value.match(/(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  return new Date(REFERENCE_TODAY.getFullYear(), Number(match[1]) - 1, Number(match[2]));
}

function startOfWeek(value: Date) {
  const result = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  result.setDate(result.getDate() + (result.getDay() === 0 ? -6 : 1 - result.getDay()));
  return result;
}

function inTimelineRange(value: Date | null, view: TimelineView, cursor: Date) {
  if (!value) return false;
  if (view === 'day') return value.toDateString() === cursor.toDateString();
  if (view === 'week') {
    const start = startOfWeek(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return value >= start && value < end;
  }
  return value.getFullYear() === cursor.getFullYear() && value.getMonth() === cursor.getMonth();
}

function timelineRangeLabel(view: TimelineView, cursor: Date, locale: string, t: Translate) {
  if (view === 'day') {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(cursor);
  }
  if (view === 'week') {
    const start = startOfWeek(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    return `${formatter.format(start)} ~ ${formatter.format(end)}`;
  }
  return t('contextRoom:overviewDashboard.monthYear', { year: cursor.getFullYear(), month: cursor.getMonth() + 1 });
}

function isTodayLabel(value: string): boolean {
  const now = new Date();
  const isoDate = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return /^(今天|today)(?:\s|$)/iu.test(value) || value.includes(isoDate);
}

function timeLabel(value: string): string {
  return value.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? value;
}

export function OverviewDashboard({
  room,
  backendDocuments,
  onSelectResource,
  onOpenObject,
  onToggleTask,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  onToggleTask: (taskId: string) => void;
}) {
  const { locale, t } = useLocale();
  const latestDocumentAt = backendDocuments.reduce<string | undefined>((latest, document) => (
    !latest || document.updatedAt > latest ? document.updatedAt : latest
  ), undefined);
  const updatedTime = useRoomUpdatedTime({
    updatedAt: latestDocumentAt && (!room.updatedAt || latestDocumentAt > room.updatedAt)
      ? latestDocumentAt
      : room.updatedAt,
    lastViewed: room.lastViewed,
  });
  const [timelineView, setTimelineView] = useState<TimelineView>('month');
  const [timelineCursor, setTimelineCursor] = useState(() => new Date(REFERENCE_TODAY));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const Icon = roomKindIcon(room.kind);
  const dashboard = DASHBOARD_COPY[room.id] ?? {
    aiStatus: room.generatedContext?.status || room.brief.status,
    nextSteps: room.generatedContext?.nextSteps.length
      ? room.generatedContext.nextSteps
      : room.actionItems.slice(0, 4).map((item) => item.title),
    entities: room.generatedContext?.entities.length
      ? room.generatedContext.entities.map((entity) => ({
          label: entity.name,
          description: `${entity.kind} · ${entity.description}`,
        }))
      : room.people.map((person) => ({ label: person.name, description: person.role })),
  };
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], locale),
    [backendDocuments, locale, room],
  );
  const visibleTimeline = room.timeline.filter((item) =>
    inTimelineRange(parseRoomDate(item.time), timelineView, timelineCursor)
  );
  const recentDocuments = [...backendDocuments]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
  const recentMaterials = room.materials.slice(0, Math.max(0, 3 - recentDocuments.length));
  const todayMeeting = room.materials.find((item) => item.type === '会议' && isTodayLabel(item.time));
  const openTasks = room.actionItems.filter((item) => !item.completed && item.status !== '已完成').slice(0, 3);
  const generatedOverview = room.generatedContext?.overview?.trim() ?? '';
  const hasBrief = Boolean(room.brief.background.trim() || room.brief.goal.trim());
  const hasOverview = Boolean(generatedOverview || hasBrief);
  const moveTimeline = (delta: number) =>
    setTimelineCursor((current) => {
      const next = new Date(current);
      if (timelineView === 'month') next.setMonth(next.getMonth() + delta);
      else next.setDate(next.getDate() + delta * (timelineView === 'week' ? 7 : 1));
      return next;
    });

  return (
    <section className="context-room-dashboard" data-testid="context-room-pane-overview">
      <header className="context-room-dashboard-hero">
        <span data-icon-tone={roomKindTone(room.kind)}><Icon aria-hidden="true" /></span>
        <div>
          <h1>{room.title}</h1>
          <p><CalendarDays aria-hidden="true" />{t('contextRoom:overviewDashboard.updatedTime', { time: updatedTime })} <i /> {t('contextRoom:overviewDashboard.countResources', { count: backendDocuments.length + room.materials.length + room.fileItems.length })}</p>
        </div>
        <b>{room.status}</b>
      </header>

      <div className="context-room-dashboard-grid">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" />{t('contextRoom:overviewDashboard.roomOverview')}</header>
          {hasOverview ? (
            <><p>{localizedUiText(generatedOverview || room.brief.background, t) || t('contextRoom:overviewDashboard.noBackgroundProvided')}</p><small><b>{t('contextRoom:overviewDashboard.goal')}</b>{localizedUiText(room.brief.goal, t) || t('contextRoom:overviewDashboard.notSet')}</small></>
          ) : (
            <PanelEmptyState compact icon={FileText} title={t('contextRoom:overviewDashboard.noOverviewYet')} description={t('contextRoom:overviewDashboard.theRoomBackgroundAndGoalsAppearHere')} />
          )}
        </article>
        <article>
          <header data-icon-tone="room"><BarChart3 aria-hidden="true" />{t('contextRoom:overviewDashboard.currentStatus')} <em>AI</em></header>
          {dashboard.aiStatus.trim() ? <p>{localizedUiText(dashboard.aiStatus, t)}</p> : <PanelEmptyState compact icon={Info} title={t('contextRoom:overviewDashboard.noStatusSummaryYet')} description={t('contextRoom:overviewDashboard.thisStatusWillUpdateAsNewResourcesAnd')} />}
        </article>
        <article>
          <header data-icon-tone="ai"><Zap aria-hidden="true" />{t('contextRoom:overviewDashboard.suggestedNextSteps')} <em>AI</em></header>
          {dashboard.nextSteps.length ? <ul>{dashboard.nextSteps.map((item) => <li key={item}><CornerDownRight aria-hidden="true" />{item}</li>)}</ul> : <PanelEmptyState compact icon={Zap} title={t('contextRoom:overviewDashboard.noNextStepSuggestionsYet')} description={t('contextRoom:overviewDashboard.suggestionsWillBeRegeneratedWhenNewContextEnters')} />}
        </article>
        <article>
          <header data-icon-tone="memory"><Bookmark aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedMemoryEntities')}</header>
          {dashboard.entities.length ? (
            <div className="context-room-dashboard-entities">
              {dashboard.entities.map((entity) => <span key={entity.label} title={entity.description}>{entity.label}</span>)}
            </div>
          ) : <PanelEmptyState compact icon={Network} title={t('contextRoom:overviewDashboard.noRelatedEntitiesYet')} description={t('contextRoom:overviewDashboard.detectedPeopleProjectsAndTopicsAppearHere')} />}
        </article>
      </div>

      <div className="context-room-dashboard-bottom">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" />{t('contextRoom:overviewDashboard.latestResources')}</header>
          {recentDocuments.map((document) => {
            const resource = library.resources.find((item) =>
              item.kind === 'cloud-doc' && item.binding.docId === document.id);
            return <button type="button" key={document.id} onClick={() => resource && onSelectResource(resource)}><span>{t('contextRoom:overviewDashboard.document')}</span><b>{document.title}</b><time>{new Date(document.updatedAt).toLocaleString(locale)}</time></button>;
          })}
          {recentMaterials.map((material) => {
            const resource = library.resources.find((item) => item.name === material.title);
            return <button type="button" key={material.id} onClick={() => resource && onSelectResource(resource)}><span>{material.type}</span><b>{material.title}</b><time>{material.time}</time></button>;
          })}
          {!recentDocuments.length && !recentMaterials.length ? <PanelEmptyState compact icon={FileText} title={t('contextRoom:overviewDashboard.noResourcesYet')} description={t('contextRoom:overviewDashboard.documentsEmailsAndMeetingsCollectedByTheRoom')} /> : null}
        </article>
        <article>
          <header data-icon-tone="calendar"><CalendarDays aria-hidden="true" />{t('contextRoom:overviewDashboard.todaySSchedule')}</header>
          {todayMeeting ? <button type="button" onClick={() => onOpenObject({ kind: 'meeting', id: todayMeeting.id })}><time>{timeLabel(todayMeeting.time)}</time><b>{todayMeeting.title}</b></button> : <PanelEmptyState compact icon={CalendarDays} title={t('contextRoom:overviewDashboard.nothingScheduledToday')} description={t('contextRoom:overviewDashboard.todaySMeetingsAndDueTasksAppearHere')} />}
        </article>
        <article>
          <header data-icon-tone="task"><CheckSquare2 aria-hidden="true" />{t('contextRoom:overviewDashboard.toDoTasks')}</header>
          {openTasks.map((task) => <div className="context-room-dashboard-task" key={task.id}><button type="button" aria-label={t('contextRoom:overviewDashboard.completeTitle', { title: task.title })} onClick={() => onToggleTask(task.id)}><i /></button><button type="button" onClick={() => onOpenObject({ kind: 'task', id: task.id })}><b>{task.title}</b><time>{t(localizedUiText(task.deadline, t))}</time></button></div>)}
          {!openTasks.length ? <PanelEmptyState compact icon={CheckSquare2} title={t('contextRoom:overviewDashboard.noToDoTasks')} description={t('contextRoom:overviewDashboard.incompleteRoomTasksAppearHere')} /> : null}
        </article>
      </div>

      <article className="context-room-dashboard-timeline">
        <header data-icon-tone="data"><GitBranch aria-hidden="true" />{t('contextRoom:overviewDashboard.roomTimeline')} <span>{t('contextRoom:overviewDashboard.countEvents', { count: visibleTimeline.length })}</span></header>
        <div className="context-room-timeline-toolbar">
          <div>{(['day', 'week', 'month'] as const).map((view) => <button type="button" key={view} aria-pressed={timelineView === view} onClick={() => setTimelineView(view)}>{t(view === 'day' ? 'contextRoom:overviewDashboard.day' : view === 'week' ? 'contextRoom:overviewDashboard.week' : 'contextRoom:overviewDashboard.month')}</button>)}</div>
          <nav aria-label={t('contextRoom:overviewDashboard.timelineRange')}>
            <button type="button" aria-label={t('contextRoom:overviewDashboard.previousPeriod')} onClick={() => moveTimeline(-1)}><ChevronLeft aria-hidden="true" /></button>
            <span>{timelineRangeLabel(timelineView, timelineCursor, locale, t)}</span>
            <button type="button" aria-label={t('contextRoom:overviewDashboard.nextPeriod')} onClick={() => moveTimeline(1)}><ChevronRight aria-hidden="true" /></button>
            <button type="button" disabled={timelineCursor.toDateString() === REFERENCE_TODAY.toDateString()} onClick={() => setTimelineCursor(new Date(REFERENCE_TODAY))}>{t('contextRoom:overviewDashboard.today')}</button>
          </nav>
        </div>
        {visibleTimeline.length ? <ol>{visibleTimeline.map((item, index) => {
          const material = recentMaterials[index] as (typeof recentMaterials)[number] | undefined;
          const resource = material ? library.resources.find((candidate) => candidate.name === material.title) : null;
          return <li key={`${item.time}-${item.title}`}><i data-kind={item.kind} /><div><div><b>{item.title}</b><time>{item.time}</time></div><p>{item.description}</p>{resource ? <><button type="button" aria-expanded={expanded.has(index)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}><ChevronRight aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedResources')} <span>1</span></button>{expanded.has(index) ? <button type="button" className="context-room-timeline-material" onClick={() => onSelectResource(resource)}><FileText aria-hidden="true" />{resource.name}</button> : null}</> : null}</div></li>;
        })}</ol> : <PanelEmptyState compact icon={GitBranch} title={t('contextRoom:overviewDashboard.noEventsInThisRange')} description={t('contextRoom:overviewDashboard.changeTheDateRangeToSeeOtherRoom')} />}
      </article>
    </section>
  );
}
