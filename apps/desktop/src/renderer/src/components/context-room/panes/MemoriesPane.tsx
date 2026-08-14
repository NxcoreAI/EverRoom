import { Bookmark } from 'lucide-react'
import { useMemo, useState } from 'react'

import { createMemoryGraphData } from '../data'
import { GraphWorkspace } from '../GraphWorkspace'
import type { ContextRoomRecord } from '../types'

export function MemoriesPane({ room }: { room: ContextRoomRecord }) {
  const data = useMemo(() => createMemoryGraphData(room), [room])
  const [selectedId, setSelectedId] = useState<string | null>(data.nodes[0]?.id ?? null)

  return (
    <div className="cr-memory-pane">
      <div className="cr-memory-head">
        <div><h2>实体与事实</h2><span>{room.memories.length} 条 Room 记忆</span></div>
        <div className="segmented-control"><button type="button">列表</button><button type="button" data-active="true">图谱</button></div>
      </div>
      <GraphWorkspace data={data} selectedId={selectedId} onSelect={setSelectedId} />
      <section className="cr-memory-list">
        {room.memories.map((memory) => (
          <article key={memory.id}>
            <Bookmark aria-hidden="true" strokeWidth={1.8} />
            <div><strong>{memory.title}</strong><p>{memory.detail}</p></div>
            <span data-status={memory.status}>{memory.status}</span>
          </article>
        ))}
      </section>
    </div>
  )
}
