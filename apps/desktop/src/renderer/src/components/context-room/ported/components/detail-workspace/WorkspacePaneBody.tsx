import type { RoomAppliedEntitySource, RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import type { ContextRoomRecord, ContextRoomResource, ContextRoomWikiPageResource } from '../../types';
import type {
  EmergenceFocusInput,
  KnowledgeFileDto,
} from '../../../../../../../shared/knowledge';
import type { BoardId, BoardSubtab } from '../RoomIconSidebar';
import {
  ActivityPane,
  ArtifactLibraryPane,
  IdeasBoardPane,
  LinkGraphPane,
  MaterialsPane,
  MemoryPane,
  OverviewDashboard,
  RelationsPane,
  TodoPane,
  WikiPane,
  type WorkspaceObjectPreview,
} from '../detail-panels';

export function WorkspacePaneBody({
  board,
  subtab,
  room,
  selectedResourceId,
  selectedResource,
  focus,
  focusLocked,
  onToggleFocusLock,
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
  onOpenDocument,
  onOpenPane,
  linkGraphFocusNodeId,
  onOpenObject,
  onOpenSource,
  rooms,
  onOpenRoom,
  onToggleTask,
  onUpdateRoom,
  selectedObject,
  onCloseObject,
}: {
  board: BoardId;
  subtab: BoardSubtab | null;
  room: ContextRoomRecord;
  selectedResourceId: string | null;
  selectedResource: ContextRoomResource | null;
  /** 焦点协调器输出：权威焦点档案。 */
  focus: EmergenceFocusInput;
  focusLocked: boolean;
  onToggleFocusLock: () => void;
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
  /** 建联图谱等面板按文档 id 在右区打开文档。 */
  onOpenDocument: (documentId: string) => void;
  /** 概览下钻到工作板块其他页签。 */
  onOpenPane: (subtab: BoardSubtab) => void;
  /** 索引 chip 跳转：建联图谱聚焦节点 id（memory:{id} / doc:{id}）。 */
  linkGraphFocusNodeId?: string | null;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  onOpenSource: (source: RoomAppliedEntitySource) => void;
  rooms: ContextRoomRecord[];
  onOpenRoom: (roomId: string) => void;
  onToggleTask: (taskId: string) => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
  /** 面板内详情子视图的受控态：仅归属页签消费（任务/会议/邮件）。 */
  selectedObject: WorkspaceObjectPreview | null;
  onCloseObject: () => void;
}) {
  // 详情归属页签与 PortedDetail.openObject 的映射保持一致：会议/任务归待办，邮件归资料。
  const objectOwnerSubtab = (target: WorkspaceObjectPreview): BoardSubtab =>
    target.kind === 'meeting' || target.kind === 'task' ? 'todo' : 'materials';
  const ownedDetail = selectedObject && board === 'work' && objectOwnerSubtab(selectedObject) === subtab
    ? selectedObject
    : null;

  if (board === 'work') {
    if (subtab === 'activity') {
      return (
        <ActivityPane
          room={room}
          backendDocuments={backendDocuments.filter((document) => document.origin !== 'native')}
          knowledgeFiles={knowledgeFiles}
          onSelectResource={onSelectResource}
          onOpenObject={onOpenObject}
        />
      );
    }
    if (subtab === 'todo') {
      return (
        <TodoPane
          room={room}
          onOpen={onOpenObject}
          onSelect={(id) => onOpenObject({ kind: 'task', id })}
          onToggle={onToggleTask}
          detail={ownedDetail}
          onCloseDetail={onCloseObject}
          onUpdateRoom={onUpdateRoom}
        />
      );
    }
    if (subtab === 'materials') {
      // 资料：按来源对象平铺（外部导入文档、上传/本地文件、邮件、会议）；
      // EverRoom 产物只在产物板块出现。
      return (
        <MaterialsPane
          room={room}
          rooms={rooms}
          selectedId={selectedResourceId}
          backendDocuments={backendDocuments.filter((document) => document.origin !== 'native')}
          trashedDocuments={trashedDocuments.filter((document) => document.origin !== 'native')}
          knowledgeFiles={knowledgeFiles}
          onSelect={onSelectResource}
          onDeleteDocument={onDeleteDocument}
          onRestoreDocument={onRestoreDocument}
          onDeleteDocumentPermanently={onDeleteDocumentPermanently}
          onEmptyTrash={onEmptyTrash}
          onOpenObject={onOpenObject}
          detail={ownedDetail}
          onCloseDetail={onCloseObject}
          onUpdateRoom={onUpdateRoom}
        />
      );
    }
    // 分屏等工作非概览页签下的概览渲染（整屏场景由 WorkspaceLayout 直接接管）。
    return (
      <OverviewDashboard
        room={room}
        backendDocuments={backendDocuments}
        knowledgeFiles={knowledgeFiles}
        onSelectResource={onSelectResource}
        onOpenObject={onOpenObject}
        onOpenPane={onOpenPane}
        onToggleTask={onToggleTask}
      />
    );
  }

  if (board === 'artifacts') {
    // 产物库：仅用户在 EverRoom 创建的文档；外部导入归工作/资料。
    return (
      <ArtifactLibraryPane
        room={room}
        selectedId={selectedResourceId}
        backendDocuments={backendDocuments.filter((document) => document.origin === 'native')}
        trashedDocuments={trashedDocuments.filter((document) => document.origin === 'native')}
        onSelect={onSelectResource}
        onCreateDocument={onCreateDocument}
        onDeleteDocument={onDeleteDocument}
        onRestoreDocument={onRestoreDocument}
        onDeleteDocumentPermanently={onDeleteDocumentPermanently}
      />
    );
  }

  if (board === 'relations') {
    if (subtab === 'entities') {
      return (
        <MemoryPane
          room={room}
          onUpdateRoom={onUpdateRoom}
          onOpenRoom={onOpenRoom}
          onOpenSource={onOpenSource}
        />
      );
    }
    if (subtab === 'linkGraph') {
      return (
        <LinkGraphPane
          room={room}
          backendDocuments={backendDocuments}
          trashedDocuments={trashedDocuments}
          onOpenDocument={onOpenDocument}
          focusNodeId={linkGraphFocusNodeId}
        />
      );
    }
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

  if (board === 'thoughts') {
    return (
      <IdeasBoardPane
        room={room}
        focus={focus}
        focusLocked={focusLocked}
        onToggleFocusLock={onToggleFocusLock}
      />
    );
  }

  return (
    <WikiPane
      room={room}
      selectedResourceId={selectedResourceId}
      onOpenPage={onOpenWikiPage}
      view={subtab === 'wikiGraph' ? 'graph' : 'tree'}
    />
  );
}
