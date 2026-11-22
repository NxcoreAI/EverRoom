import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Popover from '@radix-ui/react-popover';
import { Check, Ellipsis, FileText, FileSpreadsheet, FileUp, FolderInput, FolderOpen, ListChecks, Presentation, FileText as WordIcon, LoaderCircle, Package, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import { formatRelative } from '@/components/pages/sources/sourceKinds';
import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary } from '../../resources';
import { consumeArtifactCreateIntent } from '../../../artifactCreateIntent';
import { showToast } from '@/state/toast';
import type {
  ContextRoomCloudDocResource,
  ContextRoomKnowledgeFileResource,
  ContextRoomRecord,
  ContextRoomResource,
} from '../../types';
import { markdownDocumentTitle, parseMarkdownDocument } from '../detail-editor/markdownImport';
import { ARTIFACT_IMPORT_EXTENSIONS, isArtifactImportFileName } from '../../../../../../../shared/sources';
import { buildLinkGraphData } from '../linkGraphModel';
import { PanelEmptyState } from './PanelEmptyState';
import { FilterSelect, ReferenceDialog } from '../shared';
import { MoveDocumentToRoomDialog } from '../MoveDocumentToRoomDialog';

type ArtifactFilter = 'all' | 'clouddoc' | 'office';
type CreateType = 'doc' | 'word' | 'ppt' | 'xlsx';

/**
 * 产物库：Room 内创作成果的平铺清单（原型 room-launch 产物板块）。
 * 筛选只区分「云文档（轻文档）」与「Office 产物（Agent 生成 + 导入）」；
 * 不设草稿/回收站状态视图。新建支持轻文档（md）与 Word/PPT/Excel——
 * Office 双路径任选：导入本地文件（artifact-imported 直达本栏）或
 * Room 内 Agent 生成通道（context_room_*_create）。
 */
export function ArtifactLibraryPane({
  room,
  backendDocuments,
  trashedDocuments,
  artifactFiles = [],
  selectedId,
  onSelect,
  onCreateDocument,
  onDeleteDocument,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  /** Room 产物文件（Agent 生成 + 导入的 Office，清单按 sourceKind 过滤）。 */
  artifactFiles: KnowledgeFileDto[];
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onCreateDocument: (title: string, contentJson?: TiptapJsonContent) => Promise<void>;
  /** 产物库行内删除（云文档进回收站），由父级 useRoomDocuments.deleteDocument 提供。 */
  onDeleteDocument?: (document: RoomDocument) => Promise<void>;
  /** 回收站管理操作已从 UI 下线；父级仍会传入，保留类型兼容。 */
  onRestoreDocument?: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently?: (document: RoomDocument) => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, trashedDocuments, [], locale),
    [backendDocuments, locale, room, trashedDocuments],
  );
  // Office 产物（Agent 生成 + 导入）：复用 knowledge-file 资源映射（点击 → 内嵌 Office 预览）。
  const officeArtifacts = useMemo(
    () => createContextRoomResourceLibrary(room, [], [], artifactFiles, locale)
      .resources.filter((resource): resource is ContextRoomKnowledgeFileResource => resource.kind === 'knowledge-file'),
    [artifactFiles, locale, room],
  );
  const isCloudDoc = (resource: ContextRoomResource): resource is ContextRoomCloudDocResource =>
    resource.kind === 'cloud-doc';
  const cloudDocs = library.resources.filter(isCloudDoc).filter((resource) => !resource.trashed);
  // 版本/更新时间来自文件清单 DTO（资源映射只带预格式化体积/状态文本）：
  // 旧网关无字段时 undefined → 副标题自然省略，不伪造成 v1。
  const fileById = useMemo(() => new Map(artifactFiles.map((file) => [file.id, file])), [artifactFiles]);

  const [filter, setFilter] = useState<ArtifactFilter>('all');
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false);
  const [createType, setCreateType] = useState<CreateType | null>(null);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const markdownInputRef = useRef<HTMLInputElement>(null);
  const officeImportInputRef = useRef<HTMLInputElement>(null);
  // 行内删除：office 产物为硬删除（级联清理），云文档进回收站（可恢复）。
  const [pendingDelete, setPendingDelete] = useState<
    | { key: string; kind: 'file'; fileId: string; name: string }
    | { key: string; kind: 'document'; document: RoomDocument; name: string }
    | null
  >(null);
  const [deletingArtifact, setDeletingArtifact] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // 移动目标：空数组 = 弹层关闭；单个/批量共用同一目标选择器。
  const [moveTargets, setMoveTargets] = useState<Array<{ id: string; title: string; roomId: string }>>([]);
  // 多选整理：开启后云文档行进入勾选态，工具条提供批量「移动到其他 Room」。
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(() => new Set());

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedDocumentIds(new Set());
  };

  const toggleDocumentSelection = (documentId: string) => {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (next.has(documentId)) next.delete(documentId);
      else next.add(documentId);
      return next;
    });
  };

  const selectedDocuments = backendDocuments.filter((document) => selectedDocumentIds.has(document.id));

  // 文稿页「+新建文档」进入本 Room 的一次性意图：自动展开「+新建产物」面板，
  // 直接停在创建类型选择界面（轻文档 / Word / PPT / Excel）。
  // 同步置位、不安排 rAF：StrictMode 会「effect → cleanup → effect」双跑，若把
  // 打开动作放进可被 cleanup 取消的异步回调（或依赖二次 effect），意图已被消费
  // 而首次回调被取消，浮层就永远打不开。触发按钮与浮层同批挂载，直接置位即可。
  useEffect(() => {
    if (!consumeArtifactCreateIntent(room.id)) return;
    setCreateType(null);
    setCreateError(null);
    setCreatePopoverOpen(true);
  }, [room.id]);

  const confirmArtifactDelete = async () => {
    if (!pendingDelete) return;
    setDeleteError(null);
    setDeletingArtifact(true);
    try {
      if (pendingDelete.kind === 'file') {
        const files = window.nxcore?.files;
        if (!files) throw new Error(t('contextRoom:artifactLibrary.failedToDeleteFile'));
        await files.delete(pendingDelete.fileId);
        // 文件清单各面板监听该事件刷新；尾随刷新由钩子自兜。
        window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      } else {
        await onDeleteDocument?.(pendingDelete.document);
      }
      setPendingDelete(null);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error && error.message
        ? error.message
        : t('contextRoom:artifactLibrary.failedToDeleteFile'));
    } finally {
      setDeletingArtifact(false);
    }
  };

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

  // Office 预览是原生层，HTML 弹层画不过它：新建弹框期间的显隐不再单独
  // 处理，由 officeViewport 的遮挡扫描按几何关系统一裁决。

  const visibleArtifacts: Array<{ key: string; resource: ContextRoomResource; isOffice: boolean }> =
    filter === 'clouddoc'
      ? cloudDocs.map((resource) => ({ key: resource.id, resource, isOffice: false }))
      : filter === 'office'
        ? officeArtifacts.map((resource) => ({ key: resource.id, resource, isOffice: true }))
        : [
            ...officeArtifacts.map((resource) => ({ key: resource.id, resource, isOffice: true })),
            ...cloudDocs.map((resource) => ({ key: resource.id, resource, isOffice: false })),
          ];

  const createDocument = async () => {
    const title = newDocumentTitle.trim() || t('contextRoom:resource.untitledDocument');
    setCreateError(null);
    setCreatingDocument(true);
    try {
      await onCreateDocument(title);
      setCreatePopoverOpen(false);
      setNewDocumentTitle('');
      setCreateType(null);
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
      setCreateType(null);
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : t('contextRoom:resource.failedToImportMarkdownDocument'));
    } finally {
      setCreatingDocument(false);
    }
  };

  /**
   * 导入本地 Office 文件为产物（AI 生成的任选替代路径）：主进程按
   * sourceKind=artifact-imported 入库并归属 Room，成功后广播清单刷新并
   * 原位打开首个产物（openResource 对未刷新清单回退资源自带 sourceKind）。
   */
  const importOfficeFiles = async (files: File[]) => {
    const officeFiles = files.filter((file) => isArtifactImportFileName(file.name));
    if (officeFiles.length === 0) {
      setCreateError(t('contextRoom:artifactLibrary.chooseOfficeFile'));
      return;
    }
    setCreateError(null);
    setCreatingDocument(true);
    try {
      const imported = await window.nxcore?.files?.importArtifacts(officeFiles, room.id) ?? [];
      if (imported.length === 0) {
        setCreateError(t('contextRoom:artifactLibrary.importFailed'));
        return;
      }
      window.dispatchEvent(new CustomEvent('everroom:knowledge-changed'));
      showToast({ title: t('contextRoom:artifactLibrary.importSuccess', { count: imported.length }) });
      setCreatePopoverOpen(false);
      setNewDocumentTitle('');
      setCreateType(null);
      const first = imported[0]!;
      onSelect({
        id: `${room.id}:kfile:${first.fileId}`,
        roomId: room.id,
        folderId: null,
        name: first.originalName,
        updatedAt: new Date().toISOString(),
        kind: 'knowledge-file',
        fileId: first.fileId,
        originalName: first.originalName,
        bytes: officeFiles.find((file) => file.name === first.originalName)?.size ?? 0,
        uploadedAt: new Date().toISOString(),
        sourceKind: 'artifact-imported',
        statusLabel: '',
        sizeLabel: '',
      });
    } catch (error: unknown) {
      setCreateError(error instanceof Error ? error.message : t('contextRoom:artifactLibrary.importFailed'));
    } finally {
      setCreatingDocument(false);
    }
  };

  /** Word/PPT/Excel：经 Room 会话派发生成请求（Word/Excel 走 context_room_*_create，
   *  PPT 走 slides_create 脚本直生）产物生成后自动进入本栏并打开预览。 */
  const dispatchOfficeCreate = (type: Exclude<CreateType, 'doc'>) => {
    const title = newDocumentTitle.trim() || t(`contextRoom:artifactLibrary.newOfficeDefault.${type}`);
    const createInstruction = type === 'word'
      ? `请用 context_room_office_create 新建`
      : type === 'ppt'
        ? `请用 slides_create 脚本直生`
        : `请用 context_room_sheets_create 新建`;
    const kindLabel = t(`contextRoom:artifactLibrary.newOfficeDefault.${type}`);
    // message 是内部指令（runtime 用）；displayMessage 是用户看得懂的人话（气泡/会话标题用）。
    const displayMessage = type === 'ppt'
      ? `帮我新建一份 PPT《${title}》，先出内容稿，后续我再补充。`
      : `帮我新建一份${kindLabel}《${title}》，先搭个基本骨架，后续我再补充。`;
    window.dispatchEvent(new CustomEvent('everroom:room-agent-ask', {
      detail: {
        roomId: room.id,
        message: `${createInstruction}一份${kindLabel}《${title}》：内容从简，只生成标题与基本骨架，后续我再补充；完成后告知文件名。`,
        displayMessage,
      },
    }));
    setCreatePopoverOpen(false);
    setNewDocumentTitle('');
    setCreateType(null);
  };

  const filters: { id: ArtifactFilter; label: string }[] = [
    { id: 'all', label: t('contextRoom:artifactLibrary.filterAll') },
    { id: 'clouddoc', label: t('contextRoom:artifactLibrary.filterCloudDoc') },
    { id: 'office', label: t('contextRoom:artifactLibrary.filterOffice') },
  ];

  const CREATE_TYPES: Array<{ id: CreateType; label: string; hint: string; icon: typeof WordIcon }> = [
    { id: 'doc', label: t('contextRoom:artifactLibrary.newLightDoc'), hint: t('contextRoom:artifactLibrary.newLightDocHint'), icon: FileText },
    { id: 'word', label: t('contextRoom:artifactLibrary.newWord'), hint: t('contextRoom:artifactLibrary.newOfficeHint'), icon: WordIcon },
    { id: 'ppt', label: t('contextRoom:artifactLibrary.newPpt'), hint: t('contextRoom:artifactLibrary.newOfficeHint'), icon: Presentation },
    { id: 'xlsx', label: t('contextRoom:artifactLibrary.newXlsx'), hint: t('contextRoom:artifactLibrary.newOfficeHint'), icon: FileSpreadsheet },
  ];

  return (
    <div className="context-room-artifact-library">
      <div className="context-room-artifact-toolbar">
        <FilterSelect
          value={filter}
          options={filters}
          onChange={setFilter}
          ariaLabel={t('contextRoom:boardTab.library')}
        />
        <div className="context-room-artifact-toolbar-actions">
          {selectionMode ? (
            <div className="context-room-artifact-selection" role="group" aria-label={t('contextRoom:artifactLibrary.selectedCount', { count: selectedDocumentIds.size })}>
              <span>{t('contextRoom:artifactLibrary.selectedCount', { count: selectedDocumentIds.size })}</span>
              <button
                type="button"
                className="context-room-artifact-selection-move"
                disabled={selectedDocuments.length === 0}
                onClick={() => setMoveTargets(selectedDocuments.map((document) => ({
                  id: document.id,
                  title: document.title,
                  roomId: document.roomId,
                })))}
              >
                <FolderInput aria-hidden="true" />
                {t('contextRoom:artifactLibrary.moveSelected')}
              </button>
              <button type="button" className="context-room-artifact-selection-cancel" onClick={exitSelection}>
                {t('contextRoom:artifactLibrary.cancelSelection')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="context-room-artifact-select-toggle"
              aria-pressed={false}
              onClick={() => setSelectionMode(true)}
            >
              <ListChecks aria-hidden="true" />
              {t('contextRoom:artifactLibrary.select')}
            </button>
          )}
          <Popover.Root
            open={createPopoverOpen}
            onOpenChange={(nextOpen) => {
              if (!nextOpen && creatingDocument) return;
              setCreateError(null);
              setCreatePopoverOpen(nextOpen);
              if (!nextOpen) { setNewDocumentTitle(''); setCreateType(null); }
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
                className={`context-room-document-create-popover${createType === null ? ' is-chooser' : ''}`}
                side="bottom"
                align="end"
                sideOffset={6}
                collisionPadding={10}
                aria-label={t('contextRoom:artifactLibrary.newArtifact')}
              >
                {createType === null ? (
                  <div className="context-room-document-create-types">
                    {CREATE_TYPES.map(({ id, label, hint, icon: Icon }) => (
                      <button key={id} type="button" className="context-room-document-create-type" onClick={() => setCreateType(id)}>
                        <Icon aria-hidden="true" />
                        <span className="context-room-document-create-type-body">
                          <b>{label}</b>
                          <small>{hint}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : createType === 'doc' ? (
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
                      <button type="button" disabled={creatingDocument} onClick={() => setCreateType(null)}>
                        {t('contextRoom:resource.cancel')}
                      </button>
                      <button type="submit" className="is-primary" disabled={creatingDocument}>
                        {t(creatingDocument ? 'contextRoom:resource.creating' : 'contextRoom:resource.create')}
                      </button>
                    </footer>
                  </form>
                ) : (
                  <form onSubmit={(event) => { event.preventDefault(); dispatchOfficeCreate(createType); }}>
                    <label htmlFor="context-room-new-artifact-title">{t('contextRoom:resource.documentName')}</label>
                    <input
                      id="context-room-new-artifact-title"
                      autoFocus
                      maxLength={120}
                      value={newDocumentTitle}
                      placeholder={t('contextRoom:resource.untitledDocument')}
                      onChange={(event) => setNewDocumentTitle(event.target.value)}
                    />
                    <input
                      ref={officeImportInputRef}
                      className="context-room-document-import-input"
                      type="file"
                      accept={ARTIFACT_IMPORT_EXTENSIONS.join(',')}
                      multiple
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        event.currentTarget.value = '';
                        if (files.length > 0) void importOfficeFiles(files);
                      }}
                    />
                    <button
                      type="button"
                      className="context-room-document-import"
                      disabled={creatingDocument}
                      onClick={() => officeImportInputRef.current?.click()}
                    >
                      <FileUp aria-hidden="true" />
                      {t(creatingDocument ? 'contextRoom:resource.processing' : 'contextRoom:artifactLibrary.importOffice')}
                    </button>
                    {createError ? <small role="alert">{createError}</small> : null}
                    <small className="context-room-document-create-hint">{t('contextRoom:artifactLibrary.officeCreateHint')}</small>
                    <footer>
                      <button type="button" onClick={() => setCreateType(null)}>{t('contextRoom:resource.cancel')}</button>
                      <button type="submit" className="is-primary">{t('contextRoom:artifactLibrary.createOffice')}</button>
                    </footer>
                  </form>
                )}
                <Popover.Arrow className="context-room-document-create-arrow" />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>
      <MoveDocumentToRoomDialog
        open={moveTargets.length > 0}
        onOpenChange={(open) => {
          if (!open) setMoveTargets([]);
        }}
        documents={moveTargets}
        onMoved={() => exitSelection()}
      />
      <ReferenceDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && deletingArtifact) return;
          if (!open) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title={pendingDelete
          ? pendingDelete.kind === 'file'
            ? t('contextRoom:artifactLibrary.confirmDeleteFileName', { name: pendingDelete.name })
            : t('contextRoom:resource.confirmMovingDocumentNameToTrash', { name: pendingDelete.name })
          : ''}
        contentClassName="context-room-artifact-delete-shell"
      >
        <div className="context-room-action-confirm">
          <header>
            <h2>{pendingDelete?.kind === 'file'
              ? t('contextRoom:artifactLibrary.deleteFile')
              : t('contextRoom:resource.moveToTrash')}</h2>
          </header>
          <div className="context-room-action-confirm-body">
            <p>{pendingDelete?.kind === 'file'
              ? t('contextRoom:artifactLibrary.confirmDeleteFile')
              : t('contextRoom:resource.confirmMoveToTrash')}</p>
            <p className="context-room-action-confirm-note">
              {pendingDelete
                ? pendingDelete.kind === 'file'
                  ? t('contextRoom:artifactLibrary.deleteFileIrreversible')
                  : t('contextRoom:resource.nameCanBeRestoredFromTrash', { name: pendingDelete.name })
                : null}
            </p>
            {deleteError ? <p className="context-room-move-error" role="alert">{deleteError}</p> : null}
          </div>
          <footer>
            <button
              type="button"
              className="context-room-ghost"
              disabled={deletingArtifact}
              onClick={() => {
                setPendingDelete(null);
                setDeleteError(null);
              }}
            >
              {t('contextRoom:resource.cancel')}
            </button>
            <button
              type="button"
              className="context-room-danger-button"
              disabled={deletingArtifact}
              onClick={() => void confirmArtifactDelete()}
            >
              {t(deletingArtifact ? 'contextRoom:artifactLibrary.deleting' : 'contextRoom:artifactLibrary.delete')}
            </button>
          </footer>
        </div>
      </ReferenceDialog>
      <div className="context-room-artifact-list">
        {visibleArtifacts.map(({ key, resource }) => {
          const office = resource.kind === 'knowledge-file' ? resource : null;
          const cloud = resource.kind === 'cloud-doc' ? resource : null;
          const backendDocument = cloud ? backendDocuments.find((document) => document.id === cloud.binding.docId) ?? null : null;
          const citations = backendDocument ? citationCounts.get(backendDocument.id) ?? 0 : 0;
          const officeFile = office ? fileById.get(office.fileId) ?? null : null;
          // 副标题：版本 · 更新时间 · 体积——同一份产物的多版本才分得清谁最新
          const officeMeta = office
            ? [
                officeFile?.versionNo != null ? `v${officeFile.versionNo}` : null,
                formatRelative(officeFile?.updatedAt ?? officeFile?.uploadedAt ?? office.uploadedAt, locale),
                office.sizeLabel,
              ].filter((part): part is string => Boolean(part)).join(' · ')
            : null;
          return (
            <div
              className="context-room-artifact-row"
              data-selecting={selectionMode && Boolean(backendDocument) || undefined}
              key={key}
            >
              {selectionMode && backendDocument ? (
                <button
                  type="button"
                  role="checkbox"
                  className="context-room-artifact-check"
                  aria-checked={selectedDocumentIds.has(backendDocument.id)}
                  aria-label={t('contextRoom:artifactLibrary.selectDocument', { name: resource.name })}
                  onClick={() => toggleDocumentSelection(backendDocument.id)}
                >
                  {selectedDocumentIds.has(backendDocument.id) ? <Check aria-hidden="true" /> : null}
                </button>
              ) : null}
              <button
                type="button"
                className="context-room-artifact-item"
                aria-selected={selectedId === resource.id}
                onClick={() => {
                  if (selectionMode && backendDocument) {
                    toggleDocumentSelection(backendDocument.id);
                    return;
                  }
                  onSelect(resource);
                }}
              >
                <span className="context-room-artifact-ico"><FileText aria-hidden="true" /></span>
                <span className="context-room-artifact-body">
                  <b>{resource.name}</b>
                  <small>{office ? officeMeta : cloud && `${cloud.version} · ${cloud.updatedAt}`}</small>
                </span>
                <span className="context-room-artifact-meta">
                  {office ? (
                    <span className="context-room-artifact-tag is-draft">
                      {t(office.sourceKind === 'artifact-imported'
                        ? 'contextRoom:artifactLibrary.importedTag'
                        : 'contextRoom:artifactLibrary.agentGenerated')}
                    </span>
                  ) : citations > 0 ? (
                    <span className="context-room-artifact-tag">{t('contextRoom:artifactLibrary.citationCount', { count: citations })}</span>
                  ) : null}
                </span>
              </button>
              {office || backendDocument ? (
                <span className="context-room-artifact-acts">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button
                        type="button"
                        className="context-room-resource-more"
                        aria-label={t('contextRoom:artifactLibrary.moreActions')}
                        title={t('contextRoom:artifactLibrary.moreActions')}
                      >
                        <Ellipsis aria-hidden="true" />
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="context-room-card-menu context-room-artifact-menu"
                        align="end"
                        sideOffset={6}
                      >
                        {backendDocument ? (
                          <DropdownMenu.Item
                            onSelect={() => setMoveTargets([{
                              id: backendDocument.id,
                              title: backendDocument.title || resource.name,
                              roomId: backendDocument.roomId,
                            }])}
                          >
                            <FolderInput aria-hidden="true" />
                            {t('contextRoom:artifactLibrary.moveToAnotherRoom')}
                          </DropdownMenu.Item>
                        ) : null}
                        {office ? (
                          <DropdownMenu.Item
                            onSelect={() => {
                              void window.nxcore?.files?.exportReveal(office.fileId, office.originalName).catch((error: unknown) => {
                                showToast({
                                  title: t('contextRoom:artifactLibrary.revealFailed'),
                                  message: error instanceof Error ? error.message : String(error),
                                  variant: 'error',
                                });
                              });
                            }}
                          >
                            <FolderOpen aria-hidden="true" />
                            {t('contextRoom:artifactLibrary.revealInFolder')}
                          </DropdownMenu.Item>
                        ) : null}
                        <DropdownMenu.Separator className="context-room-document-actions-separator" />
                        <DropdownMenu.Item
                          className="danger"
                          onSelect={() => {
                            setDeleteError(null);
                            setPendingDelete(office
                              ? { key, kind: 'file', fileId: office.fileId, name: resource.name }
                              : backendDocument
                                ? { key, kind: 'document', document: backendDocument, name: resource.name }
                                : null);
                          }}
                        >
                          <Trash2 aria-hidden="true" />
                          {office
                            ? t('contextRoom:artifactLibrary.deleteFile')
                            : t('contextRoom:resource.moveToTrash')}
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </span>
              ) : null}
            </div>
          );
        })}
        {visibleArtifacts.length === 0 ? (
          <PanelEmptyState
            compact
            icon={Package}
            title={t(filter === 'all'
              ? 'contextRoom:artifactLibrary.noArtifactsYet'
              : filter === 'office'
                ? 'contextRoom:artifactLibrary.noOfficeYet'
                : 'contextRoom:artifactLibrary.noCloudDocYet')}
          />
        ) : null}
      </div>
    </div>
  );
}
