import * as Popover from '@radix-ui/react-popover';
import { FileText, FileUp, LoaderCircle, Package, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import { createContextRoomResourceLibrary } from '../../resources';
import type {
  ContextRoomCloudDocResource,
  ContextRoomRecord,
  ContextRoomResource,
} from '../../types';
import { markdownDocumentTitle, parseMarkdownDocument } from '../detail-editor/markdownImport';
import { buildLinkGraphData } from '../linkGraphModel';
import { PanelEmptyState } from './PanelEmptyState';

type ArtifactFilter = 'all' | 'draft' | 'trash';

/**
 * 产物库：Room 内用户创建文档的平铺清单（原型 room-launch 产物板块）。
 * 行信息与筛选只用真实字段——版本/更新时间来自文档，引用数来自建联边投影。
 */
export function ArtifactLibraryPane({
  room,
  backendDocuments,
  trashedDocuments,
  selectedId,
  onSelect,
  onCreateDocument,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onCreateDocument: (title: string, contentJson?: TiptapJsonContent) => Promise<void>;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onRestoreDocument: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, trashedDocuments, [], locale),
    [backendDocuments, locale, room, trashedDocuments],
  );
  const isCloudDoc = (resource: ContextRoomResource): resource is ContextRoomCloudDocResource =>
    resource.kind === 'cloud-doc';
  const cloudDocs = library.resources.filter(isCloudDoc);
  const artifacts = cloudDocs.filter((resource) => !resource.trashed);
  const trashedArtifacts = cloudDocs.filter((resource) => resource.trashed);
  const backendById = useMemo(
    () => new Map([...backendDocuments, ...trashedDocuments].map((document) => [document.id, document])),
    [backendDocuments, trashedDocuments],
  );
  // 引用来源计数：与建联图谱同源的纯读侧投影，按文档聚合边数。
  const citationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of buildLinkGraphData(room, backendDocuments, trashedDocuments).edges) {
      counts.set(edge.sourceDocumentId, (counts.get(edge.sourceDocumentId) ?? 0) + edge.count);
      if (edge.kind === 'document' && edge.targetDocumentId !== edge.sourceDocumentId) {
        counts.set(edge.targetDocumentId, (counts.get(edge.targetDocumentId) ?? 0) + edge.count);
      }
    }
    return counts;
  }, [room, backendDocuments, trashedDocuments]);

  const [filter, setFilter] = useState<ArtifactFilter>('all');
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const markdownInputRef = useRef<HTMLInputElement>(null);
  const [documentToDelete, setDocumentToDelete] = useState<RoomDocument | null>(null);
  const [documentToDeletePermanently, setDocumentToDeletePermanently] = useState<RoomDocument | null>(null);
  const [busyDocumentId, setBusyDocumentId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const visibleArtifacts = filter === 'draft'
    ? artifacts.filter((resource) => backendById.get(resource.binding.docId)?.status === 'draft')
    : filter === 'trash'
      ? trashedArtifacts
      : artifacts;

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

  const confirmDelete = async (document: RoomDocument) => {
    setDeleteError(null);
    setBusyDocumentId(document.id);
    try {
      await onDeleteDocument(document);
      setDocumentToDelete(null);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : t('contextRoom:resource.failedToDeleteDocument'));
    } finally {
      setBusyDocumentId(null);
    }
  };

  const restoreDocument = async (document: RoomDocument) => {
    setActionError(null);
    setBusyDocumentId(document.id);
    try {
      await onRestoreDocument(document);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : t('contextRoom:resource.failedToRestoreDocument'));
    } finally {
      setBusyDocumentId(null);
    }
  };

  const confirmPermanentDelete = async (document: RoomDocument) => {
    setDeleteError(null);
    setBusyDocumentId(document.id);
    try {
      await onDeleteDocumentPermanently(document);
      setDocumentToDeletePermanently(null);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : t('contextRoom:resource.failedToPermanentlyDeleteDocument'));
    } finally {
      setBusyDocumentId(null);
    }
  };

  const filters: { id: ArtifactFilter; label: string }[] = [
    { id: 'all', label: t('contextRoom:artifactLibrary.filterAll') },
    { id: 'draft', label: t('contextRoom:artifactLibrary.draft') },
    { id: 'trash', label: t('contextRoom:artifactLibrary.filterTrash') },
  ];

  return (
    <div className="context-room-artifact-library">
      <div className="context-room-artifact-toolbar">
        <div className="context-room-artifact-filters" role="group" aria-label={t('contextRoom:boardTab.library')}>
          {filters.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`context-room-artifact-pill${filter === id ? ' is-active' : ''}`}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <Popover.Root
          open={createPopoverOpen}
          onOpenChange={(nextOpen) => {
            if (!nextOpen && creatingDocument) return;
            setCreateError(null);
            setCreatePopoverOpen(nextOpen);
            if (!nextOpen) setNewDocumentTitle('');
          }}
        >
          <Popover.Trigger asChild>
            <button
              type="button"
              className="context-room-artifact-new"
              aria-label={t('contextRoom:artifactLibrary.newArtifact')}
              disabled={creatingDocument}
            >
              {creatingDocument
                ? <LoaderCircle aria-hidden="true" className="is-spinning" />
                : <Plus aria-hidden="true" />}
              {t('contextRoom:artifactLibrary.newArtifact')}
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="context-room-document-create-popover"
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={12}
              aria-label={t('contextRoom:artifactLibrary.newArtifact')}
            >
              <form onSubmit={(event) => { event.preventDefault(); void createDocument(); }}>
                <label htmlFor="context-room-new-artifact-title">{t('contextRoom:resource.documentName')}</label>
                <input
                  id="context-room-new-artifact-title"
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
      </div>
      {actionError ? <div className="context-room-resource-error" role="alert">{actionError}</div> : null}
      <div className="context-room-artifact-list">
        {visibleArtifacts.map((resource) => {
          const backendDocument = backendById.get(resource.binding.docId);
          if (!backendDocument) return null;
          const deleting = backendDocument.id === busyDocumentId;
          const busy = Boolean(backendDocument.activeTransactionId);
          const trashed = Boolean(resource.trashed);
          const citations = citationCounts.get(backendDocument.id) ?? 0;
          return (
            <div className={`context-room-artifact-row${trashed ? ' is-trash' : ''}`} key={resource.id}>
              {trashed ? (
                <div className="context-room-artifact-item is-trashed" aria-disabled="true">
                  <span className="context-room-artifact-ico"><FileText aria-hidden="true" /></span>
                  <span className="context-room-artifact-body">
                    <b>{resource.name}</b>
                    <small>{resource.updatedAt}</small>
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  className="context-room-artifact-item"
                  aria-selected={selectedId === resource.id}
                  onClick={() => onSelect(resource)}
                >
                  <span className="context-room-artifact-ico"><FileText aria-hidden="true" /></span>
                  <span className="context-room-artifact-body">
                    <b>{resource.name}</b>
                    <small>{`${resource.version} · ${resource.updatedAt}`}</small>
                  </span>
                  <span className="context-room-artifact-meta">
                    {backendDocument.status === 'draft' ? (
                      <span className="context-room-artifact-tag is-draft">{t('contextRoom:artifactLibrary.draft')}</span>
                    ) : null}
                    {citations > 0 ? (
                      <span className="context-room-artifact-tag">{t('contextRoom:artifactLibrary.citationCount', { count: citations })}</span>
                    ) : null}
                  </span>
                </button>
              )}
              {trashed ? (
                <span className="context-room-artifact-acts">
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
                </span>
              ) : (
                <span className="context-room-artifact-acts">
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
                </span>
              )}
            </div>
          );
        })}
        {visibleArtifacts.length === 0 ? (
          artifacts.length === 0 && trashedArtifacts.length === 0 ? (
            <PanelEmptyState
              compact
              icon={Package}
              title={t('contextRoom:artifactLibrary.noArtifactsYet')}
            />
          ) : (
            <PanelEmptyState
              compact
              icon={Package}
              title={t(filter === 'trash' && trashedArtifacts.length === 0
                ? 'contextRoom:resource.trashIsEmpty'
                : 'contextRoom:artifactLibrary.emptyFilter')}
            />
          )
        ) : null}
      </div>
    </div>
  );
}
