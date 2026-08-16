import * as Popover from '@radix-ui/react-popover';
import {
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RoomDocument } from '@nxcore/agent-contract';
import {
  createContextRoomResourceLibrary,
  getContextRoomOfficeFormat,
} from '../../resources';
import type {
  ContextRoomOfficeResource,
  ContextRoomRecord,
  ContextRoomResource,
} from '../../types';

function EmptyState({ children }: { children: string }) {
  return <div className="context-room-workspace-empty">{children}</div>;
}

export function OfficePreview({ resource }: { resource: ContextRoomOfficeResource }) {
  const preview = resource.preview;
  return (
    <div className="context-room-office-preview" data-testid="context-room-office-preview">
      <header>
        <span className="context-room-preview-icon">
          {resource.format === 'xlsx' ? <FileSpreadsheet aria-hidden="true" /> : <FileText aria-hidden="true" />}
        </span>
        <div>
          <h1>{preview.title}</h1>
          <p>{resource.format.toUpperCase()} · 只读预览 · {resource.updatedAt}</p>
        </div>
      </header>
      <section className="context-room-preview-summary">
        <span>内容摘要</span>
        <p>{preview.summary}</p>
      </section>
      {preview.columns && preview.rows ? (
        <div className="context-room-sheet-preview">
          <table>
            <thead>
              <tr>{preview.columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {preview.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => <td key={`${String(rowIndex)}-${String(cellIndex)}`}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {preview.slides ? (
        <div className="context-room-slide-preview">
          {preview.slides.map((slide, index) => (
            <article key={slide.title}>
              <span>{index + 1}</span>
              <div><h2>{slide.title}</h2><p>{slide.body}</p></div>
            </article>
          ))}
        </div>
      ) : null}
      {preview.pages ? (
        <div className="context-room-page-preview">
          {preview.pages.map((page) => <article key={page.title}><h2>{page.title}</h2><p>{page.body}</p></article>)}
        </div>
      ) : null}
      {preview.paragraphs ? (
        <article className="context-room-document-preview">
          <h2>{preview.title}</h2>
          {preview.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        </article>
      ) : null}
      {preview.metadata ? (
        <div className="context-room-metadata-preview">
          {preview.metadata.map((item) => <div key={item.label}><span>{item.label}</span><b>{item.value}</b></div>)}
        </div>
      ) : null}
    </div>
  );
}

const HOSTFS_OFFICE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx', 'pdf']);

export interface LocalOfficeFile {
  mimeType: string;
  modifiedAt: Date;
  name: string;
  path: string;
  size: number;
}

const LOCAL_OFFICE_FILES: LocalOfficeFile[] = [
  { name: 'V1 发布检查清单.xlsx', path: '/演示文件/V1 发布检查清单.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedAt: new Date(2026, 6, 9), size: 42_160 },
  { name: '客户沟通纪要.docx', path: '/演示文件/客户沟通纪要.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedAt: new Date(2026, 6, 8), size: 28_640 },
  { name: '阶段汇报.pptx', path: '/演示文件/阶段汇报.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', modifiedAt: new Date(2026, 6, 7), size: 184_320 },
];

function HostFSOfficePicker({ onAdd, onClose }: { onAdd: (file: LocalOfficeFile) => void; onClose: () => void }) {
  const [path, setPath] = useState('/');
  const folders = path === '/' ? [{ name: '演示文件', path: '/演示文件' }] : [];
  const officeFiles = path === '/演示文件'
    ? LOCAL_OFFICE_FILES.filter((entry) => HOSTFS_OFFICE_EXTENSIONS.has(entry.name.split('.').pop()?.toLowerCase() ?? ''))
    : [];
  const parent = path === '/' ? '/' : path.replace(/\/[^/]+$/, '') || '/';
  return (
    <div className="context-room-hostfs-picker" role="dialog" aria-label="从文件系统添加 Office 文件">
      <header><div><strong>文件系统</strong><span>{path}</span></div><button type="button" aria-label="关闭文件系统选择器" onClick={onClose}><X aria-hidden="true" /></button></header>
      <div className="context-room-hostfs-picker-list">
        {path !== '/' ? <button type="button" onClick={() => setPath(parent)}><ChevronLeft aria-hidden="true" /> 返回上级</button> : null}
        {folders.map((folder) => <button type="button" key={folder.path} onClick={() => setPath(folder.path)}><Folder aria-hidden="true" /><span>{folder.name}</span><ChevronRight aria-hidden="true" /></button>)}
        {officeFiles.map((file) => <button type="button" key={file.path} onClick={() => onAdd(file)}><FileSpreadsheet aria-hidden="true" /><span>{file.name}</span><small>{getContextRoomOfficeFormat(file.name).toUpperCase()}</small></button>)}
        {!folders.length && !officeFiles.length ? <div className="context-room-hostfs-picker-state">当前目录没有可预览的 Office 文件</div> : null}
      </div>
    </div>
  );
}

export function ResourceTree({
  room,
  backendDocuments,
  trashedDocuments,
  selectedId,
  onSelect,
  onCreateDocument,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
  onAddFile,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onCreateDocument: (title: string) => Promise<void>;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onRestoreDocument: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>;
  onAddFile: (file: LocalOfficeFile) => void;
}) {
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, trashedDocuments),
    [backendDocuments, room, trashedDocuments],
  );
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set(
    library.folders.filter((folder) => !folder.id.endsWith(':folder:trash')).map((folder) => folder.id),
  ));
  const [showFilePicker, setShowFilePicker] = useState(false);
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
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

  const confirmDelete = async (document: RoomDocument) => {
    setDeleteError(null);
    setDeletingDocumentId(document.id);
    try {
      await onDeleteDocument(document);
      setDocumentToDelete(null);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : '删除文档失败');
    } finally {
      setDeletingDocumentId(null);
    }
  };

  const createDocument = async () => {
    const title = newDocumentTitle.trim() || '无标题文档';
    setCreateError(null);
    setCreatingDocument(true);
    try {
      await onCreateDocument(title);
      setCreatePopoverOpen(false);
      setNewDocumentTitle('');
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : '创建文档失败');
    } finally {
      setCreatingDocument(false);
    }
  };

  const restoreDocument = async (document: RoomDocument) => {
    setActionError(null);
    setDeletingDocumentId(document.id);
    try {
      await onRestoreDocument(document);
    } catch (error: unknown) {
      setActionError(error instanceof Error ? error.message : '恢复文档失败');
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
      setDeleteError(error instanceof Error ? error.message : '彻底删除文档失败');
    } finally {
      setDeletingDocumentId(null);
    }
  };

  return (
    <div className="context-room-resource-tree">
      <label><Search aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Room 内文档…" aria-label="搜索 Room 内文档" /></label>
      <button type="button" className="context-room-resource-add-file" onClick={() => setShowFilePicker((value) => !value)}><FolderOpen aria-hidden="true" />从文件系统添加 Office 文件</button>
      {showFilePicker ? <HostFSOfficePicker onAdd={(file) => { onAddFile(file); setShowFilePicker(false); }} onClose={() => setShowFilePicker(false)} /> : null}
      {actionError ? <div className="context-room-resource-error" role="alert">{actionError}</div> : null}
      <div className="context-room-resource-scroll" role="tree" aria-label="Room 资源">
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
                  <span>{folder.name}</span><small>{resources.length}</small>
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
                        aria-label="新建文档"
                        title="新建文档"
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
                        aria-label="新建文档"
                      >
                        <form onSubmit={(event) => { event.preventDefault(); void createDocument(); }}>
                          <label htmlFor="context-room-new-document-title">文档名称</label>
                          <input
                            id="context-room-new-document-title"
                            autoFocus
                            maxLength={120}
                            value={newDocumentTitle}
                            placeholder="无标题文档"
                            onChange={(event) => setNewDocumentTitle(event.target.value)}
                            disabled={creatingDocument}
                          />
                          {createError ? <small role="alert">{createError}</small> : null}
                          <footer>
                            <Popover.Close asChild>
                              <button type="button" disabled={creatingDocument}>取消</button>
                            </Popover.Close>
                            <button type="submit" className="is-primary" disabled={creatingDocument}>
                              {creatingDocument ? '创建中…' : '创建'}
                            </button>
                          </footer>
                        </form>
                        <Popover.Arrow className="context-room-document-create-arrow" />
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
                        {resource.kind === 'cloud-doc' ? <FileText aria-hidden="true" /> : resource.format === 'xlsx' ? <FileSpreadsheet aria-hidden="true" /> : <FileText aria-hidden="true" />}
                        <span><b>{resource.name}</b><small>{resource.updatedAt}</small></span>
                      </button>
                    )}
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
                            aria-label={`将文档 ${resource.name} 移到回收站`}
                            title={busy ? 'Agent 正在写入，暂时不能移动' : '移到回收站'}
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
                            aria-label={`确认将文档 ${resource.name} 移到回收站`}
                          >
                            <p>移到回收站？</p>
                            <span>“{resource.name}”可在回收站恢复。</span>
                            {deleteError ? <small role="alert">{deleteError}</small> : null}
                            <footer>
                              <Popover.Close asChild>
                                <button type="button" disabled={deleting}>取消</button>
                              </Popover.Close>
                              <button
                                type="button"
                                className="is-danger"
                                disabled={deleting}
                                onClick={() => void confirmDelete(backendDocument)}
                              >
                                {deleting ? '移动中…' : '移入'}
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
                          aria-label={`恢复文档 ${resource.name}`}
                          title="恢复文档"
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
                              aria-label={`彻底删除文档 ${resource.name}`}
                              title="彻底删除"
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
                              aria-label={`确认彻底删除文档 ${resource.name}`}
                            >
                              <p>彻底删除“{resource.name}”？</p>
                              <span>正文和历史版本将无法恢复。</span>
                              {deleteError ? <small role="alert">{deleteError}</small> : null}
                              <footer>
                                <Popover.Close asChild>
                                  <button type="button" disabled={deleting}>取消</button>
                                </Popover.Close>
                                <button
                                  type="button"
                                  className="is-danger"
                                  disabled={deleting}
                                  onClick={() => void confirmPermanentDelete(backendDocument)}
                                >
                                  {deleting ? '删除中…' : '彻底删除'}
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
              {open && folder.id.endsWith(':folder:documents') && resources.length === 0 ? (
                <p className="context-room-resource-folder-empty">暂无文档</p>
              ) : null}
              {open && trashFolder && resources.length === 0 ? (
                <p className="context-room-resource-folder-empty">回收站为空</p>
              ) : null}
            </section>
          );
        })}
        {!library.resources.some((resource) => !normalized || resource.name.toLowerCase().includes(normalized)) ? <EmptyState>没有匹配的资源</EmptyState> : null}
      </div>
    </div>
  );
}
