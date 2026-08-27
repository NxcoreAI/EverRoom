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
  MessageSquarePlus,
  Network,
  Quote,
  Sparkles,
  Zap,
} from 'lucide-react';
import type { RoomDocument, RoomOverviewProjection } from '@nxcore/agent-contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, type Translate } from '../../../../../i18n/LocaleContext';
import { useContextRoomState } from '../../../ContextRoomStateProvider';
import { showToast } from '@/state/toast';

import { createContextRoomResourceLibrary } from '../../resources';
import { localizedUiText, uiText } from '../../adapters';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { useRoomUpdatedTime } from '../../roomUpdatedTime';
import { formatTimelineTime, parseTimelineDate } from '../../roomTimeline';
import { roomKindIcon, roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';
import {
  addRoomOverviewCitation,
  ROOM_OVERVIEW_CITATION_CLEAR_EVENT,
  type RoomOverviewCitation,
  type RoomOverviewCitationSection,
} from '../../../roomOverviewCitation';
type WorkspaceObjectPreview =
  | { kind: 'meeting'; id: string }
  | { kind: 'task'; id: string };

type TimelineView = 'day' | 'week' | 'month';
type SelectionOverlay = { section: RoomOverviewCitationSection; text: string; top: number; left: number };

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

// 时间轴的“今天”以会话启动时的真实日期为基准（原演示固定 2026-08-11 已移除）。
const REFERENCE_TODAY = new Date();

// 逐 Room 的 AI 状态文案覆盖表（原演示 Room 词条已移除）；缺省走下方真实数据派生。
const DASHBOARD_COPY: Record<
  string,
  { aiStatus: string; nextSteps: string[]; entities: Array<{ label: string; description: string }> }
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
  const { refreshFromBackend } = useContextRoomState();
  const dashboardRef = useRef<HTMLElement>(null);
  const citedRangeRef = useRef<Range | null>(null);
  const [selectionOverlay, setSelectionOverlay] = useState<SelectionOverlay | null>(null);
  const [citation, setCitation] = useState<RoomOverviewCitation | null>(null);
  const [citationBadge, setCitationBadge] = useState<{ top: number; left: number } | null>(null);
  const [overviewProjection, setOverviewProjection] = useState<RoomOverviewProjection | null>(null);
  const [regeneratingBrief, setRegeneratingBrief] = useState(false);
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
    aiStatus: overviewProjection?.status.map((item) => item.text).join('\n')
      || room.generatedContext?.status || room.brief.status,
    nextSteps: overviewProjection?.nextSteps.length
      ? overviewProjection.nextSteps.map((item) => item.text)
      : room.generatedContext?.nextSteps.length
        ? room.generatedContext.nextSteps
      : room.actionItems.slice(0, 4).map((item) => item.title),
    entities: overviewProjection?.entities.length
      ? overviewProjection.entities.map((entity) => ({
          label: entity.text.split('：')[0] || entity.text,
          description: entity.text,
        }))
      : room.generatedContext?.entities.length
      ? room.generatedContext.entities.map((entity) => ({
          label: entity.name,
          description: `${t(uiText(entity.kind))} · ${entity.description}`,
        }))
      : room.people.map((person) => ({ label: person.name, description: person.role })),
  };
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], locale),
    [backendDocuments, locale, room],
  );
  const projectedTimeline = overviewProjection?.timeline.length
    ? overviewProjection.timeline.map((item) => ({
        time: item.occurredAt || overviewProjection.generatedAt,
        title: item.text,
        description: item.origin === 'inference' ? t('contextRoom:overviewDashboard.inferredTimelineEntry') : '',
        kind: item.origin === 'inference' ? 'info' as const : 'done' as const,
        generated: item.origin !== 'user',
        sourceDocumentId: item.evidence.find((source) => source.sourceKind === 'everroom-doc')?.sourceId,
      }))
    : room.timeline;
  const visibleTimeline = projectedTimeline.filter((item) =>
    inTimelineRange(parseTimelineDate(item.time, REFERENCE_TODAY), timelineView, timelineCursor)
  );
  const recentDocuments = [...backendDocuments]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
  const recentMaterials = room.materials.slice(0, Math.max(0, 3 - recentDocuments.length));
  const todayMeeting = room.materials.find((item) => item.type === '会议' && isTodayLabel(item.time));
  const openTasks = room.actionItems.filter((item) => !item.completed && item.status !== '已完成').slice(0, 3);
  const generatedOverview = overviewProjection?.overview.map((item) => item.text).join('\n').trim()
    || room.generatedContext?.overview?.trim() || '';
  const hasBrief = Boolean(room.brief.background.trim() || room.brief.goal.trim());
  const hasOverview = Boolean(generatedOverview || hasBrief);

  const clearCitation = useCallback(() => {
    const highlights = (CSS as unknown as { highlights?: { delete: (name: string) => void } }).highlights;
    highlights?.delete('room-overview-citation');
    citedRangeRef.current = null;
    setCitation(null);
    setCitationBadge(null);
  }, []);

  useEffect(() => {
    const root = dashboardRef.current;
    if (!root) return undefined;
    const readSelection = () => {
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelectionOverlay(null);
        return;
      }
      const anchor = elementOf(selection.anchorNode)?.closest<HTMLElement>('[data-room-citation-section]');
      const focus = elementOf(selection.focusNode)?.closest<HTMLElement>('[data-room-citation-section]');
      if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)
        || anchor.dataset.roomCitationSection !== focus.dataset.roomCitationSection) {
        setSelectionOverlay(null);
        return;
      }
      const text = selection.toString().replace(/\s+/g, ' ').trim().slice(0, 8_000);
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!text || rect.width === 0 || rect.height === 0) {
        setSelectionOverlay(null);
        return;
      }
      setSelectionOverlay({
        section: anchor.dataset.roomCitationSection as RoomOverviewCitationSection,
        text,
        top: Math.max(8, rect.top - 38),
        left: Math.min(window.innerWidth - 176, Math.max(8, rect.left + rect.width / 2 - 80)),
      });
    };
    root.addEventListener('mouseup', readSelection);
    root.addEventListener('keyup', readSelection);
    return () => {
      root.removeEventListener('mouseup', readSelection);
      root.removeEventListener('keyup', readSelection);
    };
  }, []);

  useEffect(() => {
    const clear = (event: Event) => {
      if ((event as CustomEvent<string>).detail === citation?.id) clearCitation();
    };
    window.addEventListener(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, clear as EventListener);
    return () => window.removeEventListener(ROOM_OVERVIEW_CITATION_CLEAR_EVENT, clear as EventListener);
  }, [citation?.id, clearCitation]);

  useEffect(() => {
    if (!citation) return undefined;
    const syncBadge = () => {
      const rect = citedRangeRef.current?.getBoundingClientRect();
      setCitationBadge(rect ? { top: rect.bottom - 7, left: rect.right - 5 } : null);
    };
    syncBadge();
    const root = dashboardRef.current;
    root?.addEventListener('scroll', syncBadge, { passive: true });
    window.addEventListener('resize', syncBadge);
    return () => {
      root?.removeEventListener('scroll', syncBadge);
      window.removeEventListener('resize', syncBadge);
    };
  }, [citation]);

  const loadOverview = useCallback(async () => {
    const api = window.nxcore?.contextRooms;
    if (!api?.overview) return;
    try {
      setOverviewProjection(await api.overview(room.id));
    } catch {
      // Keep the last-good Room snapshot visible when the projection service is unavailable.
    }
  }, [room.id]);

  useEffect(() => {
    void loadOverview();
    const refresh = (event: Event) => {
      const changedRoomId = (event as CustomEvent<{ roomId?: string }>).detail?.roomId;
      if (!changedRoomId || changedRoomId === room.id) void loadOverview();
    };
    window.addEventListener('nxcore:room-overview-changed', refresh as EventListener);
    return () => window.removeEventListener('nxcore:room-overview-changed', refresh as EventListener);
  }, [loadOverview, room.id]);

  const addSelectionToAgent = useCallback(() => {
    const selection = document.getSelection();
    if (!selectionOverlay || !selection || selection.rangeCount === 0) return;
    clearCitation();
    const range = selection.getRangeAt(0).cloneRange();
    citedRangeRef.current = range;
    const HighlightConstructor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const highlights = (CSS as unknown as { highlights?: { set: (name: string, value: unknown) => void } }).highlights;
    if (HighlightConstructor && highlights) highlights.set('room-overview-citation', new HighlightConstructor(range));
    const next: RoomOverviewCitation = {
      id: crypto.randomUUID(),
      roomId: room.id,
      roomTitle: room.title,
      section: selectionOverlay.section,
      text: selectionOverlay.text,
    };
    setCitation(next);
    const rect = range.getBoundingClientRect();
    setCitationBadge({ top: rect.bottom - 7, left: rect.right - 5 });
    setSelectionOverlay(null);
    selection.removeAllRanges();
    addRoomOverviewCitation(next);
  }, [clearCitation, room.id, room.title, selectionOverlay]);
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
      {selectionOverlay ? (
        <button
          type="button"
          className="context-room-selection-to-agent"
          style={{ top: selectionOverlay.top, left: selectionOverlay.left }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={addSelectionToAgent}
        >
          <MessageSquarePlus aria-hidden="true" />
          {t('contextRoom:overviewDashboard.addToAgent')}
        </button>
      ) : null}
      {citation && citationBadge ? (
        <span
          className="context-room-citation-badge"
          title={t('contextRoom:overviewDashboard.referencedByAgent')}
          style={citationBadge}
        ><Quote aria-hidden="true" /></span>
      ) : null}
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
            <><p data-room-citation-section="overview">{localizedUiText(generatedOverview || room.brief.background, t) || t('contextRoom:overviewDashboard.noBackgroundProvided')}</p><small data-room-citation-section="overview"><b>{t('contextRoom:overviewDashboard.goal')}</b>{localizedUiText(room.brief.goal, t) || t('contextRoom:overviewDashboard.notSet')}</small></>
          ) : (
            <PanelEmptyState compact icon={FileText} title={t('contextRoom:overviewDashboard.noOverviewYet')} description={t('contextRoom:overviewDashboard.theRoomBackgroundAndGoalsAppearHere')} />
          )}
        </article>
        <article>
          <header data-icon-tone="room"><BarChart3 aria-hidden="true" />{t('contextRoom:overviewDashboard.currentStatus')} <em>AI</em></header>
          {dashboard.aiStatus.trim() ? <p data-room-citation-section="status">{localizedUiText(dashboard.aiStatus, t)}</p> : <PanelEmptyState compact icon={Info} title={t('contextRoom:overviewDashboard.noStatusSummaryYet')} description={t('contextRoom:overviewDashboard.thisStatusWillUpdateAsNewResourcesAnd')} />}
        </article>
        <article>
          <header data-icon-tone="ai"><Zap aria-hidden="true" />{t('contextRoom:overviewDashboard.suggestedNextSteps')} <em>AI</em></header>
          {dashboard.nextSteps.length ? <ul data-room-citation-section="next_steps">{dashboard.nextSteps.map((item) => <li key={item}><CornerDownRight aria-hidden="true" />{item}</li>)}</ul> : <PanelEmptyState compact icon={Zap} title={t('contextRoom:overviewDashboard.noNextStepSuggestionsYet')} description={t('contextRoom:overviewDashboard.suggestionsWillBeRegeneratedWhenNewContextEnters')} />}
        </article>
        <article>
          <header data-icon-tone="memory"><Bookmark aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedMemoryEntities')}</header>
          {dashboard.entities.length ? (
            <div className="context-room-dashboard-entities" data-room-citation-section="entities">
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
        {visibleTimeline.length ? <ol data-room-citation-section="timeline">{visibleTimeline.map((item, index) => {
          // 相关资料按事件来源文档解析（sourceDocumentId → 云文档资源）；手工/无来源条目不显示
          const resource = item.sourceDocumentId
            ? library.resources.find((candidate) => candidate.kind === 'cloud-doc' && candidate.binding.docId === item.sourceDocumentId)
            : null;
          return <li key={`${item.time}-${item.title}`}><i data-kind={item.kind} /><div><div><b>{localizedUiText(item.title, t)}</b><time>{formatTimelineTime(item.time, locale)}</time></div><p>{localizedUiText(item.description, t)}</p>{resource ? <><button type="button" aria-expanded={expanded.has(index)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}><ChevronRight aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedResources')} <span>1</span></button>{expanded.has(index) ? <button type="button" className="context-room-timeline-material" onClick={() => onSelectResource(resource)}><FileText aria-hidden="true" />{resource.name}</button> : null}</> : null}</div></li>;
        })}</ol> : <PanelEmptyState compact icon={GitBranch} title={t('contextRoom:overviewDashboard.noEventsInThisRange')} description={t('contextRoom:overviewDashboard.changeTheDateRangeToSeeOtherRoom')} />}
      </article>
    </section>
  );
}
