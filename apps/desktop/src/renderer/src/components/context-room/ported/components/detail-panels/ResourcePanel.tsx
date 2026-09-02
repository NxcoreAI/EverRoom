import * as Popover from '@radix-ui/react-popover';
import {
  ChevronRight,
  FileSpreadsheet,
  FileText,
  FileUp,
  Folder,
  FolderOpen,
  LoaderCircle,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import {
  createContextRoomResourceLibrary,
} from '../../resources';
import type {
  ContextRoomRecord,
  ContextRoomResource,
} from '../../types';
import { uiText } from '../../adapters';
import { markdownDocumentTitle, parseMarkdownDocument } from '../detail-editor/markdownImport';
import { ResourceCorrectionMenu } from '../ResourceCorrection';
import { PanelEmptyState } from './PanelEmptyState';

export function ResourceTree({
  room,
  rooms,
  backendDocuments,
  trashedDocuments,
  knowledgeFiles,
  selectedId,
  onSelect,
  onCreateDocument,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
  onEmptyTrash,
  onCorrected,
}: {
  room: ContextRoomRecord;
  /** 归入纠正（改归其他 Room）的目标候选。 */
  rooms: ContextRoomRecord[];
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onCreateDocument: (title: string, contentJson?: TiptapJsonContent) => Promise<void>;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onRestoreDocument: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>;
  onEmptyTrash: (roomId: string) => Promise<void>;
  /** 纠正完成后的就地刷新钩子（资料清单随 knowledge-changed 自刷新，可缺省）。 */
  onCorrected?: () => void;
}) {
  const { locale, t } = useLocale();
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, trashedDocuments, knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room, trashedDocuments],
  );
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(
    library.folders.filter((folder) => !folder.id.endsWith(':folder:trash')).map((folder) => folder.id),
  ));
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const markdownInputRef = useRef<HTMLInputElement>(null);
  const [clearTrashPopoverOpen, setClearTrashPopoverOpen] = useState(false);
  const [clearingTrash, setClearingTrash] = useState(false);
  const [clearTrashError, setClearTrashError] = useState<string | null>(null);
  const [documentToDelete, setDocumentToDelete] = useState<RoomDocument | null>(null);
  const [documentToDeletePermanently, setDocumentToDeletePermanently] = useState<RoomDocument | null>(null);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const normalized = query.trim().toLowerCase();
  const backendById = useMemo(
    () => new Map([...backendDocuments, ...trashedDocuments].map((document) => [document.id, document])),
    [backendDocuments, trashedDocuments],
  );
  const trashDocumentCount = trashedDocuments.length;
  const matchingResourceCount = library.resources.filter((resource) =>
    !normalized || resource.name.toLowerCase().includes(normalized)
  ).length;

  const confirmDelete = async (document: RoomDocument) => {
    setDeleteError(null);
    setDeletingDocumentId(document.id);
    try {
      await onDeleteDocument(document);
      setDocumentToDelete(null);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : t('contextRoom:resource.failedToDeleteDocument'));
    } finally {
      setDeletingDocumentId(null);
    }
  };

  const createDocument = async () => {
    const title = newDocumentTitle.trim() || t('contextRoom:resource.untitledDocument');
    setCreateError(null);
    setCreatingDocument(true);
    try {
      await onCreateDocument(title);
      setCreatePopoverOpen(false);
      setNewDocumentTitle('');
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : t('contextRoom:resource.failedToCreateDocument'));
    } finally {
      setCreatingDocument(false);
    }
  };

  const importMarkdownDocument = async (file: File) => {
    if (!/\.(?:md|markdown)$/i.test(file.name)) {
      setCreateError(t('contextRoom:resource.chooseAnMdOrMarkdownFile'));
      return;
    }
    setCreateError(null);
    setCreatingDocument(true);
    try {
      const markdown = await file.text();
      const title = newDocumentTitle.trim() || markdownDocumentTitle(file.name, t('contextRoom:documentOperationCenter.untitledDocument'));
      await onCreateDocument(title, parseMarkdownDocument(markdown));
      setCreatePopoverOpen(false);
      setNewDocumentTitle('');
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : t('contextRoom:resource.failedToImportMarkdownDocument'));
    } finally {
      setCreatingDocument(false);
    }
  };

  const clearTrash = async () => {
    setClearTrashError(null);
    setClearingTrash(true);
    try {
      await onEmptyTrash(room.id);
      setClearTrashPopoverOpen(false);
    } catch (error: unknown) {
      setClearTrashError(error instanceof Error ? error.message : t('contextRoom:resource.failedToEmptyTrash'));
    } finally {
      setClearingTrash(false);
    }
  };

  const restoreDocument = async (document: RoomDocument) => {
    setActionError(null);
    setDeletingDocumentId(document.id);
    try {
      await onRestoreDocument(document);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : t('contextRoom:resource.failedToRestoreDocument'));
    } finally {
      setDeletingDocumentId(null);
    }
  };

  const confirmPermanentDelete = async (document: RoomDocument) => {
    setDeleteError(null);
    setDeletingDocumentId(document.id);
    try {
      await onDeleteDocumentPermanently(document);
      setDocumentToDeletePermanently(null);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : t('contextRoom:resource.failedToPermanentlyDeleteDocument'));
    } finally {
      setDeletingDocumentId(null);
    }
  };

  return (
    <div className="context-room-resource-tree">
      <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('contextRoom:resource.searchDocumentsInThisRoom')} aria-label={t('contextRoom:resource.searchDocumentsAriaLabel')} /></label>
      {actionError ? <div className="context-room-resource-error" role="alert">{actionError}</div> : null}
      <div className="context-room-resource-scroll" role="tree" aria-label={t('contextRoom:resource.roomResources')}>
        {library.folders.map((folder) => {
          const resources = library.resources.filter((resource) => resource.folderId === folder.id && (!normalized || resource.name.toLowerCase().includes(normalized)));
          if (normalized && !resources.length) return null;
          const open = expanded.has(folder.id);
          const trashFolder = folder.id.endsWith(':folder:trash');
          const documentsFolder = folder.id.endsWith(':folder:documents');
          return (
            <section key={folder.id}>
              <div className="context-room-resource-folder-row">
                <button type="button" className="context-room-resource-folder" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(folder.id)) next.delete(folder.id); else next.add(folder.id); return next; })}>
                  <ChevronRight aria-hidden="true" className={open ? 'is-open' : ''} />
                  {trashFolder ? <Trash2 aria-hidden="true" /> : open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}
                  <span>{t(uiText(folder.name))}</span><small>{resources.length}</small>
                </button>
                {documentsFolder ? (
                  <Popover.Root
                    open={createPopoverOpen}
                    onOpenChange={(nextOpen) => {
                      if (!nextOpen && creatingDocument) return;
                      setCreateError(null);
                      setCreatePopoverOpen(nextOpen);
                      if (nextOpen) {
                        setExpanded((current) => new Set(current).add(folder.id));
                      } else {
                        setNewDocumentTitle('');
                      }
                    }}
                  >
                    <Popover.Trigger asChild>
                      <button
                        type="button"
                        className="context-room-resource-folder-add"
                        aria-label={t('contextRoom:resource.newDocument')}
                        title={t('contextRoom:resource.newDocument')}
                        disabled={creatingDocument}
                      >
                        {creatingDocument
                          ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                          : <Plus aria-hidden="true" />}
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        className="context-room-document-create-popover"
                        side="right"
                        align="start"
                        sideOffset={8}
                        collisionPadding={12}
                        aria-label={t('contextRoom:resource.newDocument')}
                      >
                        <form onSubmit={(event) => { event.preventDefault(); void createDocument(); }}>
                          <label htmlFor="context-room-new-document-title">{t('contextRoom:resource.documentName')}</label>
                          <input
                            id="context-room-new-document-title"
                            autoFocus
                            maxLength={120}
                            value={newDocumentTitle}
                            placeholder={t('contextRoom:resource.untitledDocument')}
                            onChange={(event) => setNewDocumentTitle(event.target.value)}
                            disabled={creatingDocument}
                          />
                          <input
                            ref={markdownInputRef}
                            className="context-room-document-import-input"
                            type="file"
                            accept=".md,.markdown,text/markdown"
                            tabIndex={-1}
                            aria-hidden="true"
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              if (file) void importMarkdownDocument(file);
                            }}
                          />
                          <button
                            type="button"
                            className="context-room-document-import"
                            disabled={creatingDocument}
                            onClick={() => markdownInputRef.current?.click()}
                          >
                            <FileUp aria-hidden="true" />
                            {t(creatingDocument ? 'contextRoom:resource.processing' : 'contextRoom:resource.importLocalMarkdown')}
                          </button>
                          {createError ? <small role="alert">{createError}</small> : null}
                          <footer>
                            <Popover.Close asChild>
                              <button type="button" disabled={creatingDocument}>{t('contextRoom:resource.cancel')}</button>
                            </Popover.Close>
                            <button type="submit" className="is-primary" disabled={creatingDocument}>
                              {t(creatingDocument ? 'contextRoom:resource.creating' : 'contextRoom:resource.create')}
                            </button>
                          </footer>
                        </form>
                        <Popover.Arrow className="context-room-document-create-arrow" />
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                ) : null}
                {trashFolder ? (
                  <Popover.Root
                    open={clearTrashPopoverOpen}
                    onOpenChange={(nextOpen) => {
                      if (!nextOpen && clearingTrash) return;
                      setClearTrashError(null);
                      setClearTrashPopoverOpen(nextOpen);
                    }}
                  >
                    <Popover.Trigger asChild>
                      <button
                        type="button"
                        className="context-room-resource-folder-add is-danger"
                        aria-label={t('contextRoom:resource.emptyTrash')}
                        title={t(trashDocumentCount ? 'contextRoom:resource.emptyTrash' : 'contextRoom:resource.trashIsEmpty')}
                        disabled={!trashDocumentCount || clearingTrash}
                      >
                        {clearingTrash
                          ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                          : <Trash2 aria-hidden="true" />}
                      </button>
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        className="context-room-document-delete-popover"
                        side="right"
                        align="start"
                        sideOffset={8}
                        collisionPadding={12}
                        aria-label={t('contextRoom:resource.confirmEmptyTrash')}
                      >
                        <p>{t('contextRoom:resource.emptyTrashQuestion')}</p>
                        <span>{t('contextRoom:resource.countDocumentsAndTheirVersionHistoryCannotBe', { count: trashDocumentCount })}</span>
                        {clearTrashError ? <small role="alert">{clearTrashError}</small> : null}
                        <footer>
                          <Popover.Close asChild>
                            <button type="button" disabled={clearingTrash}>{t('contextRoom:resource.cancel')}</button>
                          </Popover.Close>
                          <button
                            type="button"
                            className="is-danger"
                            disabled={clearingTrash}
                            onClick={() => void clearTrash()}
                          >
                            {t(clearingTrash ? 'contextRoom:resource.emptying' : 'contextRoom:resource.clear')}
                          </button>
                        </footer>
                        <Popover.Arrow className="context-room-document-delete-arrow" />
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                ) : null}
              </div>
              {open ? resources.map((resource) => {
                const backendDocument = resource.kind === 'cloud-doc'
                  ? backendById.get(resource.binding.docId)
                  : undefined;
                const deleting = backendDocument?.id === deletingDocumentId;
                const busy = Boolean(backendDocument?.activeTransactionId);
                const trashed = resource.kind === 'cloud-doc' && resource.trashed;
                return (
                  <div className={`context-room-resource-row${trashed ? ' is-trash' : ''}`} key={resource.id}>
                    {trashed ? (
                      <div
                      role="treeitem"
                        aria-disabled="true"
                        className="context-room-resource-item is-trashed"
                      >
                        <FileText aria-hidden="true" />
                        <span><b>{resource.name}</b><small>{resource.updatedAt}</small></span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        role="treeitem"
                        aria-selected={selectedId === resource.id}
                        className={`context-room-resource-item${selectedId === resource.id ? ' is-selected' : ''}`}
                        onClick={() => onSelect(resource)}
                      >
                        {resource.kind === 'office-file' && resource.format === 'xlsx' ? <FileSpreadsheet aria-hidden="true" /> : null}
                        {resource.kind === 'knowledge-file' ? <Paperclip aria-hidden="true" /> : null}
                        {resource.kind !== 'office-file' && resource.kind !== 'knowledge-file' ? <FileText aria-hidden="true" /> : null}
                        {resource.kind === 'knowledge-file' ? (
                          <span><b>{resource.name}</b><small title={resource.updatedAt}>{`${t(uiText(resource.statusLabel))} · ${resource.sizeLabel}`}</small></span>
                        ) : (
                          <span><b>{resource.name}</b><small>{resource.updatedAt}</small></span>
                        )}
                      </button>
                    )}
                    {resource.kind === 'knowledge-file' && !trashed ? (
                      <ResourceCorrectionMenu
                        room={room}
                        rooms={rooms}
                        target={{ sourceKind: 'file', sourceId: resource.fileId, title: resource.name }}
                        onCorrected={onCorrected}
                      />
                    ) : null}
                    {backendDocument && !trashed ? (
                      <Popover.Root
                        open={documentToDelete?.id === backendDocument.id}
                        onOpenChange={(open) => {
                          if (!open && deleting) return;
                          setDeleteError(null);
                          setDocumentToDelete(open ? backendDocument : null);
                        }}
                      >
                        <Popover.Trigger asChild>
                          <button
                            type="button"
                            className="context-room-resource-delete"
                            aria-label={t('contextRoom:resource.moveDocumentNameToTrash', { name: resource.name })}
                            title={t(busy ? 'contextRoom:resource.agentIsWritingThisDocumentCannotBeMoved' : 'contextRoom:resource.moveToTrash')}
                            disabled={busy || deleting}
                          >
                            <Trash2 aria-hidden="true" />
                          </button>
                        </Popover.Trigger>
                        <Popover.Portal>
                          <Popover.Content
                            className="context-room-document-delete-popover"
                            side="right"
                            align="center"
                            sideOffset={8}
                            collisionPadding={12}
                            aria-label={t('contextRoom:resource.confirmMovingDocumentNameToTrash', { name: resource.name })}
                          >
                            <p>{t('contextRoom:resource.confirmMoveToTrash')}</p>
                            <span>{t('contextRoom:resource.nameCanBeRestoredFromTrash', { name: resource.name })}</span>
                            {deleteError ? <small role="alert">{deleteError}</small> : null}
                            <footer>
                              <Popover.Close asChild>
                                <button type="button" disabled={deleting}>{t('contextRoom:resource.cancel')}</button>
                              </Popover.Close>
                              <button
                                type="button"
                                className="is-danger"
                                disabled={deleting}
                                onClick={() => void confirmDelete(backendDocument)}
                              >
                                {t(deleting ? 'contextRoom:resource.moving' : 'contextRoom:resource.move')}
                              </button>
                            </footer>
                            <Popover.Arrow className="context-room-document-delete-arrow" />
                          </Popover.Content>
                        </Popover.Portal>
                      </Popover.Root>
                    ) : backendDocument && trashed ? (
                      <div className="context-room-resource-trash-actions">
                        <button
                          type="button"
                          aria-label={t('contextRoom:resource.restoreDocumentName', { name: resource.name })}
                          title={t('contextRoom:resource.restoreDocument')}
                          disabled={deleting}
                          onClick={() => void restoreDocument(backendDocument)}
                        >
                          <RotateCcw aria-hidden="true" />
                        </button>
                        <Popover.Root
                          open={documentToDeletePermanently?.id === backendDocument.id}
                          onOpenChange={(open) => {
                            if (!open && deleting) return;
                            setDeleteError(null);
                            setDocumentToDeletePermanently(open ? backendDocument : null);
                          }}
                        >
                          <Popover.Trigger asChild>
                            <button
                              type="button"
                              aria-label={t('contextRoom:resource.permanentlyDeleteDocumentName', { name: resource.name })}
                              title={t('contextRoom:resource.deletePermanently')}
                              disabled={deleting}
                            >
                              <Trash2 aria-hidden="true" />
                            </button>
                          </Popover.Trigger>
                          <Popover.Portal>
                            <Popover.Content
                              className="context-room-document-delete-popover"
                              side="right"
                              align="center"
                              sideOffset={8}
                              collisionPadding={12}
                              aria-label={t('contextRoom:resource.confirmPermanentlyDeletingDocumentName', { name: resource.name })}
                            >
                              <p>{t('contextRoom:resource.permanentlyDeleteName', { name: resource.name })}</p>
                              <span>{t('contextRoom:resource.theContentAndVersionHistoryCannotBeRestored')}</span>
                              {deleteError ? <small role="alert">{deleteError}</small> : null}
                              <footer>
                                <Popover.Close asChild>
                                  <button type="button" disabled={deleting}>{t('contextRoom:resource.cancel')}</button>
                                </Popover.Close>
                                <button
                                  type="button"
                                  className="is-danger"
                                  disabled={deleting}
                                  onClick={() => void confirmPermanentDelete(backendDocument)}
                                >
                                  {t(deleting ? 'contextRoom:resource.deleting' : 'contextRoom:resource.deletePermanently')}
                                </button>
                              </footer>
                              <Popover.Arrow className="context-room-document-delete-arrow" />
                            </Popover.Content>
                          </Popover.Portal>
                        </Popover.Root>
                      </div>
                    ) : null}
                  </div>
                );
              }) : null}
              {open && library.resources.length > 0 && folder.id.endsWith(':folder:documents') && resources.length === 0 ? (
                <p className="context-room-resource-folder-empty">{t('contextRoom:resource.noDocuments')}</p>
              ) : null}
              {open && trashFolder && resources.length === 0 ? (
                <p className="context-room-resource-folder-empty">{t('contextRoom:resource.trashIsEmpty')}</p>
              ) : null}
            </section>
          );
        })}
        {!normalized && !library.resources.length ? (
          <PanelEmptyState
            compact
            icon={FileText}
            title={t('contextRoom:resource.noDocumentsYet')}
            description={t('contextRoom:resource.createADocumentOrAddALocalOffice')}
          />
        ) : null}
        {normalized && !matchingResourceCount ? (
          <PanelEmptyState
            compact
            icon={SearchX}
            title={t('contextRoom:resource.noMatchingResources')}
            description={t('contextRoom:resource.tryAnotherSearchTerm')}
          />
        ) : null}
      </div>
    </div>
  );
}
