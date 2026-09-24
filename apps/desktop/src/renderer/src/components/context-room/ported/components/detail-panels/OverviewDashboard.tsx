import {
  BarChart3,
  BookOpen,
  Bookmark,
  CalendarDays,
  CheckSquare2,
  CornerDownRight,
  FileText,
  Info,
  Network,
  Zap,
} from 'lucide-react';
import type { RoomDocument, RoomOverviewProjection } from '@nxcore/agent-contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
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
import type { KnowledgeFileDto, KnowledgeWikiPagesResultDto } from '../../../../../../../shared/knowledge';
import { formatTimelineTime } from '../../roomTimeline';
import { useRoomUpdatedTime } from '../../roomUpdatedTime';
import { roomKindIcon, roomKindTone } from '../utils';
import { CalendarProviderIcon } from '../CalendarProviderIcon';
import { PanelEmptyState } from './PanelEmptyState';
import type { WorkspaceObjectPreview } from './index';

// 逐 Room 的 AI 状态文案覆盖表（原演示 Room 词条已移除）；缺省走下方真实数据派生。
/** 概览关联实体 chip：投影分支带 claim/实体元数据，其余分支只有文案。 */
type OverviewEntityChip = {
  label: string;
  description: string;
  id?: string;
  text?: string;
  entityId?: string;
  salience?: number;
  mentionCount?: number;
};
const DASHBOARD_COPY: Record<
  string,
  {
    aiStatus: string;
    nextSteps: Array<{ id: string; text: string; owner: string | null; dueAt: string | null; itemType: string }>;
    entities: OverviewEntityChip[];
  }
> = {};

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

/** 概览/状态长文折叠：超过 lines 行时截断显示，展开按钮只在真溢出时出现。 */
function ClampedText({
  lines,
  section,
  children,
}: {
  lines: number;
  section: string;
  children: React.ReactNode;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // 展开态不测量（scrollHeight==clientHeight 会误判为不溢出，收起按钮会闪没）。
    if (expanded || !ref.current) return;
    setOverflowing(ref.current.scrollHeight - ref.current.clientHeight > 2);
  });
  return (
    <>
      <p
        data-room-citation-section={section}
        data-clamp={expanded ? undefined : String(lines)}
        style={{ '--clamp-lines': String(lines) } as React.CSSProperties}
        ref={ref}
      >
        {children}
      </p>
      {overflowing || expanded ? (
        <button
          type="button"
          className="context-room-dashboard-clamp-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {t(expanded ? 'contextRoom:overviewDashboard.collapse' : 'contextRoom:overviewDashboard.expand')}
        </button>
      ) : null}
    </>
  );
}

export function OverviewDashboard({
  room,
  backendDocuments,
  knowledgeFiles,
  onSelectResource,
  onOpenObject,
  onOpenPane,
  onOpenEntity,
  onOpenWikiBoard,
  onToggleTask,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  /** 概览行点击跳转对应面板：投影日程/待办无详情对象（连接器/本地助手行），只切面板。 */
  onOpenPane?: (pane: 'todo') => void;
  /** 关联实体 chip 点击：切到关联记忆板块并聚焦该实体节点。 */
  onOpenEntity?: (entityId: string) => void;
  /** Wiki 概览卡「打开 Wiki」跳转 Wiki 板块（整屏概览有；分屏概览缺省不渲染按钮）。 */
  onOpenWikiBoard?: () => void;
  onToggleTask: (taskId: string) => void;
}) {
  const { locale, t } = useLocale();
  // 合并完成/投影生成的过渡窗口，room 数组字段可能缺失（裸 .length/.map 会崩渲染，
  // 即"合并后首次点开 Room 报错要求刷新"）：入口一次性归一化，宁可空面板不可白屏。
  const materials = room.materials ?? [];
  const actionItems = room.actionItems ?? [];
  const people = room.people ?? [];
  const fileItems = room.fileItems ?? [];
  const dashboardRef = useRef<HTMLElement>(null);
  const [overviewProjection, setOverviewProjection] = useState<RoomOverviewProjection | null>(null);
  const [wiki, setWiki] = useState<KnowledgeWikiPagesResultDto | null>(null);
  const wikiPages = wiki?.items ?? null;
  /** KS 生成的 ≤100 字摘要按句读拆成要点；无摘要时卡体回退页面标题。 */
  const wikiSummaryPoints = useMemo(() => (wiki?.summary ?? '')
    .split(/[。；;！!？?\n]+/).map((part) => part.trim()).filter(Boolean).slice(0, 4), [wiki?.summary]);
  const wikiUpdatedAt = wiki?.updatedAt ?? null;
  const latestDocumentAt = backendDocuments.reduce<string | undefined>((latest, document) => (
    !latest || document.updatedAt > latest ? document.updatedAt : latest
  ), undefined);
  const updatedTime = useRoomUpdatedTime({
    updatedAt: latestDocumentAt && (!room.updatedAt || latestDocumentAt > room.updatedAt)
      ? latestDocumentAt
      : room.updatedAt,
    lastViewed: room.lastViewed,
  });
  const Icon = roomKindIcon(room.kind);
  const dashboard = DASHBOARD_COPY[room.id] ?? {
    aiStatus: overviewProjection?.status.map((item) => item.text).join('\n')
      || room.generatedContext?.status || room.brief.status,
    nextSteps: overviewProjection?.nextSteps?.length
      ? overviewProjection.nextSteps
        // 已完成的本地助手待办不进「接下来」建议（面板专属「已完成」分组）。
        .filter((item) => !(item.data?.kind === 'next_step' && item.data.itemType === 'task' && item.data.status === 'completed'))
        .map((item) => ({
          id: item.id,
          text: item.text,
          owner: item.data?.kind === 'next_step' ? item.data.owner : null,
          dueAt: item.data?.kind === 'next_step' ? item.data.dueAt : null,
          itemType: item.data?.kind === 'next_step' ? item.data.itemType : 'suggestion',
        }))
      : room.generatedContext?.nextSteps?.length
        ? room.generatedContext.nextSteps.map((item, index) => ({
            id: `generated-${index}`, text: item, owner: null, dueAt: null, itemType: 'suggestion',
          }))
      : actionItems.slice(0, 4).map((item) => ({
          id: item.id, text: item.title, owner: item.owner || null, dueAt: item.deadline || null, itemType: 'task',
        })),
    entities: overviewProjection?.entities?.length
      // 关联比例（salience）降序取前 10：新投影网关侧已截断，这里兜底旧缓存投影。
      ? [...overviewProjection.entities]
          .sort((left, right) => (right.data?.kind === 'entity' ? right.data.salience : 0)
            - (left.data?.kind === 'entity' ? left.data.salience : 0))
          .slice(0, 10)
          .map((entity) => ({
            id: entity.id,
            text: entity.text,
            label: entity.text.split('：')[0] || entity.text,
            entityId: entity.data?.kind === 'entity' ? entity.data.entityId : undefined,
            salience: entity.data?.kind === 'entity' ? entity.data.salience : undefined,
            mentionCount: entity.data?.kind === 'entity' ? entity.data.mentionCount : undefined,
            description: entity.data?.kind === 'entity'
              ? t('contextRoom:overviewDashboard.entityChipMeta', {
                type: t(localizedUiText(entity.data.entityKind, t)),
                ratio: Math.round(entity.data.salience * 100),
                count: entity.data.mentionCount,
              })
              : entity.text,
          }))
      : room.generatedContext?.entities?.length
      ? room.generatedContext.entities.map((entity) => ({
          label: entity.name,
          description: `${t(uiText(entity.kind))} · ${entity.description}`,
        }))
      : people.map((person) => ({ label: person.name, description: person.role })),
  };
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room],
  );
  const recentDocuments = [...backendDocuments]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 3);
  const recentMaterials = materials.slice(0, Math.max(0, 3 - recentDocuments.length));
  const todayMeeting = materials.find((item) => item.type === '会议' && isTodayLabel(item.time));
  const openTasks = actionItems.filter((item) => !item.completed && item.status !== '已完成').slice(0, 3);
  // 确定性投影叠加：连接器日历/待办 claim（只读展示，不参与本地任务勾选）。
  const projectionNextSteps = overviewProjection?.nextSteps ?? [];
  const projectionSchedules = projectionNextSteps.filter((item) =>
    item.data?.kind === 'next_step' && item.data.itemType === 'schedule' && isDueToday(item.data.dueAt)).slice(0, 2);
  const openTaskTitles = new Set(openTasks.map((task) => task.title.trim().toLocaleLowerCase()));
  const projectionTasks = projectionNextSteps.filter((item) =>
    item.data?.kind === 'next_step' && item.data.itemType === 'task'
    && item.data.status !== 'completed'
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
        overviewCount: projection.overview?.length ?? 0,
        statusCount: projection.status?.length ?? 0,
        nextStepsCount: projection.nextSteps?.length ?? 0,
        timelineCount: projection.timeline?.length ?? 0,
        entityCount: projection.entities?.length ?? 0,
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
    // Wiki 概览卡：KS 生成的 ≤100 字摘要分句成要点；无摘要回退页面标题。
    // 无知识服务（旧网关）时整卡不渲染。
    let wikiCancelled = false;
    window.nxcore?.knowledge?.listWikiPages(room.id)
      .then((data) => { if (!wikiCancelled) setWiki(data); })
      .catch(() => { if (!wikiCancelled) setWiki(null); });
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
    return () => {
      wikiCancelled = true;
      window.removeEventListener(ROOM_OVERVIEW_CHANGED_EVENT, refresh as EventListener);
    };
  }, [loadOverview, room.id]);

  return (
    <section ref={dashboardRef} className="context-room-dashboard" data-testid="context-room-pane-overview">
      <RoomOverviewCitationControls rootRef={dashboardRef} roomId={room.id} roomTitle={room.title} />
      <header className="context-room-dashboard-hero">
        <span data-icon-tone={roomKindTone(room.kind)}><Icon aria-hidden="true" /></span>
        <div>
          <h1>{room.title}</h1>
          <p><CalendarDays aria-hidden="true" />{t('contextRoom:overviewDashboard.updatedTime', { time: updatedTime })} <i /> {t('contextRoom:overviewDashboard.countResources', { count: backendDocuments.length + materials.length + fileItems.length })}</p>
        </div>
        <b>{t(uiText(room.status))}</b>
      </header>

      <div className="context-room-dashboard-grid">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" />{t('contextRoom:overviewDashboard.roomOverview')}</header>
          {hasOverview ? (
            <>
              <ClampedText lines={4} section="overview">
                {overviewClaims.length
                  ? overviewClaims.map((claim, index) => <span key={claim.id} data-room-citation-claim-id={claim.id} data-room-citation-claim-text={claim.text}>{index ? ' ' : ''}{localizedUiText(claim.text, t)}</span>)
                  : localizedUiText(generatedOverview || room.brief.background, t) || t('contextRoom:overviewDashboard.noBackgroundProvided')}
              </ClampedText>
              <small data-room-citation-section="overview"><b>{t('contextRoom:overviewDashboard.goal')}</b><span data-room-citation-claim-id={goalClaim?.id} data-room-citation-claim-text={goalClaim?.text}>{localizedUiText(projectedGoal, t) || t('contextRoom:overviewDashboard.notSet')}</span></small>
            </>
          ) : (
            <PanelEmptyState compact icon={FileText} title={t('contextRoom:overviewDashboard.noOverviewYet')} description={t('contextRoom:overviewDashboard.theRoomBackgroundAndGoalsAppearHere')} />
          )}
        </article>
        <article>
          <header data-icon-tone="room"><BarChart3 aria-hidden="true" />{t('contextRoom:overviewDashboard.currentStatus')} <em>AI</em></header>
          {dashboard.aiStatus.trim() ? (
            <ClampedText lines={3} section="status">
              {overviewProjection?.status.length
                ? overviewProjection.status.map((claim, index) => <span key={claim.id} data-room-citation-claim-id={claim.id} data-room-citation-claim-text={claim.text}>{index ? ' ' : ''}{localizedUiText(claim.text, t)}</span>)
                : localizedUiText(dashboard.aiStatus, t)}
            </ClampedText>
          ) : <PanelEmptyState compact icon={Info} title={t('contextRoom:overviewDashboard.noStatusSummaryYet')} description={t('contextRoom:overviewDashboard.thisStatusWillUpdateAsNewResourcesAnd')} />}
        </article>
        <article>
          <header data-icon-tone="ai"><Zap aria-hidden="true" />{t('contextRoom:overviewDashboard.suggestedNextSteps')} <em>AI</em></header>
          {dashboard.nextSteps.length ? <ul data-room-citation-section="next_steps">{dashboard.nextSteps.map((item) => <li key={item.id} title={[item.owner, item.dueAt].filter(Boolean).join(' · ')} data-item-type={item.itemType} data-room-citation-claim-id={projectedNextStepIds.has(item.id) ? item.id : undefined} data-room-citation-claim-text={projectedNextStepIds.has(item.id) ? item.text : undefined}><CornerDownRight aria-hidden="true" />{item.text}</li>)}</ul> : <PanelEmptyState compact icon={Zap} title={t('contextRoom:overviewDashboard.noNextStepSuggestionsYet')} description={t('contextRoom:overviewDashboard.suggestionsWillBeRegeneratedWhenNewContextEnters')} />}
        </article>
        <article>
          <header data-icon-tone="memory"><Bookmark aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedMemoryEntities')}</header>
          {dashboard.entities.length ? (
            <div className="context-room-dashboard-entities" data-room-citation-section="entities">
              {dashboard.entities.map((entity: OverviewEntityChip) => {
                const entityId = entity.entityId;
                const salience = entity.salience;
                const claimId = entity.id;
                const claimText = entity.text;
                return entityId && onOpenEntity ? (
                  <button
                    type="button"
                    key={entity.label}
                    title={entity.description}
                    data-room-citation-claim-id={claimId}
                    data-room-citation-claim-text={claimText}
                    onClick={() => onOpenEntity(entityId)}
                  >
                    {entity.label}
                    {salience !== undefined ? <i>{`${Math.round(salience * 100)}%`}</i> : null}
                  </button>
                ) : (
                  <span
                    key={entity.label}
                    title={entity.description}
                    data-room-citation-claim-id={claimId}
                    data-room-citation-claim-text={claimText}
                  >
                    {entity.label}
                  </span>
                );
              })}
            </div>
          ) : <PanelEmptyState compact icon={Network} title={t('contextRoom:overviewDashboard.noRelatedEntitiesYet')} description={t('contextRoom:overviewDashboard.detectedPeopleProjectsAndTopicsAppearHere')} />}
        </article>
        {wikiPages && wikiPages.length > 0 ? (
          <article className="context-room-dashboard-wiki">
            <header data-icon-tone="data"><BookOpen aria-hidden="true" />{t('contextRoom:overviewDashboard.wikiOverview')}</header>
            <ul>
              {wikiSummaryPoints.length
                ? wikiSummaryPoints.map((point, index) => <li key={`summary-${index}`}><CornerDownRight aria-hidden="true" />{point}</li>)
                : wikiPages.slice(0, 4).map((page) => <li key={page.id}><CornerDownRight aria-hidden="true" />{page.title}</li>)}
            </ul>
            <footer>
              <span>
                {t('contextRoom:overviewDashboard.generatedPages', { count: wikiPages.length })}
                {wikiUpdatedAt ? ` · ${t('contextRoom:overviewDashboard.updatedAt', { time: formatTimelineTime(wikiUpdatedAt, locale) })}` : ''}
              </span>
              {onOpenWikiBoard ? (
                <button type="button" onClick={onOpenWikiBoard}>
                  {t('contextRoom:overviewDashboard.openWiki')}
                </button>
              ) : null}
            </footer>
          </article>
        ) : null}
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
            <button type="button" key={item.id} data-item-type="schedule" data-connector-source="calendar-event" title={item.data?.kind === 'next_step' && item.data.dueAt ? new Date(item.data.dueAt).toLocaleString(locale) : undefined} onClick={() => onOpenPane?.('todo')}>
              <CalendarProviderIcon provider={item.data?.kind === 'next_step' ? item.data.provider : undefined} />
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
            <button type="button" key={item.id} data-item-type="task" data-connector-source="todo" title={item.data?.kind === 'next_step' && item.data.dueAt ? new Date(item.data.dueAt).toLocaleString(locale) : undefined} onClick={() => onOpenPane?.('todo')}>
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
    </section>
  );
}
