import type { RoomDocument } from '@nxcore/agent-contract';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import type { DetailPane } from '../RoomIconSidebar';
import {
  MailsPane,
  MemoryPane,
  RelationsPane,
  SchedulePane,
  TasksPane,
  WikiPane,
  type WorkspaceObjectPreview,
} from '../detail-panels';
import { ResourceTree, type LocalOfficeFile } from '../detail-panels/ResourcePanel';

export function WorkspacePaneBody({
  pane,
  room,
  selectedResourceId,
  backendDocuments,
  onSelectResource,
  onDeleteDocument,
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
  onSelectResource: (resource: ContextRoomResource) => void;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
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
        onSelect={onSelectResource}
        onDeleteDocument={onDeleteDocument}
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
  if (pane === 'wiki') {
    return <WikiPane room={room} />;
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
