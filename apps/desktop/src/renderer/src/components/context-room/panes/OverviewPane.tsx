import {
  BarChart3,
  Bookmark,
  CalendarDays,
  CheckSquare2,
  CornerDownRight,
  FileText,
  GitBranch,
  Zap,
} from 'lucide-react'

import { RoomIcon } from '../RoomIcon'
import type { ContextRoomRecord, RoomPane } from '../types'

export function OverviewPane({
  room,
  onSelect,
}: {
  room: ContextRoomRecord
  onSelect: (pane: RoomPane) => void
}) {
  const openTasks = room.tasks.filter((task) => !task.done)
  const nextSteps = openTasks.length
    ? openTasks.slice(0, 4).map((task) => task.title)
    : ['补充 Room 的目标与资料边界', '添加第一项可追溯资料']
  const entities = [...room.people, ...room.tags].slice(0, 8)
  const timeline = [
    ...room.materials.slice(0, 3).map((material) => ({
      id: material.id,
      title: material.title,
      description: `${material.type}已进入当前 Room，可用于后续检索和引用。`,
      time: material.updated,
    })),
    ...room.memories.slice(0, 2).map((memory) => ({
      id: memory.id,
      title: `沉淀记忆：${memory.title}`,
      description: memory.detail,
      time: memory.status,
    })),
  ]

  return (
    <div className="cr-overview cr-dashboard">
      <header className="cr-dashboard-hero">
        <RoomIcon kind={room.kind} />
        <div>
          <h1>{room.title}</h1>
          <p><CalendarDays aria-hidden="true" strokeWidth={1.8} />最近更新于 {room.updated}<i />{room.materials.length} 条资料</p>
        </div>
        <b>{room.kind}</b>
      </header>

      <div className="cr-dashboard-grid">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" strokeWidth={1.8} />Room 简介</header>
          <p>{room.description}</p><small><b>目标：</b>聚合资料、人物、记忆与执行进展，形成可追溯的工作上下文。</small>
        </article>
        <article>
          <header data-icon-tone="room"><BarChart3 aria-hidden="true" strokeWidth={1.8} />当前状态 <em>AI</em></header>
          <p>已聚合 {room.materials.length} 项资料、{room.memories.length} 条记忆，当前有 {openTasks.length} 项待办。所有输出保留到原始来源的引用。</p>
        </article>
        <article>
          <header data-icon-tone="ai"><Zap aria-hidden="true" strokeWidth={1.8} />建议下一步 <em>AI</em></header>
          <ul>{nextSteps.map((item) => <li key={item}><CornerDownRight aria-hidden="true" strokeWidth={1.8} />{item}</li>)}</ul>
        </article>
        <article>
          <header data-icon-tone="memory"><Bookmark aria-hidden="true" strokeWidth={1.8} />关联记忆实体</header>
          <div className="cr-dashboard-entities">{entities.length ? entities.map((entity) => <span key={entity}>{entity}</span>) : '暂无关联实体'}</div>
        </article>
      </div>

      <div className="cr-dashboard-bottom">
        <article>
          <header data-icon-tone="document"><FileText aria-hidden="true" strokeWidth={1.8} />最新资料</header>
          {room.materials.slice(0, 3).map((material) => (
            <button type="button" key={material.id} onClick={() => onSelect('documents')}><span>{material.type}</span><b>{material.title}</b><time>{material.updated}</time></button>
          ))}
          {!room.materials.length ? <p>暂无资料</p> : null}
        </article>
        <article>
          <header data-icon-tone="calendar"><CalendarDays aria-hidden="true" strokeWidth={1.8} />今日日程</header>
          <button type="button" onClick={() => onSelect('schedule')}><time>14:30</time><b>产品范围评审</b></button>
        </article>
        <article>
          <header data-icon-tone="task"><CheckSquare2 aria-hidden="true" strokeWidth={1.8} />待办任务</header>
          {openTasks.slice(0, 3).map((task) => <button type="button" key={task.id} onClick={() => onSelect('tasks')}><span>待办</span><b>{task.title}</b><time>{task.owner}</time></button>)}
          {!openTasks.length ? <p>暂无待办</p> : null}
        </article>
      </div>

      <article className="cr-dashboard-timeline">
        <header data-icon-tone="data"><GitBranch aria-hidden="true" strokeWidth={1.8} />Room 时间轴 <span>{timeline.length} 个事件</span></header>
        {timeline.length ? (
          <ol>{timeline.map((item) => <li key={item.id}><i /><div><div><b>{item.title}</b><time>{item.time}</time></div><p>{item.description}</p></div></li>)}</ol>
        ) : <div className="cr-dashboard-empty">当前 Room 暂无事件</div>}
      </article>
    </div>
  )
}
