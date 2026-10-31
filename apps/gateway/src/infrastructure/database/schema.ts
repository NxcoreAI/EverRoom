import {
  index,
  integer,
  blob,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  AgentNavigationTarget,
  AgentDocumentExportMode,
  AgentDocumentExportStatus,
  AgentDocumentExportTarget,
  AgentAuthChallengeView,
  CanonicalComment,
  DocumentImportBatchItemView,
  DocumentImportBatchMode,
  DocumentImportBatchStatus,
  DocumentImportRunStatus,
  ExternalCommentsStatus,
  ExternalDocumentListItem,
  ExternalDocumentProvider,
  ExternalDocumentWarning,
  DocumentOperationCommandInput,
  DocumentOperationInteractionMode,
  DocumentOperationItemStatus,
  DocumentOperationStatus,
  DocumentMutationTarget,
  SubagentInvocationResult,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import type {
  RealityCaptureDevice,
  RealityInsights,
  RealityMarker,
  RealityTag,
  RealityTranscriptSegment,
} from "@nxcore/reality-contract";

export const gatewayMetadata = sqliteTable("gateway_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const runtimeConfigStore = sqliteTable("runtime_config_store", {
  source: text("source", { enum: ["user"] }).primaryKey(),
  payload: text("payload", { mode: "json" }).notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  configVersion: integer("config_version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed", "cancelled"],
    })
      .notNull()
      .default("pending"),
    payload: text("payload", { mode: "json" }).notNull(),
    result: text("result", { mode: "json" }),
    error: text("error", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("jobs_type_status_created_idx").on(table.type, table.status, table.createdAt)],
);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  action: text("action").notNull(),
  actor: text("actor").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: text("metadata", { mode: "json" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const externalCallPolicies = sqliteTable(
  "external_call_policies",
  {
    id: text("id").primaryKey(),
    subjectScope: text("subject_scope", { enum: ["user", "workspace", "service"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    service: text("service", { enum: ["WEB_SEARCH", "MCP", "CONNECTOR"] }).notNull(),
    period: text("period", { enum: ["UTC_DAY", "UTC_MONTH"] }).notNull(),
    callLimit: integer("call_limit").notNull(),
    warningThreshold: integer("warning_threshold").notNull(),
    enforcement: text("enforcement", { enum: ["BLOCK", "AUDIT_ONLY"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("external_call_policies_subject_idx")
    .on(table.subjectScope, table.subjectId, table.service, table.period)],
);

export const externalCallUsage = sqliteTable(
  "external_call_usage",
  {
    policyId: text("policy_id").notNull().references(() => externalCallPolicies.id, { onDelete: "cascade" }),
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    reservedCalls: integer("reserved_calls").notNull().default(0),
    consumedCalls: integer("consumed_calls").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.policyId, table.periodStart] }),
    index("external_call_usage_period_idx").on(table.periodStart),
  ],
);

export const externalCallReservations = sqliteTable("external_call_reservations", {
  id: text("id").primaryKey(),
  policyIds: text("policy_ids", { mode: "json" }).$type<string[]>().notNull(),
  service: text("service", { enum: ["WEB_SEARCH", "MCP", "CONNECTOR"] }).notNull(),
  tool: text("tool").notNull(),
  state: text("state", { enum: ["RESERVED", "CONSUMED", "RELEASED"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const externalCallAudits = sqliteTable(
  "external_call_audits",
  {
    id: text("id").primaryKey(),
    subjectScope: text("subject_scope", { enum: ["user", "workspace", "service"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    workspaceId: text("workspace_id"),
    userId: text("user_id"),
    service: text("service", { enum: ["WEB_SEARCH", "MCP", "CONNECTOR"] }).notNull(),
    tool: text("tool").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    source: text("source").notNull(),
    runId: text("run_id"),
    correlationId: text("correlation_id"),
    reservedCalls: integer("reserved_calls").notNull(),
    consumedCalls: integer("consumed_calls").notNull(),
    durationMs: integer("duration_ms").notNull(),
    outcome: text("outcome", { enum: ["SUCCEEDED", "FAILED", "RELEASED", "BLOCKED"] }).notNull(),
    failureCode: text("failure_code", {
      enum: ["PROVIDER_FAILURE", "NOT_DISPATCHED", "BUDGET_EXCEEDED", "CANCELLED"],
    }),
  },
  (table) => [
    index("external_call_audits_subject_idx").on(table.subjectScope, table.subjectId, table.occurredAt),
    index("external_call_audits_service_idx").on(table.service, table.occurredAt),
  ],
);

export const connectorTombstones = sqliteTable(
  "connector_tombstones",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    connectionName: text("connection_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("connector_tombstones_owner_service_connection_idx").on(
      table.ownerId,
      table.service,
      table.connectionName,
    ),
    index("connector_tombstones_owner_idx").on(table.ownerId),
  ],
);

/** 工作区：会话的组织容器；id='default' 的默认工作区由迁移与懒初始化保证存在。 */
export const agentWorkspaces = sqliteTable("agent_workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 空间描述（概览页展示）；未填写为 NULL。 */
  description: text("description"),
  /** 目标列表，以 JSON 文本存放；NULL/空数组都按 [] 暴露。 */
  goals: text("goals", { mode: "json" }).$type<string[]>(),
  path: text("path"),
  kind: text("kind", { enum: ["default", "custom"] }).notNull().default("custom"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastOpenedAt: integer("last_opened_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  /** 会话所属工作区；旧会话迁移后回填为 'default'。 */
  workspaceId: text("workspace_id"),
  roomId: text("room_id"),
  pageLabel: text("page_label").notNull(),
  runtimeId: text("runtime_id").notNull(),
  runtimeSessionRef: text("runtime_session_ref"),
  activeAgentId: text("active_agent_id").notNull().default("main"),
  title: text("title"),
  /** 会话权限模式（provider 中立语义档）；null = 未显式设置，按运行时默认（pi: accept_edits，ACP: 适配器 currentModeId）。 */
  permissionMode: text("permission_mode", {
    enum: ["ask_before_write", "accept_edits", "auto", "full_access"],
  }),
  /** 会话级思考档位覆盖；null = 跟随 runtime config 的 reasoning（现有行为）。 */
  thinkingLevel: text("thinking_level", {
    enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  }),
  status: text("status", {
    enum: ["idle", "running", "interrupted", "closed"],
  })
    .notNull()
    .default("idle"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const agentSessionLinks = sqliteTable(
  "agent_session_links",
  {
    id: text("id").primaryKey(),
    sourceSessionId: text("source_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    targetSessionId: text("target_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    sourceRunId: text("source_run_id").notNull(),
    sourcePageId: text("source_page_id").notNull(),
    sourcePageLabel: text("source_page_label").notNull(),
    sourceRoomId: text("source_room_id"),
    targetKey: text("target_key").notNull(),
    target: text("target", { mode: "json" }).$type<AgentNavigationTarget>().notNull(),
    returnedAt: integer("returned_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("agent_session_links_source_target_idx").on(table.sourceRunId, table.targetKey),
    index("agent_session_links_source_session_idx").on(table.sourceSessionId),
    index("agent_session_links_target_session_idx").on(table.targetSessionId),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull().default("main"),
    invocationMode: text("invocation_mode", {
      enum: ["explicit_switch", "delegated_subagent"],
    }).notNull().default("explicit_switch"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Persisted per-run Room attribution. Sessions may span multiple Rooms. */
    roomId: text("room_id"),
    status: text("status", {
      enum: ["accepted", "running", "completed", "failed", "cancelled", "interrupted"],
    })
      .notNull()
      .default("accepted"),
    prompt: text("prompt").notNull(),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("agent_runs_session_idempotency_idx").on(table.sessionId, table.idempotencyKey)],
);

export const agentMessages = sqliteTable("agent_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => agentSessions.id, { onDelete: "cascade" }),
  runId: text("run_id")
    .notNull()
    .references(() => agentRuns.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
  authorAgentId: text("author_agent_id"),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const dataMigrationSources = sqliteTable(
  "data_migration_sources",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: ["notion", "openclaw", "codex", "claude", "cherry", "hermes"] }).notNull(),
    transport: text("transport", { enum: ["oauth", "zip", "local-sqlite", "local-jsonl", "archive", "directory"] }).notNull(),
    stableSourceKey: text("stable_source_key").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["ready", "importing", "completed", "error", "unavailable", "deleting"] }).notNull().default("ready"),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("data_migration_sources_stable_idx").on(table.provider, table.stableSourceKey)],
);

export const dataMigrationRuns = sqliteTable(
  "data_migration_runs",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => dataMigrationSources.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["notion", "openclaw", "codex", "claude", "cherry", "hermes"] }).notNull(),
    transport: text("transport", { enum: ["oauth", "zip", "local-sqlite", "local-jsonl", "archive", "directory"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).notNull().default("queued"),
    phase: text("phase", { enum: ["discovering", "reading", "normalizing", "saving", "memory", "finalizing", "completed"] }).notNull().default("discovering"),
    pagesTotal: integer("pages_total").notNull().default(0),
    pagesCompleted: integer("pages_completed").notNull().default(0),
    threadsTotal: integer("threads_total").notNull().default(0),
    threadsCompleted: integer("threads_completed").notNull().default(0),
    messagesTotal: integer("messages_total").notNull().default(0),
    messagesCompleted: integer("messages_completed").notNull().default(0),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("data_migration_runs_source_started_idx").on(table.sourceId, table.startedAt)],
);

export const migrationJobs = sqliteTable(
  "migration_jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    sourceId: text("source_id"),
    type: text("type", { enum: ["memory_index", "source_gc"] }).notNull(),
    payload: text("payload").notNull().default("{}"),
    status: text("status", { enum: ["pending", "running", "done", "failed"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("migration_jobs_status_run_at_idx").on(table.status, table.runAt),
    index("migration_jobs_run_idx").on(table.runId),
    index("migration_jobs_source_idx").on(table.sourceId),
  ],
);

export const externalAgentThreads = sqliteTable(
  "external_agent_threads",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => dataMigrationSources.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["openclaw", "codex", "claude", "cherry", "hermes"] }).notNull(),
    stableKey: text("stable_key").notNull(),
    agentId: text("agent_id"),
    externalSessionId: text("external_session_id").notNull(),
    title: text("title").notNull(),
    importVersion: integer("import_version").notNull().default(1),
    memorySessionId: text("memory_session_id").notNull(),
    memoryStatus: text("memory_status", { enum: ["pending", "indexed", "error"] }).notNull().default("pending"),
    contentHash: text("content_hash"),
    memoryRuleVersion: integer("memory_rule_version").notNull().default(1),
    available: integer("available", { mode: "boolean" }).notNull().default(true),
    messageCount: integer("message_count").notNull().default(0),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }),
    lastMessageExcerpt: text("last_message_excerpt").notNull().default(""),
    lastSeenRunId: text("last_seen_run_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("external_agent_threads_source_key_idx").on(table.sourceId, table.stableKey),
    index("external_agent_threads_recent_idx").on(table.available, table.lastMessageAt),
  ],
);

export const externalAgentMessages = sqliteTable(
  "external_agent_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => externalAgentThreads.id, { onDelete: "cascade" }),
    stableKey: text("stable_key").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    attachments: text("attachments").notNull().default("[]"),
    ordinal: integer("ordinal").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("external_agent_messages_thread_key_idx").on(table.threadId, table.stableKey),
    index("external_agent_messages_thread_order_idx").on(table.threadId, table.ordinal),
  ],
);

export const migrationSourceCapabilities = sqliteTable(
  "migration_source_capabilities",
  {
    sourceId: text("source_id").primaryKey().references(() => dataMigrationSources.id, { onDelete: "cascade" }),
    importState: text("import_state", { enum: ["not_available", "available", "active", "error", "paused"] }).notNull().default("not_available"),
    syncState: text("sync_state", { enum: ["not_available", "available", "active", "error", "paused"] }).notNull().default("not_available"),
    onDemandState: text("on_demand_state", { enum: ["not_available", "available", "active", "error", "paused"] }).notNull().default("not_available"),
    writeBackState: text("write_back_state", { enum: ["not_available", "available", "active", "error", "paused"] }).notNull().default("not_available"),
    nativeRestoreState: text("native_restore_state", { enum: ["not_available", "available", "active", "error", "paused"] }).notNull().default("not_available"),
    syncDetail: text("sync_detail").notNull().default("{}"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
);

export const agentSessionExternalThreads = sqliteTable(
  "agent_session_external_threads",
  {
    sessionId: text("session_id").primaryKey().references(() => agentSessions.id, { onDelete: "cascade" }),
    externalThreadId: text("external_thread_id").notNull().references(() => externalAgentThreads.id, { onDelete: "restrict" }),
    importVersion: integer("import_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("agent_session_external_threads_thread_idx").on(table.externalThreadId)],
);

export const agentSessionParticipants = sqliteTable(
  "agent_session_participants",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    runtimeId: text("runtime_id").notNull(),
    runtimeSessionRef: text("runtime_session_ref"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    workspaceRoot: text("workspace_root"),
    permissionProfile: text("permission_profile", {
      enum: ["inspect", "workspace_write", "full_access"],
    }).notNull().default("inspect"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.agentId] }),
    index("agent_session_participants_agent_idx").on(table.agentId),
  ],
);

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("agent_events_run_seq_idx").on(table.runId, table.seq)],
);

export const pendingAgentIntents = sqliteTable(
  "pending_agent_intents",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    sourceRunId: text("source_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    originalPrompt: text("original_prompt").notNull(),
    targetCapability: text("target_capability", {
      enum: ["document.create", "document.edit", "document.continue", "task.clarify"],
    }).notNull(),
    allowedRoomIds: text("allowed_room_ids", { mode: "json" }).$type<string[]>().notNull(),
    allowedDocumentIds: text("allowed_document_ids", { mode: "json" }).$type<string[]>().notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("pending_agent_intents_session_idx").on(table.sessionId),
    index("pending_agent_intents_source_run_idx").on(table.sourceRunId),
    index("pending_agent_intents_expires_idx").on(table.expiresAt),
  ],
);

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  contentJson: text("content_json", { mode: "json" }).notNull(),
  contentSchemaVersion: integer("content_schema_version").notNull().default(1),
  version: integer("version").notNull().default(0),
  status: text("status", { enum: ["draft", "active"] }).notNull().default("draft"),
  /** native=用户在 EverRoom 创建（产物）；import=外部导入（工作资料）。 */
  origin: text("origin", { enum: ["native", "import"] }).notNull().default("native"),
  activeTransactionId: text("active_transaction_id"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  overviewText: text("overview_text"),
  overviewVersion: integer("overview_version"),
  overviewGeneratedAt: integer("overview_generated_at", { mode: "timestamp_ms" }),
}, (table) => [
  index("documents_updated_idx").on(table.updatedAt),
]);

/** 章节刻度线 hover 的 AI 章节预览：content_hash 命中即缓存，正文变化才重生成。 */
export const documentSectionPreviews = sqliteTable("document_section_previews", {
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  blockId: text("block_id").notNull(),
  headingText: text("heading_text").notNull(),
  previewText: text("preview_text").notNull(),
  contentHash: text("content_hash").notNull(),
  generatedAt: integer("generated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.documentId, table.blockId] }),
]);

export const documentVersions = sqliteTable(
  "doc_versions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull().default("无标题文档"),
    // Only retained snapshots have a JSON body. Other versions are
    // reconstructed from the Yjs history chain.
    contentJson: text("content_json", { mode: "json" }),
    contentSchemaVersion: integer("content_schema_version").notNull().default(1),
    sourceTransactionId: text("source_transaction_id"),
    /** 变更概览（重要变更保存时自动生成；其余懒加载回填）。source: ai|local。 */
    changeSummary: text("change_summary"),
    changeSummarySource: text("change_summary_source"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_versions_document_version_idx").on(table.documentId, table.version)],
);

export const documentYjsCheckpoints = sqliteTable(
  "document_yjs_checkpoints",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    throughVersion: integer("through_version").notNull(),
    docState: blob("doc_state", { mode: "buffer" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("document_yjs_checkpoints_document_version_idx").on(table.documentId, table.throughVersion),
    index("document_yjs_checkpoints_document_idx").on(table.documentId),
  ],
);

export const documentYjsUpdates = sqliteTable(
  "document_yjs_updates",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    update: blob("update", { mode: "buffer" }).notNull(),
    source: text("source").notNull().default("commit"),
    contentHash: text("content_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("document_yjs_updates_document_version_idx").on(table.documentId, table.version),
    index("document_yjs_updates_document_idx").on(table.documentId, table.version),
  ],
);

export const documentYjsVersions = sqliteTable(
  "document_yjs_versions",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    updateId: text("update_id")
      .notNull()
      .references(() => documentYjsUpdates.id, { onDelete: "cascade" }),
    checkpointId: text("checkpoint_id").references(() => documentYjsCheckpoints.id, { onDelete: "set null" }),
    backfilled: integer("backfilled", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.version] }),
    index("document_yjs_versions_update_idx").on(table.updateId),
  ],
);

export const documentOperations = sqliteTable(
  "document_operations",
  {
    id: text("id").primaryKey(),
    capabilityId: text("capability_id").notNull(),
    capabilityVersion: integer("capability_version").notNull(),
    interactionMode: text("interaction_mode", {
      enum: ["streaming_commit", "atomic_review", "incremental_review", "preview_replace"],
    }).$type<DocumentOperationInteractionMode>().notNull(),
    presenterKey: text("presenter_key").notNull(),
    // P0-2d：工作区级操作没有归属 Room（Agent 在无 Room 时创建/修改文稿）。
    roomId: text("room_id"),
    documentId: text("document_id").references(() => documents.id, { onDelete: "cascade" }),
    documentTitle: text("document_title").notNull(),
    agentSessionId: text("agent_session_id").notNull(),
    runId: text("run_id").notNull(),
    baseVersion: integer("base_version"),
    status: text("status", {
      enum: [
        "created", "running", "awaiting_input", "awaiting_review", "applying",
        "completed", "rejected", "conflicted", "failed", "cancelled", "expired",
      ],
    }).$type<DocumentOperationStatus>().notNull().default("created"),
    revision: integer("revision").notNull().default(1),
    summary: text("summary").notNull(),
    input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    conflictVersion: integer("conflict_version"),
    error: text("error", { mode: "json" }).$type<Record<string, unknown>>(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("document_operations_document_status_idx").on(table.documentId, table.status),
    index("document_operations_room_status_idx").on(table.roomId, table.status),
    index("document_operations_session_status_idx").on(table.agentSessionId, table.status),
    index("document_operations_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const documentOperationItems = sqliteTable(
  "document_operation_items",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull()
      .references(() => documentOperations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    operation: text("operation", {
      enum: ["insert", "replace", "delete", "stream_chunk", "replace_selection"],
    }).notNull(),
    target: text("target", { mode: "json" }).$type<DocumentMutationTarget>(),
    beforeJson: text("before_json", { mode: "json" }).$type<TiptapJsonContent[]>().notNull(),
    afterJson: text("after_json", { mode: "json" }).$type<TiptapJsonContent[]>().notNull(),
    markdown: text("markdown").notNull().default(""),
    contentHash: text("content_hash").notNull(),
    status: text("status", {
      enum: ["pending", "accepted", "rejected", "applied", "skipped"],
    }).$type<DocumentOperationItemStatus>().notNull().default("pending"),
    appliedVersion: integer("applied_version"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("document_operation_items_sequence_idx").on(table.operationId, table.sequence),
    index("document_operation_items_status_idx").on(table.operationId, table.status),
  ],
);

export const documentOperationCommands = sqliteTable(
  "document_operation_commands",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull()
      .references(() => documentOperations.id, { onDelete: "cascade" }),
    expectedRevision: integer("expected_revision").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("document_operation_commands_operation_id_idx").on(table.operationId, table.id)],
);

export const externalDocumentBindings = sqliteTable(
  "external_document_bindings",
  {
    documentId: text("document_id").primaryKey()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind", { enum: ["obsidian-vault", "local-directory"] }).notNull(),
    sourceId: text("source_id").notNull(),
    resourceId: text("resource_id").notNull(),
    roomId: text("room_id").notNull(),
    relativePath: text("relative_path").notNull(),
    sourceHash: text("source_hash").notNull(),
    projectedMarkdown: text("projected_markdown").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("external_document_bindings_source_idx").on(
      table.sourceKind,
      table.sourceId,
      table.resourceId,
    ),
  ],
);

export const externalDocumentPatchPreparations = sqliteTable(
  "external_document_patch_preparations",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull()
      .references(() => documentOperations.id, { onDelete: "cascade" }),
    commandId: text("command_id").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    command: text("command", { mode: "json" }).$type<DocumentOperationCommandInput>().notNull(),
    expectedSourceHash: text("expected_source_hash").notNull(),
    patch: text("patch").notNull(),
    preparedMarkdown: text("prepared_markdown").notNull(),
    status: text("status", { enum: ["pending", "completed"] }).notNull().default("pending"),
    resultingSourceHash: text("resulting_source_hash"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("external_document_patch_command_idx").on(table.operationId, table.commandId),
    index("external_document_patch_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const documentOperationEvents = sqliteTable(
  "document_operation_events",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull()
      .references(() => documentOperations.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("document_operation_events_revision_idx").on(table.operationId, table.revision),
    index("document_operation_events_created_idx").on(table.createdAt),
  ],
);

export const documentBlocks = sqliteTable(
  "document_blocks",
  {
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    blockId: text("block_id").notNull(),
    parentBlockId: text("parent_block_id"),
    rootBlockId: text("root_block_id").notNull(),
    type: text("type").notNull(),
    siblingIndex: integer("sibling_index").notNull(),
    ordinal: integer("ordinal").notNull(),
    path: text("path", { mode: "json" }).$type<number[]>().notNull(),
    depth: integer("depth").notNull(),
    textPreview: text("text_preview").notNull(),
    indexedVersion: integer("indexed_version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.documentId, table.blockId] }),
    uniqueIndex("document_blocks_document_ordinal_idx").on(table.documentId, table.ordinal),
    index("document_blocks_document_idx").on(table.documentId),
    index("document_blocks_root_idx").on(table.documentId, table.rootBlockId),
  ],
);

export const documentBlockReferences = sqliteTable(
  "document_block_references",
  {
    sourceDocumentId: text("source_document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceBlockId: text("source_block_id").notNull(),
    targetRoomId: text("target_room_id").notNull(),
    targetDocumentId: text("target_document_id").notNull(),
    targetBlockId: text("target_block_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    indexedVersion: integer("indexed_version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceDocumentId, table.ordinal] }),
    index("document_block_references_source_idx").on(table.sourceDocumentId, table.sourceBlockId),
    index("document_block_references_target_idx").on(table.targetDocumentId, table.targetBlockId),
  ],
);

// ═══════════════════ 外部文档导入（feishu-notion-document-export-plan.md） ═══════════════════
// 飞书/Notion 文档经 OpenConnector 只读导入：来源登记、不可变快照（正文/评论内容
// 存 files 模块 sha256 内容寻址存储，表内只留 artifact 引用）、导入任务与 Room
// 关联。document_import_sources 只用于识别"同一来源再次导入"和审计，不代表持续
// 同步关系。

/** 外部文档来源登记（owner + provider + remote id 唯一）。 */
export const documentImportSources = sqliteTable(
  "document_import_sources",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().default("local-user"),
    provider: text("provider", { enum: ["feishu", "notion"] }).$type<ExternalDocumentProvider>().notNull(),
    remoteDocumentId: text("remote_document_id").notNull(),
    sourceUrl: text("source_url"),
    displayTitle: text("display_title"),
    externalAccountRef: text("external_account_ref"),
    lastSeenRevision: text("last_seen_revision"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("document_import_sources_owner_remote_idx").on(
      table.ownerId,
      table.provider,
      table.remoteDocumentId,
    ),
    index("document_import_sources_provider_idx").on(table.provider),
  ],
);

/** 导入任务：一次"搜索→读取→预览→（可选）提交到 Room"的完整过程。 */
export const documentImportRuns = sqliteTable(
  "document_import_runs",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    ownerId: text("owner_id").notNull().default("local-user"),
    provider: text("provider", { enum: ["feishu", "notion"] }).$type<ExternalDocumentProvider>().notNull(),
    sourceId: text("source_id").references(() => documentImportSources.id, { onDelete: "cascade" }),
    remoteDocumentId: text("remote_document_id").notNull(),
    targetRoomId: text("target_room_id"),
    targetDocumentId: text("target_document_id"),
    actionRefsJson: text("action_refs_json", { mode: "json" }).$type<string[]>().notNull().default([]),
    snapshotId: text("snapshot_id"),
    status: text("status", {
      enum: ["searching", "reading", "preview", "committing", "succeeded", "failed", "cancelled"],
    }).$type<DocumentImportRunStatus>().notNull().default("searching"),
    warningsJson: text("warnings_json", { mode: "json" }).$type<ExternalDocumentWarning[]>().notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("document_import_runs_owner_created_idx").on(table.ownerId, table.createdAt),
    index("document_import_runs_source_idx").on(table.sourceId),
    index("document_import_runs_target_idx").on(table.targetRoomId, table.targetDocumentId),
  ],
);

/** 不可变外部快照；artifact_ref 指向 files CAS 中的 CanonicalDocumentArtifact JSON。 */
export const documentImportSnapshots = sqliteTable(
  "document_import_snapshots",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => documentImportSources.id, { onDelete: "cascade" }),
    importRunId: text("import_run_id")
      .notNull()
      .references(() => documentImportRuns.id, { onDelete: "cascade" }),
    artifactRef: text("artifact_ref").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceRevision: text("source_revision"),
    commentsStatus: text("comments_status", {
      enum: ["complete", "partial", "unavailable", "failed"],
    }).$type<ExternalCommentsStatus>().notNull(),
    commentsHash: text("comments_hash"),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    warningsJson: text("warnings_json", { mode: "json" }).$type<ExternalDocumentWarning[]>().notNull().default([]),
  },
  (table) => [
    index("document_import_snapshots_source_idx").on(table.sourceId, table.capturedAt),
    index("document_import_snapshots_run_idx").on(table.importRunId),
    index("document_import_snapshots_content_idx").on(table.contentHash),
  ],
);

/** 快照随附的评论记录（只读，不参与正文版本编号）。 */
export const documentImportComments = sqliteTable(
  "document_import_comments",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => documentImportSnapshots.id, { onDelete: "cascade" }),
    remoteCommentId: text("remote_comment_id").notNull(),
    parentRemoteCommentId: text("parent_remote_comment_id"),
    authorJson: text("author_json", { mode: "json" }).$type<{ name: string | null } | null>(),
    body: text("body").notNull(),
    quotedText: text("quoted_text"),
    anchorJson: text("anchor_json", { mode: "json" }).$type<CanonicalComment["anchor"]>(),
    status: text("status", { enum: ["open", "resolved", "unknown"] }).notNull().default("unknown"),
    sourceUrl: text("source_url"),
    locationStatus: text("location_status", {
      enum: ["located", "unlocated", "unsupported"],
    }).$type<CanonicalComment["locationStatus"]>().notNull().default("unlocated"),
    commentCreatedAt: integer("comment_created_at", { mode: "timestamp_ms" }),
    commentUpdatedAt: integer("comment_updated_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("document_import_comments_snapshot_remote_idx").on(table.snapshotId, table.remoteCommentId),
    index("document_import_comments_snapshot_idx").on(table.snapshotId),
  ],
);

/** 导入与 Room 文档的关联；relation=candidate 表示"再次导入候选"，不覆盖当前版本。 */
export const documentRoomImports = sqliteTable(
  "document_room_imports",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    importRunId: text("import_run_id")
      .notNull()
      .references(() => documentImportRuns.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => documentImportSnapshots.id, { onDelete: "cascade" }),
    importedVersion: integer("imported_version"),
    relation: text("relation", { enum: ["primary", "candidate"] }).notNull().default("primary"),
    /** relation=candidate 时物化出的临时候选文档；应用后保留供追溯。 */
    candidateDocumentId: text("candidate_document_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("document_room_imports_room_document_idx").on(table.roomId, table.documentId),
    index("document_room_imports_run_idx").on(table.importRunId),
  ],
);

/** 连接器页批量导入：一次批量一行，逐项结果内联 JSON（≤50 项整行读写）。 */
export const documentImportBatches = sqliteTable(
  "document_import_batches",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    ownerId: text("owner_id").notNull().default("local-user"),
    provider: text("provider", { enum: ["feishu", "notion"] }).$type<ExternalDocumentProvider>().notNull(),
    connectionName: text("connection_name"),
    mode: text("mode", { enum: ["room", "auto"] }).$type<DocumentImportBatchMode>().notNull(),
    targetRoomId: text("target_room_id"),
    status: text("status", {
      enum: ["running", "completed", "failed", "cancelled"],
    }).$type<DocumentImportBatchStatus>().notNull().default("running"),
    total: integer("total").notNull(),
    processed: integer("processed").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    itemsJson: text("items_json", { mode: "json" })
      .$type<DocumentImportBatchItemView[]>()
      .notNull()
      .default([]),
    cancelRequested: integer("cancel_requested", { mode: "boolean" }).notNull().default(false),
    /** true：跳过来源去重，同来源一律新建工作区文稿（用户明确选"创建新的"）。 */
    forceNew: integer("force_new", { mode: "boolean" }).notNull().default(false),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("document_import_batches_owner_created_idx").on(table.ownerId, table.createdAt)],
);

/** 连接器页全量列举缓存：每 (provider, connectionName) 一行，面板打开先回显
 * 上次结果再按需刷新，避免每次进入都全量拉取远端。 */
export const documentImportListCache = sqliteTable(
  "document_import_list_cache",
  {
    provider: text("provider", { enum: ["feishu", "notion"] }).$type<ExternalDocumentProvider>().notNull(),
    /** 空 = 默认连接语义；与列表请求的 connectionName 一致。 */
    connectionName: text("connection_name").notNull().default(""),
    itemsJson: text("items_json", { mode: "json" })
      .$type<ExternalDocumentListItem[]>()
      .notNull()
      .default([]),
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    warningsJson: text("warnings_json", { mode: "json" })
      .$type<ExternalDocumentWarning[]>()
      .notNull()
      .default([]),
    itemCount: integer("item_count").notNull().default(0),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    /** 最近一次写入的同步方式：full=全量替换（清删除），delta=增量合并。 */
    syncMode: text("sync_mode", { enum: ["full", "delta"] }),
    /** 增量水位线（取已见条目最大 updatedAt）：delta 从此时间往前 5 分钟重叠窗拉取。 */
    watermarkAt: integer("watermark_at", { mode: "timestamp_ms" }),
    /** 最近一次全量对账时间：超过 24h 由同步 worker 触发全量，清掉远端已删文档。 */
    lastFullAt: integer("last_full_at", { mode: "timestamp_ms" }),
  },
  (table) => [primaryKey({ columns: [table.provider, table.connectionName] })],
);

// ═══════════════════ 文档本地评论（与外部导入评论共用面板） ═══════════════════

/** 文档本地评论：正文内用户手动添加，支持回复与解决；与导入的飞书评论相互独立。 */
export const documentComments = sqliteTable(
  "document_comments",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    blockId: text("block_id"),
    quotedText: text("quoted_text"),
    body: text("body").notNull(),
    authorName: text("author_name").notNull().default("我"),
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("document_comments_document_idx").on(table.documentId, table.createdAt),
    index("document_comments_parent_idx").on(table.parentId),
  ],
);

// ═══════════════════ Agent 文档导出（一次性发布，无远端 binding） ═══════════════════

/** 一次性导出任务：记录由哪个 Room 文档版本、何时、以何种 CLI/skill 写到哪里。 */
export const agentDocumentExports = sqliteTable(
  "agent_document_exports",
  {
    id: text("id").primaryKey(),
    requestId: text("request_id").notNull(),
    ownerId: text("owner_id").notNull().default("local-user"),
    roomId: text("room_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    provider: text("provider", { enum: ["feishu", "notion"] }).$type<ExternalDocumentProvider>().notNull(),
    mode: text("mode", { enum: ["create", "update", "export_file"] }).$type<AgentDocumentExportMode>().notNull(),
    targetJson: text("target_json", { mode: "json" }).$type<AgentDocumentExportTarget | null>(),
    rendererVersion: text("renderer_version"),
    payloadHash: text("payload_hash"),
    payloadMarkdownRef: text("payload_markdown_ref"),
    cliSkillRef: text("cli_skill_ref"),
    status: text("status", {
      enum: [
        "preparing",
        "environment_not_ready",
        "awaiting_auth",
        "awaiting_confirmation",
        "running",
        "succeeded",
        "failed",
        "needs_review",
        "cancelled",
      ],
    }).$type<AgentDocumentExportStatus>().notNull().default("preparing"),
    challengeJson: text("challenge_json", { mode: "json" }).$type<AgentAuthChallengeView | null>(),
    confirmationJson: text("confirmation_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    remoteResultJson: text("remote_result_json", { mode: "json" }).$type<Record<string, unknown> | null>(),
    warningsJson: text("warnings_json", { mode: "json" }).$type<ExternalDocumentWarning[]>().notNull().default([]),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("agent_document_exports_owner_created_idx").on(table.ownerId, table.createdAt),
    index("agent_document_exports_document_idx").on(table.documentId),
  ],
);

// ═══════════════════ Knowledge 路由层（docs/entity-room-plan.md） ═══════════════════
/** ②b 层映射规则：仅 manual（用户显式配置），默认为空，纯可选逃生舱；不做自动回写。 */
export const routingRules = sqliteTable("routing_rules", {
  id: text("id").primaryKey(),
  /** 匹配条件（JSON）：{ sourceTag?, filenamePrefix?, threadId?, titleKeyword?, creatorId? }，字段间 AND。 */
  matcher: text("matcher", { mode: "json" }).notNull(),
  targetRoomId: text("target_room_id").notNull(),
  origin: text("origin").notNull().default("manual"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  hitCount: integer("hit_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastHitAt: integer("last_hit_at", { mode: "timestamp_ms" }),
});

/**
 * 上传文件本体登记（room-wiki 方案 §资料模型修订）。
 * 身份 = 规范化文件名（B 案：同名重传同 ID = 版本更新，改名 = 新文件）；
 * 内容 = 版本：content_hash 变化即新版本，原始字节住对象库。
 */
export const uploadedFiles = sqliteTable("uploaded_files", {
  /** file-<规范化文件名 sha256 前 12 位>：确定性派生，判重闸 1 的身份键。 */
  id: text("id").primaryKey(),
  /** 当前版本的原始字节 sha256（判重闸 1 的内容键）。 */
  contentHash: text("content_hash").notNull(),
  /** 对象库相对路径（相对 gateway dataDir）：files/sha256/<前2字符>/<hash>。 */
  storagePath: text("storage_path").notNull(),
  originalName: text("original_name").notNull(),
  bytes: integer("bytes").notNull(),
  mime: text("mime").notNull().default("text/markdown"),
  /** Asset semantics are explicit so diary/perception never infer privacy from filenames. */
  assetKind: text("asset_kind", {
    enum: ["document", "screenshot", "photo", "audio", "other"],
  }).notNull().default("document"),
  originChannel: text("origin_channel").notNull().default("upload"),
  visibility: text("visibility", { enum: ["private", "shared"] }).notNull().default("private"),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }),
  /** 当前生效的解析产物（后级路由/ingest 只读 parsed_contents.markdown）。 */
  currentParsedId: text("current_parsed_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 统一文件目录（统一文件目录与 ingest 设计）。
 * uploaded_files 在兼容期继续存在；新入口以 file_entries/file_versions 为
 * 权威目录，原始字节按 hash 复用 file_blobs。
 */
export const fileBlobs = sqliteTable("file_blobs", {
  contentHash: text("content_hash").primaryKey(),
  storagePath: text("storage_path").notNull().unique(),
  byteSize: integer("byte_size").notNull(),
  mime: text("mime").notNull().default("application/octet-stream"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const fileEntries = sqliteTable(
  "file_entries",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind", {
      enum: ["manual-upload", "local-folder", "connector", "migration", "web-clipper", "legacy-upload", "agent-generated", "artifact-imported"],
    }).notNull(),
    sourceKey: text("source_key").notNull(),
    originalName: text("original_name").notNull(),
    displayName: text("display_name"),
    extension: text("extension").notNull(),
    provider: text("provider"),
    connectionId: text("connection_id"),
    localSourceId: text("local_source_id"),
    localItemId: text("local_item_id"),
    /** 本地文件只引用用户磁盘上的原路径，不在 EverRoom 对象库保留原始字节镜像。 */
    sourcePath: text("source_path"),
    /** 归属工作区（资料库/产物库按空间隔离）；NULL 按服务层归一为 default。 */
    workspaceId: text("workspace_id"),
    relativePath: text("relative_path"),
    sourceUri: text("source_uri"),
    currentVersionId: text("current_version_id"),
    state: text("state", {
      enum: ["processing", "ready", "failed", "missing", "deleted"],
    }).notNull().default("processing"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("file_entries_source_key_idx").on(table.sourceKind, table.sourceKey),
    index("file_entries_state_updated_idx").on(table.state, table.updatedAt),
    index("file_entries_local_item_idx").on(table.localSourceId, table.localItemId),
    index("file_entries_workspace_idx").on(table.workspaceId),
    // 文件页目录分页（WHERE deleted_at IS NULL ORDER BY updated_at DESC）的覆盖索引：
    // 缺它时每页都要全表 SCAN + 临时 B-Tree 排序，桌面端一次全量刷新（17k 条目 ≈ 87 页
    // 并发）会把网关主线程占满数十秒，健康检查随之超时。见 0087 迁移。
    index("file_entries_deleted_updated_idx").on(table.deletedAt, sql`${table.updatedAt} desc`),
  ],
);

export const fileVersions = sqliteTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    fileEntryId: text("file_entry_id").notNull().references(() => fileEntries.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    contentHash: text("content_hash").notNull().references(() => fileBlobs.contentHash),
    sourceModifiedAt: integer("source_modified_at", { mode: "timestamp_ms" }),
    parserId: text("parser_id").notNull(),
    parserVersion: integer("parser_version").notNull(),
    parsedId: text("parsed_id").references(() => parsedContents.id),
    ingestEventId: text("ingest_event_id"),
    status: text("status", {
      enum: ["stored", "queued", "parsing", "parsed", "failed"],
    }).notNull().default("stored"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("file_versions_entry_version_idx").on(table.fileEntryId, table.versionNo),
    uniqueIndex("file_versions_entry_hash_idx").on(table.fileEntryId, table.contentHash),
    index("file_versions_hash_idx").on(table.contentHash),
    index("file_versions_status_created_idx").on(table.status, table.createdAt),
  ],
);

/**
 * 文件版本的结构化多模态解析产物。第一阶段将完整 Canonical Artifact
 * 保存在 JSON 中；高频的 page/block/table 索引在查询需求稳定后再拆表。
 */
export const parsedDocuments = sqliteTable(
  "parsed_documents",
  {
    id: text("id").primaryKey(),
    fileVersionId: text("file_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
    parserRevision: text("parser_revision").notNull(),
    format: text("format", {
      enum: ["pdf", "docx", "xlsx", "pptx", "legacy-office"],
    }).notNull(),
    artifact: text("artifact", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    markdown: text("markdown").notNull(),
    quality: text("quality", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("parsed_documents_version_revision_idx").on(table.fileVersionId, table.parserRevision),
    index("parsed_documents_format_created_idx").on(table.format, table.createdAt),
  ],
);

export const fileClassifications = sqliteTable(
  "file_classifications",
  {
    id: text("id").primaryKey(),
    fileVersionId: text("file_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    summary: text("summary").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    embedding: text("embedding", { mode: "json" }).$type<number[]>(),
    confidence: real("confidence").notNull(),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("file_classifications_version_idx").on(table.fileVersionId)],
);

/**
 * 解析产物表（判重闸 2）：md 是唯一权威派生形态，后级只处理 md。
 * (content_hash, parser_version) 唯一 —— 同内容同解析器零重复解析；
 * 解析器升级（版本号变）是唯一合法的重解析场景。
 */
export const parsedContents = sqliteTable(
  "parsed_contents",
  {
    id: text("id").primaryKey(),
    contentHash: text("content_hash").notNull(),
    parserVersion: text("parser_version").notNull(),
    markdown: text("markdown").notNull(),
    parsedAt: integer("parsed_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("parsed_contents_hash_parser_idx").on(table.contentHash, table.parserVersion),
  ],
);

/** User-managed Agent schedules. Phase 1 起调度器不再注入内置任务，
 * 表内记录与接口返回一一对应。 */
export const agentSchedules = sqliteTable(
  "agent_schedules",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    prompt: text("prompt").notNull(),
    scheduleType: text("schedule_type", { enum: ["daily"] }).notNull().default("daily"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    localTime: text("local_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("UTC"),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastStatus: text("last_status", { enum: ["pending", "running", "completed", "failed"] }),
    lastError: text("last_error"),
    configVersion: integer("config_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("agent_schedules_due_idx").on(table.enabled, table.nextRunAt)],
);

export interface DiaryPayload {
  headline: string;
  summary: string;
  reflection: string;
  range: { start: string; end: string };
  events: Array<{
    time: string;
    endTime?: string;
    title: string;
    summary: string;
    sourceRefs: string[];
    tags?: string[];
  }>;
  closing: string;
}

// ═══════════════════ 统一理解引擎（docs/unified-ingest-plan.md）═══════════════════

/** 三链路开关（Room / wiki / 记忆）。wiki 依赖 Room（U2：无 Room 不设全局 wiki）。 */
export interface IngestPipelines {
  room: boolean;
  wiki: boolean;
  memory: boolean;
}

/** 记忆链路扇出结果：成功摘要或错误（失败不阻塞 Room 链路）。 */
export interface IngestMemoryOk {
  documentId: string;
  chunkCount: number;
  deduplicated: boolean;
}

/** agent 过滤器判定（ingest 第一级闸门）：无价值资料不进下游链路。 */
export interface IngestFilterVerdict {
  informative: boolean;
  /** 判定依据（台账可见，用户能理解为什么被过滤）。 */
  reason: string;
  /** 细分类：bot-noise | trivial | template | empty | other */
  category: string;
  /** 置信 0~1，低于阈值放行（宁漏勿错杀）。 */
  confidence: number;
  /** 状态/参考分流（2026-09-24 定案）：这条数据会被更新/覆盖、需要唯一
   * 权威版本吗。true 时即便类型默认 memory:false（参考型兜底）也单独打开
   * 记忆链路；缺省 = 未判定，不触发恢复（fail-closed，保 token）。 */
  stateLike?: boolean;
}

/**
 * 统一进入台账（§6.1/U3）：每次经 /v1/ingest 进入的资料一行，
 * 含类型识别结果与策略快照——晋升/增量 ingest 的 wiki 判定读快照而非
 * 实时 policy（策略事后变化不应让已进入的资料行为漂移）。
 * 引擎只记自己做的；Room/wiki 下游状态继续查 knowledge 既有表（§6.3）。
 */
export const subagentDefinitions = sqliteTable("subagent_definitions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  currentRevisionId: text("current_revision_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const subagentRevisions = sqliteTable(
  "subagent_revisions",
  {
    id: text("id").primaryKey(),
    agentDefinitionId: text("agent_definition_id").notNull().references(() => subagentDefinitions.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    digest: text("digest").notNull(),
    manifest: text("manifest", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    systemPrompt: text("system_prompt").notNull(),
    agentDirectory: text("agent_directory").notNull(),
    mcpServers: text("mcp_servers", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    policy: text("policy", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    inputSchema: text("input_schema", { mode: "json" }).$type<Record<string, unknown>>(),
    outputSchema: text("output_schema", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("subagent_revisions_definition_version_idx").on(table.agentDefinitionId, table.version),
    uniqueIndex("subagent_revisions_definition_digest_idx").on(table.agentDefinitionId, table.digest),
  ],
);

export const subagentInvocations = sqliteTable(
  "subagent_invocations",
  {
    id: text("id").primaryKey(),
    agentDefinitionId: text("agent_definition_id").notNull().references(() => subagentDefinitions.id, { onDelete: "restrict" }),
    agentRevisionId: text("agent_revision_id").notNull().references(() => subagentRevisions.id, { onDelete: "restrict" }),
    source: text("source", { enum: ["primary_agent", "scheduler", "internal_workflow"] }).notNull(),
    parentSessionId: text("parent_session_id"),
    parentRunId: text("parent_run_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    task: text("task").notNull(),
    input: text("input", { mode: "json" }).$type<unknown>().notNull(),
    status: text("status", { enum: ["accepted", "running", "completed", "failed", "cancelled", "interrupted", "timed_out"] }).notNull().default("accepted"),
    runtimeSessionRef: text("runtime_session_ref"),
    lastEventSeq: integer("last_event_seq").notNull().default(0),
    result: text("result", { mode: "json" }).$type<SubagentInvocationResult>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("subagent_invocations_source_idempotency_idx").on(table.source, table.parentRunId, table.idempotencyKey),
    index("subagent_invocations_status_created_idx").on(table.status, table.createdAt),
  ],
);

export interface LocalAgentDispatchMaterialRecord {
  id: string;
  kind: string;
  title: string;
  chars: number;
  truncated: boolean;
  agentOutput: boolean;
  sourceDispatchId: string | null;
}

/** slides 风格会话（无模版风格管线的跨轮次状态）。 */
export const slidesStyleSessions = sqliteTable(
  "slides_style_sessions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    draftDocumentId: text("draft_document_id"),
    instruction: text("instruction").notNull().default(""),
    /** 用户累积反馈（「不要太蓝」等），逐条进入下轮生图提示词。 */
    feedback: text("feedback", { mode: "json" }).$type<string[]>().notNull().default([]),
    /** 候选纵览图（contentHash 寻址回源 /v1/materials/:hash）。 */
    overviewImages: text("overview_images", { mode: "json" })
      .$type<Array<{ contentHash: string; generation: number }>>()
      .notNull()
      .default([]),
    selectedImageHash: text("selected_image_hash"),
    styleParams: text("style_params", { mode: "json" }).$type<unknown>(),
    demoImageHash: text("demo_image_hash"),
    stage: text("stage", { enum: ["images_ready", "extracting", "card_ready", "confirmed"] }).notNull(),
    /** 第几次「不满意」重生成（提示词反馈累积层数）。 */
    generation: integer("generation").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("slides_style_sessions_room_idx").on(table.roomId, table.stage),
  ],
);

/** slides 正文配图会话（配图缺口的确认/过目两等待阶段的跨轮次状态）。 */
export const slidesPageImageSessions = sqliteTable(
  "slides_page_image_sessions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    draftDocumentId: text("draft_document_id").notNull(),
    styleSessionId: text("style_session_id"),
    stage: text("stage", { enum: ["confirm", "review", "settling", "resolved"] }).notNull(),
    /** 第几轮重生成（单张重掷递增，前端凭它重开过目卡）。 */
    generation: integer("generation").notNull().default(1),
    /** arrange 全量落页方案（等待期间唯一事实来源，resume 不重排）。 */
    plan: text("plan", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** 待配图页：pageIndex 指向 plan.pages 下标；rejected=过目打回（落页时剥图）。 */
    pages: text("pages", { mode: "json" })
      .$type<Array<{ pageIndex: number; title: string; imagePrompt: string; contentHash: string | null; rejected?: boolean }>>()
      .notNull()
      .default([]),
    /** 创建时从风格卡固化的调色板（重生成复用，避免跨存储回查）。 */
    stylePalette: text("style_palette", { mode: "json" })
      .$type<{ primary?: string; accent?: string; background?: string } | null>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("slides_page_image_sessions_draft_idx").on(table.roomId, table.draftDocumentId),
  ],
);

/** Durable generation progress; identity includes content, agent revisions and model configuration. */
export const slidesGenerationCheckpoints = sqliteTable("slides_generation_checkpoints", {
  key: text("key").primaryKey(),
  state: text("state", { mode: "json" })
    .$type<import("../../modules/subagents/slides-generation-checkpoints.js").SlidesGenerationCheckpoint>().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** slides 编辑层 storyboard（M1 影子模式）：按草稿 + 内容 hash 存最近一次的压缩结果与验收报告。 */
export const slidesStoryboards = sqliteTable(
  "slides_storyboards",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    draftDocumentId: text("draft_document_id").notNull(),
    /** 用户确认后草稿内容 hash：同一草稿再编辑即视为新版本。 */
    draftHash: text("draft_hash").notNull(),
    /** storyboard/v2 全量 JSON（editor 输出）。 */
    storyboard: text("storyboard", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** 网关确定性验收报告（errors/warnings/字数）。 */
    report: text("report", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("slides_storyboards_draft_idx").on(table.roomId, table.draftDocumentId),
  ],
);

/** 论文格式卡（thesis-format 管线）：一工作区多卡，同工作区内 (workspace_id, source_name) 唯一，重传同名模版即覆盖。 */
export const thesisFormatCards = sqliteTable(
  "thesis_format_cards",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    /** validate 后的 ThesisFormatCard 全量 JSON。 */
    formatCard: text("format_card", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** 设为模版的库内文件（parseFromDisk 直传时为空）。 */
    sourceFileEntryId: text("source_file_entry_id"),
    sourceName: text("source_name").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("thesis_format_cards_workspace_source_idx").on(table.workspaceId, table.sourceName),
  ],
);

export const localAgentDispatches = sqliteTable(
  "local_agent_dispatches",
  {    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    parentRunId: text("parent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    displayName: text("display_name").notNull(),
    provider: text("provider").notNull(),
    assignment: text("assignment").notNull(),
    sharedGoal: text("shared_goal"),
    constraints: text("constraints", { mode: "json" }).$type<string[]>().notNull().default([]),
    materials: text("materials", { mode: "json" }).$type<LocalAgentDispatchMaterialRecord[]>().notNull().default([]),
    packageJson: text("package_json").notNull(),
    packageDigest: text("package_digest").notNull(),
    packageVersion: integer("package_version").notNull(),
    status: text("status", {
      enum: ["pending", "running", "completed", "failed", "cancelled", "timed_out"],
    }).notNull().default("pending"),
    resultText: text("result_text"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    subRunId: text("sub_run_id"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("local_agent_dispatches_parent_run_idx").on(table.parentRunId),
    index("local_agent_dispatches_session_created_idx").on(table.sessionId, table.createdAt),
  ],
);

export const subagentInvocationEvents = sqliteTable(
  "subagent_invocation_events",
  {
    id: text("id").primaryKey(),
    invocationId: text("invocation_id").notNull().references(() => subagentInvocations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("subagent_invocation_events_invocation_seq_idx").on(table.invocationId, table.seq)],
);

/**
 * 统一搜索索引（PRD 0.2.0 §2.5）：每类内容一行，itemType+refId 即去重身份。
 * 元信息先行（status=meta_only），正文解析后经队列写入 FTS（status=indexed）。
 * FTS5 虚拟表 search_index_fts 由应用层维护，rowid 对齐本表 id 的 INTEGER 行号。
 */
export const searchIndex = sqliteTable(
  "search_index",
  {
    id: text("id").primaryKey(),
    itemType: text("item_type", {
      enum: ["file", "message", "room", "document", "export"],
    }).notNull(),
    refId: text("ref_id").notNull(),
    title: text("title").notNull(),
    bodyPreview: text("body_preview").notNull().default(""),
    sourceKind: text("source_kind"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }),
    ingestedAt: integer("ingested_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    timeBasis: text("time_basis", { enum: ["occurred", "ingested"] }).notNull().default("ingested"),
    fileVersionId: text("file_version_id"),
    versionLabel: text("version_label"),
    /** itemType=message 时存所属会话 id（结果跳转用）；其余为 null。 */
    sessionId: text("session_id"),
    status: text("status", {
      enum: ["meta_only", "indexed", "failed"],
    })
      .notNull()
      .default("meta_only"),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("search_index_item_ref_idx").on(table.itemType, table.refId),
    index("search_index_status_idx").on(table.status),
    index("search_index_item_type_idx").on(table.itemType),
  ],
);

/**
 * 外部 Agent 连接（PRD 0.2.0 第 7 章 L2.5）：Agent 连接页签发的持久凭证。
 * token 只存 sha256（tokenHash），创建/轮换时明文返回一次；status=paused
 * 拒绝校验但保留，revoked 终结。scopes 为能力 + Room 范围 + 回写位置的快照。
 */
export const agentConnections = sqliteTable(
  "agent_connections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    tool: text("tool", {
      enum: ["claude-code", "cursor", "codex", "cherry-studio", "openclaw", "hermes", "generic"],
    }).notNull(),
    tokenHash: text("token_hash").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<{
      roomIds: string[] | "all";
      capabilities: string[];
      writebackRoomId: string | null;
    }>().notNull(),
    status: text("status", { enum: ["active", "paused", "revoked"] }).notNull().default("active"),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    exampleQueryAt: integer("example_query_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("agent_connections_token_hash_idx").on(table.tokenHash),
    index("agent_connections_status_idx").on(table.status),
  ],
);

/**
 * 外部 Agent 幂等提交（PRD 7.4 / A.3 提交键）：会话增量、结果文本、产物文件、
 * 来源引用与候选统一落此表，(connectionId, clientSubmissionId) 唯一去重，
 * 重试重放返回已存结果（duplicate）。items 保留原始载荷（含两链合并键：
 * 平台/线程/消息 ID + 内容），results 为逐项处理结果。
 */
export const agentSubmissions = sqliteTable(
  "agent_submissions",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull().references(() => agentConnections.id, { onDelete: "cascade" }),
    clientSubmissionId: text("client_submission_id").notNull(),
    items: text("items", { mode: "json" }).$type<unknown[]>().notNull(),
    status: text("status", {
      enum: ["received", "completed", "partial_failed", "rejected"],
    }).notNull().default("received"),
    results: text("results", { mode: "json" }).$type<unknown[] | null>(),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("agent_submissions_connection_client_idx").on(table.connectionId, table.clientSubmissionId),
    index("agent_submissions_recent_idx").on(table.connectionId, table.createdAt),
  ],
);

/** 外部 Agent 访问事件（PRD 7.5 调试页）：每次 MCP 调用/连接/提交一行，每连接保留最近 200 条。 */
export const agentAccessEvents = sqliteTable(
  "agent_access_events",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull().references(() => agentConnections.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["call", "connect", "submit"] }).notNull(),
    tool: text("tool"),
    status: text("status").notNull(),
    durationMs: integer("duration_ms"),
    detail: text("detail", { mode: "json" }).$type<Record<string, unknown> | null>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("agent_access_events_recent_idx").on(table.connectionId, table.createdAt)],
);
