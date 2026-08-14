import { useMemo, useState } from 'react'

import { createRoomGraphData } from '../data'
import { GraphWorkspace } from '../GraphWorkspace'
import type { ContextRoomRecord } from '../types'

export function RelationsPane({
  room,
  rooms,
  onOpenRoom,
}: {
  room: ContextRoomRecord
  rooms: ContextRoomRecord[]
  onOpenRoom: (id: string) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(room.id)
  const graphData = useMemo(
    () => createRoomGraphData([room, ...rooms.filter((item) => item.id !== room.id)]),
    [room, rooms],
  )

  return (
    <div className="cr-full-graph">
      <header><div><h2>Room 关系图谱</h2><span>单击查看节点，双击打开 Room</span></div></header>
      <GraphWorkspace
        data={graphData}
        rooms={rooms}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onOpen={onOpenRoom}
      />
    </div>
  )
}
