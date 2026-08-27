import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import type { ContextRoomRecord, ContextRoomResource, ContextRoomWikiPageResource } from '../../types';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
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
  trashedDocuments,
  knowledgeFiles,
  onSelectResource,
  onOpenWikiPage,
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
  knowledgeFiles: KnowledgeFileDto[];
  onSelectResource: (resource: ContextRoomResource) => void;
  onOpenWikiPage: (resource: ContextRoomWikiPageResource) => void;
  onCreateDocument: (title: string, contentJson?: TiptapJsonContent) => Promise<void>;
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
        knowledgeFiles={knowledgeFiles}
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
      <MemoryPane
        room={room}
        onOpenMemory={onOpenMemory}
        onUpdateRoom={onUpdateRoom}
        onOpenObject={onOpenObject}
      />
    );
  }
  if (pane === 'wiki') {
    return (
      <WikiPane
        room={room}
        selectedResourceId={selectedResourceId}
        onOpenPage={onOpenWikiPage}
      />
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
