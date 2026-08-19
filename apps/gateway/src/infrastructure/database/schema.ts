import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  AgentNavigationTarget,
  DocumentPatchOperation,
  DocumentPatchTarget,
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

export const connectorAccounts = sqliteTable(
  "connector_accounts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    connectionName: text("connection_name").notNull(),
    status: text("status", {
      enum: ["active", "needs_connection", "disabled"],
    }).notNull().default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("connector_accounts_owner_service_connection_idx")
      .on(table.ownerId, table.service, table.connectionName),
    index("connector_accounts_owner_idx").on(table.ownerId),
  ],
);

export const connectorSyncJobs = sqliteTable(
  "connector_sync_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    action: text("action").notNull(),
    allowedActions: text("allowed_actions", { mode: "json" }).$type<string[]>().notNull().default([]),
    dataset: text("dataset").notNull(),
    resourceType: text("resource_type", { enum: ["email", "document", "calendar", "generic"] }).notNull().default("generic"),
    connectionName: text("connection_name"),
    input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    goal: text("goal").notNull().default(""),
    prompt: text("prompt"),
    promptVersion: integer("prompt_version").notNull().default(1),
    schemaVersion: integer("schema_version").notNull().default(1),
    checkpoint: text("checkpoint", { mode: "json" }).$type<Record<string, unknown>>(),
    intervalMs: integer("interval_ms").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("connector_sync_jobs_due_idx").on(table.enabled, table.nextRunAt),
    index("connector_sync_jobs_owner_idx").on(table.ownerId),
  ],
);

export const connectorSyncRuns = sqliteTable(
  "connector_sync_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => connectorSyncJobs.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["running", "success", "failed", "blocked_runtime", "needs_connection"],
    }).notNull(),
    cursor: text("cursor"),
    discovered: integer("discovered").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    agentModel: text("agent_model"),
    promptVersion: integer("prompt_version").notNull().default(1),
    schemaVersion: integer("schema_version").notNull().default(1),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("connector_sync_runs_job_started_idx").on(table.jobId, table.startedAt),
  ],
);

export const connectorRecords = sqliteTable(
  "connector_records",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    dataset: text("dataset").notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }),
    contentHash: text("content_hash").notNull(),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("connector_records_owner_source_idx")
      .on(table.ownerId, table.service, table.dataset, table.sourceRecordId),
    index("connector_records_owner_dataset_idx").on(table.ownerId, table.dataset),
    index("connector_records_synced_idx").on(table.syncedAt),
  ],
);

const connectorDomainColumns = {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  service: text("service").notNull(),
  connectionName: text("connection_name"),
  sourceRecordId: text("source_record_id").notNull(),
  sourceUpdatedAt: integer("source_updated_at", { mode: "timestamp_ms" }),
  syncedAt: integer("synced_at", { mode: "timestamp_ms" }).notNull(),
  schemaVersion: integer("schema_version").notNull(),
  promptVersion: integer("prompt_version").notNull(),
  contentHash: text("content_hash").notNull(),
  extensionPayload: text("extension_payload", { mode: "json" }).$type<Record<string, unknown>>(),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
};

export const connectorEmails = sqliteTable(
  "connector_emails",
  {
    ...connectorDomainColumns,
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    senderName: text("sender_name"),
    senderAddress: text("sender_address"),
    recipients: text("recipients", { mode: "json" }).$type<Array<{ name?: string; address: string }>>().notNull(),
    subject: text("subject").notNull(),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    bodyText: text("body_text").notNull(),
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull(),
    hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("connector_emails_owner_source_idx")
      .on(table.ownerId, table.service, table.connectionName, table.sourceRecordId),
    index("connector_emails_owner_sent_idx").on(table.ownerId, table.sentAt),
    index("connector_emails_owner_sender_idx").on(table.ownerId, table.senderAddress),
    index("connector_emails_owner_message_idx").on(table.ownerId, table.messageId),
  ],
);

export const connectorDocuments = sqliteTable(
  "connector_documents",
  {
    ...connectorDomainColumns,
    documentId: text("document_id").notNull(),
    title: text("title").notNull(),
    ownerName: text("owner_name"),
    documentType: text("document_type"),
    bodyText: text("body_text").notNull(),
    sourceUrl: text("source_url"),
  },
  (table) => [
    uniqueIndex("connector_documents_owner_source_idx")
      .on(table.ownerId, table.service, table.connectionName, table.sourceRecordId),
    index("connector_documents_owner_updated_idx").on(table.ownerId, table.sourceUpdatedAt),
    index("connector_documents_owner_document_idx").on(table.ownerId, table.documentId),
  ],
);

export const connectorCalendarEvents = sqliteTable(
  "connector_calendar_events",
  {
    ...connectorDomainColumns,
    eventId: text("event_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    organizer: text("organizer", { mode: "json" }).$type<{ name?: string; address?: string }>(),
    attendees: text("attendees", { mode: "json" }).$type<Array<{ name?: string; address?: string; status?: string }>>().notNull(),
    startAt: integer("start_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    status: text("status"),
    location: text("location"),
  },
  (table) => [
    uniqueIndex("connector_calendar_events_owner_source_idx")
      .on(table.ownerId, table.service, table.connectionName, table.sourceRecordId),
    index("connector_calendar_events_owner_start_idx").on(table.ownerId, table.startAt),
    index("connector_calendar_events_owner_event_idx").on(table.ownerId, table.eventId),
  ],
);

export const connectorQuarantinedRecords = sqliteTable(
  "connector_quarantined_records",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    jobId: text("job_id").notNull().references(() => connectorSyncJobs.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull().references(() => connectorSyncRuns.id, { onDelete: "cascade" }),
    sourceRecordId: text("source_record_id"),
    reason: text("reason").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("connector_quarantined_records_run_idx").on(table.runId),
    index("connector_quarantined_records_owner_idx").on(table.ownerId, table.createdAt),
  ],
);

export const connectorAuditEvents = sqliteTable(
  "connector_audit_events",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    requestId: text("request_id").notNull(),
    actor: text("actor").notNull(),
    operation: text("operation").notNull(),
    effect: text("effect").notNull(),
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("connector_audit_events_owner_created_idx").on(table.ownerId, table.createdAt),
    index("connector_audit_events_request_idx").on(table.requestId),
  ],
);

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

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  contentJson: text("content_json", { mode: "json" }).notNull(),
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
    contentJson: text("content_json", { mode: "json" }).notNull(),
    sourceTransactionId: text("source_transaction_id"),
    sourcePatchId: text("source_patch_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_versions_document_version_idx").on(table.documentId, table.version)],
);

export const documentBlocks = sqliteTable(
  "document_blocks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    parentBlockId: text("parent_block_id"),
    type: text("type").notNull(),
    ordinal: integer("ordinal").notNull(),
    path: text("path", { mode: "json" }).$type<number[]>().notNull(),
    textPreview: text("text_preview").notNull(),
  },
  (table) => [
    uniqueIndex("document_blocks_document_ordinal_idx").on(table.documentId, table.ordinal),
    index("document_blocks_document_idx").on(table.documentId),
  ],
);

export const documentPatches = sqliteTable(
  "document_patches",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    agentSessionId: text("agent_session_id").notNull(),
    runId: text("run_id").notNull(),
    kind: text("kind", { enum: ["continue", "edit"] }).notNull(),
    status: text("status", {
      enum: ["building", "pending", "applied", "rejected", "conflicted", "aborted", "expired"],
    }).notNull().default("building"),
    summary: text("summary").notNull(),
    baseVersion: integer("base_version").notNull(),
    baseContentJson: text("base_content_json", { mode: "json" }).$type<TiptapJsonContent>().notNull(),
    proposedContentJson: text("proposed_content_json", { mode: "json" }).$type<TiptapJsonContent>().notNull(),
    nextSequence: integer("next_sequence").notNull().default(1),
    acceptedHunkIds: text("accepted_hunk_ids", { mode: "json" }).$type<string[]>(),
    rejectedHunkIds: text("rejected_hunk_ids", { mode: "json" }).$type<string[]>(),
    acceptedBlockIds: text("accepted_block_ids", { mode: "json" }).$type<string[]>(),
    rejectedBlockIds: text("rejected_block_ids", { mode: "json" }).$type<string[]>(),
    appliedVersion: integer("applied_version"),
    conflictVersion: integer("conflict_version"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("document_patches_document_status_idx").on(table.documentId, table.status),
    index("document_patches_session_status_idx").on(table.agentSessionId, table.status),
    index("document_patches_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const documentPatchHunks = sqliteTable(
  "document_patch_hunks",
  {
    id: text("id").primaryKey(),
    patchId: text("patch_id")
      .notNull()
      .references(() => documentPatches.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    operation: text("operation", { enum: ["insert", "replace", "delete"] })
      .$type<DocumentPatchOperation>().notNull(),
    target: text("target", { mode: "json" }).$type<DocumentPatchTarget>().notNull(),
    markdown: text("markdown").notNull(),
    sha256: text("sha256").notNull(),
    beforeJson: text("before_json", { mode: "json" }).$type<TiptapJsonContent[]>().notNull(),
    afterJson: text("after_json", { mode: "json" }).$type<TiptapJsonContent[]>().notNull(),
    addedCharacters: integer("added_characters").notNull().default(0),
    deletedCharacters: integer("deleted_characters").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("document_patch_hunks_patch_sequence_idx").on(table.patchId, table.sequence)],
);

export const documentTransactions = sqliteTable(
  "doc_transactions",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id").notNull(),
    roomId: text("room_id").notNull(),
    agentSessionId: text("agent_session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    status: text("status", {
      enum: ["open", "committed", "aborted", "expired", "interrupted"],
    }).notNull().default("open"),
    nextSequence: integer("next_sequence").notNull().default(1),
    totalBytes: integer("total_bytes").notNull().default(0),
    workingContentJson: text("working_content_json", { mode: "json" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("doc_transactions_session_idx").on(table.agentSessionId),
    index("doc_transactions_expiry_idx").on(table.status, table.expiresAt),
  ],
);

export const documentOps = sqliteTable(
  "doc_ops",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => documentTransactions.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    markdown: text("markdown").notNull(),
    sha256: text("sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
    appliedContentJson: text("applied_content_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_ops_transaction_sequence_idx").on(table.transactionId, table.sequence)],
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
