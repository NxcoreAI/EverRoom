import { CalendarDays, Check, ChevronRight, Mail, Plus } from 'lucide-react'

import type { ContextRoomRecord } from '../types'

type ActivityPaneId = 'schedule' | 'tasks' | 'mails'

const SCHEDULE_ITEMS = [
  ['产品范围评审', '今天 14:30', '林薇、陆远、周明'],
  ['连接器技术对齐', '明天 10:00', '陆远、周明'],
] as const

const MAIL_ITEMS = [
  ['开源版内测清单确认', '刚刚', '林薇'],
  ['Re: Connector 边界与后续计划', '昨天', '周明'],
  ['本周产品进展', '8 月 12 日', 'Everroom 团队'],
] as const

export function ActivityPane({
  room,
  pane,
  onToggleTask,
}: {
  room: ContextRoomRecord
  pane: ActivityPaneId
  onToggleTask: (id: string) => void
}) {
  if (pane === 'tasks') {
    return (
      <div className="cr-activity-pane">
        <header>
          <div><h2>任务</h2><span>{room.tasks.filter((task) => !task.done).length} 项待办</span></div>
          <button type="button" className="primary-button"><Plus aria-hidden="true" strokeWidth={1.8} />新建任务</button>
        </header>
        <div className="cr-task-list">
          {room.tasks.map((task) => (
            <button type="button" key={task.id} onClick={() => onToggleTask(task.id)}>
              <span className="cr-task-check" data-done={String(task.done)}>{task.done ? <Check aria-hidden="true" strokeWidth={1.8} /> : null}</span>
              <span><strong>{task.title}</strong><small>{task.owner} / 当前 Room</small></span>
              <span>{task.done ? '已完成' : '进行中'}</span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const items = pane === 'schedule' ? SCHEDULE_ITEMS : MAIL_ITEMS
  const Icon = pane === 'schedule' ? CalendarDays : Mail
  const tone = pane === 'schedule' ? 'calendar' : 'communication'

  return (
    <div className="cr-activity-pane">
      <header>
        <div><h2>{pane === 'schedule' ? '日程与会议' : '相关邮件'}</h2><span>{items.length} 项与当前 Room 关联</span></div>
      </header>
      <div className="cr-activity-list">
        {items.map(([title, time, meta]) => (
          <button type="button" key={title}>
            <span className="cr-file-icon" data-icon-tone={tone}><Icon aria-hidden="true" strokeWidth={1.8} /></span>
            <span><strong>{title}</strong><small>{meta}</small></span>
            <time>{time}</time>
            <ChevronRight aria-hidden="true" strokeWidth={1.8} />
          </button>
        ))}
      </div>
    </div>
  )
}
