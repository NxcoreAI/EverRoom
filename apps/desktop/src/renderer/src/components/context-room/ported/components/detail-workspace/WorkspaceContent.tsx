import type { RoomDocument } from '@nxcore/agent-contract';
import { BookOpen, BrainCircuit, CalendarDays, CheckSquare2, ChevronLeft, FileText, Mail, Network } from 'lucide-react';
import { useLocale } from '../../../../../i18n/LocaleContext';

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
  const { locale, t } = useLocale();
  const selectedObjectOwner = selectedObject?.kind === 'meeting'
    ? 'schedule'
    : selectedObject?.kind === 'task'
      ? 'tasks'
      : selectedObject?.kind === 'graph-node'
        ? 'memories'
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
  const hasAvailableResources = createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale).resources
    .some((resource) => !('trashed' in resource) || !resource.trashed);
  const emptySelection = panels.includes('documents')
    ? hasAvailableResources
      ? { icon: FileText, title: t('contextRoom:workspaceContent.selectAResource'), description: t('contextRoom:workspaceContent.selectADocumentFromTheResourceListOn') }
      : { icon: FileText, title: t('contextRoom:workspaceContent.noDocumentsYet'), description: t('contextRoom:workspaceContent.createADocumentOrAddALocalOffice') }
    : panels.includes('tasks')
      ? { icon: CheckSquare2, title: t('contextRoom:workspaceContent.selectATask'), description: t('contextRoom:workspaceContent.selectATaskFromTheListOnThe') }
      : panels.includes('schedule')
        ? { icon: CalendarDays, title: t('contextRoom:workspaceContent.selectAScheduleItem'), description: t('contextRoom:workspaceContent.selectAMeetingOrTaskFromTheSchedule') }
        : panels.includes('relations')
          ? { icon: Network, title: t('contextRoom:workspaceContent.selectARelatedRoom'), description: t('contextRoom:workspaceContent.selectARoomFromTheRelationsViewOn') }
          : panels.includes('memories')
            ? { icon: BrainCircuit, title: t('contextRoom:workspaceContent.selectAMemory'), description: t('contextRoom:workspaceContent.selectAnEntityOrFactFromTheGraph') }
            : panels.includes('wiki')
              ? { icon: BookOpen, title: t('contextRoom:workspaceContent.selectAKnowledgePage'), description: t('contextRoom:workspaceContent.selectAPageFromTheTreeOrGraph') }
              : { icon: Mail, title: t('contextRoom:workspaceContent.selectAnEmail'), description: t('contextRoom:workspaceContent.selectAnEmailFromTheListOnThe') };

  return (
    <section className="context-room-workspace-content">
      {!selectedTask && !selectedMeeting ? (
        <button type="button" className="context-room-mobile-back" onClick={onMobileBack}>
          <ChevronLeft aria-hidden="true" />
          {t('contextRoom:workspaceContent.backToResources')}
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
