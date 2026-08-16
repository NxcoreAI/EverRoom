import type { LucideIcon } from 'lucide-react';

export interface CloudDocBinding {
  workspaceId: string;
  docId: string;
  title?: string;
  selectionStart?: number;
  selectionEnd?: number;
}

export type ContextRoomKind = '人物' | '项目' | '主题' | '长期目标' | '议题' | '事件';
export type ContextRoomTone = 'sky' | 'emerald' | 'amber' | 'rose' | 'zinc';
export type ContextRoomRecommendationStatus = 'later' | 'ignored' | 'created';
export type ViewState =
  | { name: 'home' }
  | {
      name: 'documents';
      roomId: string;
      immersive?: boolean;
      returnTo?: 'detail' | 'home';
    }
  | { name: 'graph'; roomId: string }
  | {
      name: 'detail';
      roomId: string;
      bindingOverride?: CloudDocBinding & { blockId?: string };
      resourceId?: string;
    }
  | { name: 'file-detail'; roomId: string; fileId: string }
  | { name: 'task-detail'; roomId: string; taskId: string }
  | { name: 'mail-detail'; roomId: string; mailId: string }
  | { name: 'meeting-detail'; roomId: string; meetingId: string }
  | { name: 'material-detail'; roomId: string; materialId: string }
  | { name: 'memory-detail'; roomId: string; memoryId: string }
  | {
      name: 'editor';
      roomId: string;
      bindingOverride?: CloudDocBinding & { blockId?: string };
      immersive?: boolean;
    };

export interface ContextRoomBrief {
  background: string;
  goal: string;
  status: string;
  risks: string[];
  decisions: string[];
}

export interface ContextRoomStats {
  docs: number;
  mails: number;
  meetings: number;
  events: number;
  memories: number;
  tasks: number;
}

export interface ContextRoomPerson {
  name: string;
  role: string;
  avatar: string;
}

export interface ContextRoomTimelineItem {
  time: string;
  title: string;
  description: string;
  kind: 'done' | 'warn' | 'info';
}

export interface ContextRoomMaterial {
  id: string;
  type: '文档' | '邮件' | '会议';
  title: string;
  time: string;
  summary: string;
  version?: string;
  status?: string;
  sourceState?: string;
  attendees?: string[];
  duration?: string;
  location?: string;
  transcript?: Array<{ time: string; speaker: string; text: string }>;
  meetingActions?: Array<{ id: string; title: string; owner: string; confirmed?: boolean }>;
  body?: string;
  folder?: 'inbox' | 'starred' | 'sent' | 'archive';
  starred?: boolean;
  unread?: boolean;
  sender?: string;
  recipient?: string;
  attachments?: Array<{ name: string; size?: string }>;
  replyDraft?: string;
  draftSaved?: boolean;
  sent?: boolean;
}

export interface ContextRoomActionItem {
  id: string;
  title: string;
  status: string;
  owner: string;
  deadline: string;
  completed?: boolean;
  source?: { type: string; name: string; objectId?: string };
}

export interface ContextRoomGraphEdge {
  from: string;
  to: string;
  relation: string;
}

export interface ContextRoomPendingMemory {
  id: string;
  content: string;
  type: string;
}

export interface ContextRoomMemoryItem {
  id: string;
  content: string;
  type: string;
  status: string;
  sources?: Array<{ type: string; name: string }>;
}

export interface ContextRoomFileItem {
  id: string;
  name: string;
  extension: string;
  time: string;
  summary: string;
  size?: string;
  source?: string;
  lifecycle?: '活跃' | '已归档' | '回收站';
  hostfsPath?: string;
  mimeType?: string;
}

export interface ContextRoomRecommendationSource {
  type: '邮件' | '会议' | '文件';
  name: string;
  roomId?: string;
  objectId?: string;
}

export interface ContextRoomRecommendation {
  id: string;
  name: string;
  kind: '议题' | '事件';
  reason: string;
  dataCount: number;
  triggered: string;
  confidence: string;
  anchorEntity?: { name: string; type: string; description: string };
  factCount?: number;
  sources: ContextRoomRecommendationSource[];
}

export interface ContextRoomResourceFolder {
  id: string;
  roomId: string;
  parentId: string | null;
  name: string;
}

interface ContextRoomResourceBase {
  id: string;
  roomId: string;
  folderId: string | null;
  name: string;
  updatedAt: string;
}

export interface ContextRoomCloudDocResource extends ContextRoomResourceBase {
  kind: 'cloud-doc';
  binding: CloudDocBinding;
  version: string;
  saveState: string;
}

export type ContextRoomOfficeFormat =
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'
  | 'markdown'
  | 'image'
  | 'fig';

export interface ContextRoomOfficePreview {
  title: string;
  summary: string;
  paragraphs?: string[];
  columns?: string[];
  rows?: string[][];
  slides?: Array<{ title: string; body: string }>;
  pages?: Array<{ title: string; body: string }>;
  metadata?: Array<{ label: string; value: string }>;
}

export interface ContextRoomOfficeResource extends ContextRoomResourceBase {
  kind: 'office-file';
  format: ContextRoomOfficeFormat;
  preview: ContextRoomOfficePreview;
  source?: {
    type: 'hostfs';
    path: string;
    mimeType: string;
  };
}

export type ContextRoomResource = ContextRoomCloudDocResource | ContextRoomOfficeResource;

export interface ContextRoomRecord {
  id: string;
  title: string;
  kind: ContextRoomKind;
  icon: string;
  tone: ContextRoomTone;
  status: string;
  starred: boolean;
  lastViewed: string;
  roomCode: string;
  /** gateway 注册表来源（room-wiki 方案）：auto = 路由层自动创建（打开即认领翻转为 user）。 */
  origin?: 'user' | 'auto';
  brief: ContextRoomBrief;
  stats: ContextRoomStats;
  riskCount: number;
  pendingMemoryCount: number;
  people: ContextRoomPerson[];
  timeline: ContextRoomTimelineItem[];
  materials: ContextRoomMaterial[];
  actionItems: ContextRoomActionItem[];
  graphEdges: ContextRoomGraphEdge[];
  pendingMemoryItems: ContextRoomPendingMemory[];
  memoryItems: ContextRoomMemoryItem[];
  fileItems: ContextRoomFileItem[];
  recentSource?: { type: string; name: string };
  crossHint?: string;
  nextReverseRecall: string;
  cloudDoc: CloudDocBinding;
}

export interface ToolbarAction {
  label: string;
  icon: LucideIcon;
  isActive?: boolean;
  onSelect: () => void;
}
