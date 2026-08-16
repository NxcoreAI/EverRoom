import { ChevronRight, FileText, Maximize2, Network } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ContextRoomRecord } from '../../types';
import { RoomGraphCanvas, type RoomGraphCanvasHandle } from '../RoomGraphCanvas';
import { roomKindIcon, roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';

export function RelationsPane({ room, rooms, onOpenRoom }: { room: ContextRoomRecord; rooms: ContextRoomRecord[]; onOpenRoom: (roomId: string) => void }) {
  const people = useMemo(() => new Set(room.people.map((person) => person.name)), [room]);
  const relatedRooms = rooms.filter((candidate) => candidate.id !== room.id && (candidate.kind === room.kind || candidate.people.some((person) => people.has(person.name))));
  const graphRooms = [room, ...relatedRooms];
  const graphRef = useRef<RoomGraphCanvasHandle>(null);
  const [selectedGraphRoomId, setSelectedGraphRoomId] = useState(room.id);
  useEffect(() => setSelectedGraphRoomId(room.id), [room.id]);
  const selected = graphRooms.find((candidate) => candidate.id === selectedGraphRoomId) ?? room;
  const sharedPeople = selected.people.filter((person) => people.has(person.name));
  const Icon = roomKindIcon(selected.kind);

  if (!relatedRooms.length) {
    return (
      <div className="context-room-related-rooms-pane is-empty">
        <header className="context-room-related-empty-header">
          <div><h2>Room 关系图谱</h2><span>{room.title}</span></div>
        </header>
        <PanelEmptyState
          icon={Network}
          title="还没有关联 Room"
          description="具有相同类型或共同人物的 Room 会出现在这里。"
        />
      </div>
    );
  }

  return <div className="context-room-related-rooms-pane"><section className="context-room-related-graph"><header><div><h2>Room 关系图谱</h2><span>{room.title}</span></div><button type="button" aria-label="适应关联 Room 图谱" title="适应画布" onClick={() => void graphRef.current?.fitView()}><Maximize2 aria-hidden="true" /></button></header><div className="context-room-related-graph-canvas"><RoomGraphCanvas ref={graphRef} compact rooms={graphRooms} selectedId={selectedGraphRoomId} onSelectRoom={(roomId) => setSelectedGraphRoomId(roomId ?? room.id)} onOpenRoom={onOpenRoom} /></div></section><article className="context-room-related-inline-detail" data-icon-tone={roomKindTone(selected.kind)}><header><span className="context-room-related-room-icon"><Icon aria-hidden="true" /></span><div><small>{selected.id === room.id ? '当前 Room' : '关联 Room'}</small><h3>{selected.title}</h3></div></header><p>{selected.brief.background}</p><dl><div><dt>关系依据</dt><dd>{selected.id === room.id ? '当前关系图中心' : sharedPeople.length ? `共同人物：${sharedPeople.map((person) => person.name).join('、')}` : `同为${room.kind} Room`}</dd></div><div><dt>相关资料</dt><dd>{selected.materials.length + selected.fileItems.length} 项</dd></div></dl><section><span>相关资料</span>{selected.materials.slice(0, 3).map((material) => <div key={material.id}><FileText aria-hidden="true" /><b>{material.title}</b><time>{material.time}</time></div>)}</section><button type="button" className="context-room-primary" onClick={() => onOpenRoom(selected.id)}>打开 Room<ChevronRight aria-hidden="true" /></button></article></div>;
}
