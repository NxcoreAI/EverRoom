import type { RoomDocument } from '@nxcore/agent-contract';
import type { KnowledgeFileDto } from '../../../../../shared/knowledge';
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
    summary: `来自 Everroom PC 文件系统：${file.path}`,
    size: `${String(Math.max(1, Math.round(file.size / 1024)))} KB`,
    source: `文件系统 ${file.path}`,
    lifecycle: '活跃',
    hostfsPath: file.path,
    mimeType: file.mimeType,
  };
}

function previewFor(format: ContextRoomOfficeFormat, title: string, summary: string) {
  if (format === 'xlsx') {
    return {
      title,
      summary,
      columns: ['项目', '负责人', '状态', '更新时间'],
      rows: [
        ['发布材料', '林薇', '进行中', '今天'],
        ['来源追溯', '周明', '待确认', '昨天'],
        ['内测包', '陆远', '计划中', '07-30'],
      ],
    };
  }
  if (format === 'pptx') {
    return {
      title,
      summary,
      slides: [
        { title: '项目目标', body: '围绕当前 Room 汇总目标、范围和交付节点。' },
        { title: '核心进展', body: '资料持续聚合，关键结论保留来源。' },
        { title: '下一步', body: '确认风险项并完成阶段交付。' },
      ],
    };
  }
  if (format === 'pdf') {
    return {
      title,
      summary,
      pages: [
        { title: '摘要', body: summary },
        { title: '关键内容', body: '该文件已建立预览索引，可供 Room 和 Agent 引用。' },
      ],
    };
  }
  if (format === 'fig' || format === 'image') {
    return {
      title,
      summary,
      metadata: [
        { label: '格式', value: format.toUpperCase() },
        { label: '用途', value: '设计与视觉资料' },
        { label: '索引状态', value: '已生成预览数据' },
      ],
    };
  }
  return {
    title,
    summary,
    paragraphs: [
      summary,
      '此内容为当前阶段的确定性预览数据。资源接入后将替换为真实文件解析结果。',
      '资源所属 Room 已写入数据契约，后续服务端查询必须按 Room 进行隔离。',
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
      preview: previewFor(format, item.name, item.summary),
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
    folderId: documentsFolderId,
    name: file.originalName,
    updatedAt: new Date(file.uploadedAt).toLocaleString('zh-CN'),
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
