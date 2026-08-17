import type { DocumentEvent, RoomDocument } from '@nxcore/agent-contract';
import { ChevronLeft } from 'lucide-react';

import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { ObjectDetailView } from '../ObjectDetailView';
import type { DetailPane } from '../RoomIconSidebar';
import { ObjectPreview, type WorkspaceObjectPreview } from '../detail-panels';
import { FakeDocumentContent } from '../detail-panels/FakeDocumentPane';
import { OfficePreview } from '../detail-panels/ResourcePanel';
import { WikiPageReader } from '../detail-panels/WikiPageReader';

export function WorkspaceContent({
  room,
  rooms,
  panels,
  selectedObject,
  selectedResource,
  backendDocuments,
  documentEvents,
  onBackendDocumentChange,
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
  backendDocuments: RoomDocument[];
  documentEvents: Record<string, DocumentEvent[]>;
  onBackendDocumentChange: (document: RoomDocument) => void;
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
  // wiki 页面资源例外：知识库面板在场即可显示（从 wiki 目录树/图谱点开的页不切走左栏）
  const resourcePaneVisible = selectedResource?.kind === 'wiki-page'
    ? panels.includes('wiki') || panels.includes('documents')
    : panels.includes('documents');
  const visibleResource = resourcePaneVisible ? selectedResource : null;
  const showCloudDocs = !visibleObject && visibleResource?.kind === 'cloud-doc';
  const selectedTask = visibleObject?.kind === 'task'
    ? room.actionItems.find((item) => item.id === visibleObject.id)
    : null;
  const selectedMeeting = visibleObject?.kind === 'meeting'
    ? room.materials.find((item) => item.id === visibleObject.id && item.type === '会议')
    : null;

  return (
    <section className="context-room-workspace-content">
      {!selectedTask && !selectedMeeting ? (
        <button type="button" className="context-room-mobile-back" onClick={onMobileBack}>
          <ChevronLeft aria-hidden="true" />
          返回资源
        </button>
      ) : null}
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
        <FakeDocumentContent
          room={room}
          resource={visibleResource}
          backendDocuments={backendDocuments}
          documentEvents={documentEvents}
          onBackendDocumentChange={onBackendDocumentChange}
        />
      ) : visibleResource?.kind === 'office-file' ? (
        <OfficePreview resource={visibleResource} />
      ) : visibleResource?.kind === 'wiki-page' ? (
        <WikiPageReader resource={visibleResource} />
      ) : panels.includes('documents') ? (
        <div className="context-room-workspace-empty">暂无文档</div>
      ) : (
        <div className="context-room-workspace-empty">从左侧选择一个资源</div>
      )}
    </section>
  );
}
