import * as Popover from '@radix-ui/react-popover';
import {
  FileSpreadsheet,
  FileText,
  Mail,
  Mic,
  Paperclip,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
  X,
} from 'lucide-react';
import type { RoomDocument, RoomMailDetail } from '@nxcore/agent-contract';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale } from '../../../../../i18n/LocaleContext';

import type { KnowledgeFileDto } from '../../../../../../../shared/knowledge';
import { createContextRoomResourceLibrary, formatBytes, knowledgeFileStatusLabel } from '../../resources';
import { localizedUiText, uiText } from '../../adapters';
import type { ContextRoomRecord, ContextRoomResource } from '../../types';
import { useRoomMails } from '../../hooks/useRoomMails';
import { MailProviderIcon } from '../MailProviderIcon';
import { ObjectDetailView } from '../ObjectDetailView';
import { ResourceCorrectionMenu } from '../ResourceCorrection';
import { MarkdownBody } from './MarkdownBody';
import { PanelEmptyState } from './PanelEmptyState';
import type { WorkspaceObjectPreview } from './index';

type RoomUpdater = (room: ContextRoomRecord) => ContextRoomRecord;

type MaterialsSort = 'source' | 'updated' | 'imported' | 'name';
type MaterialsFilter = 'all' | 'doc' | 'file' | 'mail' | 'meeting';

/** 资料视图的排序与筛选按 Room 记忆（PRD 6.6：排序选择按 Room 记忆）。 */
const MATERIALS_VIEW_KEY = 'nxcore-ce:room-materials-view:v1';
const MAX_ROOMS = 200;

const SORT_OPTIONS: ReadonlyArray<{ id: MaterialsSort; label: string }> = [
  { id: 'source', label: 'contextRoom:materialsPane.sort.source' },
  { id: 'updated', label: 'contextRoom:materialsPane.sort.updated' },
  { id: 'imported', label: 'contextRoom:materialsPane.sort.imported' },
  { id: 'name', label: 'contextRoom:materialsPane.sort.name' },
];

const FILTER_OPTIONS: ReadonlyArray<{ id: MaterialsFilter; label: string }> = [
  { id: 'all', label: 'contextRoom:materialsPane.filter.all' },
  { id: 'doc', label: 'contextRoom:materialsPane.filter.doc' },
  { id: 'file', label: 'contextRoom:materialsPane.filter.file' },
  { id: 'mail', label: 'contextRoom:materialsPane.filter.mail' },
  { id: 'meeting', label: 'contextRoom:materialsPane.filter.meeting' },
];

interface MaterialsViewMemory {
  sort: MaterialsSort;
  filter: MaterialsFilter;
}

function loadMaterialsView(roomId: string): MaterialsViewMemory {
  try {
    const raw = window.localStorage.getItem(MATERIALS_VIEW_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, Partial<MaterialsViewMemory>> : {};
    const entry = parsed[roomId];
    return {
      sort: SORT_OPTIONS.some((option) => option.id === entry?.sort) ? (entry?.sort as MaterialsSort) : 'source',
      filter: FILTER_OPTIONS.some((option) => option.id === entry?.filter) ? (entry?.filter as MaterialsFilter) : 'all',
    };
  } catch {
    return { sort: 'source', filter: 'all' };
  }
}

function saveMaterialsView(roomId: string, next: MaterialsViewMemory): void {
  try {
    const raw = window.localStorage.getItem(MATERIALS_VIEW_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, MaterialsViewMemory> : {};
    parsed[roomId] = next;
    const roomIds = Object.keys(parsed);
    if (roomIds.length > MAX_ROOMS) {
      for (const id of roomIds.slice(0, roomIds.length - MAX_ROOMS)) delete parsed[id];
    }
    window.localStorage.setItem(MATERIALS_VIEW_KEY, JSON.stringify(parsed));
  } catch {
    // 存储不可用时静默放弃：排序记忆是增强而非关键路径。
  }
}

/** 本地快照时间的宽松解析（"昨天 16:40"/"07-21 10:20"），解析不到返回 null。 */
function parseDisplayDate(value: string): Date | null {
  if (!value) return null;
  if (/^(今天|today)(?:\s|$)/iu.test(value)) return new Date();
  if (/^(昨天|yesterday)(?:\s|$)/iu.test(value)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday;
  }
  const fullDate = value.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (fullDate) return new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3]));
  const match = value.match(/(\d{1,2})-(\d{1,2})/);
  if (!match) return null;
  const now = new Date();
  return new Date(now.getFullYear(), Number(match[1]) - 1, Number(match[2]));
}

/** 本地日期键（补零）：与连接器邮件的同日判断共用。 */
function paddedDateKey(when: Date): string {
  return `${String(when.getFullYear())}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`;
}

function timeSortKey(value: string | null | undefined): number {
  if (!value) return 0;
  const iso = Date.parse(value);
  if (!Number.isNaN(iso)) return iso;
  return parseDisplayDate(value)?.getTime() ?? 0;
}

/** 资料平铺行：一个来源对象一行（文档/文件/邮件/会议），共用排序与筛选键。 */
interface MaterialRow {
  key: string;
  type: MaterialsFilter;
  title: string;
  subtitle: string;
  timeLabel: string;
  /** 来源发生时间（邮件发送/会议召开/文档创建）排序键，0=未知沉底。 */
  sortSource: number;
  sortUpdated: number;
  sortImported: number;
  unread?: boolean;
  resource?: ContextRoomResource;
  openObject?: WorkspaceObjectPreview;
  document?: RoomDocument;
  knowledgeFileId?: string;
  connectorMail?: { sourceId: string; subject: string };
  connectorSource?: string;
}

/** 连接器邮件详情（资料面板下半区）：身份头 + 元信息 + 正文滚动区。 */
function ConnectorMailDetailPanel({
  state,
  locale,
  onClose,
}: {
  state: { loading: boolean; detail: RoomMailDetail | null; error: boolean };
  locale: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  if (state.loading) {
    return (
      <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
        <p className="context-room-mail-detail-hint">{t('contextRoom:activityPanes.loadingMailBody')}</p>
      </aside>
    );
  }
  if (state.error || !state.detail) {
    return (
      <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
        <p className="context-room-mail-detail-hint">{t('contextRoom:activityPanes.mailBodyUnavailable')}</p>
      </aside>
    );
  }
  const detail = state.detail;
  const when = detail.sentAt && !Number.isNaN(Date.parse(detail.sentAt))
    ? new Date(detail.sentAt).toLocaleString(locale)
    : null;
  return (
    <aside className="context-room-mail-detail" data-testid="context-room-mail-detail">
      <header>
        <MailProviderIcon provider={detail.provider} />
        <div className="context-room-mail-detail-title">
          <strong title={detail.subject}>{detail.subject}</strong>
          <small>
            {detail.senderName ?? t('contextRoom:objectDetail.defaultSender')}
            {detail.senderAddress ? ` <${detail.senderAddress}>` : ''}
          </small>
        </div>
        <button type="button" aria-label={t('contextRoom:activityPanes.closeMailDetail')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      <p className="context-room-mail-detail-meta">
        {when ? <time>{t('contextRoom:activityPanes.sentAt')}：{when}</time> : null}
      </p>
      <div className="context-room-mail-detail-body">
        <MarkdownBody markdown={detail.body} />
      </div>
    </aside>
  );
}

/**
 * 工作 / 资料（PRD L3.2.6 + L3.2.5）：按来源对象平铺管理（不按文件格式分夹），
 * 默认按来源时间倒序，可切换最近更新/导入时间/名称并按 Room 记忆；邮件作为
 * 来源对象同列展示（列表/摘要/原件入口保留），文档版本与回收站动作保留。
 */
export function MaterialsPane({
  room,
  rooms,
  backendDocuments,
  trashedDocuments,
  knowledgeFiles,
  selectedId,
  onSelect,
  onDeleteDocument,
  onRestoreDocument,
  onDeleteDocumentPermanently,
  onEmptyTrash,
  onOpenObject,
  detail,
  onCloseDetail,
  onUpdateRoom,
}: {
  room: ContextRoomRecord;
  /** 归入纠正（改归其他 Room）的目标候选。 */
  rooms: ContextRoomRecord[];
  backendDocuments: RoomDocument[];
  trashedDocuments: RoomDocument[];
  knowledgeFiles: KnowledgeFileDto[];
  selectedId: string | null;
  onSelect: (resource: ContextRoomResource) => void;
  onDeleteDocument: (document: RoomDocument) => Promise<void>;
  onRestoreDocument: (document: RoomDocument) => Promise<void>;
  onDeleteDocumentPermanently: (document: RoomDocument) => Promise<void>;
  onEmptyTrash: (roomId: string) => Promise<void>;
  onOpenObject: (target: WorkspaceObjectPreview) => void;
  /** 受控详情态：本地邮件详情在资料面板内展示。 */
  detail?: WorkspaceObjectPreview | null;
  onCloseDetail?: () => void;
  onUpdateRoom: (updater: RoomUpdater) => void;
}) {
  const { locale, t } = useLocale();
  const { mails: connectorMails } = useRoomMails(room.id);
  const [memory, setMemory] = useState<MaterialsViewMemory>(() => loadMaterialsView(room.id));
  const [query, setQuery] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<RoomDocument | null>(null);
  const [documentToDeletePermanently, setDocumentToDeletePermanently] = useState<RoomDocument | null>(null);
  const [clearTrashPopoverOpen, setClearTrashPopoverOpen] = useState(false);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // 连接器邮件详情（受控 detail 驱动）：点击行 → onOpenObject(connector-mail)。
  const [mailDetailState, setMailDetailState] = useState<{ loading: boolean; detail: RoomMailDetail | null; error: boolean }>({
    loading: false,
    detail: null,
    error: false,
  });
  const mailDetailCache = useRef(new Map<string, RoomMailDetail>());
  const mailDetailSeq = useRef(0);

  useEffect(() => {
    setMemory(loadMaterialsView(room.id));
    setQuery('');
    setTrashOpen(false);
  }, [room.id]);

  const updateMemory = useCallback((patch: Partial<MaterialsViewMemory>) => {
    setMemory((current) => {
      const next = { ...current, ...patch };
      saveMaterialsView(room.id, next);
      return next;
    });
  }, [room.id]);

  const library = useMemo(
    () => createContextRoomResourceLibrary(room, backendDocuments, trashedDocuments, knowledgeFiles, locale),
    [backendDocuments, knowledgeFiles, locale, room, trashedDocuments],
  );

  // 本地快照邮件按「主题 + 同日」与连接器邮件去重，保留连接器版本（真实发件人/时间）。
  const connectorMailKeys = useMemo(() => new Set(connectorMails.flatMap((mail) => {
    const when = mail.sentAt ? new Date(mail.sentAt) : null;
    if (!when || Number.isNaN(when.getTime())) return [];
    return [`${mail.subject.trim().toLocaleLowerCase()}\x00${paddedDateKey(when)}`];
  })), [connectorMails]);

  const rows = useMemo<MaterialRow[]>(() => {
    const docRows: MaterialRow[] = backendDocuments.map((document) => ({
      key: `doc:${document.id}`,
      type: 'doc',
      title: document.title,
      subtitle: document.version > 0 ? `V${String(document.version)}` : t('contextRoom:materialsPane.draft'),
      timeLabel: `${t('contextRoom:materialsPane.importedAt')} ${new Date(document.createdAt).toLocaleDateString(locale)}`,
      sortSource: timeSortKey(document.createdAt),
      sortUpdated: timeSortKey(document.updatedAt),
      sortImported: timeSortKey(document.createdAt),
      resource: library.resources.find((item) => item.kind === 'cloud-doc' && item.binding.docId === document.id),
      document,
    }));
    const fileRows: MaterialRow[] = knowledgeFiles.map((file) => ({
      key: `file:${file.id}`,
      type: 'file',
      title: file.originalName,
      // 上传文件缺来源创建时间：用导入时间并标明依据（PRD 6.6）。
      subtitle: `${t(uiText(knowledgeFileStatusLabel(file)))} · ${formatBytes(file.bytes)}`,
      timeLabel: `${t('contextRoom:materialsPane.importedAt')} ${new Date(file.uploadedAt).toLocaleDateString(locale)}`,
      sortSource: timeSortKey(file.uploadedAt),
      sortUpdated: timeSortKey(file.uploadedAt),
      sortImported: timeSortKey(file.uploadedAt),
      resource: library.resources.find((item) => item.kind === 'knowledge-file' && item.fileId === file.id),
      knowledgeFileId: file.id,
    }));
    const officeRows: MaterialRow[] = room.fileItems.map((item) => ({
      key: `office:${item.id}`,
      type: 'file',
      title: item.name,
      subtitle: `${t('contextRoom:materialsPane.localFile')} · ${item.extension}`,
      timeLabel: item.time,
      sortSource: timeSortKey(item.time),
      sortUpdated: timeSortKey(item.time),
      sortImported: timeSortKey(item.time),
      resource: library.resources.find((item2) => item2.kind === 'office-file' && item2.id === `${room.id}:file:${item.id}`),
    }));
    const connectorMailRows: MaterialRow[] = connectorMails.map((mail) => ({
      key: `mail:${mail.sourceId}`,
      connectorSource: 'mail',
      type: 'mail',
      title: mail.subject,
      subtitle: mail.senderName ?? mail.senderAddress ?? t('contextRoom:objectDetail.defaultSender'),
      timeLabel: mail.sentAt && !Number.isNaN(Date.parse(mail.sentAt))
        ? new Date(mail.sentAt).toLocaleDateString(locale)
        : '',
      sortSource: timeSortKey(mail.sentAt),
      sortUpdated: timeSortKey(mail.sentAt),
      sortImported: timeSortKey(mail.sentAt),
      openObject: { kind: 'connector-mail', sourceId: mail.sourceId },
      connectorMail: { sourceId: mail.sourceId, subject: mail.subject },
    }));
    const localMailRows: MaterialRow[] = room.materials
      .filter((material) => material.type === '邮件')
      .filter((mail) => {
        const when = parseDisplayDate(mail.time);
        if (!when) return true;
        return !connectorMailKeys.has(`${mail.title.trim().toLocaleLowerCase()}\x00${paddedDateKey(when)}`);
      })
      .map((mail) => ({
        key: `lmail:${mail.id}`,
        type: 'mail',
        title: mail.title,
        subtitle: mail.sender ?? localizedUiText(mail.summary, t),
        timeLabel: mail.time,
        sortSource: timeSortKey(mail.time),
        sortUpdated: timeSortKey(mail.time),
        sortImported: timeSortKey(mail.time),
        unread: mail.unread,
        openObject: { kind: 'mail', id: mail.id },
      }));
    const meetingRows: MaterialRow[] = room.materials
      .filter((material) => material.type === '会议')
      .map((meeting) => ({
        key: `meeting:${meeting.id}`,
        type: 'meeting',
        title: meeting.title,
        subtitle: meeting.attendees?.join(locale === 'zh-CN' ? '、' : ', ') ?? '',
        timeLabel: meeting.time,
        sortSource: timeSortKey(meeting.time),
        sortUpdated: timeSortKey(meeting.time),
        sortImported: timeSortKey(meeting.time),
        openObject: { kind: 'meeting', id: meeting.id },
      }));
    return [...docRows, ...fileRows, ...officeRows, ...connectorMailRows, ...localMailRows, ...meetingRows];
  }, [backendDocuments, connectorMailKeys, connectorMails, knowledgeFiles, library.resources, locale, room, t]);

  const normalized = query.trim().toLowerCase();
  const visibleRows = rows
    .filter((row) => (memory.filter === 'all' || row.type === memory.filter)
      && (!normalized || row.title.toLowerCase().includes(normalized) || row.subtitle.toLowerCase().includes(normalized)))
    .sort((left, right) => {
      if (memory.sort === 'name') return left.title.localeCompare(right.title, locale);
      const key = memory.sort === 'updated' ? 'sortUpdated' : memory.sort === 'imported' ? 'sortImported' : 'sortSource';
      if (left[key] !== right[key]) return right[key] - left[key];
      return left.title.localeCompare(right.title, locale);
    });

  // 连接器邮件详情：受控 detail 变化时拉取全文（会话内缓存，Room 切换即失效）。
  const connectorMailDetail = detail?.kind === 'connector-mail' ? detail : null;
  useEffect(() => {
    mailDetailCache.current.clear();
    mailDetailSeq.current += 1;
  }, [room.id]);
  useEffect(() => {
    if (!connectorMailDetail) {
      setMailDetailState({ loading: false, detail: null, error: false });
      return;
    }
    const sourceId = connectorMailDetail.sourceId;
    const cached = mailDetailCache.current.get(sourceId);
    if (cached) {
      setMailDetailState({ loading: false, detail: cached, error: false });
      return;
    }
    const seq = mailDetailSeq.current + 1;
    mailDetailSeq.current = seq;
    setMailDetailState({ loading: true, detail: null, error: false });
    void (async () => {
      try {
        const fetched = await window.nxcore?.contextRooms?.readMail(room.id, sourceId);
        if (!fetched) throw new Error('mail_detail_unavailable');
        mailDetailCache.current.set(sourceId, fetched);
        if (mailDetailSeq.current === seq) {
          setMailDetailState({ loading: false, detail: fetched, error: false });
        }
      } catch {
        if (mailDetailSeq.current === seq) {
          setMailDetailState({ loading: false, detail: null, error: true });
        }
      }
    })();
  }, [connectorMailDetail, room.id]);


  // 本地邮件详情：资料面板内嵌 ObjectDetailView。
  const localMailObject = detail?.kind === 'mail'
    ? room.materials.find((material) => material.id === detail.id && material.type === '邮件') ?? null
    : null;
  if (detail?.kind === 'mail' && localMailObject && onCloseDetail) {
    return (
      <div className="context-room-page context-room-object-page">
        <ObjectDetailView
          embedded
          room={room}
          object={{ kind: 'mail', value: localMailObject }}
          onBack={onCloseDetail}
          onUpdateRoom={onUpdateRoom}
        />
      </div>
    );
  }

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

  const clearTrash = async () => {
    setDeleteError(null);
    setDeletingDocumentId('empty-trash');
    try {
      await onEmptyTrash(room.id);
      setClearTrashPopoverOpen(false);
    } catch (error: unknown) {
      setDeleteError(error instanceof Error ? error.message : t('contextRoom:resource.failedToEmptyTrash'));
    } finally {
      setDeletingDocumentId(null);
    }
  };

  const rowIcon = (row: MaterialRow) => {
    if (row.type === 'mail') {
      return row.connectorMail
        ? <MailProviderIcon provider={connectorMails.find((mail) => mail.sourceId === row.connectorMail?.sourceId)?.provider} />
        : <Mail aria-hidden="true" />;
    }
    if (row.type === 'meeting') return <Mic aria-hidden="true" />;
    if (row.type === 'file') {
      return row.resource?.kind === 'office-file' && row.resource.format === 'xlsx'
        ? <FileSpreadsheet aria-hidden="true" />
        : row.resource?.kind === 'knowledge-file' ? <Paperclip aria-hidden="true" /> : <FileText aria-hidden="true" />;
    }
    return <FileText aria-hidden="true" />;
  };

  return (
    <div className={`context-room-materials-pane${connectorMailDetail ? ' has-detail' : ''}`} data-testid="context-room-pane-materials">
      <header className="context-room-materials-toolbar">
        <label>
          <Search aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('contextRoom:materialsPane.searchPlaceholder')}
            aria-label={t('contextRoom:materialsPane.searchAriaLabel')}
          />
        </label>
        <div className="context-room-materials-filters" role="group" aria-label={t('contextRoom:materialsPane.filterByType')}>
          {FILTER_OPTIONS.map(({ id, label }) => (
            <button
              type="button"
              key={id}
              aria-pressed={memory.filter === id}
              className={memory.filter === id ? 'is-active' : ''}
              onClick={() => updateMemory({ filter: id })}
            >
              {t(label)}
            </button>
          ))}
        </div>
        <label className="context-room-materials-sort">
          {t('contextRoom:materialsPane.sortLabel')}
          <select
            value={memory.sort}
            aria-label={t('contextRoom:materialsPane.sortAriaLabel')}
            onChange={(event) => updateMemory({ sort: event.target.value as MaterialsSort })}
          >
            {SORT_OPTIONS.map(({ id, label }) => <option key={id} value={id}>{t(label)}</option>)}
          </select>
        </label>
      </header>
      {actionError ? <div className="context-room-resource-error" role="alert">{actionError}</div> : null}
      <div className="context-room-materials-list" role="list">
        {visibleRows.map((row) => (
          <div
            className={`context-room-materials-row${row.resource && selectedId === row.resource.id ? ' is-selected' : ''}`}
            key={row.key}
            data-row-type={row.type}
            data-connector-source={row.connectorSource}
          >
            <button
              type="button"
              role="listitem"
              className={`context-room-materials-item${row.resource && selectedId === row.resource.id ? ' is-selected' : ''}${row.unread ? ' is-unread' : ''}`}
              onClick={() => {
                if (row.resource) onSelect(row.resource);
                else if (row.openObject) onOpenObject(row.openObject);
              }}
            >
              <span className="context-room-materials-icon">{rowIcon(row)}</span>
              <span className="context-room-materials-main">
                <b>{row.title}</b>
                <small>{row.subtitle}</small>
              </span>
              <time>{row.timeLabel}</time>
            </button>
            {row.knowledgeFileId && row.resource?.kind === 'knowledge-file' ? (
              <ResourceCorrectionMenu
                room={room}
                rooms={rooms}
                target={{ sourceKind: 'file', sourceId: row.knowledgeFileId, title: row.title }}
              />
            ) : null}
            {row.connectorMail ? (
              <ResourceCorrectionMenu
                room={room}
                rooms={rooms}
                target={{ sourceKind: 'mail', sourceId: row.connectorMail.sourceId, title: row.connectorMail.subject }}
              />
            ) : null}
            {row.document && !row.document.deletedAt ? (
              <Popover.Root
                open={documentToDelete?.id === row.document.id}
                onOpenChange={(open) => {
                  if (!open && deletingDocumentId === row.document?.id) return;
                  setDeleteError(null);
                  setDocumentToDelete(open ? row.document ?? null : null);
                }}
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="context-room-resource-delete"
                    aria-label={t('contextRoom:resource.moveDocumentNameToTrash', { name: row.title })}
                    title={t('contextRoom:resource.moveToTrash')}
                    disabled={deletingDocumentId === row.document.id}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="context-room-document-delete-popover"
                    side="left"
                    align="center"
                    sideOffset={8}
                    collisionPadding={12}
                    aria-label={t('contextRoom:resource.confirmMovingDocumentNameToTrash', { name: row.title })}
                  >
                    <p>{t('contextRoom:resource.confirmMoveToTrash')}</p>
                    <span>{t('contextRoom:resource.nameCanBeRestoredFromTrash', { name: row.title })}</span>
                    {deleteError ? <small role="alert">{deleteError}</small> : null}
                    <footer>
                      <Popover.Close asChild>
                        <button type="button">{t('contextRoom:resource.cancel')}</button>
                      </Popover.Close>
                      <button
                        type="button"
                        className="is-danger"
                        disabled={deletingDocumentId === row.document.id}
                        onClick={() => void confirmDelete(row.document!)}
                      >
                        {t(deletingDocumentId === row.document.id ? 'contextRoom:resource.moving' : 'contextRoom:resource.move')}
                      </button>
                    </footer>
                    <Popover.Arrow className="context-room-document-delete-arrow" />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
            ) : null}
          </div>
        ))}
        {!rows.length ? (
          <PanelEmptyState
            compact
            icon={FileText}
            title={t('contextRoom:materialsPane.noMaterialsYet')}
            description={t('contextRoom:resource.createADocumentOrAddALocalOffice')}
          />
        ) : null}
        {rows.length && !visibleRows.length ? (
          <PanelEmptyState
            compact
            icon={SearchX}
            title={t('contextRoom:resource.noMatchingResources')}
            description={t('contextRoom:resource.tryAnotherSearchTerm')}
          />
        ) : null}
      </div>
      {trashedDocuments.length ? (
        <section className="context-room-materials-trash">
          <button
            type="button"
            className="context-room-materials-trash-toggle"
            aria-expanded={trashOpen}
            onClick={() => setTrashOpen((value) => !value)}
          >
            <Trash2 aria-hidden="true" />
            {t(uiText('回收站'))}
            <span>{trashedDocuments.length}</span>
          </button>
          {trashOpen ? (
            <>
              <Popover.Root
                open={clearTrashPopoverOpen}
                onOpenChange={(nextOpen) => {
                  if (!nextOpen && deletingDocumentId === 'empty-trash') return;
                  setDeleteError(null);
                  setClearTrashPopoverOpen(nextOpen);
                }}
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="context-room-materials-trash-clear"
                    aria-label={t('contextRoom:resource.emptyTrash')}
                    disabled={deletingDocumentId === 'empty-trash'}
                  >
                    {t('contextRoom:resource.emptyTrash')}
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    className="context-room-document-delete-popover"
                    side="top"
                    align="start"
                    sideOffset={8}
                    collisionPadding={12}
                    aria-label={t('contextRoom:resource.confirmEmptyTrash')}
                  >
                    <p>{t('contextRoom:resource.emptyTrashQuestion')}</p>
                    <span>{t('contextRoom:resource.countDocumentsAndTheirVersionHistoryCannotBe', { count: trashedDocuments.length })}</span>
                    {deleteError ? <small role="alert">{deleteError}</small> : null}
                    <footer>
                      <Popover.Close asChild>
                        <button type="button">{t('contextRoom:resource.cancel')}</button>
                      </Popover.Close>
                      <button type="button" className="is-danger" disabled={deletingDocumentId === 'empty-trash'} onClick={() => void clearTrash()}>
                        {t(deletingDocumentId === 'empty-trash' ? 'contextRoom:resource.emptying' : 'contextRoom:resource.clear')}
                      </button>
                    </footer>
                    <Popover.Arrow className="context-room-document-delete-arrow" />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              {trashedDocuments.map((document) => (
                <div className="context-room-materials-row is-trash" key={`trash:${document.id}`}>
                  <div role="listitem" className="context-room-materials-item is-trashed" aria-disabled="true">
                    <span className="context-room-materials-icon"><FileText aria-hidden="true" /></span>
                    <span className="context-room-materials-main">
                      <b>{document.title}</b>
                      <small>{document.deletedAt ? new Date(document.deletedAt).toLocaleDateString(locale) : ''}</small>
                    </span>
                  </div>
                  <div className="context-room-resource-trash-actions">
                    <button
                      type="button"
                      aria-label={t('contextRoom:resource.restoreDocumentName', { name: document.title })}
                      title={t('contextRoom:resource.restoreDocument')}
                      disabled={deletingDocumentId === document.id}
                      onClick={() => void restoreDocument(document)}
                    >
                      <RotateCcw aria-hidden="true" />
                    </button>
                    <Popover.Root
                      open={documentToDeletePermanently?.id === document.id}
                      onOpenChange={(open) => {
                        if (!open && deletingDocumentId === document.id) return;
                        setDeleteError(null);
                        setDocumentToDeletePermanently(open ? document : null);
                      }}
                    >
                      <Popover.Trigger asChild>
                        <button
                          type="button"
                          aria-label={t('contextRoom:resource.permanentlyDeleteDocumentName', { name: document.title })}
                          title={t('contextRoom:resource.deletePermanently')}
                          disabled={deletingDocumentId === document.id}
                        >
                          <Trash2 aria-hidden="true" />
                        </button>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content
                          className="context-room-document-delete-popover"
                          side="top"
                          align="end"
                          sideOffset={8}
                          collisionPadding={12}
                          aria-label={t('contextRoom:resource.confirmPermanentlyDeletingDocumentName', { name: document.title })}
                        >
                          <p>{t('contextRoom:resource.permanentlyDeleteName', { name: document.title })}</p>
                          <span>{t('contextRoom:resource.theContentAndVersionHistoryCannotBeRestored')}</span>
                          {deleteError ? <small role="alert">{deleteError}</small> : null}
                          <footer>
                            <Popover.Close asChild>
                              <button type="button">{t('contextRoom:resource.cancel')}</button>
                            </Popover.Close>
                            <button
                              type="button"
                              className="is-danger"
                              disabled={deletingDocumentId === document.id}
                              onClick={() => void confirmPermanentDelete(document)}
                            >
                              {t(deletingDocumentId === document.id ? 'contextRoom:resource.deleting' : 'contextRoom:resource.deletePermanently')}
                            </button>
                          </footer>
                          <Popover.Arrow className="context-room-document-delete-arrow" />
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  </div>
                </div>
              ))}
            </>
          ) : null}
        </section>
      ) : null}
      {connectorMailDetail ? (
        <ConnectorMailDetailPanel
          state={mailDetailState}
          locale={locale}
          onClose={() => onCloseDetail?.()}
        />
      ) : null}
    </div>
  );
}
