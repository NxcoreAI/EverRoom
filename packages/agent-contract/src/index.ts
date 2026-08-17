export const AGENT_PROTOCOL_VERSION = 1 as const;

export type AgentSessionStatus = "idle" | "running" | "interrupted" | "closed";
export type AgentRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type AgentMessageRole = "user" | "assistant" | "system";

export type AgentEventType =
  | "session.created"
  | "run.accepted"
  | "run.started"
  | "message.started"
  | "message.delta"
  | "reasoning.delta"
  | "message.completed"
  | "tool.requested"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.resolved"
  | "context.updated"
  | "run.interrupted"
  | "run.failed"
  | "run.cancelled"
  | "run.completed";

export interface AgentSession {
  id: string;
  roomId: string | null;
  pageLabel: string;
  runtimeId: string;
  title: string | null;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  prompt: string;
  lastEventSeq: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AgentMessage {
  id: string;
  sessionId: string;
  runId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
}

export interface AgentEvent<T = unknown> {
  id: string;
  sessionId: string;
  runId: string;
  seq: number;
  type: AgentEventType;
  occurredAt: string;
  payload: T;
}

export interface RuntimeCapabilities {
  streaming: boolean;
  reasoning: boolean;
  tools: boolean;
  steering: boolean;
  resume: boolean;
}

export interface CreateAgentSessionInput {
  pageLabel: string;
  roomId?: string | null;
}

export interface UpdateAgentSessionInput {
  title: string;
}

export type AgentNavigationAction = "created" | "updated" | "opened" | "referenced";
export type AgentNavigationObjectType = "room" | "document" | "source" | "memory" | "task" | "diary";

export interface AgentNavigationTarget {
  pageId: string;
  title: string;
  action: AgentNavigationAction;
  roomId?: string | null;
  objectId?: string;
  objectType?: AgentNavigationObjectType;
  blockId?: string;
}

export interface CreateAgentSessionLinkInput {
  sourceSessionId: string;
  targetSessionId: string;
  sourceRunId: string;
  sourcePageId: string;
  sourcePageLabel: string;
  sourceRoomId?: string | null;
  target: AgentNavigationTarget;
}

export interface AgentSessionLink extends CreateAgentSessionLinkInput {
  id: string;
  createdAt: string;
  returnedAt: string | null;
}

export interface AgentRoomReference {
  id: string;
  title: string;
  kind?: string;
}

export interface ContextRoomSnapshotItem extends AgentRoomReference {
  data: Record<string, unknown>;
}

export interface ContextRoomSnapshot {
  rooms: ContextRoomSnapshotItem[];
  deletedRooms: ContextRoomSnapshotItem[];
  updatedAt: string | null;
}

export interface SaveContextRoomSnapshotInput {
  rooms: ContextRoomSnapshotItem[];
  deletedRooms: ContextRoomSnapshotItem[];
}

export interface StartAgentRunInput {
  prompt: string;
  idempotencyKey: string;
  /** Defaults to true. Temporary preview runs can defer capture until user confirmation. */
  captureMemory?: boolean;
  context?: {
    selectedText?: string;
    /** Current, non-deleted Rooms visible to the desktop when this run starts. */
    rooms?: AgentRoomReference[];
    /** Explicit UI-confirmed target for a global Agent session. */
    selectedRoomId?: string | null;
    activeDocument?: AgentActiveDocumentContext;
  };
}

export interface AgentDocumentCursorAnchor {
  blockId: string;
  /** UTF-16 offset into the block's text content. */
  offset: number;
  affinity: "after";
}

export interface AgentActiveDocumentContext {
  roomId: string;
  documentId: string;
  title: string;
  version: number;
  defaultAnchor: "end";
  cursorAnchorCandidate?: AgentDocumentCursorAnchor;
}

export interface TiptapJsonContent {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapJsonContent[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

export interface RoomDocument {
  id: string;
  roomId: string;
  title: string;
  contentJson: TiptapJsonContent;
  version: number;
  status: "draft" | "active";
  activeTransactionId: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentBlockSummary {
  id: string;
  documentId: string;
  roomId: string;
  parentBlockId: string | null;
  type: string;
  ordinal: number;
  path: number[];
  textPreview: string;
}

export interface DocumentBlockList {
  documentId: string;
  roomId: string;
  version: number;
  blocks: DocumentBlockSummary[];
}

export type DocumentBlockResolutionStatus =
  | "available"
  | "document_trashed"
  | "document_deleted"
  | "block_missing"
  | "room_unavailable";

export interface DocumentBlockReferenceInput {
  roomId: string;
  documentId: string;
  blockId: string;
}

export interface ResolveDocumentBlockReferencesInput {
  sourceRoomId: string;
  references: DocumentBlockReferenceInput[];
}

export interface DocumentBlockResolution extends DocumentBlockReferenceInput {
  status: DocumentBlockResolutionStatus;
  title: string | null;
  textPreview: string | null;
  version: number | null;
}

export interface ResolveDocumentBlockReferencesResult {
  resolutions: DocumentBlockResolution[];
}

export type DocumentPatchKind = "continue" | "edit";
export type DocumentPatchStatus =
  | "building"
  | "pending"
  | "applied"
  | "rejected"
  | "conflicted"
  | "aborted"
  | "expired";
export type DocumentPatchOperation = "insert" | "replace" | "delete";

export type DocumentPatchTarget =
  | { at: "end" }
  | { blockId: string; edge: "before" | "after" }
  | { blockId: string; fromOffset?: number; toOffset?: number }
  | { fromBlockId: string; toBlockId: string };

export interface DocumentPatchHunk {
  id: string;
  sequence: number;
  operation: DocumentPatchOperation;
  target: DocumentPatchTarget;
  markdown: string;
  before: TiptapJsonContent[];
  after: TiptapJsonContent[];
  addedCharacters: number;
  deletedCharacters: number;
}

export interface DocumentContinuationBlock {
  blockId: string;
  sequence: number;
  hunkId: string;
  target: DocumentPatchTarget;
  contentJson: TiptapJsonContent;
  textPreview: string;
  addedCharacters: number;
}

export interface DocumentPatchSummary {
  id: string;
  roomId: string;
  documentId: string;
  documentTitle: string;
  baseVersion: number;
  sessionId: string;
  runId: string;
  kind: DocumentPatchKind;
  status: DocumentPatchStatus;
  summary: string;
  hunkCount: number;
  addedCharacters: number;
  deletedCharacters: number;
  acceptedHunkIds: string[];
  rejectedHunkIds: string[];
  acceptedBlockIds: string[];
  rejectedBlockIds: string[];
  appliedVersion: number | null;
  conflictVersion: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentPatch extends DocumentPatchSummary {
  baseContentJson: TiptapJsonContent;
  proposedContentJson: TiptapJsonContent;
  hunks: DocumentPatchHunk[];
  continuationBlocks: DocumentContinuationBlock[];
  nextPendingBlock: DocumentContinuationBlock | null;
}

export interface CreateDocumentPatchInput {
  documentId: string;
  baseVersion: number;
  kind: DocumentPatchKind;
  summary: string;
}

export interface AppendDocumentPatchHunkInput {
  patchId: string;
  sequence: number;
  operation: DocumentPatchOperation;
  target: DocumentPatchTarget;
  markdown?: string;
}

export interface ApplyDocumentPatchInput {
  baseVersion: number;
  acceptedHunkIds: string[];
}

export interface ApplyDocumentPatchResult {
  patch: DocumentPatch;
  document: RoomDocument;
}

export interface AcceptDocumentContinuationBlockInput {
  /** The authoritative document version currently shown by the editor. */
  baseVersion: number;
  blockId: string;
}

export interface AcceptDocumentContinuationBlockResult {
  patch: DocumentPatch;
  document: RoomDocument;
  nextPendingBlock: DocumentContinuationBlock | null;
}

export interface RejectDocumentContinuationBlockInput {
  /** The authoritative document version currently shown by the editor. */
  baseVersion: number;
  blockId: string;
}

export interface RejectDocumentContinuationBlockResult {
  patch: DocumentPatch;
  nextPendingBlock: DocumentContinuationBlock | null;
}

export type DocumentEventType =
  | "document.opened"
  | "document.appended"
  | "document.commit-requested"
  | "document.committed"
  | "document.aborted"
  | "document.trashed"
  | "document.restored"
  | "document.deleted"
  | "document.updated"
  | "document.patch-building"
  | "document.patch-prepared"
  | "document.patch-continuation-advanced"
  | "document.patch-applied"
  | "document.patch-rejected"
  | "document.patch-conflicted"
  | "document.patch-aborted"
  | "document.patch-expired";

export interface DocumentEvent<T = unknown> {
  id: string;
  roomId: string;
  documentId: string;
  transactionId: string | null;
  type: DocumentEventType;
  occurredAt: string;
  payload: T;
}

export interface DocumentSnapshotEventPayload {
  document: RoomDocument;
}

export interface DocumentAppendedEventPayload extends DocumentSnapshotEventPayload {
  sequence: number;
  text: string;
}

export interface DocumentCommitRequestedEventPayload extends DocumentSnapshotEventPayload {
  finalSequence: number;
}

export interface DocumentEventFrame {
  type: "document.event";
  protocol: 1;
  event: DocumentEvent;
}

export interface ImportRoomDocumentInput {
  id: string;
  roomId: string;
  title: string;
  contentJson: TiptapJsonContent;
}

export interface SaveRoomDocumentInput {
  baseVersion: number;
  title?: string;
  contentJson: TiptapJsonContent;
}

export interface AcknowledgeDocumentTransactionInput {
  sequence: number;
  contentJson: TiptapJsonContent;
}

export interface AgentSessionSnapshot {
  session: AgentSession;
  activeRun: AgentRun | null;
  messages: AgentMessage[];
  lastEventSeq: number;
}

export interface AgentEventFrame {
  type: "event";
  protocol: typeof AGENT_PROTOCOL_VERSION;
  event: AgentEvent;
}

export interface AgentReadyFrame {
  type: "ready";
  protocol: typeof AGENT_PROTOCOL_VERSION;
  sessionId: string;
  lastEventSeq: number;
}

export type AgentSocketFrame = AgentReadyFrame | AgentEventFrame;

export function isAgentSocketFrame(value: unknown): value is AgentSocketFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<AgentSocketFrame>;
  if (frame.protocol !== AGENT_PROTOCOL_VERSION) return false;
  if (frame.type === "ready") {
    return typeof frame.sessionId === "string" && Number.isInteger(frame.lastEventSeq);
  }
  if (frame.type !== "event" || !frame.event || typeof frame.event !== "object") return false;
  const event = frame.event as Partial<AgentEvent>;
  return (
    typeof event.id === "string" &&
    typeof event.sessionId === "string" &&
    typeof event.runId === "string" &&
    Number.isInteger(event.seq) &&
    typeof event.type === "string" &&
    typeof event.occurredAt === "string"
  );
}
