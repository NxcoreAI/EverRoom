import * as Popover from '@radix-ui/react-popover';
import { FileText, FileSpreadsheet, FileUp, Presentation, FileText as WordIcon, LoaderCircle, Package, Plus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';
import type { RoomDocument, TiptapJsonContent } from '@nxcore/agent-contract';
import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary } from '../../resources';
import { getEmbeddedOffice } from '../../embeddedOffice';
import type {
  ContextRoomCloudDocResource,
  ContextRoomKnowledgeFileResource,
  ContextRoomRecord,
  ContextRoomResource,
} from '../../types';
import { markdownDocumentTitle, parseMarkdownDocument } from '../detail-editor/markdownImport';
import { buildLinkGraphData } from '../linkGraphModel';
import { PanelEmptyState } from './PanelEmptyState';

type ArtifactFilter = 'all' | 'clouddoc' | 'office';
type CreateType = 'doc' | 'word' | 'ppt' | 'xlsx';

/**
 * 产物库：Room 内创作成果的平铺清单（原型 room-launch 产物板块）。
 * 筛选只区分「云文档（轻文档）」与「Office 产物（Agent 生成）」；
 * 不设草稿/回收站状态视图。新建支持轻文档（md）与 Word/PPT/Excel——
 * Office 走 Room 内 Agent 生成通道（context_room_*_create）。
 */
export function ArtifactLibraryPane({
  room,
  backendDocuments,
  trashedDocuments,
  agentFiles = [],
  selectedId,
  onSelect,
  onCreateDocument,
}: {
  room: ContextRoomRecord;
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  /** Agent 生成的 Office 产物（Room 文件清单按 sourceKind 过滤）。 */
  agentFiles: KnowledgeFileDto[];
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onCreateDocument: (title: string, contentJson?: TiptapJsonContent) => Promise<void>;
  /** 回收站相关操作已从 UI 下线；父级仍会传入，保留类型兼容。 */
  onDeleteDocument?: (document: RoomDocument) => Promise<void>;
  onRestoreDocument?: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently?: (document: RoomDocument) => Promise<void>;
}) {
  const { locale, t } = useLocale();
  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, trashedDocuments, [], locale),
    [backendDocuments, locale, room, trashedDocuments],
  );
  // Agent Office 产物：复用 knowledge-file 资源映射（点击 → 内嵌 Office 预览）。
  const officeArtifacts = useMemo(
    () => createContextRoomResourceLibrary(room, [], [], agentFiles, locale)
      .resources.filter((resource): resource is ContextRoomKnowledgeFileResource => resource.kind === 'knowledge-file'),
    [agentFiles, locale, room],
  );
  const isCloudDoc = (resource: ContextRoomResource): resource is ContextRoomCloudDocResource =>
    resource.kind === 'cloud-doc';
  const cloudDocs = library.resources.filter(isCloudDoc).filter((resource) => !resource.trashed);

  const [filter, setFilter] = useState<ArtifactFilter>('all');
  const [createPopoverOpen, setCreatePopoverOpen] = useState(false);
  const [createType, setCreateType] = useState<CreateType | null>(null);
  const [newDocumentTitle, setNewDocumentTitle] = useState('');
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const markdownInputRef = useRef<HTMLInputElement>(null);
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

  // Office 预览是主进程 WebContentsView（原生层，叠在窗口上），HTML 弹层
  // 永远画不过它：新建弹框打开期间隐藏全部 office 视图，关闭时恢复当前
  // 登记的实例；期间被生成流程新激活的实例以恢复时刻的仲裁为准。
  useEffect(() => {
    if (!createPopoverOpen) return
    const office = window.nxcore?.office
    if (!office) return
    void office.setActiveInstance(null)
    return () => {
      const active = getEmbeddedOffice()
      if (active) void office.setActiveInstance(active.instanceId)
    }
  }, [createPopoverOpen])

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

  /** Word/PPT/Excel：经 Room 会话派发生成请求（Agent 走 context_room_*_create
   *  全链路），产物生成后自动进入本栏并打开预览。 */
  const dispatchOfficeCreate = (type: Exclude<CreateType, 'doc'>) => {
    const title = newDocumentTitle.trim() || t(`contextRoom:artifactLibrary.newOfficeDefault.${type}`);
    const tool = type === 'word' ? 'context_room_office_create' : type === 'ppt' ? 'context_room_slides_create' : 'context_room_sheets_create';
    const kindLabel = t(`contextRoom:artifactLibrary.newOfficeDefault.${type}`);
    window.dispatchEvent(new CustomEvent('everroom:room-agent-ask', {
      detail: {
        roomId: room.id,
        message: `请用 ${tool} 新建一份${kindLabel}《${title}》：内容从简，只生成标题与基本骨架，后续我再补充；完成后告知文件名。`,
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
              side="right"
              align="start"
              sideOffset={8}
              collisionPadding={12}
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
      <div className="context-room-artifact-list">
        {visibleArtifacts.map(({ key, resource }) => {
          const office = resource.kind === 'knowledge-file' ? resource : null;
          const cloud = resource.kind === 'cloud-doc' ? resource : null;
          const backendDocument = cloud ? backendDocuments.find((document) => document.id === cloud.binding.docId) ?? null : null;
          const citations = backendDocument ? citationCounts.get(backendDocument.id) ?? 0 : 0;
          return (
            <div className="context-room-artifact-row" key={key}>
              <button
                type="button"
                className="context-room-artifact-item"
                aria-selected={selectedId === resource.id}
                onClick={() => onSelect(resource)}
              >
                <span className="context-room-artifact-ico"><FileText aria-hidden="true" /></span>
                <span className="context-room-artifact-body">
                  <b>{resource.name}</b>
                  <small>{office
                    ? `${office.sizeLabel} · ${office.statusLabel}`
                    : cloud && `${cloud.version} · ${cloud.updatedAt}`}</small>
                </span>
                <span className="context-room-artifact-meta">
                  {office ? (
                    <span className="context-room-artifact-tag is-draft">{t('contextRoom:artifactLibrary.agentGenerated')}</span>
                  ) : citations > 0 ? (
                    <span className="context-room-artifact-tag">{t('contextRoom:artifactLibrary.citationCount', { count: citations })}</span>
                  ) : null}
                </span>
              </button>
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
