import { ArrowLeft, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'

import { PaneRail } from './PaneRail'
import { ActivityPane } from './panes/ActivityPane'
import { CloudDocumentPane } from './panes/CloudDocumentPane'
import { MemoriesPane } from './panes/MemoriesPane'
import { OverviewPane } from './panes/OverviewPane'
import { RelationsPane } from './panes/RelationsPane'
import { PANE_ITEMS } from './roomConfig'
import { RoomIcon } from './RoomIcon'
import type { ContextRoomRecord, RoomPane } from './types'

export function ContextRoomDetail({
  room,
  rooms,
  onBack,
  onOpenRoom,
  onUpdateRoom,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  onBack: () => void
  onOpenRoom: (id: string) => void
  onUpdateRoom: (room: ContextRoomRecord) => void
}) {
  const [activePane, setActivePane] = useState<RoomPane>('overview')
  const paneTitle = PANE_ITEMS.find((item) => item.id === activePane)?.label ?? '概览'

  const toggleTask = (id: string) => {
    onUpdateRoom({
      ...room,
      tasks: room.tasks.map((task) => task.id === id ? { ...task, done: !task.done } : task),
    })
  }

  return (
    <div className="cr-detail">
      <header className="cr-detail-header">
        <button type="button" className="cr-back" aria-label="返回 Context Room" onClick={onBack}>
          <ArrowLeft aria-hidden="true" strokeWidth={1.8} />
        </button>
        <RoomIcon kind={room.kind} />
        <div><span>{room.kind} Room</span><h1>{room.title}</h1></div>
        <span className="cr-detail-location">{paneTitle}</span>
        <button type="button" className="cr-icon-button" aria-label="Room 更多操作" title="更多操作">
          <MoreHorizontal aria-hidden="true" strokeWidth={1.8} />
        </button>
      </header>
      <div className="cr-detail-body">
        <PaneRail activePane={activePane} onSelect={setActivePane} />
        <main className="cr-pane-content">
          {activePane === 'overview' ? <OverviewPane room={room} onSelect={setActivePane} /> : null}
          {activePane === 'documents' ? <CloudDocumentPane key={room.id} room={room} /> : null}
          {activePane === 'relations' ? <RelationsPane room={room} rooms={rooms} onOpenRoom={onOpenRoom} /> : null}
          {activePane === 'memories' ? <MemoriesPane room={room} /> : null}
          {activePane === 'schedule' || activePane === 'tasks' || activePane === 'mails' ? (
            <ActivityPane room={room} pane={activePane} onToggleTask={toggleTask} />
          ) : null}
        </main>
      </div>
    </div>
  )
}
