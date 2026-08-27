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
import type {
  AgentNavigationTarget,
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
  source: text("source", { enum: ["user", "saas"] }).primaryKey(),
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

export const connectorAccounts = sqliteTable(
  "connector_accounts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    connectionName: text("connection_name").notNull(),
    displayName: text("display_name"),
    accountLabel: text("account_label"),
    credentialRef: text("credential_ref"),
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

export const connectorPromptProfiles = sqliteTable(
  "connector_prompt_profiles",
  {
    id: text("id").primaryKey(),
    service: text("service").notNull(),
    resourceType: text("resource_type", { enum: ["email", "document", "calendar", "todo", "generic"] }).notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    template: text("template").notNull(),
    schemaVersion: integer("schema_version").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    status: text("status", { enum: ["draft", "published", "retired"] }).notNull().default("draft"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("connector_prompt_profiles_service_version_idx").on(table.service, table.resourceType, table.version),
    index("connector_prompt_profiles_status_idx").on(table.status, table.service),
  ],
);

export const connectorSyncJobs = sqliteTable(
  "connector_sync_jobs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull().default("Connector sync"),
    service: text("service").notNull(),
    action: text("action").notNull(),
    allowedActions: text("allowed_actions", { mode: "json" }).$type<string[]>().notNull().default([]),
    dataset: text("dataset").notNull(),
    resourceType: text("resource_type", { enum: ["email", "document", "calendar", "todo", "generic"] }).notNull().default("generic"),
    connectionName: text("connection_name"),
    input: text("input", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    goal: text("goal").notNull().default(""),
    prompt: text("prompt"),
    promptProfileId: text("prompt_profile_id").references(() => connectorPromptProfiles.id),
    promptOverride: text("prompt_override"),
    promptVersion: integer("prompt_version").notNull().default(1),
    schemaVersion: integer("schema_version").notNull().default(1),
    checkpoint: text("checkpoint", { mode: "json" }).$type<Record<string, unknown>>(),
    intervalMs: integer("interval_ms").notNull(),
    scheduleType: text("schedule_type", { enum: ["manual", "interval"] }).notNull().default("interval"),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    retryPolicy: text("retry_policy", { mode: "json" })
      .$type<{ maxAttempts: number; baseDelayMs: number }>()
      .notNull()
      .default({ maxAttempts: 3, baseDelayMs: 30_000 }),
    priority: integer("priority").notNull().default(0),
    status: text("status", { enum: ["draft", "active", "paused", "archived"] }).notNull().default("active"),
    configVersion: integer("config_version").notNull().default(1),
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

export const connectorSyncJobStates = sqliteTable(
  "connector_sync_job_states",
  {
    jobId: text("job_id").primaryKey().references(() => connectorSyncJobs.id, { onDelete: "cascade" }),
    checkpoint: text("checkpoint", { mode: "json" }).$type<Record<string, unknown>>(),
    nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("connector_sync_job_states_due_idx").on(table.nextRunAt, table.leaseExpiresAt)],
);

export const connectorSyncJobVersions = sqliteTable(
  "connector_sync_job_versions",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull().references(() => connectorSyncJobs.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    configSnapshot: text("config_snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    changedBy: text("changed_by").notNull(),
    changeReason: text("change_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("connector_sync_job_versions_job_version_idx").on(table.jobId, table.version)],
);

export const connectorSyncRuns = sqliteTable(
  "connector_sync_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => connectorSyncJobs.id, { onDelete: "cascade" }),
    jobVersionId: text("job_version_id").references(() => connectorSyncJobVersions.id),
    status: text("status", {
      enum: ["running", "success", "failed", "blocked_runtime", "needs_connection"],
    }).notNull(),
    cursor: text("cursor"),
    discovered: integer("discovered").notNull().default(0),
    inserted: integer("inserted").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    unchanged: integer("unchanged").notNull().default(0),
    quarantined: integer("quarantined").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    agentModel: text("agent_model"),
    renderedPromptHash: text("rendered_prompt_hash"),
    promptProfileVersion: integer("prompt_profile_version"),
    inputCheckpoint: text("input_checkpoint", { mode: "json" }).$type<Record<string, unknown>>(),
    outputCheckpoint: text("output_checkpoint", { mode: "json" }).$type<Record<string, unknown>>(),
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

export const connectorTodos = sqliteTable(
  "connector_todos",
  {
    ...connectorDomainColumns,
    todoId: text("todo_id").notNull(),
    title: text("title").notNull(),
    notes: text("notes").notNull(),
    /** null = 来源未提供（needsAction/completed 等语义由连接器 Skill 归一）。 */
    status: text("status"),
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    priority: text("priority"),
    listId: text("list_id"),
    listName: text("list_name"),
  },
  (table) => [
    uniqueIndex("connector_todos_owner_source_idx")
      .on(table.ownerId, table.service, table.connectionName, table.sourceRecordId),
    index("connector_todos_owner_due_idx").on(table.ownerId, table.dueAt),
    index("connector_todos_owner_todo_idx").on(table.ownerId, table.todoId),
  ],
);

export const connectorMarkdownArtifacts = sqliteTable(
  "connector_markdown_artifacts",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    service: text("service").notNull(),
    connectionName: text("connection_name").notNull(),
    resourceType: text("resource_type", { enum: ["email", "document", "calendar", "todo", "generic"] }).notNull(),
    sourceRecordId: text("source_record_id").notNull(),
    ingestSourceId: text("ingest_source_id").notNull(),
    activePath: text("active_path").notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    markdownContentHash: text("markdown_content_hash"),
    rendererVersion: text("renderer_version").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status", { enum: ["pending", "ready", "failed", "deleted"] }).notNull().default("pending"),
    ingestStatus: text("ingest_status", { enum: ["pending", "succeeded", "failed", "skipped"] }).notNull().default("pending"),
    lastError: text("last_error"),
    parsedId: text("parsed_id"),
    ingestEventId: text("ingest_event_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    uniqueIndex("connector_markdown_artifacts_source_idx").on(
      table.ownerId, table.service, table.connectionName, table.resourceType, table.sourceRecordId,
    ),
    uniqueIndex("connector_markdown_artifacts_ingest_source_idx").on(table.resourceType, table.ingestSourceId),
    index("connector_markdown_artifacts_status_idx").on(table.status, table.ingestStatus, table.updatedAt),
  ],
);

export const connectorMarkdownOutbox = sqliteTable(
  "connector_markdown_outbox",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    resourceType: text("resource_type", { enum: ["email", "document", "calendar", "todo", "generic"] }).notNull(),
    ingestSourceId: text("ingest_source_id").notNull(),
    operation: text("operation", { enum: ["upsert", "delete"] }).notNull(),
    sourceContentHash: text("source_content_hash").notNull(),
    status: text("status", { enum: ["pending", "processing", "done", "dead"] }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    leaseOwner: text("lease_owner"),
    leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("connector_markdown_outbox_due_idx").on(table.status, table.availableAt, table.leaseUntil),
    index("connector_markdown_outbox_source_idx").on(table.resourceType, table.ingestSourceId, table.createdAt),
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
  activeAgentId: text("active_agent_id").notNull().default("main"),
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
    lifecycle: text("lifecycle", { enum: ["active", "merging", "merged"] }).notNull().default("active"),
    mergedIntoRoomId: text("merged_into_room_id"),
    mergedAt: integer("merged_at", { mode: "timestamp_ms" }),
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

export const roomOverviews = sqliteTable(
  "room_overviews",
  {
    roomId: text("room_id").primaryKey().references(() => contextRooms.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    baseProjection: text("base_projection", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    projection: text("projection", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("room_overviews_updated_idx").on(table.updatedAt)],
);

export const roomContextCorrections = sqliteTable(
  "room_context_corrections",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull().references(() => contextRooms.id, { onDelete: "cascade" }),
    operation: text("operation", {
      enum: ["content_replace", "content_add", "content_suppress", "fact_correct", "fact_add", "source_remove", "source_reassign"],
    }).notNull(),
    section: text("section", {
      enum: ["overview", "status", "next_steps", "timeline", "entities"],
    }).notNull(),
    targetClaimId: text("target_claim_id"),
    targetSource: text("target_source", { mode: "json" }).$type<Record<string, unknown> | null>(),
    targetRoomId: text("target_room_id"),
    originalText: text("original_text"),
    replacementText: text("replacement_text"),
    rationale: text("rationale").notNull(),
    status: text("status", { enum: ["proposed", "applied", "revoked"] }).notNull().default("proposed"),
    entryPoint: text("entry_point", { enum: ["overview", "section", "agent"] }).notNull(),
    sessionId: text("session_id"),
    proposedByRunId: text("proposed_by_run_id"),
    appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("room_context_corrections_room_status_idx").on(table.roomId, table.status),
    index("room_context_corrections_session_idx").on(table.sessionId),
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
    provider: text("provider", { enum: ["notion", "openclaw", "codex", "claude"] }).notNull(),
    transport: text("transport", { enum: ["oauth", "zip", "local-sqlite", "local-jsonl", "archive", "directory"] }).notNull(),
    stableSourceKey: text("stable_source_key").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["ready", "importing", "completed", "error", "unavailable"] }).notNull().default("ready"),
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
    provider: text("provider", { enum: ["notion", "openclaw", "codex", "claude"] }).notNull(),
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

export const externalAgentThreads = sqliteTable(
  "external_agent_threads",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull().references(() => dataMigrationSources.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["openclaw", "codex", "claude"] }).notNull(),
    stableKey: text("stable_key").notNull(),
    agentId: text("agent_id"),
    externalSessionId: text("external_session_id").notNull(),
    title: text("title").notNull(),
    importVersion: integer("import_version").notNull().default(1),
    memorySessionId: text("memory_session_id").notNull(),
    memoryStatus: text("memory_status", { enum: ["pending", "indexed", "error"] }).notNull().default("pending"),
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
    // Only retained snapshots have a JSON body. Other versions are
    // reconstructed from the Yjs history chain.
    contentJson: text("content_json", { mode: "json" }),
    contentSchemaVersion: integer("content_schema_version").notNull().default(1),
    sourceTransactionId: text("source_transaction_id"),
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

export const externalDocumentBindings = sqliteTable(
  "external_document_bindings",
  {
    documentId: text("document_id").primaryKey()
      .references(() => documents.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind", { enum: ["obsidian-vault"] }).notNull(),
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

// ═══════════════════ Knowledge 路由层（docs/entity-room-plan.md） ═══════════════════
// Room 注册表：Room 长期只存在于渲染器 localStorage，gateway 侧此前无实体表。
// 渲染器 Room 打开/创建/改名时上报 upsert（origin=user），删除时写 deletedAt；
// 实体晋升产出的 Room 写 origin=auto，渲染器经 REST 拉取显示。
// 新表对 rooms 一律松引用（存量 roomId 无注册行不阻塞），完整性由 service 层校验。
export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  /** 对齐渲染器 ContextRoomKind 六值枚举（人物/项目/主题/长期目标/议题/事件）。 */
  kind: text("kind").notNull().default("议题"),
  /** user = 渲染器上报；auto = 实体证据累积晋升时自动创建。上报命中 auto 行 = 认领，翻转为 user。 */
  origin: text("origin", { enum: ["user", "auto"] }).notNull().default("user"),
  /** Room 简介（晋升时"转正登记"综合产出；user Room 由用户维护）。 */
  summary: text("summary"),
  /** 曾用名/同义词（重名去重比对用）；rename/认领时把旧 title 追加。 */
  aliases: text("aliases", { mode: "json" }).$type<string[]>(),
  /** Room 的户口实体（ED4：现有 Room 一律种子化为已晋升实体；渲染器上报时同步维护）。 */
  entityId: text("entity_id"),
  lifecycle: text("lifecycle", { enum: ["active", "merging", "merged"] }).notNull().default("active"),
  mergedIntoRoomId: text("merged_into_room_id"),
  mergedAt: integer("merged_at", { mode: "timestamp_ms" }),
  /** 软删除（null = 存活）：候选池/auto 同步/wiki 挂载全部过滤。 */
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Durable Room-pair duplicate assessment. Formal Rooms are never auto-merged. */
export const roomDuplicateCandidates = sqliteTable(
  "room_duplicate_candidates",
  {
    id: text("id").primaryKey(),
    roomAId: text("room_a_id").notNull(),
    roomBId: text("room_b_id").notNull(),
    nameScore: real("name_score").notNull().default(0),
    centroidScore: real("centroid_score").notNull().default(0),
    contentOverlap: real("content_overlap").notNull().default(0),
    entityOverlap: real("entity_overlap").notNull().default(0),
    duplicateScore: real("duplicate_score").notNull().default(0),
    confidence: text("confidence", { enum: ["high", "medium", "related", "distinct", "pending"] }).notNull(),
    llmVerdict: text("llm_verdict", { enum: ["same", "different", "unavailable"] }),
    reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull(),
    status: text("status", { enum: ["open", "related", "distinct", "merged"] }).notNull().default("open"),
    evidenceRevision: text("evidence_revision").notNull(),
    scoringVersion: integer("scoring_version").notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_duplicate_candidates_pair_idx").on(table.roomAId, table.roomBId),
    index("room_duplicate_candidates_status_idx").on(table.status, table.confidence),
    index("room_duplicate_candidates_room_a_idx").on(table.roomAId),
    index("room_duplicate_candidates_room_b_idx").on(table.roomBId),
  ],
);

/** User-confirmed, irreversible Room merge orchestration state. */
export const roomMergeOperations = sqliteTable(
  "room_merge_operations",
  {
    id: text("id").primaryKey(),
    sourceRoomId: text("source_room_id").notNull(),
    targetRoomId: text("target_room_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    previewHash: text("preview_hash").notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed", "cancelled"] }).notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    commitReached: integer("commit_reached", { mode: "boolean" }).notNull().default(false),
    impact: text("impact", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    error: text("error"),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_merge_operations_idempotency_idx").on(table.idempotencyKey),
    index("room_merge_operations_rooms_idx").on(table.sourceRoomId, table.targetRoomId),
    index("room_merge_operations_status_idx").on(table.status, table.updatedAt),
  ],
);

/** Execution journal used for crash recovery before the irreversible commit point. */
export const roomMergeItems = sqliteTable(
  "room_merge_items",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull().references(() => roomMergeOperations.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    beforeRoomId: text("before_room_id"),
    afterRoomId: text("after_room_id"),
    beforeValue: text("before_value", { mode: "json" }).$type<Record<string, unknown>>(),
    fingerprint: text("fingerprint"),
    status: text("status", { enum: ["pending", "moved", "folded", "skipped"] }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_merge_items_operation_resource_idx").on(table.operationId, table.resourceType, table.resourceId),
    index("room_merge_items_operation_idx").on(table.operationId, table.status),
  ],
);

/** Gateway-owned provenance for memories that can be attributed to one Room. */
export const roomMemoryAttributions = sqliteTable(
  "room_memory_attributions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    memoryId: text("memory_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    confidence: text("confidence", { enum: ["explicit", "derived"] }).notNull().default("explicit"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_memory_attributions_memory_idx").on(table.memoryId),
    index("room_memory_attributions_room_idx").on(table.roomId),
  ],
);

/**
 * 实体注册表（entity-room-plan §3.1）：弱 Room 的本体，也是 Room 的"户口"。
 * weak = 候选（无 wiki 无 ingest，证据累积中）；ready = 推荐（达阈值，等用户
 * 确认创建）；room = 已晋升（roomId 回填）；promoting = 晋升 job 的原子抢占态
 * （崩溃后由启动清扫回 weak）；archived = 老化归档/被合并（不参与解析，新链
 * 接可复活回 weak）。status 列无 CHECK 约束（TEXT 枚举仅类型层），加态免迁移。
 */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** 曾用名/同义词：解析命中不同叫法时累积；合并时并集。 */
    aliases: text("aliases", { mode: "json" }).$type<string[]>(),
    /** 人物/项目/主题/长期目标/议题/事件。 */
    kind: text("kind", {
      enum: ["人物", "项目", "主题", "长期目标", "议题", "事件"],
    }).notNull().default("主题"),
    /** 晋升时"转正登记"一次性综合产出（弱期为 NULL——依据句日志即事实源，ED7）。 */
    summary: text("summary"),
    status: text("status", {
      enum: ["weak", "ready", "promoting", "room", "archived", "suppressed"],
    }).notNull().default("weak"),
    /** 晋升后回填 rooms.id。 */
    roomId: text("room_id"),
    /** V2 有效证据分：按 evidence_group_key 分组取最大贡献后求和。 */
    evidenceScore: real("evidence_score").notNull().default(0),
    /** 原始关联资料数（按 sourceKind + sourceId 去重）。 */
    sourceCount: integer("source_count").notNull().default(0),
    /** V2 聚合计数：有效/可信/强证据组。 */
    eligibleSourceCount: integer("eligible_source_count").notNull().default(0),
    trustedSourceCount: integer("trusted_source_count").notNull().default(0),
    strongSourceCount: integer("strong_source_count").notNull().default(0),
    /** 达标路径：standard（三份合格证据）或 strong（两份独立强证据）。 */
    readinessPath: text("readiness_path", { enum: ["standard", "strong"] }),
    scoringVersion: integer("scoring_version").notNull().default(2),
    /** 质心：弱实体从第一份资料就开始累积（ED：冷启动问题随模型消失）。 */
    centroid: text("centroid"),
    centroidDocs: integer("centroid_docs").notNull().default(0),
    centroidModel: text("centroid_model"),
    /** 审计：被合并进本实体的实体 id（自动/手动合并都记）。 */
    mergedFrom: text("merged_from", { mode: "json" }).$type<string[]>(),
    /** 最近一次链接时间（老化归档依据，E3）。 */
    lastLinkedAt: integer("last_linked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("entities_status_idx").on(table.status),
    index("entities_name_idx").on(table.name),
  ],
);

/**
 * 资料 → 实体链接：归属的单一事实源（原 route_decisions 的归属语义迁到这里）。
 * 一份资料对同一实体只一行（新版本覆盖更新 role/salience/version）。
 */
export const entityDocLinks = sqliteTable(
  "entity_doc_links",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id").notNull(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "visual-event", "mail", "file", "cloud-doc", "calendar-event", "todo", "connector-record"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    /** primary = 资料核心主题（网关侧从 salience 推导）；mention = 顺带提及；manual = 用户挂载。 */
    role: text("role", { enum: ["primary", "mention", "manual"] }).notNull(),
    /** 抽取时的分量快照（0~1）。 */
    salience: real("salience").notNull().default(0),
    /** V2 推荐评分快照；规则升级时可从来源元数据重新计算。 */
    evidenceGroupKey: text("evidence_group_key").notNull().default(""),
    roleWeight: real("role_weight").notNull().default(0),
    sourceWeight: real("source_weight").notNull().default(0),
    qualityFactor: real("quality_factor").notNull().default(0),
    relevanceFactor: real("relevance_factor").notNull().default(0),
    effectiveWeight: real("effective_weight").notNull().default(0),
    qualityLevel: text("quality_level", {
      enum: ["excluded", "uncertain", "low", "normal", "high"],
    }).notNull().default("excluded"),
    trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
    strong: integer("strong", { mode: "boolean" }).notNull().default(false),
    scoreReasons: text("score_reasons", { mode: "json" }).$type<string[]>(),
    scoringVersion: integer("scoring_version").notNull().default(2),
    /** 抽取依据句（原文短句）——实体详情"为什么存在"的可解释性来源。 */
    evidence: text("evidence"),
    decidedBy: text("decided_by", { enum: ["resolution", "user"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("entity_doc_links_entity_source_idx").on(
      table.entityId,
      table.sourceKind,
      table.sourceId,
    ),
    index("entity_doc_links_source_idx").on(table.sourceKind, table.sourceId),
  ],
);

/**
 * Room relation source projection. This is deliberately separate from
 * entity_doc_links: relation indexing must not change routing or recommendation
 * scores. One source can belong to multiple Rooms, while a mail thread remains
 * one evidence group.
 */
export const roomSourceMemberships = sqliteTable(
  "room_source_memberships",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "visual-event", "mail", "file", "cloud-doc", "calendar-event", "todo", "connector-record"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    sourceTitle: text("source_title"),
    evidenceGroupKey: text("evidence_group_key").notNull(),
    role: text("role", { enum: ["entry", "primary", "mention", "manual", "rule"] }).notNull(),
    effectiveWeight: real("effective_weight").notNull().default(0),
    qualityLevel: text("quality_level", {
      enum: ["excluded", "uncertain", "low", "normal", "high"],
    }).notNull().default("excluded"),
    trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
    scoreReasons: text("score_reasons", { mode: "json" }).$type<string[]>(),
    scoringVersion: integer("scoring_version").notNull().default(1),
    /** Entity extraction completed for this source version, including an empty result. */
    entityIndexed: integer("entity_indexed", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_source_memberships_room_source_idx").on(table.roomId, table.sourceKind, table.sourceId),
    index("room_source_memberships_source_idx").on(table.sourceKind, table.sourceId),
    index("room_source_memberships_group_idx").on(table.evidenceGroupKey),
    index("room_source_memberships_room_idx").on(table.roomId),
  ],
);

/** Normalized entities mentioned by a Room's source material. */
export const roomEntityMentions = sqliteTable(
  "room_entity_mentions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    entityId: text("entity_id").notNull(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "visual-event", "mail", "file", "cloud-doc", "calendar-event", "todo", "connector-record"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    evidenceGroupKey: text("evidence_group_key").notNull(),
    salience: real("salience").notNull().default(0),
    relevanceFactor: real("relevance_factor").notNull().default(0),
    qualityLevel: text("quality_level", {
      enum: ["excluded", "uncertain", "low", "normal", "high"],
    }).notNull().default("excluded"),
    trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
    evidence: text("evidence"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_entity_mentions_room_entity_source_idx").on(
      table.roomId,
      table.entityId,
      table.sourceKind,
      table.sourceId,
    ),
    index("room_entity_mentions_entity_idx").on(table.entityId),
    index("room_entity_mentions_room_idx").on(table.roomId),
    index("room_entity_mentions_source_idx").on(table.sourceKind, table.sourceId),
  ],
);

/**
 * 事实记忆投影（PRD 6.6.1：描述实体属性或实体间关系的明确陈述）。
 * 与 room_entity_mentions 同语义：来源级投影，replaceSource 按来源整体替换；
 * 同一事实跨来源 = 多行，读取侧按 factId（sha256(content) 指纹）聚合去重。
 */
export const roomEntityFacts = sqliteTable(
  "room_entity_facts",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    /** 全局内容指纹：sha256(content) 前 20 位，跨来源去重键。 */
    factId: text("fact_id").notNull(),
    content: text("content").notNull(),
    /** 属性 = 单一实体的性质/状态/归属；关系 = 实体间关系。 */
    type: text("type", { enum: ["属性", "关系"] }).notNull().default("属性"),
    /** 涉及实体（抽取名称经 resolveMentionEntity 解析后的 id；解析不到的不进表）。 */
    entityIds: text("entity_ids", { mode: "json" }).$type<string[]>(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "visual-event", "mail", "file", "cloud-doc", "calendar-event", "todo", "connector-record"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    evidenceGroupKey: text("evidence_group_key").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_entity_facts_room_source_fact_idx").on(
      table.roomId,
      table.sourceKind,
      table.sourceId,
      table.factId,
    ),
    index("room_entity_facts_room_idx").on(table.roomId),
    index("room_entity_facts_source_idx").on(table.sourceKind, table.sourceId),
    index("room_entity_facts_fact_idx").on(table.factId),
  ],
);

/** Materialized, explainable Room-to-Room relations plus user overrides. */
export const roomRelations = sqliteTable(
  "room_relations",
  {
    id: text("id").primaryKey(),
    roomAId: text("room_a_id").notNull(),
    roomBId: text("room_b_id").notNull(),
    autoScore: real("auto_score").notNull().default(0),
    autoType: text("auto_type", { enum: ["shared_evidence", "shared_entity", "mixed"] }),
    strength: text("strength", { enum: ["weak", "medium", "strong"] }),
    sharedSourceCount: integer("shared_source_count").notNull().default(0),
    sharedEntityCount: integer("shared_entity_count").notNull().default(0),
    directMentionCount: integer("direct_mention_count").notNull().default(0),
    topReasons: text("top_reasons", { mode: "json" }).$type<Array<Record<string, unknown>>>(),
    scoringVersion: integer("scoring_version").notNull().default(1),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    manualType: text("manual_type", {
      enum: ["related", "depends_on", "part_of", "supports", "blocks", "owns", "custom"],
    }),
    manualFromRoomId: text("manual_from_room_id"),
    manualToRoomId: text("manual_to_room_id"),
    manualLabel: text("manual_label"),
    manualNote: text("manual_note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("room_relations_pair_idx").on(table.roomAId, table.roomBId),
    index("room_relations_room_a_idx").on(table.roomAId),
    index("room_relations_room_b_idx").on(table.roomBId),
    index("room_relations_updated_idx").on(table.updatedAt),
  ],
);

/** Room ↔ wiki 映射；懒创建（第一份文档路由到该 Room 时才 ensure，见 plan D1）。 */
export const roomWikis = sqliteTable("room_wikis", {
  roomId: text("room_id").primaryKey(),
  /** KS（MemoryKnowledge）侧的 wiki_id。 */
  knowledgeId: text("knowledge_id").notNull(),
  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  /** ④ 向量层用：质心（float32 数组 base64，null = 未初始化）。 */
  centroid: text("centroid"),
  centroidDocs: integer("centroid_docs").notNull().default(0),
  /** 生成质心所用 embedding 模型标识：换模型后旧质心不可比，检测到不一致时整体重算。 */
  centroidModel: text("centroid_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * 抽取审计流水（entity-room-plan §3.2）：归属语义已迁 entity_doc_links，
 * 本表降级为每次路由运行的审计记录（抽取原始输出 + 解析结果 + ingest 状态）。
 * primaryRoomId 回填 primary 实体晋升后的 Room（供撤销/清单 join 用）。
 */
export const routeDecisions = sqliteTable(
  "route_decisions",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "visual-event", "mail", "file", "cloud-doc", "calendar-event", "todo", "connector-record"],
    }).notNull().default("everroom-doc"),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    /** 外部信封的快照（连接器类源没有 documents 行，晋升批量 ingest 时要还原内容）。 */
    sourceTitle: text("source_title"),
    sourceMarkdown: text("source_markdown"),
    /** primary 实体晋升后的 Room（落 ingest）；null = 弱实体孵化中/未识别。 */
    primaryRoomId: text("primary_room_id"),
    /** 附带 Room（仅写 room_doc_links 链接，不 ingest）——入口直连多 Room 时使用。 */
    linkedRoomIds: text("linked_room_ids", { mode: "json" }).$type<string[]>(),
    newRoomName: text("new_room_name"),
    newRoomSummary: text("new_room_summary"),
    newRoomKind: text("new_room_kind"),
    confidence: real("confidence").notNull(),
    /**
     * entry/rule = 确定性入口；resolution = 实体解析命中已晋升实体；
     * user = 手动挂载；null = 未识别（抽取空/失败）。
     */
    decidedBy: text("decided_by", { enum: ["entry", "rule", "resolution", "user"] }),
    /** 抽取输出与解析结果的快照（JSON：summary/entities/resolution/ingested）。 */
    evidence: text("evidence", { mode: "json" }),
    reason: text("reason"),
    status: text("status", {
      enum: ["pending", "auto", "linked", "awaiting_review", "confirmed", "reverted"],
    }).notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("route_decisions_source_idx").on(table.sourceKind, table.sourceId),
    index("route_decisions_status_idx").on(table.status),
  ],
);

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
      enum: ["manual-upload", "local-folder", "connector", "migration", "web-clipper", "legacy-upload"],
    }).notNull(),
    sourceKey: text("source_key").notNull(),
    originalName: text("original_name").notNull(),
    displayName: text("display_name"),
    extension: text("extension").notNull(),
    provider: text("provider"),
    connectionId: text("connection_id"),
    localSourceId: text("local_source_id"),
    localItemId: text("local_item_id"),
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

export const clipperCaptures = sqliteTable(
  "clipper_captures",
  {
    id: text("id").primaryKey(),
    captureKey: text("capture_key").notNull().unique(),
    fileEntryId: text("file_entry_id").references(() => fileEntries.id, { onDelete: "cascade" }),
    fileVersionId: text("file_version_id").references(() => fileVersions.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    publishedAt: text("published_at"),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
    extractionMode: text("extraction_mode", { enum: ["selection", "article", "full-page"] }).notNull(),
    rawContentHash: text("raw_content_hash").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    status: text("status", {
      enum: ["storing", "assets_pending", "ready", "ready_with_missing_assets", "failed"],
    }).notNull().default("storing"),
    assetCount: integer("asset_count").notNull().default(0),
    storedAssetCount: integer("stored_asset_count").notNull().default(0),
    failedAssetCount: integer("failed_asset_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    favoritedAt: integer("favorited_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("clipper_captures_file_entry_idx").on(table.fileEntryId, table.capturedAt),
    index("clipper_captures_canonical_idx").on(table.canonicalUrl, table.capturedAt),
    index("clipper_captures_status_idx").on(table.status, table.updatedAt),
  ],
);

export const clipperAssets = sqliteTable(
  "clipper_assets",
  {
    id: text("id").primaryKey(),
    captureId: text("capture_id").notNull().references(() => clipperCaptures.id, { onDelete: "cascade" }),
    fileVersionId: text("file_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
    referenceKey: text("reference_key").notNull(),
    contentHash: text("content_hash").references(() => fileBlobs.contentHash),
    originalUrl: text("original_url").notNull(),
    mime: text("mime"),
    byteSize: integer("byte_size"),
    altText: text("alt_text"),
    width: integer("width"),
    height: integer("height"),
    status: text("status", { enum: ["pending", "stored", "failed"] }).notNull().default("pending"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    visualStatus: text("visual_status", {
      enum: ["pending", "processing", "ready", "skipped", "failed"],
    }).notNull().default("pending"),
    visualKind: text("visual_kind", {
      enum: ["photo", "illustration", "chart", "diagram", "screenshot", "logo", "decoration", "other"],
    }),
    visualSummary: text("visual_summary"),
    visualOcrText: text("visual_ocr_text"),
    visualKeyPoints: text("visual_key_points", { mode: "json" }).$type<string[]>(),
    visualEntities: text("visual_entities", { mode: "json" }).$type<Array<{
      name: string;
      kind: string;
      evidence: string;
    }>>(),
    visualRelevance: real("visual_relevance"),
    visualQuality: real("visual_quality"),
    visualContentRole: text("visual_content_role", {
      enum: ["primary", "supporting", "noise"],
    }),
    visualNoiseReason: text("visual_noise_reason", {
      enum: ["none", "emoji", "qr_code", "advertisement", "avatar", "logo", "social_widget", "navigation", "decoration", "tracking", "other"],
    }),
    visualModel: text("visual_model"),
    visualPromptVersion: text("visual_prompt_version"),
    coverScore: real("cover_score"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    index("clipper_assets_capture_idx").on(table.captureId, table.status),
    index("clipper_assets_reference_idx").on(table.referenceKey, table.createdAt),
    index("clipper_assets_hash_idx").on(table.contentHash),
  ],
);

/**
 * 网页剪藏的规范化产物。displayMarkdown 忠实用于阅读；semanticMarkdown
 * 融合图片 VLM 描述，仅供 Memory/Knowledge 下游消费。
 */
export const clipperArtifacts = sqliteTable("clipper_artifacts", {
  captureId: text("capture_id").primaryKey().references(() => clipperCaptures.id, { onDelete: "cascade" }),
  schemaVersion: integer("schema_version").notNull().default(1),
  displayMarkdown: text("display_markdown").notNull(),
  semanticMarkdown: text("semantic_markdown").notNull(),
  excerpt: text("excerpt").notNull().default(""),
  coverAssetId: text("cover_asset_id"),
  parseStatus: text("parse_status", {
    enum: ["pending", "processing", "ready", "partial", "failed"],
  }).notNull().default("pending"),
  visualStatus: text("visual_status", {
    enum: ["pending", "processing", "ready", "partial", "skipped", "failed"],
  }).notNull().default("pending"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

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

export const fileClusters = sqliteTable("file_clusters", {
  id: text("id").primaryKey(),
  canonicalTitle: text("canonical_title").notNull(),
  titleSource: text("title_source", { enum: ["agent", "user", "fallback"] }).notNull(),
  titlePinned: integer("title_pinned", { mode: "boolean" }).notNull().default(false),
  summary: text("summary").notNull().default(""),
  embedding: text("embedding", { mode: "json" }).$type<number[]>(),
  embeddingModel: text("embedding_model"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const fileClusterMemberships = sqliteTable(
  "file_cluster_memberships",
  {
    fileEntryId: text("file_entry_id").primaryKey().references(() => fileEntries.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id").notNull().references(() => fileClusters.id, { onDelete: "cascade" }),
    confidence: real("confidence").notNull(),
    decidedBy: text("decided_by", { enum: ["exact-hash", "agent", "fallback", "user"] }).notNull(),
    model: text("model"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("file_cluster_memberships_cluster_idx").on(table.clusterId)],
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

export const realityEvents = sqliteTable(
  "reality_events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["ongoing", "completed", "failed", "pending_sync"],
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

// ═══════════════════ Local visual perception and diary ═══════════════════

export const perceptionSettings = sqliteTable("perception_settings", {
  ownerId: text("owner_id").primaryKey().default("local-user"),
  captureEnabled: integer("capture_enabled", { mode: "boolean" }).notNull().default(false),
  captureIntervalSeconds: integer("capture_interval_seconds").notNull().default(300),
  onlineVlmEnabled: integer("online_vlm_enabled", { mode: "boolean" }).notNull().default(false),
  configVersion: integer("config_version").notNull().default(1),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

export const visualNodes = sqliteTable(
  "visual_nodes",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["screenshot", "photo"] }).notNull(),
    startAt: integer("start_at", { mode: "timestamp_ms" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp_ms" }).notNull(),
    sampleCount: integer("sample_count").notNull().default(1),
    representativeObservationId: text("representative_observation_id"),
    latestPerceptualHash: text("latest_perceptual_hash"),
    vlmStatus: text("vlm_status", {
      enum: ["disabled", "pending", "processing", "ready", "failed"],
    }).notNull().default("disabled"),
    eventType: text("event_type"),
    title: text("title"),
    summary: text("summary"),
    keyPoints: text("key_points", { mode: "json" }).$type<string[]>().notNull().default([]),
    representativeTags: text("representative_tags", { mode: "json" }).$type<RealityTag[]>().notNull().default([]),
    confidence: real("confidence"),
    model: text("model"),
    promptVersion: integer("prompt_version").notNull().default(1),
    resultVersion: integer("result_version").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("visual_nodes_range_idx").on(table.startAt, table.endAt),
    index("visual_nodes_status_idx").on(table.vlmStatus, table.updatedAt),
  ],
);

export const visualObservations = sqliteTable(
  "visual_observations",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull().references(() => visualNodes.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull().references(() => uploadedFiles.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: ["screenshot", "photo"] }).notNull(),
    capturedAt: integer("captured_at", { mode: "timestamp_ms" }).notNull(),
    perceptualHash: text("perceptual_hash"),
    width: integer("width"),
    height: integer("height"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("visual_observations_file_idx").on(table.fileId),
    index("visual_observations_node_captured_idx").on(table.nodeId, table.capturedAt),
    index("visual_observations_captured_idx").on(table.capturedAt),
  ],
);

export const visualProcessingJobs = sqliteTable(
  "visual_processing_jobs",
  {
    id: text("id").primaryKey(),
    nodeId: text("node_id").notNull().references(() => visualNodes.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("visual_processing_jobs_node_idx").on(table.nodeId),
    index("visual_processing_jobs_due_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
  ],
);

export const diarySchedules = sqliteTable("diary_schedules", {
  ownerId: text("owner_id").primaryKey().default("local-user"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  localTime: text("local_time").notNull().default("23:30"),
  timezone: text("timezone").notNull(),
  enabledFrom: text("enabled_from"),
  nextRunAt: integer("next_run_at", { mode: "timestamp_ms" }),
  configVersion: integer("config_version").notNull().default(1),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

/** User-managed Agent schedules. Built-in tasks (for example diary.daily)
 * remain outside this table and are exposed by the scheduler as immutable
 * records. */
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

export const diaryDays = sqliteTable(
  "diary_days",
  {
    date: text("date").primaryKey(),
    status: text("status", { enum: ["pending", "generating", "ready", "stale", "failed"] }).notNull().default("pending"),
    currentVersionId: text("current_version_id"),
    sourceFingerprint: text("source_fingerprint"),
    eventCount: integer("event_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [index("diary_days_status_date_idx").on(table.status, table.date)],
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

export const diaryVersions = sqliteTable(
  "diary_versions",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull().references(() => diaryDays.date, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    content: text("content", { mode: "json" }).$type<DiaryPayload>().notNull(),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    windowEnd: integer("window_end", { mode: "timestamp_ms" }).notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    agentModel: text("agent_model"),
    promptVersion: integer("prompt_version").notNull().default(1),
    runId: text("run_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("diary_versions_date_version_idx").on(table.date, table.version)],
);

export const diaryVersionSources = sqliteTable(
  "diary_version_sources",
  {
    versionId: text("version_id").notNull().references(() => diaryVersions.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceVersion: text("source_version").notNull(),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    timeBasis: text("time_basis").notNull().default("recorded_at"),
    contentFingerprint: text("content_fingerprint").notNull(),
    evidenceSummary: text("evidence_summary").notNull(),
    assetFileId: text("asset_file_id").references(() => uploadedFiles.id, { onDelete: "restrict" }),
  },
  (table) => [
    primaryKey({ columns: [table.versionId, table.sourceId] }),
    index("diary_version_sources_source_idx").on(table.sourceKind, table.sourceId),
  ],
);

export const diaryRuns = sqliteTable(
  "diary_runs",
  {
    id: text("id").primaryKey(),
    date: text("date").notNull().references(() => diaryDays.date, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ["scheduled", "catch_up", "manual"] }).notNull(),
    status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull().default("pending"),
    windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
    windowEnd: integer("window_end", { mode: "timestamp_ms" }).notNull(),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    error: text("error"),
    versionId: text("version_id").references(() => diaryVersions.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("diary_runs_due_idx").on(table.status, table.nextAttemptAt, table.leaseExpiresAt),
    index("diary_runs_date_idx").on(table.date, table.createdAt),
  ],
);

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
}

/**
 * 统一进入台账（§6.1/U3）：每次经 /v1/ingest 进入的资料一行，
 * 含类型识别结果与策略快照——晋升/增量 ingest 的 wiki 判定读快照而非
 * 实时 policy（策略事后变化不应让已进入的资料行为漂移）。
 * 引擎只记自己做的；Room/wiki 下游状态继续查 knowledge 既有表（§6.3）。
 */
export const ingestEvents = sqliteTable(
  "ingest_events",
  {
    /** ing-<uuid12> */
    id: text("id").primaryKey(),
    sourceKind: text("source_kind", {
      enum: ["everroom-doc", "reality-event", "visual-event", "mail", "file", "cloud-doc", "calendar-event", "todo", "connector-record"],
    }).notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: integer("source_version").notNull(),
    dataType: text("data_type").notNull(),
    /** 识别依据（U1 全确定性）：explicit | json-type | extension | source-kind | sniff */
    detectedBy: text("detected_by").notNull(),
    title: text("title").notNull(),
    /** 源内容指纹（原始字节 / 表引用的规范化序列化）。 */
    contentHash: text("content_hash").notNull(),
    /** 归一化产物（parsed_contents 行；全文，消费端各自截断）。 */
    parsedId: text("parsed_id").notNull(),
    /** 策略快照（U3）json {room, wiki, memory}。 */
    pipelines: text("pipelines", { mode: "json" }).$type<IngestPipelines>().notNull(),
    /** 记忆链路即时结果 json {documentId, chunkCount, deduplicated} | {error} | null */
    memoryResult: text("memory_result", { mode: "json" })
      .$type<IngestMemoryOk | { error: string }>(),
    /** Room 链路 route job 引用（knowledge.route）。 */
    routeJobId: text("route_job_id"),
    /**
     * 过滤闸状态（agent 过滤器，ingest 第一级）：
     * null = 未经过闸（豁免/过滤关闭时的直通）；pending = 待判定；
     * passed | filtered | bypassed（fail-open 放行，verdict 记录失败原因）
     */
    filterStatus: text("filter_status", {
      enum: ["pending", "passed", "filtered", "bypassed"],
    }),
    /** 过滤器判定 json {informative, reason, category, confidence}（含 bypassed 的失败说明）。 */
    filterVerdict: text("filter_verdict", { mode: "json" })
      .$type<IngestFilterVerdict>(),
    /**
     * 误杀恢复时间戳（POST reinstate 写入）：用户明确表达"过滤器拦错了"的
     * 精确记录——洞察 job 的误杀样本只认这列，不拿 verdict 近似。
     */
    reinstatedAt: integer("reinstated_at", { mode: "timestamp_ms" }),
    /** file | paste-file | connector | reality | everroom-doc | upload */
    originChannel: text("origin_channel").notNull().default("upload"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("ingest_events_source_idx").on(table.sourceKind, table.sourceId),
    index("ingest_events_source_hash_idx").on(table.sourceId, table.contentHash),
  ],
);

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
