import type { RoomAppliedEntitySource, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
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
import { ResourceTree } from '../detail-panels/ResourcePanel';

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
  onOpenMemory,
  onOpenObject,
  onOpenSource,
  rooms,
  onOpenRoom,
  onToggleTask,
  onUpdateRoom,
  selectedObject,
  onCloseObject,
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
  onOpenMemory: (id: string) => void;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  onOpenSource: (source: RoomAppliedEntitySource) => void;
  rooms: ContextRoomRecord[];
  onOpenRoom: (roomId: string) => void;
  onToggleTask: (taskId: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
  /** 面板内详情子视图的受控态：仅归属面板消费（任务/会议/邮件）。 */
  selectedObject: WorkspaceObjectPreview | null;
  onCloseObject: () => void;
}) {
  // 详情归属面板与 PortedDetail.openObject 的映射保持一致。
  const objectOwnerPane = (target: WorkspaceObjectPreview): DetailPane =>
    target.kind === 'meeting' ? 'schedule' : target.kind === 'task' ? 'tasks' : 'mails';
  const ownedDetail = selectedObject && objectOwnerPane(selectedObject) === pane ? selectedObject : null;
  if (pane === 'documents') {
    return (
      <ResourceTree
        room={room}
        rooms={rooms}
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
      />
    );
  }
  if (pane === 'relations') {
    return (
      <RelationsPane
        room={room}
        rooms={rooms}
        backendDocuments={backendDocuments}
        knowledgeFiles={knowledgeFiles}
        onOpenRoom={onOpenRoom}
        onSelectResource={onSelectResource}
      />
    );
  }
  if (pane === 'memories') {
    return (
      <MemoryPane
        room={room}
        onOpenMemory={onOpenMemory}
        onUpdateRoom={onUpdateRoom}
        onOpenRoom={onOpenRoom}
        onOpenSource={onOpenSource}
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
  if (pane === 'schedule') {
    return (
      <SchedulePane
        room={room}
        onOpen={onOpenObject}
        detail={ownedDetail}
        onCloseDetail={onCloseObject}
        onUpdateRoom={onUpdateRoom}
      />
    );
  }
  if (pane === 'tasks') {
    return (
      <TasksPane
        room={room}
        onSelect={(id) => onOpenObject({ kind: 'task', id })}
        onToggle={onToggleTask}
        detail={ownedDetail}
        onCloseDetail={onCloseObject}
        onUpdateRoom={onUpdateRoom}
      />
    );
  }
  return (
    <MailsPane
      room={room}
      rooms={rooms}
      onSelect={(id) => onOpenObject({ kind: 'mail', id })}
      detail={ownedDetail}
      onCloseDetail={onCloseObject}
      onUpdateRoom={onUpdateRoom}
    />
  );
}
