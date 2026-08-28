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
  LoaderCircle,
  Network,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { RoomDocument, RoomOverviewEvidence, RoomOverviewProjection } from '@nxcore/agent-contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, type Translate } from '../../../../../i18n/LocaleContext';
import { useContextRoomState } from '../../../ContextRoomStateProvider';
import { showToast } from '@/state/toast';
import { RoomOverviewCitationControls } from '../../../RoomOverviewCitationControls';
import {
  preferRoomOverviewProjection,
  ROOM_OVERVIEW_CHANGED_EVENT,
  type RoomOverviewChangedDetail,
} from '../../../roomOverviewChange';
import { recordRoomOverviewDiagnostic } from '../../../roomOverviewDiagnostics';

import { createContextRoomResourceLibrary } from '../../resources';
import { localizedUiText, uiText } from '../../adapters';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { useRoomUpdatedTime } from '../../roomUpdatedTime';
import { formatTimelineTime, parseTimelineDate } from '../../roomTimeline';
import { roomKindIcon, roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';
type WorkspaceObjectPreview =
  | { kind: 'meeting'; id: string }
  | { kind: 'task'; id: string };

type TimelineView = 'day' | 'week' | 'month';

/** 时间轴条目的统一视图形状：投影条目与本地快照条目共用同一渲染路径。 */
type TimelineEntry = {
  id: string;
  /** null = 无日期事件（解析不到发生时间），排序沉底、不参与日期范围过滤。 */
  time: string | null;
  title: string;
  description: string;
  kind: 'done' | 'warn' | 'info';
  generated: boolean;
  evidence: RoomOverviewEvidence[];
};

/** 证据去重（同来源多版本只展示一次）并按展示预算截断。 */
function timelineMaterials(evidence: RoomOverviewEvidence[]): RoomOverviewEvidence[] {
  const unique: RoomOverviewEvidence[] = [];
  for (const source of evidence) {
    if (unique.some((candidate) =>
      candidate.sourceKind === source.sourceKind && candidate.sourceId === source.sourceId)) continue;
    unique.push(source);
  }
  return unique.slice(0, 4);
}

/** 证据 → 可跳转资源：云文档/上传文件有对应资源；连接器来源仅作标签展示。 */
function timelineResource(source: RoomOverviewEvidence, resources: ContextRoomResource[]): ContextRoomResource | null {
  if (source.sourceKind === 'everroom-doc') {
    return resources.find((item) => item.kind === 'cloud-doc' && item.binding.docId === source.sourceId) ?? null;
  }
  if (source.sourceKind === 'file') {
    return resources.find((item) => item.kind === 'knowledge-file' && item.fileId === source.sourceId) ?? null;
  }
  return null;
}

// 逐 Room 的 AI 状态文案覆盖表（原演示 Room 词条已移除）；缺省走下方真实数据派生。
const DASHBOARD_COPY: Record<
  string,
  {
    aiStatus: string;
    nextSteps: Array<{ id: string; text: string; owner: string | null; dueAt: string | null; itemType: string }>;
    entities: Array<{ label: string; description: string }>;
  }
> = {};

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

/** ISO 截止时间是否落在本地“今天”（日程/待办 claim 的当日判断）。 */
function isDueToday(value: string | null): boolean {
  if (!value) return false;
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return false;
  const now = new Date();
  return due.getFullYear() === now.getFullYear()
    && due.getMonth() === now.getMonth()
    && due.getDate() === now.getDate();
}

function timeLabel(value: string): string {
  return value.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? value;
}

export function OverviewDashboard({
  room,
  backendDocuments,
  knowledgeFiles,
  onSelectResource,
  onOpenObject,
  onToggleTask,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  onToggleTask: (taskId: string) => void;
}) {
  const { locale, t } = useLocale();
  const { refreshFromBackend } = useContextRoomState();
  const dashboardRef = useRef<HTMLElement>(null);
  const [overviewProjection, setOverviewProjection] = useState<RoomOverviewProjection | null>(null);
  const [regeneratingBrief, setRegeneratingBrief] = useState(false);
  // “今天”每次渲染实时取值，避免长驻窗口跨天后“今天”按钮与范围判断失真。
  const today = new Date();
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
  const [timelineCursor, setTimelineCursor] = useState(() => new Date());
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const Icon = roomKindIcon(room.kind);
  const dashboard = DASHBOARD_COPY[room.id] ?? {
    aiStatus: overviewProjection?.status.map((item) => item.text).join('\n')
      || room.generatedContext?.status || room.brief.status,
    nextSteps: overviewProjection?.nextSteps.length
      ? overviewProjection.nextSteps.map((item) => ({
          id: item.id,
          text: item.text,
          owner: item.data?.kind === 'next_step' ? item.data.owner : null,
          dueAt: item.data?.kind === 'next_step' ? item.data.dueAt : null,
          itemType: item.data?.kind === 'next_step' ? item.data.itemType : 'suggestion',
        }))
      : room.generatedContext?.nextSteps.length
        ? room.generatedContext.nextSteps.map((item, index) => ({
            id: `generated-${index}`, text: item, owner: null, dueAt: null, itemType: 'suggestion',
          }))
      : room.actionItems.slice(0, 4).map((item) => ({
          id: item.id, text: item.title, owner: item.owner || null, dueAt: item.deadline || null, itemType: 'task',
        })),
    entities: overviewProjection?.entities.length
      ? overviewProjection.entities.map((entity) => ({
          id: entity.id,
          text: entity.text,
          label: entity.text.split('：')[0] || entity.text,
          description: entity.data?.kind === 'entity'
            ? `${entity.data.entityKind} · ${entity.text} · ${entity.data.mentionCount}`
            : entity.text,
        }))
      : room.generatedContext?.entities.length
      ? room.generatedContext.entities.map((entity) => ({
          label: entity.name,
          description: `${t(uiText(entity.kind))} · ${entity.description}`,
        }))
      : room.people.map((person) => ({ label: person.name, description: person.role })),
  };
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room],
  );
  const projectedTimeline: TimelineEntry[] = overviewProjection?.timeline.length
    ? overviewProjection.timeline.map((item) => ({
        id: item.id,
        time: item.occurredAt ?? null,
        title: item.data?.kind === 'timeline' ? item.data.title : item.text,
        description: item.data?.kind === 'timeline'
          ? item.data.description || (item.data.certainty === 'inference' ? t('contextRoom:overviewDashboard.inferredTimelineEntry') : '')
          : item.origin === 'inference' ? t('contextRoom:overviewDashboard.inferredTimelineEntry') : '',
        kind: item.origin === 'inference' ? 'info' as const : 'done' as const,
        generated: item.origin !== 'user',
        evidence: item.evidence,
      }))
    : room.timeline.map((item, index) => ({
        id: `local:${index}:${item.time}:${item.title}`,
        time: item.time || null,
        title: item.title,
        description: item.description,
        kind: item.kind,
        generated: item.generated === true,
        evidence: item.sourceDocumentId
          ? [{ sourceKind: 'everroom-doc', sourceId: item.sourceDocumentId, sourceTitle: null }]
          : [],
      }));
  // 不信任后端返回顺序：本地按发生时间倒序重排，无日期事件沉底但始终可见。
  const visibleTimeline = projectedTimeline
    .filter((item) => {
      const when = parseTimelineDate(item.time ?? '', today);
      return when === null || inTimelineRange(when, timelineView, timelineCursor);
    })
    .sort((left, right) => {
      const leftDate = parseTimelineDate(left.time ?? '', today);
      const rightDate = parseTimelineDate(right.time ?? '', today);
      if (leftDate && rightDate) return rightDate.getTime() - leftDate.getTime();
      if (leftDate) return -1;
      if (rightDate) return 1;
      return 0;
    });
  const recentDocuments = [...backendDocuments]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
  const recentMaterials = room.materials.slice(0, Math.max(0, 3 - recentDocuments.length));
  const todayMeeting = room.materials.find((item) => item.type === '会议' && isTodayLabel(item.time));
  const openTasks = room.actionItems.filter((item) => !item.completed && item.status !== '已完成').slice(0, 3);
  // 确定性投影叠加：连接器日历/待办 claim（只读展示，不参与本地任务勾选）。
  const projectionNextSteps = overviewProjection?.nextSteps ?? [];
  const projectionSchedules = projectionNextSteps.filter((item) =>
    item.data?.kind === 'next_step' && item.data.itemType === 'schedule' && isDueToday(item.data.dueAt)).slice(0, 2);
  const openTaskTitles = new Set(openTasks.map((task) => task.title.trim().toLocaleLowerCase()));
  const projectionTasks = projectionNextSteps.filter((item) =>
    item.data?.kind === 'next_step' && item.data.itemType === 'task'
    && !openTaskTitles.has(item.text.trim().toLocaleLowerCase())).slice(0, 3);
  const overviewClaims = overviewProjection?.overview
    .filter((item) => item.data?.kind !== 'overview' || item.data.aspect !== 'goal') ?? [];
  const generatedOverview = overviewClaims
    .map((item) => item.text).join('\n').trim()
    || room.generatedContext?.overview?.trim() || '';
  const goalClaim = overviewProjection?.overview.find((item) =>
    item.data?.kind === 'overview' && item.data.aspect === 'goal');
  const projectedGoal = goalClaim?.text || room.brief.goal;
  const projectedNextStepIds = new Set(overviewProjection?.nextSteps.map((item) => item.id) ?? []);
  const projectedTimelineIds = new Set(overviewProjection?.timeline.map((item) => item.id) ?? []);
  const projectedTimelineText = new Map(overviewProjection?.timeline.map((item) => [item.id, item.text]) ?? []);
  const hasBrief = Boolean(room.brief.background.trim() || room.brief.goal.trim());
  const hasOverview = Boolean(generatedOverview || hasBrief);

  const loadOverview = useCallback(async () => {
    const api = window.nxcore?.contextRooms;
    if (!api?.overview) {
      recordRoomOverviewDiagnostic('load.skipped', { roomId: room.id, reason: 'api_unavailable' }, 'warn');
      return;
    }
    recordRoomOverviewDiagnostic('load.started', { roomId: room.id });
    try {
      const projection = await api.overview(room.id);
      setOverviewProjection((current) => {
        const preferred = preferRoomOverviewProjection(current, projection);
        recordRoomOverviewDiagnostic(preferred === projection ? 'projection.applied' : 'projection.discarded', {
          roomId: room.id,
          source: 'load',
          currentRevision: current?.revision ?? null,
          incomingRevision: projection.revision,
        }, preferred === projection ? 'info' : 'warn');
        return preferred;
      });
      recordRoomOverviewDiagnostic('load.completed', {
        roomId: room.id,
        revision: projection.revision,
        overviewCount: projection.overview.length,
        statusCount: projection.status.length,
        nextStepsCount: projection.nextSteps.length,
        timelineCount: projection.timeline.length,
        entityCount: projection.entities.length,
      });
    } catch (error) {
      recordRoomOverviewDiagnostic('load.failed', {
        roomId: room.id,
        errorType: error instanceof Error ? error.name : typeof error,
      }, 'error');
      // Keep the last-good Room snapshot visible when the projection service is unavailable.
    }
  }, [room.id]);

  useEffect(() => {
    void loadOverview();
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<RoomOverviewChangedDetail>).detail;
      if (detail?.roomId && detail.roomId !== room.id) {
        recordRoomOverviewDiagnostic('change.ignored', {
          roomId: room.id,
          changedRoomId: detail.roomId,
          reason: 'room_mismatch',
        });
        return;
      }
      const projection = detail?.projection;
      if (!projection) {
        recordRoomOverviewDiagnostic('change.received', {
          roomId: room.id,
          mode: 'invalidation',
        }, 'warn');
        void loadOverview();
        return;
      }
      recordRoomOverviewDiagnostic('change.received', {
        roomId: room.id,
        mode: 'projection',
        revision: projection.revision,
      });
      setOverviewProjection((current) => {
        const preferred = preferRoomOverviewProjection(current, projection);
        recordRoomOverviewDiagnostic(preferred === projection ? 'projection.applied' : 'projection.discarded', {
          roomId: room.id,
          source: 'event',
          currentRevision: current?.revision ?? null,
          incomingRevision: projection.revision,
        }, preferred === projection ? 'info' : 'warn');
        return preferred;
      });
    };
    window.addEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
    return () => window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
  }, [loadOverview, room.id]);

  const moveTimeline = (delta: number) =>
    setTimelineCursor((current) => {
      const next = new Date(current);
      if (timelineView === 'month') next.setMonth(next.getMonth() + delta);
      else next.setDate(next.getDate() + delta * (timelineView === 'week' ? 7 : 1));
      return next;
    });
  // 简报再生成：dispatch context-room 子 Agent（brief-refresh），完成后拉取后端快照刷新本地状态。
  const regenerateBrief = useCallback(async () => {
    const api = window.nxcore?.contextRooms;
    if (!api || regeneratingBrief) return;
    setRegeneratingBrief(true);
    try {
      await api.refreshBrief(room.id);
      await refreshFromBackend();
      setOverviewProjection(await api.refreshOverview(room.id));
      showToast({ title: t('contextRoom:overviewDashboard.briefRegenerated') });
    } catch (error) {
      showToast({
        title: t('contextRoom:overviewDashboard.briefRegenerateFailed'),
        message: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setRegeneratingBrief(false);
    }
  }, [refreshFromBackend, regeneratingBrief, room.id, t]);

  return (
    <section ref={dashboardRef} className="context-room-dashboard" data-testid="context-room-pane-overview">
      <RoomOverviewCitationControls rootRef={dashboardRef} roomId={room.id} roomTitle={room.title} />
      <header className="context-room-dashboard-hero">
        <span data-icon-tone={roomKindTone(room.kind)}><Icon aria-hidden="true" /></span>
        <div>
          <h1>{room.title}</h1>
          <p><CalendarDays aria-hidden="true" />{t('contextRoom:overviewDashboard.updatedTime', { time: updatedTime })} <i /> {t('contextRoom:overviewDashboard.countResources', { count: backendDocuments.length + room.materials.length + room.fileItems.length })}</p>
        </div>
        <b>{t(uiText(room.status))}</b>
      </header>

      <div className="context-room-dashboard-grid">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" />{t('contextRoom:overviewDashboard.roomOverview')}
            <button
              type="button"
              className="context-room-dashboard-regenerate"
              disabled={regeneratingBrief}
              onClick={() => void regenerateBrief()}
            >
              {regeneratingBrief
                ? <LoaderCircle aria-hidden="true" data-spin="true" />
                : <Sparkles aria-hidden="true" />}
              {t(regeneratingBrief
                ? 'contextRoom:overviewDashboard.regeneratingBrief'
                : 'contextRoom:overviewDashboard.regenerateBrief')}
            </button>
          </header>
          {hasOverview ? (
            <>
              <p data-room-citation-section="overview">
                {overviewClaims.length
                  ? overviewClaims.map((claim, index) => <span key={claim.id} data-room-citation-claim-id={claim.id} data-room-citation-claim-text={claim.text}>{index ? ' ' : ''}{localizedUiText(claim.text, t)}</span>)
                  : localizedUiText(generatedOverview || room.brief.background, t) || t('contextRoom:overviewDashboard.noBackgroundProvided')}
              </p>
              <small data-room-citation-section="overview"><b>{t('contextRoom:overviewDashboard.goal')}</b><span data-room-citation-claim-id={goalClaim?.id} data-room-citation-claim-text={goalClaim?.text}>{localizedUiText(projectedGoal, t) || t('contextRoom:overviewDashboard.notSet')}</span></small>
            </>
          ) : (
            <PanelEmptyState compact icon={FileText} title={t('contextRoom:overviewDashboard.noOverviewYet')} description={t('contextRoom:overviewDashboard.theRoomBackgroundAndGoalsAppearHere')} />
          )}
        </article>
        <article>
          <header data-icon-tone="room"><BarChart3 aria-hidden="true" />{t('contextRoom:overviewDashboard.currentStatus')} <em>AI</em></header>
          {dashboard.aiStatus.trim() ? <p data-room-citation-section="status">{overviewProjection?.status.length
            ? overviewProjection.status.map((claim, index) => <span key={claim.id} data-room-citation-claim-id={claim.id} data-room-citation-claim-text={claim.text}>{index ? ' ' : ''}{localizedUiText(claim.text, t)}</span>)
            : localizedUiText(dashboard.aiStatus, t)}</p> : <PanelEmptyState compact icon={Info} title={t('contextRoom:overviewDashboard.noStatusSummaryYet')} description={t('contextRoom:overviewDashboard.thisStatusWillUpdateAsNewResourcesAnd')} />}
        </article>
        <article>
          <header data-icon-tone="ai"><Zap aria-hidden="true" />{t('contextRoom:overviewDashboard.suggestedNextSteps')} <em>AI</em></header>
          {dashboard.nextSteps.length ? <ul data-room-citation-section="next_steps">{dashboard.nextSteps.map((item) => <li key={item.id} title={[item.owner, item.dueAt].filter(Boolean).join(' · ')} data-item-type={item.itemType} data-room-citation-claim-id={projectedNextStepIds.has(item.id) ? item.id : undefined} data-room-citation-claim-text={projectedNextStepIds.has(item.id) ? item.text : undefined}><CornerDownRight aria-hidden="true" />{item.text}</li>)}</ul> : <PanelEmptyState compact icon={Zap} title={t('contextRoom:overviewDashboard.noNextStepSuggestionsYet')} description={t('contextRoom:overviewDashboard.suggestionsWillBeRegeneratedWhenNewContextEnters')} />}
        </article>
        <article>
          <header data-icon-tone="memory"><Bookmark aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedMemoryEntities')}</header>
          {dashboard.entities.length ? (
            <div className="context-room-dashboard-entities" data-room-citation-section="entities">
              {dashboard.entities.map((entity) => <span key={entity.label} title={entity.description} data-room-citation-claim-id={'id' in entity ? entity.id : undefined} data-room-citation-claim-text={'text' in entity ? entity.text : undefined}>{entity.label}</span>)}
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
          {todayMeeting ? <button type="button" onClick={() => onOpenObject({ kind: 'meeting', id: todayMeeting.id })}><time>{timeLabel(todayMeeting.time)}</time><b>{todayMeeting.title}</b></button> : null}
          {projectionSchedules.map((item) => (
            <button type="button" key={item.id} data-item-type="schedule" data-connector-source="calendar-event" title={item.data?.kind === 'next_step' && item.data.dueAt ? new Date(item.data.dueAt).toLocaleString(locale) : undefined}>
              <time>{item.data?.kind === 'next_step' && item.data.dueAt
                ? new Date(item.data.dueAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
                : ''}</time>
              <b>{item.text}</b>
            </button>
          ))}
          {!todayMeeting && !projectionSchedules.length ? <PanelEmptyState compact icon={CalendarDays} title={t('contextRoom:overviewDashboard.nothingScheduledToday')} description={t('contextRoom:overviewDashboard.todaySMeetingsAndDueTasksAppearHere')} /> : null}
        </article>
        <article>
          <header data-icon-tone="task"><CheckSquare2 aria-hidden="true" />{t('contextRoom:overviewDashboard.toDoTasks')}</header>
          {openTasks.map((task) => <div className="context-room-dashboard-task" key={task.id}><button type="button" aria-label={t('contextRoom:overviewDashboard.completeTitle', { title: task.title })} onClick={() => onToggleTask(task.id)}><i /></button><button type="button" onClick={() => onOpenObject({ kind: 'task', id: task.id })}><b>{task.title}</b><time>{t(localizedUiText(task.deadline, t))}</time></button></div>)}
          {projectionTasks.map((item) => (
            <button type="button" key={item.id} data-item-type="task" data-connector-source="todo" title={item.data?.kind === 'next_step' && item.data.dueAt ? new Date(item.data.dueAt).toLocaleString(locale) : undefined}>
              <span>{t('contextRoom:memory.sourceKind.todo')}</span>
              <b>{item.text}</b>
              <time>{item.data?.kind === 'next_step' && item.data.dueAt
                ? new Date(item.data.dueAt).toLocaleDateString(locale)
                : ''}</time>
            </button>
          ))}
          {!openTasks.length && !projectionTasks.length ? <PanelEmptyState compact icon={CheckSquare2} title={t('contextRoom:overviewDashboard.noToDoTasks')} description={t('contextRoom:overviewDashboard.incompleteRoomTasksAppearHere')} /> : null}
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
            <button type="button" disabled={timelineCursor.toDateString() === today.toDateString()} onClick={() => setTimelineCursor(new Date())}>{t('contextRoom:overviewDashboard.today')}</button>
          </nav>
        </div>
        {visibleTimeline.length ? <ol data-room-citation-section="timeline">{visibleTimeline.map((item, index) => {
          // 相关资料按证据来源解析：云文档/上传文件可跳转，连接器来源等展示来源标签
          const materials = timelineMaterials(item.evidence);
          return <li key={item.id} data-room-citation-claim-id={projectedTimelineIds.has(item.id) ? item.id : undefined} data-room-citation-claim-text={projectedTimelineText.get(item.id)}><i data-kind={item.kind} /><div><div><b>{localizedUiText(item.title, t)}</b>{item.time ? <time>{formatTimelineTime(item.time, locale)}</time> : null}</div>{item.description ? <p>{localizedUiText(item.description, t)}</p> : null}{materials.length ? <><button type="button" aria-expanded={expanded.has(index)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}><ChevronRight aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedResources')} <span>{materials.length}</span></button>{expanded.has(index) ? <div className="context-room-timeline-materials">{materials.map((source) => {
            const resource = timelineResource(source, library.resources);
            const label = resource ? resource.name : source.sourceTitle || t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
            return resource
              ? <button type="button" key={`${source.sourceKind}:${source.sourceId}`} className="context-room-timeline-material" onClick={() => onSelectResource(resource)}><FileText aria-hidden="true" />{label}</button>
              : <span key={`${source.sourceKind}:${source.sourceId}`} className="context-room-timeline-material is-plain"><FileText aria-hidden="true" />{label}</span>;
          })}</div> : null}</> : null}</div></li>;
        })}</ol> : <PanelEmptyState compact icon={GitBranch} title={t('contextRoom:overviewDashboard.noEventsInThisRange')} description={t('contextRoom:overviewDashboard.changeTheDateRangeToSeeOtherRoom')} />}
      </article>
    </section>
  );
}
