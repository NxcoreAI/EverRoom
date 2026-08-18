import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  AgentNavigationTarget,
  DocumentOperationInteractionMode,
  DocumentOperationItemStatus,
  DocumentOperationStatus,
  DocumentMutationTarget,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import type {
  RealityCaptureDevice,
  RealityInsights,
  RealityMarker,
  RealityTranscriptSegment,
} from "@nxcore/reality-contract";

export const gatewayMetadata = sqliteTable("gateway_metadata", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const jobs = sqliteTable("jobs", {
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
});

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

export const agentSessions = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  roomId: text("room_id"),
  pageLabel: text("page_label").notNull(),
  runtimeId: text("runtime_id").notNull(),
  runtimeSessionRef: text("runtime_session_ref"),
  title: text("title"),
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

export const contextRooms = sqliteTable(
  "context_rooms",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    kind: text("kind"),
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    position: integer("position").notNull().default(0),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("context_rooms_deleted_idx").on(table.deletedAt),
    index("context_rooms_updated_idx").on(table.updatedAt),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
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
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

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
      enum: ["document.create", "document.edit", "document.continue"],
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
  activeTransactionId: text("active_transaction_id"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const roomDocumentLinks = sqliteTable(
  "room_doc_links",
  {
    roomId: text("room_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    linkedAt: integer("linked_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_doc_links_room_document_idx").on(table.roomId, table.documentId),
    index("room_doc_links_room_idx").on(table.roomId),
  ],
);

export const documentVersions = sqliteTable(
  "doc_versions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull().default("无标题文档"),
    contentJson: text("content_json", { mode: "json" }).notNull(),
    contentSchemaVersion: integer("content_schema_version").notNull().default(1),
    sourceTransactionId: text("source_transaction_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_versions_document_version_idx").on(table.documentId, table.version)],
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
    roomId: text("room_id").notNull(),
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

export const realityEvents = sqliteTable(
  "reality_events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["ongoing", "pending_confirmation", "completed", "failed", "pending_sync"],
    }).notNull(),
    processingState: text("processing_state", {
      enum: ["capturing", "saving", "transcribing", "understanding", "ready", "failed"],
    }).notNull(),
    captureDevice: text("capture_device", { mode: "json" }).$type<RealityCaptureDevice>().notNull(),
    processingDevice: text("processing_device").notNull(),
    audioSource: text("audio_source", { enum: ["microphone", "system"] }).notNull(),
    audioFileName: text("audio_file_name"),
    audioMimeType: text("audio_mime_type"),
    durationMs: integer("duration_ms").notNull().default(0),
    currentTopic: text("current_topic"),
    transcript: text("transcript").notNull().default(""),
    transcriptSegments: text("transcript_segments", { mode: "json" })
      .$type<RealityTranscriptSegment[]>().notNull(),
    transcriptEditedAt: integer("transcript_edited_at", { mode: "timestamp_ms" }),
    insights: text("insights", { mode: "json" }).$type<RealityInsights>().notNull(),
    markers: text("markers", { mode: "json" }).$type<RealityMarker[]>().notNull(),
    important: integer("important", { mode: "boolean" }).notNull().default(false),
    asrJobId: text("asr_job_id"),
    asrSource: text("asr_source", { enum: ["local", "saas"] }),
    resultVersion: integer("result_version").notNull().default(0),
    error: text("error"),
    version: integer("version").notNull().default(1),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("reality_events_asr_job_idx").on(table.asrJobId)],
);
