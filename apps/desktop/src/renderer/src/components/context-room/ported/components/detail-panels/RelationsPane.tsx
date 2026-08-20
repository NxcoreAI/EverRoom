import { ChevronRight, FileText, Maximize2, Network } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { ContextRoomRecord } from '../../types';
import { localizedUiText, uiText } from '../../adapters';
import { RoomGraphCanvas, type RoomGraphCanvasHandle } from '../RoomGraphCanvas';
import { roomKindIcon, roomKindTone } from '../utils';
import { PanelEmptyState } from './PanelEmptyState';

export function RelationsPane({ room, rooms, onOpenRoom }: { room: ContextRoomRecord; rooms: ContextRoomRecord[]; onOpenRoom: (roomId: string) => void }) {
  const { t } = useLocale();
  const people = useMemo(() => new Set(room.people.map((person) => person.name)), [room]);
  const relatedRooms = rooms.filter((candidate) => candidate.id !== room.id && (candidate.kind === room.kind || candidate.people.some((person) => people.has(person.name))));
  const graphRooms = [room, ...relatedRooms];
  const graphRef = useRef<RoomGraphCanvasHandle>(null);
  const [selectedGraphRoomId, setSelectedGraphRoomId] = useState(room.id);
  useEffect(() => setSelectedGraphRoomId(room.id), [room.id]);
  const selectedRoom = graphRooms.find((candidate) => candidate.id === selectedGraphRoomId) ?? room;
  const selected = {
    ...selectedRoom,
    brief: {
      ...selectedRoom.brief,
      background: localizedUiText(selectedRoom.brief.background, t),
    },
  };
  const sharedPeople = selected.people.filter((person) => people.has(person.name));
  const Icon = roomKindIcon(selected.kind);

  if (!relatedRooms.length) {
    return (
      <div className="context-room-related-rooms-pane is-empty">
        <header className="context-room-related-empty-header">
          <div><h2>{t('contextRoom:relations.roomRelationshipGraph')}</h2><span>{room.title}</span></div>
        </header>
        <PanelEmptyState
          icon={Network}
          title={t('contextRoom:relations.noRelatedRoomsYet')}
          description={t('contextRoom:relations.roomsWithTheSameTypeOrSharedPeople')}
        />
      </div>
    );
  }

  return <div className="context-room-related-rooms-pane"><section className="context-room-related-graph"><header><div><h2>{t('contextRoom:relations.roomRelationshipGraph')}</h2><span>{room.title}</span></div><button type="button" aria-label={t('contextRoom:relations.fitRelatedRoomGraph')} title={t('contextRoom:relations.fitToCanvas')} onClick={() => void graphRef.current?.fitView()}><Maximize2 aria-hidden="true" /></button></header><div className="context-room-related-graph-canvas"><RoomGraphCanvas ref={graphRef} compact rooms={graphRooms} selectedId={selectedGraphRoomId} onSelectRoom={(roomId) => setSelectedGraphRoomId(roomId ?? room.id)} onOpenRoom={onOpenRoom} /></div></section><article className="context-room-related-inline-detail" data-icon-tone={roomKindTone(selected.kind)}><header><span className="context-room-related-room-icon"><Icon aria-hidden="true" /></span><div><small>{t(selected.id === room.id ? 'contextRoom:relations.currentRoom' : 'contextRoom:relations.relatedRoom')}</small><h3>{selected.title}</h3></div></header><p>{selected.brief.background}</p><dl><div><dt>{t('contextRoom:relations.relationshipBasis')}</dt><dd>{selected.id === room.id ? t('contextRoom:relations.centerOfTheCurrentGraph') : sharedPeople.length ? t('contextRoom:relations.sharedPeoplePeople', { people: sharedPeople.map((person) => person.name).join('、') }) : t('contextRoom:relations.bothAreKindRooms', { kind: t(uiText(room.kind)) })}</dd></div><div><dt>{t('contextRoom:relations.relatedResources')}</dt><dd>{t('contextRoom:relations.countItems', { count: selected.materials.length + selected.fileItems.length })}</dd></div></dl><section><span>{t('contextRoom:relations.relatedResources')}</span>{selected.materials.slice(0, 3).map((material) => <div key={material.id}><FileText aria-hidden="true" /><b>{material.title}</b><time>{material.time}</time></div>)}</section><button type="button" className="context-room-primary" onClick={() => onOpenRoom(selected.id)}>{t('contextRoom:relations.openRoom')}<ChevronRight aria-hidden="true" /></button></article></div>;
}
