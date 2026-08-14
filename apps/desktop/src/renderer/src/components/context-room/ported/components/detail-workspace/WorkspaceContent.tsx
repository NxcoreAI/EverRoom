import { ChevronLeft } from 'lucide-react';

import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { ObjectDetailView } from '../ObjectDetailView';
import type { DetailPane } from '../RoomIconSidebar';
import { ObjectPreview, type WorkspaceObjectPreview } from '../detail-panels';
import { FakeDocumentContent } from '../detail-panels/FakeDocumentPane';
import { OfficePreview } from '../detail-panels/ResourcePanel';

export function WorkspaceContent({
  room,
  rooms,
  panels,
  selectedObject,
  selectedResource,
  onOpenRoom,
  onMobileBack,
  onCloseObject,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  rooms: ContextRoomRecord[];
  panels: DetailPane[];
  selectedObject: WorkspaceObjectPreview | null;
  selectedResource: ContextRoomResource | null;
  onOpenRoom: (roomId: string) => void;
  onMobileBack: () => void;
  onCloseObject: () => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
}) {
  const selectedObjectOwner = selectedObject?.kind === 'meeting'
    ? 'schedule'
    : selectedObject?.kind === 'task'
      ? 'tasks'
      : selectedObject
        ? 'relations'
        : null;
  const visibleObject = selectedObjectOwner && panels.includes(selectedObjectOwner)
    ? selectedObject
    : null;
  const visibleResource = panels.includes('documents') ? selectedResource : null;
  const showCloudDocs =
    !visibleObject &&
    ((!visibleResource && panels.includes('documents')) || visibleResource?.kind === 'cloud-doc');
  const selectedTask = visibleObject?.kind === 'task'
    ? room.actionItems.find((item) => item.id === visibleObject.id)
    : null;
  const selectedMeeting = visibleObject?.kind === 'meeting'
    ? room.materials.find((item) => item.id === visibleObject.id && item.type === '会议')
    : null;

  return (
    <section className="context-room-workspace-content">
      <button type="button" className="context-room-mobile-back" onClick={onMobileBack}>
        <ChevronLeft aria-hidden="true" />
        返回资源
      </button>
      {selectedTask ? (
        <ObjectDetailView
          embedded
          room={room}
          object={{ kind: 'task', value: selectedTask }}
          onBack={onCloseObject}
          onUpdateRoom={onUpdateRoom}
        />
      ) : selectedMeeting ? (
        <ObjectDetailView
          embedded
          room={room}
          object={{ kind: 'meeting', value: selectedMeeting }}
          onBack={onCloseObject}
          onUpdateRoom={onUpdateRoom}
        />
      ) : visibleObject ? (
        <ObjectPreview
          room={room}
          rooms={rooms}
          selection={visibleObject}
          onOpenRoom={onOpenRoom}
        />
      ) : showCloudDocs ? (
        <FakeDocumentContent room={room} resource={visibleResource} />
      ) : visibleResource?.kind === 'office-file' ? (
        <OfficePreview resource={visibleResource} />
      ) : (
        <div className="context-room-workspace-empty">从左侧选择一个资源</div>
      )}
    </section>
  );
}
