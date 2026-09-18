import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileText,
  GitBranch,
  History,
  Mail,
  Mic,
  CheckSquare2,
} from 'lucide-react';
import type { RoomDocument, RoomOverviewEvidence } from '@nxcore/agent-contract';
import { useCallback, useMemo, useState } from 'react';
import { useLocale, type Translate } from '../../../../../i18n/LocaleContext';

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary } from '../../resources';
import { localizedUiText } from '../../adapters';
import { useRoomMails } from '../../hooks/useRoomMails';
import { useRoomOverviewProjection } from '../../hooks/useRoomOverviewProjection';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { formatTimelineTime, parseTimelineDate } from '../../roomTimeline';
import { requestDocumentHistory } from '../detail-editor/documentHistoryOpenSignal';
import { PanelEmptyState } from './PanelEmptyState';
import type { WorkspaceObjectPreview } from './index';

type TimelineView = 'day' | 'week' | 'month';

/** 动态条目的对象类别（筛选 chips 与图标用）。 */
type ActivityCategory = 'meeting' | 'mail' | 'task' | 'material' | 'other';

/** 同期折叠窗口：发生时间相差 10 分钟内的相邻条目视为同一批，折叠展示。 */
const TIMELINE_CLUSTER_WINDOW_MS = 10 * 60 * 1000;

/** 动态时间轴的统一条目形状：投影 claim 与本地/连接器真实对象共用同一渲染路径。 */
type ActivityEntry = {
  id: string;
  /** null = 无日期事件（解析不到发生时间），排序沉底、不参与日期范围过滤。 */
  time: string | null;
  title: string;
  description: string;
  category: ActivityCategory;
  kind: 'done' | 'warn' | 'info';
  evidence: RoomOverviewEvidence[];
  /** 人物筛选项：与会人 / 发件人等。 */
  people: string[];
  /** 文档版本条目：提供变更摘要与版本 diff 入口。 */
  document?: { documentId: string; version: number };
};

function categoryFromEventType(eventType: string | null | undefined): ActivityCategory {
  if (eventType === 'meeting') return 'meeting';
  if (eventType === 'task') return 'task';
  if (eventType === 'source') return 'material';
  return 'other';
}

/** 折叠组领头条目的优先级：会议 > 任务 > 邮件/资料 > 其余。 */
function entryPriority(entry: ActivityEntry): number {
  if (entry.category === 'meeting') return 0;
  if (entry.category === 'task') return 1;
  if (entry.category === 'other') return 3;
  return 2;
}

function startOfWeek(value: Date) {
  const result = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  result.setDate(result.getDate() + (value.getDay() === 0 ? -6 : 1 - value.getDay()));
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

function localDateKey(value: Date): string {
  return `${String(value.getFullYear())}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function parseDateOrNull(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{1,2}-\d{1,2}/.test(value.trim())) return null;
  // 本地快照的宽松解析（"昨天"/"07-21"）会回退到今天：只信完整 ISO/日期串。
  const parsed = parseTimelineDate(value, new Date());
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

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

const CATEGORY_ICONS: Record<ActivityCategory, typeof Mic> = {
  meeting: Mic,
  mail: Mail,
  task: CheckSquare2,
  material: FileText,
  other: GitBranch,
};

function categoryLabel(category: ActivityCategory, t: Translate): string {
  return t(`contextRoom:activityPane.category.${category}`);
}

type ChangeSummaryState = { loading: boolean; text: string | null; error: boolean };

/**
 * 工作 / 动态：Room 统一时间轴（PRD L3.2.2）。
 * 汇聚概览投影事件、文档版本（带变更摘要与版本 diff 入口）、资料收录、
 * 邮件与会议；支持时间范围、对象类型与人物筛选。
 */
export function ActivityPane({
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
  const today = new Date();
  const overviewProjection = useRoomOverviewProjection(room.id);
  const { mails: connectorMails } = useRoomMails(room.id);
  const [timelineView, setTimelineView] = useState<TimelineView>('month');
  const [timelineCursor, setTimelineCursor] = useState(() => new Date());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [categoryFilter, setCategoryFilter] = useState<ActivityCategory | 'all'>('all');
  const [personFilter, setPersonFilter] = useState<string | null>(null);
  const [changeSummaries, setChangeSummaries] = useState<Record<string, ChangeSummaryState>>({});
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room],
  );

  // 本地会议快照与投影日历事件同名同日视为同一事件，保留投影版本（时间与证据更准）。
  const connectorMeetingKeys = useMemo(() => new Set((overviewProjection?.timeline ?? []).flatMap((claim) => {
    if (categoryFromEventType(claim.data?.kind === 'timeline' ? claim.data.eventType : null) !== 'meeting') return [];
    const when = parseDateOrNull(claim.occurredAt ?? null);
    const title = (claim.data?.kind === 'timeline' ? claim.data.title : '') || claim.text;
    return when ? [`${title.trim().toLocaleLowerCase()}\x00${localDateKey(when)}`] : [];
  })), [overviewProjection]);

  // 本地快照邮件按「主题 + 同日」与连接器邮件去重，保留连接器版本（真实发件人/时间）。
  const connectorMailKeys = useMemo(() => new Set(connectorMails.flatMap((mail) => {
    const when = parseDateOrNull(mail.sentAt);
    return when ? [`${mail.subject.trim().toLocaleLowerCase()}\x00${localDateKey(when)}`] : [];
  })), [connectorMails]);

  // 真实对象条目（文档版本/资料收录/邮件/会议）：携带可执行动作。
  const rawEntries = useMemo<ActivityEntry[]>(() => {
    const docEntries: ActivityEntry[] = backendDocuments
      .filter((document) => !document.deletedAt)
      .map((document) => ({
        id: `doc:${document.id}`,
        time: document.updatedAt,
        title: document.title,
        description: '',
        category: 'material' as const,
        kind: 'done' as const,
        evidence: [],
        people: [],
        document: { documentId: document.id, version: document.version },
      }));
    const fileEntries: ActivityEntry[] = knowledgeFiles.map((file) => ({
      id: `file:${file.id}`,
      time: file.uploadedAt,
      title: file.originalName,
      description: t('contextRoom:activityPane.fileIngested'),
      category: 'material' as const,
      kind: 'done' as const,
      evidence: [],
      people: [],
    }));
    const connectorMailEntries: ActivityEntry[] = connectorMails.map((mail) => ({
      id: `mail:${mail.sourceId}`,
      time: mail.sentAt,
      title: mail.subject,
      description: mail.snippet ?? '',
      category: 'mail' as const,
      kind: 'done' as const,
      evidence: [],
      people: mail.senderName ? [mail.senderName] : [],
    }));
    const localMailEntries: ActivityEntry[] = room.materials
      .filter((material) => material.type === '邮件')
      .filter((mail) => !connectorMailKeys.has(`${mail.title.trim().toLocaleLowerCase()}\x00${localDateKey(parseTimelineDate(mail.time, today) ?? today)}`))
      .map((mail) => ({
        id: `lmail:${mail.id}`,
        time: null,
        title: mail.title,
        description: localizedUiText(mail.summary, t),
        category: 'mail' as const,
        kind: 'done' as const,
        evidence: [],
        people: mail.sender ? [mail.sender] : [],
      }));
    const meetingEntries: ActivityEntry[] = room.materials
      .filter((material) => material.type === '会议')
      .filter((meeting) => !connectorMeetingKeys.has(`${meeting.title.trim().toLocaleLowerCase()}\x00${localDateKey(parseTimelineDate(meeting.time, today) ?? today)}`))
      .map((meeting) => ({
        id: `meeting:${meeting.id}`,
        time: null,
        title: meeting.title,
        description: localizedUiText(meeting.summary, t),
        category: 'meeting' as const,
        kind: 'done' as const,
        evidence: [],
        people: meeting.attendees ?? [],
      }));
    return [...docEntries, ...fileEntries, ...connectorMailEntries, ...localMailEntries, ...meetingEntries];
  }, [backendDocuments, connectorMailKeys, connectorMeetingKeys, connectorMails, knowledgeFiles, room.materials, t, today]);

  // 投影条目与真实对象条目按证据/标题去重：同对象同日的收录类 claim 让位给带动作的真实条目。
  const rawEvidenceKeys = useMemo(() => {
    const docDays = new Map<string, Set<string>>();
    for (const entry of rawEntries) {
      if (!entry.document && !entry.id.startsWith('file:')) continue;
      const when = parseDateOrNull(entry.time);
      if (!when) continue;
      const objectKey = entry.document ? `everroom-doc\x00${entry.document.documentId}` : `file\x00${entry.id.slice('file:'.length)}`;
      const day = localDateKey(when);
      docDays.set(objectKey, (docDays.get(objectKey) ?? new Set()).add(day));
    }
    return docDays;
  }, [rawEntries]);

  const projectedEntries = useMemo<ActivityEntry[]>(() => {
    const claims = overviewProjection?.timeline ?? [];
    return claims.flatMap((claim) => {
      const data = claim.data?.kind === 'timeline' ? claim.data : null;
      const category = categoryFromEventType(data?.eventType);
      // 同对象同日的收录/更新 claim 已由真实条目承载，跳过避免重复。
      if (data?.eventType === 'source' || data?.eventType === 'update') {
        const duplicated = claim.evidence.some((source) => {
          const objectKey = source.sourceKind === 'everroom-doc' || source.sourceKind === 'file'
            ? `${source.sourceKind}\x00${source.sourceId}`
            : null;
          const when = parseDateOrNull(claim.occurredAt ?? null);
          return Boolean(objectKey && when && rawEvidenceKeys.get(objectKey)?.has(localDateKey(when)));
        });
        if (duplicated) return [];
      }
      return [{
        id: claim.id,
        time: claim.occurredAt ?? null,
        title: data?.title || claim.text,
        description: data?.description
          || (data?.certainty === 'inference' ? t('contextRoom:overviewDashboard.inferredTimelineEntry') : ''),
        category,
        kind: claim.origin === 'inference' ? 'info' as const : 'done' as const,
        evidence: claim.evidence,
        people: [],
      }];
    });
  }, [overviewProjection, rawEvidenceKeys, t]);

  const peoplePool = useMemo(() => {
    const people = new Set<string>();
    for (const entry of [...rawEntries, ...projectedEntries]) {
      for (const person of entry.people) {
        const name = person.trim();
        if (name) people.add(name);
      }
    }
    return [...people].sort((left, right) => left.localeCompare(right, locale));
  }, [locale, projectedEntries, rawEntries]);

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
    const groups: Array<{ entries: ActivityEntry[]; headTime: number | null }> = [];
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
      const leading = entries.reduce((best, entry) => entryPriority(entry) < entryPriority(best) ? entry : best);
      return { leading, peers: entries.filter((entry) => entry !== leading) };
    });
  }, [visibleEntries]);

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

  const openDocResource = useCallback((documentId: string) => {
    const resource = library.resources.find((item) => item.kind === 'cloud-doc' && item.binding.docId === documentId);
    if (resource) onSelectResource(resource);
  }, [library.resources, onSelectResource]);

  const openFileResource = useCallback((entryId: string) => {
    const fileId = entryId.slice('file:'.length);
    const resource = library.resources.find((item) => item.kind === 'knowledge-file' && item.fileId === fileId);
    if (resource) onSelectResource(resource);
  }, [library.resources, onSelectResource]);

  const loadChangeSummary = useCallback((documentId: string, version: number) => {
    const key = `${documentId}:${String(version)}`;
    setChangeSummaries((current) => ({
      ...current,
      [key]: current[key] ?? { loading: true, text: null, error: false },
    }));
    const documents = window.nxcore?.documents;
    if (!documents?.versionChangeSummary) {
      setChangeSummaries((current) => ({ ...current, [key]: { loading: false, text: null, error: true } }));
      return;
    }
    documents.versionChangeSummary(documentId, version)
      .then((result) => {
        setChangeSummaries((current) => ({ ...current, [key]: { loading: false, text: result.summary, error: false } }));
      })
      .catch(() => {
        setChangeSummaries((current) => ({ ...current, [key]: { loading: false, text: null, error: true } }));
      });
  }, []);

  const entryClick = (entry: ActivityEntry) => {
    if (entry.document) {
      openDocResource(entry.document.documentId);
      return;
    }
    if (entry.id.startsWith('file:')) {
      openFileResource(entry.id);
      return;
    }
    if (entry.id.startsWith('mail:')) {
      onOpenObject({ kind: 'connector-mail', sourceId: entry.id.slice('mail:'.length) });
      return;
    }
    if (entry.id.startsWith('lmail:')) {
      onOpenObject({ kind: 'mail', id: entry.id.slice('lmail:'.length) });
      return;
    }
    if (entry.id.startsWith('meeting:')) {
      onOpenObject({ kind: 'meeting', id: entry.id.slice('meeting:'.length) });
    }
  };

  // 单条动态内容（标题行 + 描述 + 相关资料开关 + 文档版本动作）：领头条目与折叠展开后的同组条目共用。
  const renderEntryBody = (entry: ActivityEntry, toggleKey: string) => {
    const materials = timelineMaterials(entry.evidence);
    const summaryKey = entry.document ? `${entry.document.documentId}:${String(entry.document.version)}` : null;
    const summary = summaryKey ? changeSummaries[summaryKey] : undefined;
    const Icon = CATEGORY_ICONS[entry.category];
    return <>
      <div>
        <button
          type="button"
          className="context-room-activity-entry-title"
          title={entry.title}
          onClick={() => entryClick(entry)}
        >
          <Icon aria-hidden="true" />
          <b>{localizedUiText(entry.title, t)}</b>
        </button>
        {entry.time ? <time>{formatTimelineTime(entry.time, locale)}</time> : null}
        {entry.document && entry.document.version > 0
          ? <span className="context-room-activity-version">V{String(entry.document.version)}</span>
          : null}
      </div>
      {entry.description ? <p>{localizedUiText(entry.description, t)}</p> : null}
      {entry.document ? (
        <div className="context-room-activity-doc-actions">
          <button
            type="button"
            aria-expanded={Boolean(summary)}
            onClick={() => summaryKey && loadChangeSummary(entry.document!.documentId, entry.document!.version)}
          >
            {t(summary?.loading
              ? 'contextRoom:activityPane.loadingChangeSummary'
              : summary?.error
                ? 'contextRoom:activityPane.changeSummaryRetry'
                : 'contextRoom:activityPane.viewChangeSummary')}
          </button>
          {summary && !summary.loading && !summary.error && summary.text
            ? <p className="context-room-activity-summary">{summary.text}</p>
            : null}
          {summary?.error ? <p className="context-room-activity-summary is-error">{t('contextRoom:activityPane.changeSummaryUnavailable')}</p> : null}
          <button
            type="button"
            onClick={() => {
              openDocResource(entry.document!.documentId);
              requestDocumentHistory(entry.document!.documentId);
            }}
          >
            <History aria-hidden="true" />
            {t('contextRoom:activityPane.viewVersions')}
          </button>
        </div>
      ) : null}
      {materials.length ? <><button type="button" aria-expanded={expanded.has(toggleKey)} onClick={() => toggleExpanded(toggleKey)}><ChevronRight aria-hidden="true" />{t('contextRoom:overviewDashboard.relatedResources')} <span>{materials.length}</span></button>{expanded.has(toggleKey) ? <div className="context-room-timeline-materials">{materials.map((source) => {
        const resource = timelineResource(source, library.resources);
        const label = resource ? resource.name : source.sourceTitle || t(`contextRoom:memory.sourceKind.${source.sourceKind}`);
        return resource
          ? <button type="button" key={`${source.sourceKind}:${source.sourceId}`} className="context-room-timeline-material" onClick={() => onSelectResource(resource)}><FileText aria-hidden="true" />{label}</button>
          : <span key={`${source.sourceKind}:${source.sourceId}`} className="context-room-timeline-material is-plain"><FileText aria-hidden="true" />{label}</span>;
      })}</div> : null}</> : null}
    </>;
  };

  const hasAnyEntries = projectedEntries.length + rawEntries.length > 0;

  return (
    <section className="context-room-activity-pane" data-testid="context-room-pane-activity">
      <header>
        <h2><GitBranch aria-hidden="true" />{t('contextRoom:activityPane.title')}</h2>
        <span>{t('contextRoom:overviewDashboard.countEvents', { count: visibleEntries.length })}</span>
      </header>
      <div className="context-room-activity-toolbar">
        <div className="context-room-timeline-toolbar">
          <div>{(['day', 'week', 'month'] as const).map((view) => <button type="button" key={view} aria-pressed={timelineView === view} onClick={() => setTimelineView(view)}>{t(view === 'day' ? 'contextRoom:overviewDashboard.day' : view === 'week' ? 'contextRoom:overviewDashboard.week' : 'contextRoom:overviewDashboard.month')}</button>)}</div>
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
                {categoryLabel(category, t)}
              </button>
            ))}
          </div>
          {peoplePool.length ? (
            <label className="context-room-activity-person">
              <CalendarDays aria-hidden="true" />
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
      </div>
      {hasAnyEntries ? (
        clustered.length ? <ol className="context-room-activity-list">{clustered.map(({ leading, peers }) => {
          const clusterKey = `cluster:${leading.id}`;
          return <li key={leading.id}>
            <i data-kind={leading.kind} />
            <div>
              {renderEntryBody(leading, leading.id)}
              {peers.length ? <>
                <button type="button" aria-expanded={expanded.has(clusterKey)} onClick={() => toggleExpanded(clusterKey)}><ChevronRight aria-hidden="true" />{t('contextRoom:overviewDashboard.samePeriodEvents', { count: peers.length })}</button>
                {expanded.has(clusterKey) ? <div className="context-room-timeline-peers">{peers.map((peer) => (
                  <div key={peer.id} className="context-room-timeline-peer">
                    <i data-kind={peer.kind} />
                    <div>{renderEntryBody(peer, peer.id)}</div>
                  </div>
                ))}</div> : null}
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
