import { Maximize2, X } from 'lucide-react'
import { useRef } from 'react'

import { ContextGraphCanvas, type ContextGraphCanvasHandle } from './ContextGraphCanvas'
import { RoomIcon } from './RoomIcon'
import type { ContextGraphData, ContextRoomRecord } from './types'

export function GraphWorkspace({
  data,
  rooms,
  selectedId,
  onSelect,
  onOpen,
  compact = false,
}: {
  data: ContextGraphData
  rooms?: ContextRoomRecord[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onOpen?: (id: string) => void
  compact?: boolean
}) {
  const graphRef = useRef<ContextGraphCanvasHandle>(null)
  const selected = data.nodes.find((node) => node.id === selectedId) ?? null
  const selectedRoom = rooms?.find((room) => room.id === selectedId)

  return (
    <div className={`cr-graph-workspace${selected ? ' is-selected' : ''}`}>
      <div className="cr-graph-stage">
        <ContextGraphCanvas
          ref={graphRef}
          data={data}
          selectedId={selectedId}
          compact={compact}
          onSelect={onSelect}
          onOpen={onOpen}
        />
        <button
          type="button"
          className="cr-fit-button"
          aria-label="适应图谱画布"
          title="适应画布"
          onClick={() => void graphRef.current?.fitView()}
        >
          <Maximize2 aria-hidden="true" />
        </button>
      </div>
      {selected ? (
        <aside className="cr-graph-inspector">
          <header>
            <span>节点详情</span>
            <button type="button" aria-label="关闭节点详情" onClick={() => onSelect(null)}>
              <X aria-hidden="true" />
            </button>
          </header>
          {selected.kind === 'fact' ? <span className="cr-node-badge">事实</span> : <RoomIcon kind={selected.kind} />}
          <h3>{selected.label}</h3>
          <p>{selected.description}</p>
          {selectedRoom ? (
            <dl>
              <div><dt>关联人物</dt><dd>{selectedRoom.people.join('、') || '暂无'}</dd></div>
              <div><dt>相关资料</dt><dd>{selectedRoom.materials.length} 项</dd></div>
              <div><dt>已沉淀记忆</dt><dd>{selectedRoom.memories.length} 条</dd></div>
            </dl>
          ) : null}
          {selectedRoom && onOpen ? (
            <button type="button" className="primary-button" onClick={() => onOpen(selectedRoom.id)}>
              打开 Room
            </button>
          ) : null}
        </aside>
      ) : null}
    </div>
  )
}
