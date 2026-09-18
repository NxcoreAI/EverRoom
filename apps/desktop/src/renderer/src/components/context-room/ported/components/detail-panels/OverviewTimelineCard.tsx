import { ChevronLeft, ChevronRight, GitBranch } from 'lucide-react';
import type { RoomDocument } from '@nxcore/agent-contract';
import { useCallback, useMemo, useState } from 'react';
import { useLocale, type Translate } from '../../../../../i18n/LocaleContext';

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { useRoomActivityEntries, type ActivityCategory } from '../../hooks/useRoomActivityEntries';
import { localizedUiText } from '../../adapters';
import { formatTimelineTime, parseTimelineDate } from '../../roomTimeline';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { ActivityEntryBody, CATEGORY_ICONS, useActivityEntryInteractions } from './ActivityEntryParts';
import { PanelEmptyState } from './PanelEmptyState';
import type { WorkspaceObjectPreview } from './index';

type TimelineView = 'day' | 'week' | 'month';

/** 同期折叠窗口：发生时间相差 10 分钟内的相邻条目视为同一批，折叠展示。 */
const TIMELINE_CLUSTER_WINDOW_MS = 10 * 60 * 1000;

/** 折叠组领头条目的优先级：会议 > 任务 > 邮件/资料 > 其余。 */
function entryPriority(category: ActivityCategory): number {
  if (category === 'meeting') return 0;
  if (category === 'task') return 1;
  if (category === 'other') return 3;
  return 2;
}

function startOfWeek(value: Date) {
  const result = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  result.setDate(result.getDate() + (value.getDay() === 0 ? -6 : 1 - value.getDay()));
  return result;
}

function inTimelineRange(value: Date, view: TimelineView, cursor: Date) {
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

/**
 * 概览底部的 Room 时间轴卡（原型 rd-dash-timeline-card）：
 * 日/周/月切换 + 区间翻页 + 类型/人物筛选，条目带折叠的相关资料。
 */
export function OverviewTimelineCard({
  room,
  backendDocuments,
  knowledgeFiles,
  onSelectResource,
  onOpenObject,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
}) {
  const { locale, t } = useLocale();
  const { rawEntries, projectedEntries, peoplePool, library, today } = useRoomActivityEntries({
    room,
    backendDocuments,
    knowledgeFiles,
    locale,
    t,
  });
  const [timelineView, setTimelineView] = useState<TimelineView>('month');
  const [timelineCursor, setTimelineCursor] = useState(() => new Date());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | 'all'>('all');
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const interactions = useActivityEntryInteractions({
    libraryResources: library.resources,
    onSelectResource,
    onOpenObject,
  });

  const visibleEntries = [...projectedEntries, ...rawEntries]
    .filter((entry) => {
      if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false;
      if (personFilter && !entry.people.includes(personFilter)) return false;
      const when = entry.time ? parseTimelineDate(entry.time, today) : null;
      // 无日期条目（本地快照邮件/会议）只在月视图沉底展示；人物筛选天然排除无人员条目。
      if (!when) return timelineView === 'month';
      return inTimelineRange(when, timelineView, timelineCursor);
    })
    .sort((left, right) => {
      const leftDate = parseTimelineDate(left.time ?? '', today);
      const rightDate = parseTimelineDate(right.time ?? '', today);
      if (leftDate && rightDate) return rightDate.getTime() - leftDate.getTime();
      if (leftDate) return -1;
      if (rightDate) return 1;
      return 0;
    });

  /** 相邻条目发生时间相差 ≤ 折叠窗口的收成一组：领头条目按类别优先级挑，其余收进「同期事件」展开区。入参须已按时间倒序。 */
  const clustered = useMemo(() => {
    const groups: Array<{ entries: typeof visibleEntries; headTime: number | null }> = [];
    for (const entry of visibleEntries) {
      const when = entry.time ? parseTimelineDate(entry.time, today) : null;
      const time = when ? when.getTime() : null;
      const current = groups[groups.length - 1];
      if (current && time !== null && current.headTime !== null && current.headTime - time <= TIMELINE_CLUSTER_WINDOW_MS) {
        current.entries.push(entry);
        continue;
      }
      groups.push({ entries: [entry], headTime: time });
    }
    return groups.map(({ entries }) => {
      const leading = entries.reduce((best, entry) => entryPriority(entry.category) < entryPriority(best.category) ? entry : best);
      return { leading, peers: entries.filter((entry) => entry !== leading) };
    });
  }, [today, visibleEntries]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const moveTimeline = (delta: number) =>
    setTimelineCursor((current) => {
      const next = new Date(current);
      if (timelineView === 'month') next.setMonth(next.getMonth() + delta);
      else next.setDate(next.getDate() + delta * (timelineView === 'week' ? 7 : 1));
      return next;
    });

  const hasAnyEntries = projectedEntries.length + rawEntries.length > 0;

  return (
    <section className="context-room-dashboard-timeline" data-testid="context-room-overview-timeline">
      <header>
        <GitBranch aria-hidden="true" />
        {t('contextRoom:overviewDashboard.roomTimeline')}
        <span>{t('contextRoom:overviewDashboard.countEvents', { count: visibleEntries.length })}</span>
      </header>
      <div className="context-room-timeline-toolbar">
        <div>
          {(['day', 'week', 'month'] as const).map((view) => (
            <button type="button" key={view} aria-pressed={timelineView === view} onClick={() => setTimelineView(view)}>
              {t(view === 'day' ? 'contextRoom:overviewDashboard.day' : view === 'week' ? 'contextRoom:overviewDashboard.week' : 'contextRoom:overviewDashboard.month')}
            </button>
          ))}
        </div>
        <nav aria-label={t('contextRoom:overviewDashboard.timelineRange')}>
          <button type="button" aria-label={t('contextRoom:overviewDashboard.previousPeriod')} onClick={() => moveTimeline(-1)}><ChevronLeft aria-hidden="true" /></button>
          <span>{timelineRangeLabel(timelineView, timelineCursor, locale, t)}</span>
          <button type="button" aria-label={t('contextRoom:overviewDashboard.nextPeriod')} onClick={() => moveTimeline(1)}><ChevronRight aria-hidden="true" /></button>
          <button type="button" disabled={timelineCursor.toDateString() === today.toDateString()} onClick={() => setTimelineCursor(new Date())}>{t('contextRoom:overviewDashboard.today')}</button>
        </nav>
      </div>
      <div className="context-room-activity-filters">
        <div role="group" aria-label={t('contextRoom:activityPane.filterByType')}>
          <button type="button" aria-pressed={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>{t('contextRoom:activityPane.category.all')}</button>
          {(['meeting', 'mail', 'task', 'material', 'other'] as const).map((category) => (
            <button
              type="button"
              key={category}
              aria-pressed={categoryFilter === category}
              onClick={() => setCategoryFilter(categoryFilter === category ? 'all' : category)}
            >
              {t(`contextRoom:activityPane.category.${category}`)}
            </button>
          ))}
        </div>
        {peoplePool.length ? (
          <label className="context-room-activity-person">
            <select
              value={personFilter ?? ''}
              aria-label={t('contextRoom:activityPane.filterByPerson')}
              onChange={(event) => setPersonFilter(event.target.value || null)}
            >
              <option value="">{t('contextRoom:activityPane.allPeople')}</option>
              {peoplePool.map((person) => <option key={person} value={person}>{person}</option>)}
            </select>
          </label>
        ) : null}
      </div>
      {hasAnyEntries ? (
        clustered.length ? <ol className="context-room-activity-list">{clustered.map(({ leading, peers }) => {
          const clusterKey = `cluster:${leading.id}`;
          const LeadingIcon = CATEGORY_ICONS[leading.category];
          return <li key={leading.id}>
            <i data-kind={leading.kind} />
            <div>
              <div className="context-room-activity-entry-row">
                <button
                  type="button"
                  className="context-room-activity-entry-title"
                  title={leading.title}
                  onClick={() => interactions.entryClick(leading)}
                >
                  <LeadingIcon aria-hidden="true" />
                  <b>{localizedUiText(leading.title, t)}</b>
                </button>
                {leading.time ? <time>{formatTimelineTime(leading.time, locale)}</time> : null}
                {leading.document && leading.document.version > 0
                  ? <span className="context-room-activity-version">V{String(leading.document.version)}</span>
                  : null}
              </div>
              <ActivityEntryBody entry={leading} interactions={interactions} materialsVariant="collapse" expanded={expanded.has(leading.id)} onToggle={toggleExpanded} />
              {peers.length ? <>
                <button type="button" aria-expanded={expanded.has(clusterKey)} onClick={() => toggleExpanded(clusterKey)}>
                  {t('contextRoom:overviewDashboard.samePeriodEvents', { count: peers.length })}
                </button>
                {expanded.has(clusterKey) ? <div className="context-room-timeline-peers">{peers.map((peer) => {
                  const PeerIcon = CATEGORY_ICONS[peer.category];
                  return (
                    <div key={peer.id} className="context-room-timeline-peer">
                      <i data-kind={peer.kind} />
                      <div>
                        <div className="context-room-activity-entry-row">
                          <button type="button" className="context-room-activity-entry-title" title={peer.title} onClick={() => interactions.entryClick(peer)}>
                            <PeerIcon aria-hidden="true" />
                            <b>{localizedUiText(peer.title, t)}</b>
                          </button>
                          {peer.time ? <time>{formatTimelineTime(peer.time, locale)}</time> : null}
                          {peer.document && peer.document.version > 0
                            ? <span className="context-room-activity-version">V{String(peer.document.version)}</span>
                            : null}
                        </div>
                        <ActivityEntryBody entry={peer} interactions={interactions} materialsVariant="collapse" expanded={expanded.has(peer.id)} onToggle={toggleExpanded} />
                      </div>
                    </div>
                  );
                })}</div> : null}
              </> : null}
            </div>
          </li>;
        })}</ol> : (
          <PanelEmptyState
            icon={GitBranch}
            title={t('contextRoom:activityPane.noEventsInThisRange')}
            description={t('contextRoom:activityPane.adjustFiltersToSeeMore')}
          />
        )
      ) : (
        <PanelEmptyState
          icon={GitBranch}
          title={t('contextRoom:activityPane.noEventsYet')}
          description={t('contextRoom:activityPane.meetingsMailsTasksAndResourceChanges')}
        />
      )}
    </section>
  );
}
