import type { RoomDocument } from '@nxcore/agent-contract';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BookOpen, ChevronLeft, Ellipsis, FileDown, FileText, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import { showToast } from '@/state/toast';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { loadRoomWorkspaceState, saveRoomWorkspaceState } from '../../roomWorkspaceState';
import { createContextRoomResourceLibrary } from '../../resources';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { ExternalImportDialog } from '../detail-editor/ExternalImportDialog';
import { externalDocumentFeatures } from '../detail-editor/externalDocumentFeatures';
import { DocumentContent } from '../detail-panels/DocumentPane';
import { KnowledgeFileExternalCard } from '../detail-panels/KnowledgeFileExternalCard';
import { KnowledgeFileReader } from '../detail-panels/KnowledgeFileReader';
import { PanelEmptyState } from '../detail-panels/PanelEmptyState';
import { ThoughtsPane } from '../detail-panels/ThoughtsPane';
import { WikiPageReader } from '../detail-panels/WikiPageReader';
import { isMarkdownFileName } from '../../../knowledgeMarkdownImport';

/**
 * 无云文档（或未选中）时的右上角「···」：与文档打开态的操作菜单同款外壳，
 * 但只保留无文档也有意义的动作——从飞书/Notion 导入（预览→加入本 Room）。
 */
function EmptyStateDocumentActions({ roomId }: { roomId: string }) {
  const { t } = useLocale();
  const [importOpen, setImportOpen] = useState(false);
  if (!externalDocumentFeatures.externalImport) return null;
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={t('contextRoom:tiptapDocumentActions.moreDocumentActions')}
            title={t('contextRoom:tiptapDocumentActions.moreActions')}
          >
            <Ellipsis aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="context-room-card-menu context-room-document-actions-menu"
            sideOffset={6}
            align="end"
          >
            <DropdownMenu.Item onSelect={() => setImportOpen(true)}>
              <FileDown aria-hidden="true" />
              {t('contextRoom:tiptapDocumentActions.importFromExternal')}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {importOpen ? (
        <ExternalImportDialog open onClose={() => setImportOpen(false)} roomId={roomId} />
      ) : null}
    </>
  );
}

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

  // 思路伴随区：打开云文档时左侧第三栏；开合按 Room 记忆。
  const [companionCollapsed, setCompanionCollapsed] = useState(
    () => loadRoomWorkspaceState(room.id)?.thoughtsCompanionCollapsed ?? false,
  );
  const [companionVein, setCompanionVein] = useState(false);
  const [selectionText, setSelectionText] = useState<string | null>(null);
  const insertQuoteRef = useRef<((quote: { text: string; source: string }) => boolean) | null>(null);

  const toggleCompanion = useCallback(() => {
    setCompanionCollapsed((current) => {
      const next = !current;
      saveRoomWorkspaceState(room.id, { thoughtsCompanionCollapsed: next });
      return next;
    });
  }, [room.id]);

  const registerQuoteInsert = useCallback((insert: (quote: { text: string; source: string }) => boolean) => {
    insertQuoteRef.current = insert;
    return () => { insertQuoteRef.current = null };
  }, []);

  const companionOpen = Boolean(selectedCloudDoc) && !companionCollapsed;

  return (
    <section
      className="context-room-workspace-content"
      data-companion={selectedCloudDoc ? (companionOpen ? 'open' : 'closed') : undefined}
      data-companion-view={selectedCloudDoc && companionOpen && companionVein ? 'vein' : 'cards'}
    >
      <button type="button" className="context-room-mobile-back" onClick={onMobileBack}>
        <ChevronLeft aria-hidden="true" />
        {t('contextRoom:workspaceContent.backToResources')}
      </button>
      {selectedCloudDoc ? (
        <>
          <aside className="context-room-thoughts-companion">
            <ThoughtsPane
              variant="companion"
              room={room}
              focusDocumentId={selectedCloudDoc.binding.docId}
              focusDocumentTitle={selectedCloudDoc.name}
              focusSelectionText={selectionText}
              onQuote={(card) => {
                const inserted = insertQuoteRef.current?.({
                  text: (card.quote || card.summary).slice(0, 600),
                  source: card.roomRef ? `${card.title} · ${card.roomRef.title}` : card.title,
                });
                if (inserted) return;
                showToast({ title: t('contextRoom:emergence.quoteUnavailable') });
              }}
              onViewChange={(view) => setCompanionVein(view === 'vein')}
            />
          </aside>
          <button
            type="button"
            className="context-room-thoughts-companion-toggle"
            aria-pressed={companionOpen}
            aria-label={t(companionOpen ? 'contextRoom:emergence.collapseCompanion' : 'contextRoom:emergence.expandCompanion')}
            title={t(companionOpen ? 'contextRoom:emergence.collapseCompanion' : 'contextRoom:emergence.expandCompanion')}
            onClick={toggleCompanion}
          >
            {companionOpen ? <PanelLeftClose aria-hidden="true" /> : <PanelLeftOpen aria-hidden="true" />}
          </button>
        </>
      ) : null}
      <div className="context-room-workspace-editor">
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
            onSelectionTextChange={setSelectionText}
            onRegisterQuoteInsert={registerQuoteInsert}
          />
        ) : selectedResource?.kind === 'knowledge-file' ? (
          isMarkdownFileName(selectedResource.originalName)
            ? <KnowledgeFileReader resource={selectedResource} />
            : <KnowledgeFileExternalCard resource={selectedResource} />
        ) : selectedResource?.kind === 'wiki-page' ? (
          <WikiPageReader resource={selectedResource} />
        ) : (
          <>
            <div className="context-room-document-actions context-room-empty-doc-actions">
              <EmptyStateDocumentActions roomId={room.id} />
            </div>
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
          </>
        )}
      </div>
    </section>
  );
}
