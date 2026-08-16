import type { RoomDocument } from '@nxcore/agent-contract';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import type { DetailPane } from '../RoomIconSidebar';
import {
  MailsPane,
  MemoryPane,
  RelationsPane,
  SchedulePane,
  TasksPane,
  type WorkspaceObjectPreview,
} from '../detail-panels';
import { ResourceTree, type LocalOfficeFile } from '../detail-panels/ResourcePanel';

export function WorkspacePaneBody({
  pane,
  room,
  selectedResourceId,
  backendDocuments,
  trashedDocuments,
  onSelectResource,
  onCreateDocument,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
  onEmptyTrash,
  onAddFile,
  onOpenMemory,
  onOpenObject,
  rooms,
  onOpenRoom,
  onToggleTask,
  onUpdateRoom,
}: {
  pane: DetailPane;
  room: ContextRoomRecord;
  selectedResourceId: string | null;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onCreateDocument: (title: string) => Promise<void>;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onRestoreDocument: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>;
  onEmptyTrash: (roomId: string) => Promise<void>;
  onAddFile: (file: LocalOfficeFile) => void;
  onOpenMemory: (id: string) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  rooms: ContextRoomRecord[];
  onOpenRoom: (roomId: string) => void;
  onToggleTask: (taskId: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
}) {
  if (pane === 'documents') {
    return (
      <ResourceTree
        room={room}
        selectedId={selectedResourceId}
        backendDocuments={backendDocuments}
        trashedDocuments={trashedDocuments}
        onSelect={onSelectResource}
        onCreateDocument={onCreateDocument}
        onDeleteDocument={onDeleteDocument}
        onRestoreDocument={onRestoreDocument}
        onDeleteDocumentPermanently={onDeleteDocumentPermanently}
        onEmptyTrash={onEmptyTrash}
        onAddFile={onAddFile}
      />
    );
  }
  if (pane === 'relations') {
    return (
      <RelationsPane
        room={room}
        rooms={rooms}
        onOpenRoom={onOpenRoom}
      />
    );
  }
  if (pane === 'memories') {
    return (
      <MemoryPane room={room} onOpenMemory={onOpenMemory} onUpdateRoom={onUpdateRoom} />
    );
  }
  if (pane === 'schedule') return <SchedulePane room={room} onOpen={onOpenObject} />;
  if (pane === 'tasks') {
    return (
      <TasksPane
        room={room}
        onSelect={(id) => onOpenObject({ kind: 'task', id })}
        onToggle={onToggleTask}
      />
    );
  }
  return <MailsPane room={room} onSelect={(id) => onOpenObject({ kind: 'mail', id })} />;
}
