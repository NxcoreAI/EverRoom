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
import { useMemo, useState } from 'react';

import { createContextRoomResourceLibrary } from '../../resources';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
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
  if (value.startsWith('今天')) return date;
  if (value.startsWith('昨天')) {
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

function timelineRangeLabel(view: TimelineView, cursor: Date) {
  if (view === 'day') {
    return `${String(cursor.getFullYear())}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
  }
  if (view === 'week') {
    const start = startOfWeek(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return `${String(start.getMonth() + 1)}/${String(start.getDate()).padStart(2, '0')} ~ ${String(end.getMonth() + 1)}/${String(end.getDate()).padStart(2, '0')}`;
  }
  return `${String(cursor.getFullYear())} 年 ${String(cursor.getMonth() + 1)} 月`;
}

export function OverviewDashboard({
  room,
  onSelectResource,
  onOpenObject,
  onToggleTask,
}: {
  room: ContextRoomRecord;
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  onToggleTask: (taskId: string) => void;
}) {
  const [timelineView, setTimelineView] = useState<TimelineView>('month');
  const [timelineCursor, setTimelineCursor] = useState(() => new Date(REFERENCE_TODAY));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const Icon = roomKindIcon(room.kind);
  const dashboard = DASHBOARD_COPY[room.id] ?? {
    aiStatus: room.brief.status,
    nextSteps: room.actionItems.slice(0, 4).map((item) => item.title),
    entities: room.people.map((person) => ({ label: person.name, description: person.role })),
  };
  const library = useMemo(() => createContextRoomResourceLibrary(room), [room]);
  const visibleTimeline = room.timeline.filter((item) =>
    inTimelineRange(parseRoomDate(item.time), timelineView, timelineCursor)
  );
  const recentMaterials = room.materials.slice(0, 3);
  const todayMeeting = room.materials.find((item) => item.type === '会议');
  const openTasks = room.actionItems.filter((item) => !item.completed && item.status !== '已完成').slice(0, 3);
  const hasBrief = Boolean(room.brief.background.trim() || room.brief.goal.trim());
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
          <p><CalendarDays aria-hidden="true" />更新于 {room.lastViewed} <i /> {room.materials.length + room.fileItems.length} 条资料</p>
        </div>
        <b>{room.status}</b>
      </header>

      <div className="context-room-dashboard-grid">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" />Room 简介</header>
          {hasBrief ? (
            <><p>{room.brief.background || '暂无背景说明'}</p><small><b>目标：</b>{room.brief.goal || '暂未设置'}</small></>
          ) : (
            <PanelEmptyState compact icon={FileText} title="还没有简介" description="Room 的背景和目标会显示在这里。" />
          )}
        </article>
        <article>
          <header data-icon-tone="room"><BarChart3 aria-hidden="true" />当前状态 <em>AI</em></header>
          {dashboard.aiStatus.trim() ? <p>{dashboard.aiStatus}</p> : <PanelEmptyState compact icon={Info} title="尚未形成状态摘要" description="有新的资料和活动后，状态会在这里更新。" />}
        </article>
        <article>
          <header data-icon-tone="ai"><Zap aria-hidden="true" />建议下一步 <em>AI</em></header>
          {dashboard.nextSteps.length ? <ul>{dashboard.nextSteps.map((item) => <li key={item}><CornerDownRight aria-hidden="true" />{item}</li>)}</ul> : <PanelEmptyState compact icon={Zap} title="暂时没有下一步建议" description="新的上下文进入 Room 后会重新生成建议。" />}
        </article>
        <article>
          <header data-icon-tone="memory"><Bookmark aria-hidden="true" />关联记忆实体</header>
          {dashboard.entities.length ? (
            <div className="context-room-dashboard-entities">
              {dashboard.entities.map((entity) => <span key={entity.label} title={entity.description}>{entity.label}</span>)}
            </div>
          ) : <PanelEmptyState compact icon={Network} title="还没有关联实体" description="识别到的人物、项目和主题会显示在这里。" />}
        </article>
      </div>

      <div className="context-room-dashboard-bottom">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" />最新资料</header>
          {recentMaterials.map((material) => {
            const resource = library.resources.find((item) => item.name === material.title);
            return <button type="button" key={material.id} onClick={() => resource && onSelectResource(resource)}><span>{material.type}</span><b>{material.title}</b><time>{material.time}</time></button>;
          })}
          {!recentMaterials.length ? <PanelEmptyState compact icon={FileText} title="还没有资料" description="Room 收集的文档、邮件和会议会显示在这里。" /> : null}
        </article>
        <article>
          <header data-icon-tone="calendar"><CalendarDays aria-hidden="true" />今日日程</header>
          {todayMeeting ? <button type="button" onClick={() => onOpenObject({ kind: 'meeting', id: todayMeeting.id })}><time>10:30</time><b>{todayMeeting.title}</b></button> : <PanelEmptyState compact icon={CalendarDays} title="今天没有日程" description="今天的会议和到期任务会显示在这里。" />}
        </article>
        <article>
          <header data-icon-tone="task"><CheckSquare2 aria-hidden="true" />待办任务</header>
          {openTasks.map((task) => <div className="context-room-dashboard-task" key={task.id}><button type="button" aria-label={`完成 ${task.title}`} onClick={() => onToggleTask(task.id)}><i /></button><button type="button" onClick={() => onOpenObject({ kind: 'task', id: task.id })}><b>{task.title}</b><time>{task.deadline}</time></button></div>)}
          {!openTasks.length ? <PanelEmptyState compact icon={CheckSquare2} title="没有待办任务" description="未完成的 Room 任务会显示在这里。" /> : null}
        </article>
      </div>

      <article className="context-room-dashboard-timeline">
        <header data-icon-tone="data"><GitBranch aria-hidden="true" />Room 时间轴 <span>{visibleTimeline.length} 个事件</span></header>
        <div className="context-room-timeline-toolbar">
          <div>{(['day', 'week', 'month'] as const).map((view) => <button type="button" key={view} aria-pressed={timelineView === view} onClick={() => setTimelineView(view)}>{view === 'day' ? '日' : view === 'week' ? '周' : '月'}</button>)}</div>
          <nav aria-label="时间轴范围">
            <button type="button" aria-label="上一周期" onClick={() => moveTimeline(-1)}><ChevronLeft aria-hidden="true" /></button>
            <span>{timelineRangeLabel(timelineView, timelineCursor)}</span>
            <button type="button" aria-label="下一周期" onClick={() => moveTimeline(1)}><ChevronRight aria-hidden="true" /></button>
            <button type="button" disabled={timelineCursor.toDateString() === REFERENCE_TODAY.toDateString()} onClick={() => setTimelineCursor(new Date(REFERENCE_TODAY))}>今天</button>
          </nav>
        </div>
        {visibleTimeline.length ? <ol>{visibleTimeline.map((item, index) => {
          const material = recentMaterials[index] as (typeof recentMaterials)[number] | undefined;
          const resource = material ? library.resources.find((candidate) => candidate.name === material.title) : null;
          return <li key={`${item.time}-${item.title}`}><i data-kind={item.kind} /><div><div><b>{item.title}</b><time>{item.time}</time></div><p>{item.description}</p>{resource ? <><button type="button" aria-expanded={expanded.has(index)} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; })}><ChevronRight aria-hidden="true" />相关资料 <span>1</span></button>{expanded.has(index) ? <button type="button" className="context-room-timeline-material" onClick={() => onSelectResource(resource)}><FileText aria-hidden="true" />{resource.name}</button> : null}</> : null}</div></li>;
        })}</ol> : <PanelEmptyState compact icon={GitBranch} title="当前范围没有事件" description="可切换时间范围查看 Room 的其他活动。" />}
      </article>
    </section>
  );
}
