import type { RoomDocument } from '@nxcore/agent-contract';
import type { KnowledgeFileDto } from '../../../../../shared/knowledge';
import { translate, type AppLocale } from '../../../i18n/LocaleContext';
import type {
  ContextRoomFileItem,
  ContextRoomOfficeFormat,
  ContextRoomRecord,
  ContextRoomResource,
  ContextRoomResourceFolder,
} from './types';
interface FileItem {
  mimeType: string;
  modifiedAt: Date;
  name: string;
  path: string;
  size: number;
}

export interface ContextRoomResourceLibrary {
  folders: ContextRoomResourceFolder[];
  resources: ContextRoomResource[];
}

function supportedLocale(locale: string): AppLocale {
  return locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}

function resourceText(
  locale: string,
  key: string,
  values?: Record<string, string | number>,
): string {
  return translate(supportedLocale(locale), `contextRoom:resourcePreview.${key}`, values);
}

function officeFormat(extension: string): ContextRoomOfficeFormat {
  const value = extension.toLowerCase();
  if (value === 'xlsx' || value === 'csv') return 'xlsx';
  if (value === 'pptx') return 'pptx';
  if (value === 'pdf') return 'pdf';
  if (value === 'md' || value === 'markdown') return 'markdown';
  if (value === 'png' || value === 'jpg' || value === 'jpeg' || value === 'webp') return 'image';
  if (value === 'fig') return 'fig';
  return 'docx';
}

function officeMimeType(format: ContextRoomOfficeFormat) {
  if (format === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (format === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (format === 'pptx') {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (format === 'pdf') return 'application/pdf';
  if (format === 'markdown') return 'text/markdown';
  if (format === 'image') return 'image/*';
  return 'application/octet-stream';
}

export function getContextRoomOfficeFormat(fileName: string): ContextRoomOfficeFormat {
  return officeFormat(fileName.split('.').pop() ?? '');
}

/** knowledge 上传文件按扩展名归夹（md → 云文档；office 类 → Office 文件；图片 → 设计与附件）。 */
function knowledgeFileFolderId(
  originalName: string,
  folders: { documents: string; office: string; design: string },
): string {
  const format = officeFormat(originalName.split('.').pop() ?? '');
  if (format === 'markdown') return folders.documents;
  if (format === 'fig' || format === 'image') return folders.design;
  return folders.office;
}

/** knowledge 文件的归属状态文案（决策 status/decidedBy 派生）。 */
export function knowledgeFileStatusLabel(file: {
  status: string;
  decidedBy: string | null;
}): string {
  if (file.status === 'confirmed') return '已沉淀';
  if (file.status === 'auto') return file.decidedBy === 'user' ? '用户确认·入库中' : '归类中';
  if (file.status === 'reverted') return '已撤销';
  return '处理中';
}

/** 体积文案（B/KB/MB 一位小数）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createContextRoomFileItem(file: FileItem, locale = 'zh-CN'): ContextRoomFileItem {
  return {
    id: `hostfs:${file.path}`,
    name: file.name,
    extension: file.name.split('.').pop()?.toUpperCase() ?? 'FILE',
    time: file.modifiedAt.toLocaleDateString(locale),
    summary: resourceText(locale, 'fileSystemSummary', { path: file.path }),
    size: `${String(Math.max(1, Math.round(file.size / 1024)))} KB`,
    source: resourceText(locale, 'fileSystemSource', { path: file.path }),
    lifecycle: '活跃',
    hostfsPath: file.path,
    mimeType: file.mimeType,
  };
}

function previewFor(format: ContextRoomOfficeFormat, title: string, summary: string, locale: string) {
  if (format === 'xlsx') {
    return {
      title,
      summary,
      columns: [
        resourceText(locale, 'columnItem'),
        resourceText(locale, 'columnOwner'),
        resourceText(locale, 'columnStatus'),
        resourceText(locale, 'columnUpdatedAt'),
      ],
      rows: [
        [resourceText(locale, 'releaseMaterials'), resourceText(locale, 'ownerLinWei'), resourceText(locale, 'inProgress'), resourceText(locale, 'today')],
        [resourceText(locale, 'sourceTraceability'), resourceText(locale, 'ownerZhouMing'), resourceText(locale, 'pendingConfirmation'), resourceText(locale, 'yesterday')],
        [resourceText(locale, 'betaPackage'), resourceText(locale, 'ownerLuYuan'), resourceText(locale, 'planned'), '07-30'],
      ],
    };
  }
  if (format === 'pptx') {
    return {
      title,
      summary,
      slides: [
        { title: resourceText(locale, 'projectGoal'), body: resourceText(locale, 'projectGoalBody') },
        { title: resourceText(locale, 'coreProgress'), body: resourceText(locale, 'coreProgressBody') },
        { title: resourceText(locale, 'nextSteps'), body: resourceText(locale, 'nextStepsBody') },
      ],
    };
  }
  if (format === 'pdf') {
    return {
      title,
      summary,
      pages: [
        { title: resourceText(locale, 'summary'), body: summary },
        { title: resourceText(locale, 'keyContent'), body: resourceText(locale, 'keyContentBody') },
      ],
    };
  }
  if (format === 'fig' || format === 'image') {
    return {
      title,
      summary,
      metadata: [
        { label: resourceText(locale, 'format'), value: format.toUpperCase() },
        { label: resourceText(locale, 'purpose'), value: resourceText(locale, 'designAndVisualMaterials') },
        { label: resourceText(locale, 'indexStatus'), value: resourceText(locale, 'previewDataGenerated') },
      ],
    };
  }
  return {
    title,
    summary,
    paragraphs: [
      summary,
      resourceText(locale, 'previewPlaceholderBody'),
      resourceText(locale, 'roomIsolationBody'),
    ],
  };
}

export function createContextRoomResourceLibrary(
  room: ContextRoomRecord,
  backendDocuments: RoomDocument[] = [],
  trashedDocuments: RoomDocument[] = [],
  knowledgeFilesOrLocale: KnowledgeFileDto[] | string = [],
  locale = 'zh-CN',
): ContextRoomResourceLibrary {
  const knowledgeFiles = Array.isArray(knowledgeFilesOrLocale) ? knowledgeFilesOrLocale : [];
  const resolvedLocale = typeof knowledgeFilesOrLocale === 'string' ? knowledgeFilesOrLocale : locale;
  const documentsFolderId = `${room.id}:folder:documents`;
  const officeFolderId = `${room.id}:folder:office`;
  const designFolderId = `${room.id}:folder:design`;
  const trashFolderId = `${room.id}:folder:trash`;
  const folders: ContextRoomResourceFolder[] = [
    { id: documentsFolderId, roomId: room.id, parentId: null, name: '云文档' },
    { id: officeFolderId, roomId: room.id, parentId: null, name: 'Office 文件' },
    { id: designFolderId, roomId: room.id, parentId: null, name: '设计与附件' },
    { id: trashFolderId, roomId: room.id, parentId: null, name: '回收站' },
  ];

  const fileResources: ContextRoomResource[] = room.fileItems.map((item) => {
    const format = officeFormat(item.extension);
    return {
      id: `${room.id}:file:${item.id}`,
      roomId: room.id,
      folderId: format === 'fig' || format === 'image' ? designFolderId : officeFolderId,
      name: item.name,
      updatedAt: item.time,
      kind: 'office-file',
      format,
      preview: previewFor(format, item.name, item.summary, resolvedLocale),
      source: item.hostfsPath
        ? {
            type: 'hostfs',
            path: item.hostfsPath,
            mimeType: item.mimeType || officeMimeType(format),
          }
        : undefined,
    };
  });

  const backendResources: ContextRoomResource[] = backendDocuments.map((document) => ({
    id: `${room.id}:cloud:${document.id}`,
    roomId: room.id,
    folderId: documentsFolderId,
    name: document.title,
    updatedAt: new Date(document.updatedAt).toLocaleString(resolvedLocale),
    kind: 'cloud-doc',
    binding: {
      workspaceId: 'gateway',
      docId: document.id,
      title: document.title,
    },
    version: document.version > 0 ? `V${String(document.version)}.0` : '草稿',
    saveState: document.status === 'draft' ? 'Agent 正在写入' : '已保存',
  }));
  const trashResources: ContextRoomResource[] = trashedDocuments.map((document) => ({
    id: `${room.id}:trash:${document.id}`,
    roomId: room.id,
    folderId: trashFolderId,
    name: document.title,
    updatedAt: document.deletedAt
      ? new Date(document.deletedAt).toLocaleString(resolvedLocale)
      : new Date(document.updatedAt).toLocaleString(resolvedLocale),
    kind: 'cloud-doc',
    binding: {
      workspaceId: 'gateway',
      docId: document.id,
      title: document.title,
    },
    version: document.version > 0 ? `V${String(document.version)}.0` : '草稿',
    saveState: '回收站',
    trashed: true,
  }));
  const knowledgeFileResources: ContextRoomResource[] = knowledgeFiles.map((file) => ({
    id: `${room.id}:kfile:${file.id}`,
    roomId: room.id,
    // 按扩展名归夹：md 与云文档同列；office 类（docx/xlsx/pptx/pdf/csv 等）
    // 进 Office 文件；图片/设计稿进设计与附件——与本地 fileItems 规则一致
    folderId: knowledgeFileFolderId(file.originalName, {
      documents: documentsFolderId,
      office: officeFolderId,
      design: designFolderId,
    }),
    name: file.originalName,
    updatedAt: new Date(file.uploadedAt).toLocaleString(resolvedLocale),
    kind: 'knowledge-file' as const,
    fileId: file.id,
    originalName: file.originalName,
    bytes: file.bytes,
    uploadedAt: file.uploadedAt,
    statusLabel: knowledgeFileStatusLabel(file),
    sizeLabel: formatBytes(file.bytes),
  }));
  return {
    folders,
    resources: [...backendResources, ...knowledgeFileResources, ...fileResources, ...trashResources],
  };
}

export function getRoomResource(
  library: ContextRoomResourceLibrary,
  roomId: string,
  resourceId: string
) {
  return library.resources.find(
    (resource) => resource.id === resourceId && resource.roomId === roomId
  );
}
