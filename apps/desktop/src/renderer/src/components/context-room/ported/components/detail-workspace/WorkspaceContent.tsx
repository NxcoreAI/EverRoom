import type { RoomDocument } from '@nxcore/agent-contract';
import { BookOpen, ChevronLeft, FileText } from 'lucide-react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary } from '../../resources';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { DocumentContent } from '../detail-panels/DocumentPane';
import { KnowledgeFileExternalCard } from '../detail-panels/KnowledgeFileExternalCard';
import { KnowledgeFileReader } from '../detail-panels/KnowledgeFileReader';
import { PanelEmptyState } from '../detail-panels/PanelEmptyState';
import { WikiPageReader } from '../detail-panels/WikiPageReader';
import { isMarkdownFileName } from '../../../knowledgeMarkdownImport';

export function WorkspaceContent({
  room,
  selectedResource,
  backendDocuments,
  knowledgeFiles,
  focusedDocumentId,
  focusedBlockId,
  documentFocusRequestId,
  onBackendDocumentChange,
  onDeleteDocument,
  onMobileBack,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  selectedResource: ContextRoomResource | null;
  backendDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  focusedDocumentId: string | null;
  focusedBlockId: string | null;
  documentFocusRequestId: number | null;
  onBackendDocumentChange: (document: RoomDocument) => void;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onMobileBack: () => void;
  onUpdateRoom: (updater: (room: ContextRoomRecord) => ContextRoomRecord) => void;
}) {
  const { locale, t } = useLocale();
  // 右区常驻文档阅读器：任务/会议/邮件等数据预览在各自面板内展示，
  // 这里只跟文档选中走，不随面板组合或对象选中改写内容。
  const selectedCloudDoc = selectedResource?.kind === 'cloud-doc' ? selectedResource : null;
  const hasAvailableResources = createContextRoomResourceLibrary(room, backendDocuments, [], knowledgeFiles, locale).resources
    .some((resource) => !('trashed' in resource) || !resource.trashed);

  return (
    <section className="context-room-workspace-content">
      <button type="button" className="context-room-mobile-back" onClick={onMobileBack}>
        <ChevronLeft aria-hidden="true" />
        {t('contextRoom:workspaceContent.backToResources')}
      </button>
      {selectedCloudDoc ? (
        <DocumentContent
          room={room}
          resource={selectedCloudDoc}
          backendDocuments={backendDocuments}
          focusedBlockId={focusedDocumentId === selectedCloudDoc.binding.docId ? focusedBlockId : null}
          documentFocusRequestId={focusedDocumentId === selectedCloudDoc.binding.docId
            ? documentFocusRequestId
            : null}
          onBackendDocumentChange={onBackendDocumentChange}
          onDeleteDocument={onDeleteDocument}
        />
      ) : selectedResource?.kind === 'knowledge-file' ? (
        isMarkdownFileName(selectedResource.originalName)
          ? <KnowledgeFileReader resource={selectedResource} />
          : <KnowledgeFileExternalCard resource={selectedResource} />
      ) : selectedResource?.kind === 'wiki-page' ? (
        <WikiPageReader resource={selectedResource} />
      ) : (
        <PanelEmptyState
          className="context-room-content-empty"
          icon={hasAvailableResources ? FileText : BookOpen}
          title={hasAvailableResources
            ? t('contextRoom:workspaceContent.selectAResource')
            : t('contextRoom:workspaceContent.noDocumentsYet')}
          description={hasAvailableResources
            ? t('contextRoom:workspaceContent.selectADocumentFromTheResourceListOn')
            : t('contextRoom:workspaceContent.createADocumentOrAddALocalOffice')}
        />
      )}
    </section>
  );
}
