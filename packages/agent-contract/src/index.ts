export const AGENT_PROTOCOL_VERSION = 1 as const;
export const MAIN_AGENT_ID = "main" as const;

export type AgentSessionStatus = "idle" | "running" | "interrupted" | "closed";
export type AgentRunStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";
export type AgentMessageRole = "user" | "assistant" | "system";

export type AgentUsageRange = "24h" | "7d" | "30d";

export interface AgentUsagePoint {
  startAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentUsageSnapshot {
  provider: string;
  model: string;
  range: AgentUsageRange;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  points: AgentUsagePoint[];
  updatedAt: string;
}

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
  | "runtime.session.updated"
  | "run.interrupted"
  | "run.failed"
  | "run.cancelled"
  | "run.completed";

export interface AgentSession {
  id: string;
  /** Legacy metadata; user sessions are not Room-scoped. */
  roomId: string | null;
  /** Last/creation UI surface, never a session partition key. */
  pageLabel: string;
  runtimeId: string;
  /** Agent that receives unmentioned user turns in this visible conversation. */
  activeAgentId?: string;
  title: string | null;
  status: AgentSessionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  agentId?: string;
  invocationMode?: AgentInvocationMode;
  /** Explicit per-run Room attribution; sessions can span multiple Rooms. */
  roomId?: string | null;
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
  /** Present for Agent-authored messages; user messages intentionally have no Agent author. */
  authorAgentId?: string | null;
  content: string;
  createdAt: string;
}

export interface AgentSessionParticipant {
  sessionId: string;
  agentId: string;
  runtimeId: string;
  runtimeSessionRef: string | null;
  lastSeenAt: string | null;
  workspaceRoot: string | null;
  permissionProfile: AgentWorkspacePermissionProfile;
  createdAt: string;
  updatedAt: string;
}

export type AgentAttachmentKind = "document" | "image";

export interface AgentAttachmentReference {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: AgentAttachmentKind;
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

export type AgentWorkspaceState = "idle" | "running" | "error";
export type AgentWorkspaceRunStatus =
  | AgentRunStatus
  | SubagentInvocationStatus;

export interface AgentWorkspaceRunSummary {
  id: string;
  task: string;
  pageLabel: string | null;
  status: AgentWorkspaceRunStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AgentWorkspaceStatus {
  agentId: string;
  name: string;
  description: string;
  kind: "builtin" | "developer";
  state: AgentWorkspaceState;
  activeRunCount: number;
  workspace: {
    id: string;
    isolation: "dedicated";
    revisionId: string | null;
  };
  currentRun: AgentWorkspaceRunSummary | null;
  lastRun: AgentWorkspaceRunSummary | null;
  updatedAt: string | null;
}

export interface AgentStatusSnapshot {
  generatedAt: string;
  summary: {
    total: number;
    running: number;
    idle: number;
    error: number;
  };
  agents: AgentWorkspaceStatus[];
}

export type SubagentInvocationSource = "primary_agent" | "scheduler" | "internal_workflow";
export type SubagentInvocationStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "timed_out";

export interface SubagentDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  currentRevisionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubagentRevision {
  id: string;
  agentDefinitionId: string;
  version: number;
  digest: string;
  createdAt: string;
}

export interface SubagentInvocationResult {
  text: string;
  structuredOutput?: unknown;
}

export interface SubagentInvocation {
  id: string;
  agentDefinitionId: string;
  agentRevisionId: string;
  source: SubagentInvocationSource;
  parentSessionId: string | null;
  parentRunId: string | null;
  task: string;
  input: unknown;
  status: SubagentInvocationStatus;
  result: SubagentInvocationResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface SubagentInvocationEvent {
  id: string;
  invocationId: string;
  seq: number;
  type: AgentEventType;
  payload: unknown;
  occurredAt: string;
}

export interface CreateAgentSessionInput {
  pageLabel: string;
  /** Legacy input accepted for compatibility; ignored for user sessions. */
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
  /** User-authored Room background, kept concise for Agent context. */
  background?: string;
  /** User-authored outcome or purpose for the Room. */
  goal?: string;
  /** Current Room status summary. */
  status?: string;
  /** Generated, read-only details derived from the Room's current source documents. */
  contextSummary?: {
    generatedAt?: string;
    overview: string;
    nextSteps: string[];
    entities: Array<{ name: string; kind: string; description: string }>;
    actionItems: Array<{ title: string; owner: string | null; dueDate: string | null; sourceTitle: string }>;
    meetings: Array<{ title: string; when: string; participants: string[]; sourceTitle: string }>;
    sourceDocuments: Array<{ documentId: string; title: string; version: number; updatedAt: string }>;
  };
}

export interface ContextRoomSnapshotItem extends AgentRoomReference {
  data: Record<string, unknown>;
  lifecycle?: "active" | "merging" | "merged";
  mergedIntoRoomId?: string | null;
}

export interface ContextRoomSnapshot {
  rooms: ContextRoomSnapshotItem[];
  deletedRooms: ContextRoomSnapshotItem[];
  updatedAt: string | null;
  /** 待处理合并候选数（红点口径：open 且 high/medium/pending）；无重复检测服务时缺省。 */
  duplicateOpenCount?: number;
}

export interface SaveContextRoomSnapshotInput {
  rooms: ContextRoomSnapshotItem[];
  deletedRooms: ContextRoomSnapshotItem[];
}

export interface CreateContextRoomInput {
  title: string;
  description: string;
  duplicateOverrideToken?: string;
}

export interface CreateContextRoomResult {
  room: ContextRoomSnapshotItem;
  created: boolean;
}

export type RoomAppliedEntityStatus =
  | "weak"
  | "ready"
  | "promoting"
  | "room"
  | "archived"
  | "suppressed";

/** Room 关联的应用实体：room_entity_mentions 按实体聚合 + entities 实时状态。 */
export interface RoomAppliedEntity {
  entityId: string;
  name: string;
  kind: string;
  status: RoomAppliedEntityStatus;
  summary: string | null;
  aliases: string[];
  /** 实体晋升后回填的 rooms.id（未晋升为 null）。 */
  linkedRoomId: string | null;
  /** Room 内提及该实体的来源数（sourceKind + sourceId 去重）。 */
  mentionCount: number;
  sourceKinds: string[];
  /** Room 内最大显著度（0-1）。 */
  salience: number;
  lastMentionAt: string | null;
  evidence: string | null;
  /** 来源提及明细（每来源一条），最新在前，最多 8 条。 */
  sources: RoomAppliedEntitySource[];
}

/** 实体在某来源资料中的一次提及（来源归属 + 证据句 + 时间）。 */
export interface RoomAppliedEntitySource {
  sourceKind: string;
  sourceId: string;
  /** 来源资料标题（room_source_memberships 冗余标题，可能为 null）。 */
  sourceTitle: string | null;
  evidence: string | null;
  /** 该来源最近一次提及时间。 */
  mentionedAt: string;
}

/** Room 事实记忆：room_entity_facts 按 factId 跨来源聚合去重（PRD CR-014）。 */
export interface RoomAppliedFact {
  /** 内容指纹（sha256 前 20 位），同内容跨来源同 id。
   * type: 事实类型（属性 = 单实体性质；关系 = 实体间关系）。 */
  factId: string;
  content: string;
  type: "属性" | "关系";
  /** 事实涉及的实体 id（解析不到实体的为空数组 → 图谱连根节点）。 */
  entityIds: string[];
  /** 涉及实体名（与 entityIds 对齐；实体被清理时可能短于 entityIds）。 */
  entityNames: string[];
  /** 陈述该事实的来源数。 */
  sourceCount: number;
  lastMentionAt: string | null;
  /** 来源明细，最新在前，最多 8 条。 */
  sources: RoomAppliedEntitySource[];
}

export interface RoomAppliedEntitiesResult {
  roomId: string;
  entities: RoomAppliedEntity[];
  /** Room 记忆图谱的事实节点数据（与实体同端点一次返回）。 */
  facts: RoomAppliedFact[];
  updatedAt: string;
}

export type RoomOverviewSection =
  | "overview"
  | "status"
  | "next_steps"
  | "timeline"
  | "entities";

export type RoomContextCorrectionOperation =
  | "content_replace"
  | "content_add"
  | "content_suppress"
  | "fact_correct"
  | "fact_add"
  | "source_remove"
  | "source_reassign";

export type RoomContextCorrectionStatus = "proposed" | "applied" | "revoked";

export interface RoomOverviewEvidence {
  sourceKind: string;
  sourceId: string;
  sourceTitle: string | null;
  /** 支撑 claim 的原文片段；不存在可定位片段时为 null。 */
  excerpt?: string | null;
  /** 该证据在来源中被观察到的时间。 */
  observedAt?: string | null;
  sourceVersion?: number | null;
}

export type RoomOverviewClaimData =
  | {
      kind: "overview";
      aspect: "summary" | "background" | "goal";
    }
  | {
      kind: "status";
      category: "conclusion" | "progress" | "problem" | "blocker";
      state: "active" | "resolved" | "unknown";
    }
  | {
      kind: "next_step";
      itemType: "schedule" | "task" | "suggestion";
      actionId: string | null;
      owner: string | null;
      dueAt: string | null;
      status: string | null;
      priority: "high" | "medium" | "low" | null;
      /** itemType=schedule 时的日历服务商 slug（连接器事件）；本地日程与其他 itemType 为 null——桌面打品牌图标。 */
      provider?: string | null;
    }
  | {
      kind: "timeline";
      eventType: "source" | "fact" | "meeting" | "task" | "decision" | "milestone" | "update" | "other";
      title: string;
      description: string | null;
      certainty: "fact" | "inference";
      /** 日历/待办时间轴事件的服务商 slug（域表 service 列，如 google_calendar）；本地日程与其他事件源为 null——桌面据此打品牌图标。 */
      provider?: string | null;
    }
  | {
      kind: "entity";
      entityId: string;
      entityKind: string;
      entityStatus: RoomAppliedEntityStatus;
      linkedRoomId: string | null;
      salience: number;
      mentionCount: number;
    };

export interface RoomOverviewClaim {
  id: string;
  section: RoomOverviewSection;
  text: string;
  origin: "fact" | "inference" | "user";
  confidence: number | null;
  evidence: RoomOverviewEvidence[];
  corrected: boolean;
  occurredAt?: string | null;
  /** 区块专属的机器可读数据。缺省表示由旧版投影读取。 */
  data?: RoomOverviewClaimData;
}

export interface RoomOverviewFreshness {
  state: "fresh" | "stale";
  /** 所有参与投影的事实、资料和 Room 数据中的最新时间。 */
  sourceUpdatedAt: string | null;
  generatedAt: string;
  staleSince: string | null;
  /** 需要语义重新生成的区块；事实型时间轴、实体和待办可先增量更新。 */
  staleSections?: RoomOverviewSection[];
}

export interface RoomOverviewProjection {
  roomId: string;
  revision: number;
  generatedAt: string;
  stale: boolean;
  freshness?: RoomOverviewFreshness;
  overview: RoomOverviewClaim[];
  status: RoomOverviewClaim[];
  nextSteps: RoomOverviewClaim[];
  timeline: RoomOverviewClaim[];
  entities: RoomOverviewClaim[];
  appliedCorrectionIds: string[];
}

/** Room 邮箱面板的连接器邮件条目（GET /v1/context-rooms/:roomId/mails，sentAt 倒序）。 */
export interface RoomMail {
  sourceId: string;
  subject: string;
  senderName: string | null;
  senderAddress: string | null;
  /** ISO 时间；路由快照回退解析不到时为 null。 */
  sentAt: string | null;
  /** 正文首 200 字摘要。 */
  snippet: string | null;
  hasAttachments: boolean;
  /** 邮箱服务商 slug（gmail/outlook…；域行取 service 列，快照回退从 sourceId 解析；解析不到为 null，前端回退通用邮件图标）。 */
  provider?: string | null;
}

/** 单封连接器邮件详情（邮件面板下半区）：正文来自域行 bodyText 或路由快照 markdown。 */
export interface RoomMailDetail {
  sourceId: string;
  subject: string;
  senderName: string | null;
  senderAddress: string | null;
  sentAt: string | null;
  hasAttachments: boolean;
  provider: string | null;
  /** domain = 连接器域行；snapshot = 路由快照兜底（发件地址/附件不可用）。 */
  origin: "domain" | "snapshot";
  /** 完整正文（网关截断 60K 字符）。 */
  body: string;
}

export interface RoomContextCorrection {
  id: string;
  roomId: string;
  operation: RoomContextCorrectionOperation;
  section: RoomOverviewSection;
  targetClaimId: string | null;
  targetSource?: RoomOverviewEvidence | null;
  targetRoomId?: string | null;
  originalText: string | null;
  replacementText: string | null;
  rationale: string;
  status: RoomContextCorrectionStatus;
  entryPoint: "overview" | "section" | "agent";
  sessionId: string | null;
  createdAt: string;
  appliedAt: string | null;
  revokedAt: string | null;
}

export interface ProposeRoomContextCorrectionInput {
  operation: RoomContextCorrectionOperation;
  section: RoomOverviewSection;
  targetClaimId?: string;
  targetSource?: RoomOverviewEvidence;
  targetRoomId?: string;
  originalText?: string;
  replacementText?: string;
  rationale: string;
  entryPoint: "overview" | "section" | "agent";
  sessionId?: string;
}

export type RoomDuplicateConfidence = "high" | "medium" | "related" | "distinct" | "pending";
export type RoomDuplicateCandidateStatus = "open" | "related" | "distinct" | "merged";

export interface RoomDuplicateCandidate {
  id: string;
  roomAId: string;
  roomBId: string;
  roomA: { id: string; title: string; kind?: string };
  roomB: { id: string; title: string; kind?: string };
  nameScore: number;
  centroidScore: number;
  contentOverlap: number;
  entityOverlap: number;
  duplicateScore: number;
  confidence: RoomDuplicateConfidence;
  reasons: string[];
  status: RoomDuplicateCandidateStatus;
  updatedAt: string;
}

export interface RoomDuplicateCheckInput {
  title: string;
  description?: string;
  kind?: string;
  excludeRoomId?: string;
}

export interface RoomDuplicateCheckResult {
  candidates: RoomDuplicateCandidate[];
  overrideToken: string | null;
  expiresAt: string | null;
}

export interface RoomMergeImpactCounts {
  documents: number;
  externalSources: number;
  wikiFiles: number;
  localMemories: number;
  attributedMemories: number;
  agentRuns: number;
  sessionLinks: number;
  entities: number;
  relations: number;
  unassignedRuns: number;
  crossRoomSessions: number;
}

/** 合并预演 sketch（M2-B）：确定性拼接两源 Room 的产物概览，非最终结果。 */
export interface RoomMergeSketch {
  background: string;
  goal: string;
  status: string;
  materialsCount: number;
  filesCount: number;
  memoriesCount: number;
  entitiesTop: string[];
}

export interface RoomMergePreview {
  sourceRoom: ContextRoomSnapshotItem;
  targetRoom: ContextRoomSnapshotItem;
  recommendedTargetRoomId: string;
  impact: RoomMergeImpactCounts;
  sketch?: RoomMergeSketch;
  conflicts: string[];
  excluded: string[];
  previewHash: string;
  generatedAt: string;
}

export type RoomMergeStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface RoomMergeOperation {
  id: string;
  sourceRoomId: string;
  targetRoomId: string;
  status: RoomMergeStatus;
  stage: string;
  progress: number;
  commitReached: boolean;
  impact: RoomMergeImpactCounts;
  error: string | null;
  confirmedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface StartAgentRunInput {
  prompt: string;
  idempotencyKey: string;
  /** Stable local Agent installation id selected by an explicit composer mention. */
  targetAgentId?: string;
  /** Explicit switches are sticky; delegated calls return to the current speaker. */
  invocationMode?: AgentInvocationMode;
  /** Optional desktop-issued workspace binding selected through a native directory picker. */
  workspaceBindingToken?: string;
  /** Desktop Main-resolved target. Renderer input is discarded and replaced before Gateway dispatch. */
  localAgent?: LocalAgentInvocationTarget;
  attachments?: AgentAttachmentReference[];
  /** Completed run replaced by this regeneration request. */
  replaceRunId?: string;
  /** Current UI locale used for assistant-generated summaries and documents. */
  responseLanguage?: string;
  /** Defaults to true. Temporary preview runs can defer capture until user confirmation. */
  captureMemory?: boolean;
  /** Defaults to true. Lightweight runs can skip automatic memory recall. */
  recallMemory?: boolean;
  /** Defaults to "global". Room focus mode: recall keeps only the core profile and the current Room's curated memories, skipping global atomic/scenario/conversation recall; memory_search is locked to the current Room. Requires context.selectedRoomId. */
  memoryScope?: "room" | "global";
  /** Defaults to true. Lightweight runs can hide all runtime tools from the model. */
  toolsEnabled?: boolean;
  context?: {
    /** UI surface where this run was started; never part of session identity. */
    pageLabel?: string;
    selectedText?: string;
    /** Current, non-deleted Rooms visible to the desktop when this run starts. */
    rooms?: AgentRoomReference[];
    /** Explicit UI-confirmed target for a global Agent session. */
    selectedRoomId?: string | null;
    activeDocument?: AgentActiveDocumentContext;
    /** Files uploaded from the conversation composer and parsed by the unified file engine. */
    attachments?: AgentFileAttachment[];
    /** Read-only imported conversation to use once when this native session starts. */
    externalConversationId?: string;
    /** One-turn history reference for Main. It never resumes or routes to the referenced Agent. */
    referencedConversationId?: string;
  };
}

export type MigrationProvider = "notion" | "openclaw" | "codex" | "claude";
export type MigrationTransport = "oauth" | "zip" | "local-sqlite" | "local-jsonl" | "archive" | "directory";
export type MigrationSourceStatus = "ready" | "importing" | "completed" | "error" | "unavailable" | "deleting";
export type MigrationRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MigrationRunPhase = "discovering" | "reading" | "normalizing" | "saving" | "memory" | "finalizing" | "completed";

export interface MigrationSource {
  id: string;
  provider: MigrationProvider;
  transport: MigrationTransport;
  displayName: string;
  status: MigrationSourceStatus;
  lastSyncedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MigrationRun {
  id: string;
  sourceId: string;
  provider: MigrationProvider;
  transport: MigrationTransport;
  status: MigrationRunStatus;
  phase: MigrationRunPhase;
  pagesTotal: number;
  pagesCompleted: number;
  threadsTotal: number;
  threadsCompleted: number;
  messagesTotal: number;
  messagesCompleted: number;
  cancelRequested: boolean;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface MigrationProgressEvent {
  run: MigrationRun;
}

export interface ExternalConversationSummary {
  id: string;
  provider: MigrationProvider;
  sourceId: string;
  title: string;
  agentId: string | null;
  externalSessionId: string;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessageExcerpt: string;
  available: boolean;
}

export interface ExternalConversationMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  occurredAt: string;
}

export interface ExternalConversationPreview {
  conversation: ExternalConversationSummary;
  messages: ExternalConversationMessage[];
}

export interface ExternalConversationPage {
  items: ExternalConversationSummary[];
  nextCursor: string | null;
}

export type LocalAgentProvider = "codex" | "claude" | "openclaw" | "opencode" | "custom";
export type LocalAgentStatus = "discovered" | "verified" | "history_available" | "unavailable";
export type AgentInvocationMode = "explicit_switch" | "delegated_subagent";
export type AgentWorkspacePermissionProfile = "inspect" | "workspace_write" | "full_access";

export interface LocalAgentCard {
  name: string;
  description: string;
  version: string;
  supportedInterfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>;
  capabilities: { streaming?: boolean; pushNotifications?: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
}

export interface LocalAgentInstallation {
  id: string;
  provider: LocalAgentProvider;
  displayName: string;
  executablePath: string | null;
  version: string | null;
  status: LocalAgentStatus;
  callable: boolean;
  invocationSupported: boolean;
  historyAvailable: boolean;
  historyPaths: string[];
  card: LocalAgentCard;
  lastSeenAt: string;
  error?: string;
}

export interface LocalAgentHistoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface LocalAgentHistoryConversation {
  /** Provider-native session id used by the CLI resume protocol. */
  sessionId: string;
  title: string;
  messages: LocalAgentHistoryMessage[];
}

export interface LocalAgentHistoryImportResult {
  sessionsFound: number;
  sessionsImported: number;
  messagesImported: number;
  skippedFiles: number;
}

export interface LocalAgentInvocationTarget {
  id: string;
  provider: LocalAgentProvider;
  displayName: string;
  executablePath: string;
  workingDirectory: string;
  permissionProfile: AgentWorkspacePermissionProfile;
  card: LocalAgentCard;
}

export interface LocalAgentDelegationContext {
  schemaVersion: 1;
  targetAgentId: string;
  task: { text: string };
  conversation: {
    messages: Array<Pick<AgentMessage, "role" | "authorAgentId" | "content" | "createdAt">>;
    truncated: boolean;
  };
  selection?: { pageLabel: string; text: string };
  attachments: Array<{
    filename: string;
    mimeType: string;
    kind: AgentAttachmentKind;
    text?: string;
  }>;
  resources: {
    workspaceRoot: string;
    roomIds: string[];
    activeDocument?: Pick<AgentActiveDocumentContext, "roomId" | "documentId" | "title" | "version">;
  };
  grant: {
    workspaceAccess: "read-only" | "workspace-write" | "full-access";
    approvals: "disabled" | "agent-reviewed";
    mutationAllowed: boolean;
  };
  provenance: {
    source: "everroom.local-agent-delegation";
    generatedAt: string;
    digestAlgorithm: "sha256";
    digest: string;
  };
}

export interface AgentFileAttachment {
  fileId: string;
  /** Immutable file version selected when the attachment was uploaded. */
  fileVersionId: string;
  fileName: string;
  content?: string;
  status?: "processing" | "ready";
  contentHash?: string;
}

export type PendingAgentIntentTargetCapability =
  | "document.create"
  | "document.edit"
  | "document.continue";

export interface PendingAgentIntent {
  id: string;
  sessionId: string;
  sourceRunId: string;
  originalPrompt: string;
  targetCapability: PendingAgentIntentTargetCapability;
  allowedRoomIds: string[];
  allowedDocumentIds: string[];
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface SubmitPendingAgentIntentInput {
  roomId: string;
  documentId?: string;
  idempotencyKey: string;
  /** Current UI locale to carry into the resumed Agent run. */
  responseLanguage?: string;
}

export interface TrustedMcpSession {
  sessionId: string;
  expiresAt: string;
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
  contentSchemaVersion: number;
  version: number;
  status: "draft" | "active";
  activeTransactionId: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentBlockSummary {
  blockId: string;
  documentId: string;
  roomId: string;
  parentBlockId: string | null;
  rootBlockId: string;
  type: string;
  siblingIndex: number;
  ordinal: number;
  path: number[];
  depth: number;
  textPreview: string;
  indexedVersion: number;
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
  | "room_unavailable"
  | "permission_denied";

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

export interface DocumentBlockBacklink {
  sourceRoomId: string;
  sourceDocumentId: string;
  sourceDocumentTitle: string;
  sourceBlockId: string;
  sourceTextPreview: string;
  targetDocumentId: string;
  targetBlockId: string;
}

export interface DocumentBlockBacklinkList {
  documentId: string;
  blockId: string | null;
  backlinks: DocumentBlockBacklink[];
}

export interface DocumentVersionSummary {
  documentId: string;
  version: number;
  contentSchemaVersion: number;
  sourceTransactionId: string | null;
  createdAt: string;
  title?: string;
  yjsBackfilled?: boolean;
  /** 变更概览（重要变更保存时已生成；null 表示待懒加载）。 */
  changeSummary?: string | null;
  changeSummarySource?: "ai" | "local" | null;
}

export interface DocumentVersionListOptions {
  limit?: number;
  beforeVersion?: number;
}

export interface DocumentVersionSnapshot {
  documentId: string;
  version: number;
  title: string;
  contentJson: TiptapJsonContent;
  contentSchemaVersion: number;
  sourceTransactionId: string | null;
  createdAt: string;
  yjsBackfilled: boolean;
}

export interface DocumentDiffSpan {
  type: "equal" | "insert" | "delete";
  text: string;
}

export interface DocumentDiffBlock {
  blockId: string;
  status: "added" | "removed" | "modified" | "unchanged";
  type: string;
  path: number[];
  before?: TiptapJsonContent;
  after?: TiptapJsonContent;
  textDiff: DocumentDiffSpan[];
  unstableMatch?: boolean;
}

export interface DocumentDiffResult {
  documentId: string;
  fromVersion: number | null;
  toVersion: number;
  blocks: DocumentDiffBlock[];
  yjsBackfilled: boolean;
  truncated?: boolean;
  truncatedReason?: "too_large";
}

export interface RestoreDocumentVersionInput {
  baseVersion: number;
}

export type DocumentOperationInteractionMode =
  | "streaming_commit"
  | "atomic_review"
  | "incremental_review"
  | "preview_replace";

export type DocumentOperationStatus =
  | "created"
  | "running"
  | "awaiting_input"
  | "awaiting_review"
  | "applying"
  | "completed"
  | "rejected"
  | "conflicted"
  | "failed"
  | "cancelled"
  | "expired";

export type DocumentOperationItemStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "applied"
  | "skipped";

export interface DocumentOperationSummary {
  id: string;
  capabilityId: string;
  capabilityVersion: number;
  interactionMode: DocumentOperationInteractionMode;
  presenterKey: string;
  roomId: string;
  documentId: string | null;
  documentTitle: string;
  sessionId: string;
  runId: string;
  baseVersion: number | null;
  status: DocumentOperationStatus;
  revision: number;
  summary: string;
  conflictVersion: number | null;
  error: Record<string, unknown> | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DocumentOperationItem {
  id: string;
  operationId: string;
  sequence: number;
  operation: DocumentMutationOperation | "stream_chunk" | "replace_selection";
  target: DocumentMutationTarget | null;
  before: TiptapJsonContent[];
  after: TiptapJsonContent[];
  markdown: string;
  contentHash: string;
  status: DocumentOperationItemStatus;
  appliedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentOperation extends DocumentOperationSummary {
  input: Record<string, unknown>;
  result: Record<string, unknown> | null;
  items: DocumentOperationItem[];
}

export interface DocumentOperationList {
  operations: DocumentOperationSummary[];
}

export interface DocumentOperationCommandInput {
  commandId: string;
  expectedRevision: number;
  type: string;
  payload?: Record<string, unknown>;
  context?: {
    roomId: string;
    sessionId: string;
    runId: string;
  };
}

export interface DocumentOperationCommandResult {
  operation: DocumentOperation;
  document?: RoomDocument;
  duplicate: boolean;
}

export interface ExternalDocumentProjectionBinding {
  sourceKind: "obsidian-vault";
  sourceId: string;
  resourceId: string;
  roomId: string;
  documentId: string;
  relativePath: string;
  sourceHash: string;
  updatedAt: string;
}

export interface SyncExternalDocumentProjectionInput {
  sourceKind: "obsidian-vault";
  sourceId: string;
  resourceId: string;
  roomId: string;
  relativePath: string;
  sourceHash: string;
  title: string;
  markdown: string;
}

export interface PrepareExternalDocumentPatchInput {
  operationId: string;
  command: DocumentOperationCommandInput;
}

export interface PreparedExternalDocumentPatch {
  preparationId: string;
  operationId: string;
  documentId: string;
  sourceId: string;
  resourceId: string;
  relativePath: string;
  expectedSourceHash: string;
  markdown: string;
  patch: string;
  expiresAt: string;
}

export interface CompleteExternalDocumentPatchInput {
  preparationId: string;
  resultingSourceHash: string;
  context: {
    roomId: string;
    sessionId: string;
    runId: string;
  };
}

export interface StartDocumentOperationInput {
  capabilityId: string;
  /**
   * 操作溯源二选一：主 Agent 会话（sessionId + runId）或 dispatch 子 Agent 调用（invocationId）。
   * invocationId 变体由网关归一化为 sessionId = runId = invocationId 后落库。
   */
  context: {
    roomId: string;
    documentId?: string;
    sessionId?: string;
    runId?: string;
    invocationId?: string;
  };
  input: Record<string, unknown>;
}

export type DocumentCapabilityType = "query" | "mutation";

export interface DocumentCapabilityManifest {
  id: string;
  version: number;
  type: DocumentCapabilityType;
  interactionMode: DocumentOperationInteractionMode | null;
  presenterKey: string | null;
  permissions: readonly ("room:read" | "document:read" | "document:write")[];
  requiresRoom: boolean;
  requiresDocument: boolean;
}

export type DocumentMutationOperation = "insert" | "replace" | "delete";

export type DocumentMutationTarget =
  | { at: "end" }
  | { blockId: string; edge: "before" | "after" }
  | { blockId: string; fromOffset?: number; toOffset?: number }
  | { fromBlockId: string; toBlockId: string };

export type DocumentEventType =
  | "document.changed"
  | "document.operation.changed"
  | "document.deleted";

export interface DocumentEvent<T = unknown> {
  id: string;
  roomId: string;
  documentId: string;
  operationId: string | null;
  type: DocumentEventType;
  occurredAt: string;
  payload: T;
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

/* ---- 外部文档导入（飞书 / Notion，OpenConnector 读通道）与 Agent 导出 ---- */

export type ExternalDocumentProvider = "feishu" | "notion";

export interface ExternalDocumentWarning {
  code: string;
  message: string;
}

export interface ExternalDocumentSearchResultItem {
  provider: ExternalDocumentProvider;
  remoteDocumentId: string;
  title: string;
  sourceUrl: string | null;
  updatedAt: string | null;
  ownerName: string | null;
}

export interface ExternalDocumentSearchResponse {
  provider: ExternalDocumentProvider;
  items: ExternalDocumentSearchResultItem[];
  warnings: ExternalDocumentWarning[];
}

export type ExternalCommentsStatus = "complete" | "partial" | "unavailable" | "failed";

export interface CanonicalAsset {
  id: string;
  kind: "image" | "file";
  name: string | null;
  sourceUrl: string | null;
  contentHash: string | null;
  mimeType: string | null;
  bytes: number | null;
  warning: string | null;
}

export interface CanonicalCommentAnchor {
  blockId: string | null;
  quotedText: string | null;
}

export interface CanonicalComment {
  id: string;
  parentId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  resolved: boolean | null;
  anchor: CanonicalCommentAnchor | null;
  sourceUrl: string | null;
  locationStatus: "located" | "unlocated" | "unsupported";
}

/** 外部来源文档的规范化中间格式；导入、快照与 diff 都以它为准。 */
export interface CanonicalDocumentArtifact {
  provider: ExternalDocumentProvider;
  remoteDocumentId: string;
  sourceUrl: string | null;
  title: string;
  bodyMarkdown: string;
  assets: CanonicalAsset[];
  comments: CanonicalComment[];
  commentsStatus: ExternalCommentsStatus;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  warnings: ExternalDocumentWarning[];
}

export interface ExternalDocumentCommentView {
  id: string;
  parentId: string | null;
  authorName: string | null;
  body: string;
  quotedText: string | null;
  resolved: boolean | null;
  sourceUrl: string | null;
  locationStatus: CanonicalComment["locationStatus"];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ExternalDocumentPreview {
  runId: string;
  provider: ExternalDocumentProvider;
  remoteDocumentId: string;
  title: string;
  bodyExcerpt: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  sourceUpdatedAt: string | null;
  comments: ExternalDocumentCommentView[];
  commentsStatus: ExternalCommentsStatus;
  warnings: ExternalDocumentWarning[];
}

export type DocumentImportRunStatus =
  | "searching"
  | "reading"
  | "preview"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface DocumentImportRunView {
  id: string;
  requestId: string;
  provider: ExternalDocumentProvider;
  remoteDocumentId: string;
  sourceId: string | null;
  snapshotId: string | null;
  targetRoomId: string | null;
  targetDocumentId: string | null;
  status: DocumentImportRunStatus;
  warnings: ExternalDocumentWarning[];
  errorCode: string | null;
  errorMessage: string | null;
  commentsStatus: ExternalCommentsStatus | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface DocumentImportHistoryEntry {
  roomImportId: string;
  importRunId: string;
  snapshotId: string;
  relation: "primary" | "candidate";
  importedVersion: number | null;
  candidateDocumentId: string | null;
  provider: ExternalDocumentProvider;
  remoteDocumentId: string;
  displayTitle: string;
  sourceUrl: string | null;
  sourceRevision: string | null;
  capturedAt: string;
  commentsStatus: ExternalCommentsStatus;
  warnings: ExternalDocumentWarning[];
}

export interface DocumentImportCommentDiffSummary {
  comparable: boolean;
  added: number;
  resolved: number;
  modified: number;
  removed: number;
  reason: string | null;
}

export type AgentDocumentExportMode = "create" | "update" | "export_file";

export type AgentDocumentExportStatus =
  | "preparing"
  | "environment_not_ready"
  | "awaiting_auth"
  | "awaiting_confirmation"
  | "running"
  | "succeeded"
  | "failed"
  | "needs_review"
  | "cancelled";

export interface AgentDocumentExportTarget {
  /** update 模式：用户明确提供的远端文档 URL 或 ID。 */
  remoteUrl?: string;
  remoteDocumentId?: string;
  /** create 模式：可选的父位置（文件夹/知识库节点/父页面 URL 或 token）。 */
  parentUrl?: string;
  parentId?: string;
  /** update 模式写入范围：append 追加到文末（默认，不破坏远端）；replace_document 替换整篇（需确认）。 */
  writeScope?: "append" | "replace_document";
}

export interface AgentAuthChallengeStep {
  id: string;
  title: string;
  description: string | null;
  action: "open_url" | "show_qr" | "wait_local_result" | "run_cli_check" | "user_confirm";
  url?: string;
  completed: boolean;
}

/** CLI/skill 未配置/未授权时返回给 Agent 的结构化授权挑战。 */
export interface AgentAuthChallengeView {
  id: string;
  provider: ExternalDocumentProvider;
  operation: "export";
  phase: "environment" | "app_setup" | "user_auth";
  status: "required" | "pending" | "authorized" | "expired" | "failed";
  reason:
    | "not_connected"
    | "missing_scope"
    | "expired"
    | "app_setup_required"
    | "environment_not_ready";
  title: string;
  steps: AgentAuthChallengeStep[];
  verificationUrl: string | null;
  localResumeHandle: string | null;
  expiresAt: string | null;
}

export interface AgentDocumentExportConfirmation {
  targetTitle: string;
  targetUrl: string;
  roomVersion: number;
  writeScope: string;
  remoteRevision: string | null;
  warnings: ExternalDocumentWarning[];
}

export interface AgentDocumentExportRunView {
  id: string;
  requestId: string;
  roomId: string;
  documentId: string;
  version: number;
  documentTitle: string | null;
  provider: ExternalDocumentProvider;
  mode: AgentDocumentExportMode;
  target: AgentDocumentExportTarget | null;
  payloadHash: string | null;
  rendererVersion: string | null;
  cliSkillRef: string | null;
  status: AgentDocumentExportStatus;
  challenge: AgentAuthChallengeView | null;
  confirmation: AgentDocumentExportConfirmation | null;
  remoteUrl: string | null;
  remoteRevision: string | null;
  warnings: ExternalDocumentWarning[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AgentSessionSnapshot {
  session: AgentSession;
  participants: AgentSessionParticipant[];
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
