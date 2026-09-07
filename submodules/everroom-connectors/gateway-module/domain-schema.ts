/**
 * 连接器域表 schema（submodule 自包含化）。
 *
 * 15 张 connector_* 表定义与宿主 apps/gateway/src/infrastructure/database/
 * schema.ts 保持逐列一致（表名/列名/索引名完全相同）。过渡期（P-A/P-B）
 * 这些表仍建在宿主 gateway.sqlite 中，模块表对象对宿主库文件操作；
 * 独立服务化（P-B）后迁入模块自有 connectors.sqlite。
 *
 * 同步纪律：宿主侧这 15 张表的任何 DDL 变更必须同步本文件（独立仓库化后
 * 由 submodule CI 的契约测试钉住）。
 */

import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  // 模块独立库内改名：connector_records 已被平台表（repository.ts 的
  // Nango/CLI 记录存储）占用；域表沿用宿主 gateway.sqlite 的列形状，
  // 表名加 domain 前缀区分（legacy 拷贝时映射）。
  "connector_domain_records",
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
    uniqueIndex("connector_domain_records_owner_source_idx")
      .on(table.ownerId, table.service, table.dataset, table.sourceRecordId),
    index("connector_domain_records_owner_dataset_idx").on(table.ownerId, table.dataset),
    index("connector_domain_records_synced_idx").on(table.syncedAt),
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
