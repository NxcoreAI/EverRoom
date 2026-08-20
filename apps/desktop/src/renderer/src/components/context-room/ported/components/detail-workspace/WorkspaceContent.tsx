import type { RoomDocument } from '@nxcore/agent-contract';
import { BookOpen, BrainCircuit, CalendarDays, CheckSquare2, ChevronLeft, FileText, Mail, Network } from 'lucide-react';

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary } from '../../resources';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { ObjectDetailView } from '../ObjectDetailView';
import type { DetailPane } from '../RoomIconSidebar';
import { ObjectPreview, type WorkspaceObjectPreview } from '../detail-panels';
import { DocumentContent } from '../detail-panels/DocumentPane';
import { KnowledgeFileReader } from '../detail-panels/KnowledgeFileReader';
import { PanelEmptyState } from '../detail-panels/PanelEmptyState';
import { OfficePreview } from '../detail-panels/ResourcePanel';
import { WikiPageReader } from '../detail-panels/WikiPageReader';

export function WorkspaceContent({
  room,
  rooms,
  panels,
  selectedObject,
  selectedResource,
  backendDocuments,
  knowledgeFiles,
  focusedDocumentId,
  focusedBlockId,
  documentFocusRequestId,
  onBackendDocumentChange,
  onDeleteDocument,
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
  knowledgeFiles: KnowledgeFileDto[];
  focusedDocumentId: string | null;
  focusedBlockId: string | null;
  documentFocusRequestId: number | null;
  onBackendDocumentChange: (document: RoomDocument) => void;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
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
  const hasAvailableResources = createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles).resources
    .some((resource) => !('trashed' in resource) || !resource.trashed);
  const emptySelection = panels.includes('documents')
    ? hasAvailableResources
      ? { icon: FileText, title: '选择一份资料', description: '从左侧资源列表中选择要查看的文档。' }
      : { icon: FileText, title: '还没有文档', description: '新建文档或添加本地 Office 文件后，可在这里查看内容。' }
    : panels.includes('tasks')
      ? { icon: CheckSquare2, title: '选择一项任务', description: '从左侧任务列表中选择要查看的任务。' }
      : panels.includes('schedule')
        ? { icon: CalendarDays, title: '选择一个日程', description: '从左侧日程列表中选择要查看的会议或任务。' }
        : panels.includes('relations')
          ? { icon: Network, title: '选择一个关联 Room', description: '从左侧关系图中选择要查看的 Room。' }
          : panels.includes('memories')
            ? { icon: BrainCircuit, title: '选择一条记忆', description: '从左侧图谱中选择要查看的实体或事实。' }
            : panels.includes('wiki')
              ? { icon: BookOpen, title: '选择一个知识页面', description: '从左侧目录或图谱中选择要查看的页面。' }
              : { icon: Mail, title: '选择一封邮件', description: '从左侧邮件列表中选择要查看的邮件。' };

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
        <DocumentContent
          room={room}
          resource={visibleResource}
          backendDocuments={backendDocuments}
          focusedBlockId={focusedDocumentId === visibleResource.binding.docId ? focusedBlockId : null}
          documentFocusRequestId={focusedDocumentId === visibleResource.binding.docId
            ? documentFocusRequestId
            : null}
          onBackendDocumentChange={onBackendDocumentChange}
          onDeleteDocument={onDeleteDocument}
        />
      ) : visibleResource?.kind === 'office-file' ? (
        <OfficePreview resource={visibleResource} />
      ) : visibleResource?.kind === 'knowledge-file' ? (
        <KnowledgeFileReader resource={visibleResource} />
      ) : visibleResource?.kind === 'wiki-page' ? (
        <WikiPageReader resource={visibleResource} />
      ) : (
        <PanelEmptyState
          className="context-room-content-empty"
          icon={emptySelection.icon}
          title={emptySelection.title}
          description={emptySelection.description}
        />
      )}
    </section>
  );
}
