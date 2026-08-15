import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("doc_versions_document_version_idx").on(table.documentId, table.version)],
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
