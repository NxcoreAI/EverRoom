import { Layers3, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'

import { createRoomGraphData, ROOM_RECOMMENDATIONS } from './data'
import { GraphWorkspace } from './GraphWorkspace'
import { RoomCard } from './RoomCard'
import { RoomIcon } from './RoomIcon'
import { SectionTitle } from './SectionTitle'
import type { ContextRoomRecord, RoomRecommendation } from './types'

export function ContextRoomHome({
  rooms,
  onOpen,
  onCreate,
  onDelete,
}: {
  rooms: ContextRoomRecord[]
  onOpen: (id: string) => void
  onCreate: (recommendation?: RoomRecommendation) => void
  onDelete: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null)
  const graphData = useMemo(() => createRoomGraphData(rooms), [rooms])
  const visibleRooms = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return normalized ? rooms.filter((room) => room.title.toLocaleLowerCase().includes(normalized)) : rooms
  }, [query, rooms])

  return (
    <div className="cr-page cr-home" data-testid="context-room-page">
      <div className="cr-home-layout">
        <section className="cr-section">
          <SectionTitle label="推荐" title="推荐的 Room" />
          <div className="cr-recommendation-grid">
            {ROOM_RECOMMENDATIONS.map((item) => (
              <button key={item.id} type="button" className="cr-recommendation" onClick={() => onCreate(item)}>
                <RoomIcon kind={item.kind} />
                <span><strong>{item.title}</strong><small>{item.reason}</small></span>
                <span className="cr-count"><Layers3 aria-hidden="true" strokeWidth={1.8} />{item.materialCount}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="cr-section">
          <div className="cr-room-toolbar">
            <div>
              <SectionTitle label="我的" title="我的 Room" />
              <button type="button" className="cr-icon-button" aria-label="新建 Room" title="新建 Room" onClick={() => onCreate()}>
                <Plus aria-hidden="true" strokeWidth={1.8} />
              </button>
            </div>
            <label className="cr-search">
              <Search aria-hidden="true" strokeWidth={1.8} />
              <input
                type="search"
                aria-label="搜索我的 Room"
                placeholder="搜索我的 Room"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="cr-room-grid">
            {visibleRooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                onOpen={() => onOpen(room.id)}
                onDelete={() => onDelete(room.id)}
              />
            ))}
            {!visibleRooms.length ? (
              <div className="cr-empty">
                <Layers3 aria-hidden="true" strokeWidth={1.8} />
                <h3>没有匹配的 Room</h3>
                <p>调整关键词，或创建一个新 Room。</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="cr-section cr-graph-section">
          <SectionTitle label="关系" title="Room 关系图谱" />
          <GraphWorkspace
            data={graphData}
            rooms={rooms}
            selectedId={selectedGraphId}
            onSelect={setSelectedGraphId}
            onOpen={onOpen}
          />
        </section>
      </div>
    </div>
  )
}
