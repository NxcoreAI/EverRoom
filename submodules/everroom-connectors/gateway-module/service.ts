import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lt, lte, or, like } from "drizzle-orm";
import type { AgentRuntime, StartRuntimeRunInput } from "@nxcore/agent-runtime";
import type { ConnectorSyncJobConfig, GatewayConfig, OpenConnectorCliConfig } from "./host-types.js";
import type { GatewayDatabase } from "./host-types.js";
import type { FilesService } from "./ports.js";
import {
  connectorAuditEvents,
  connectorAccounts,
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  connectorMarkdownOutbox,
  connectorPromptProfiles,
  connectorQuarantinedRecords,
  connectorRecords,
  connectorSyncJobStates,
  connectorSyncJobVersions,
  connectorSyncJobs,
  connectorSyncRuns,
  connectorTodos,
} from "../../../apps/gateway/src/infrastructure/database/schema.js";
import { spawn } from "node:child_process";
import {
  connectorResultData,
  gmailHistoryDelta,
  gmailMessageToDomainRecord,
  gmailSyncMode,
  inferGmailQuery,
  type GmailSyncMode,
} from "./gmail-sync.js";
import {
  GOOGLE_DOC_MIME_TYPE,
  NOTION_INCREMENTAL_OVERLAP_MS,
  googleDocsHtmlToMarkdown,
  googleFileIsDeleted,
  googleFileIsDocument,
  googleFileToDocument,
  isGoogleDocsService,
  isNotionDocumentService,
  managedDocumentSyncMode,
  notionMarkdownFromResult,
  notionPageIsDeleted,
  notionPageToDocument,
  notionPageUpdatedAt,
  type ManagedDocumentSyncMode,
} from "./document-sync.js";

const MIN_INTERVAL_MS = 5_000;
const DEFAULT_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_AGENT_BATCH_SIZE = 100;
const MAX_AGENT_BATCH_BYTES = 512 * 1024;
const LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_PROMPT_OVERRIDE_LENGTH = 2_000;
const GMAIL_INCREMENTAL_INTERVAL_MS = 5 * 60 * 1_000;
const GMAIL_BOOTSTRAP_RETRY_INTERVAL_MS = 60 * 60 * 1_000;
const NOTION_INCREMENTAL_INTERVAL_MS = 10 * 60 * 1_000;
const NOTION_RECONCILE_INTERVAL_MS = 12 * 60 * 60 * 1_000;
const GOOGLE_DOCS_INCREMENTAL_INTERVAL_MS = 5 * 60 * 1_000;
const GOOGLE_DOCS_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_CONNECTOR_PAGES = 10_000;
const MAX_OPEN_CONNECTOR_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_EXPORTED_DOCUMENT_BYTES = 32 * 1024 * 1024;

const BUILTIN_PROMPT_PROFILES = [
  {
    id: "gmail-email-sync-v1", service: "gmail", resourceType: "email" as const,
    name: "Gmail 邮件标准化", version: 1, schemaVersion: 1,
    template: "领域字段、正文选择和异常处理规则由 connector-sync Agent 的 gmail-sync Skill 提供。",
  },
  {
    id: "notion-document-sync-v1", service: "notion", resourceType: "document" as const,
    name: "Notion 文档标准化", version: 1, schemaVersion: 1,
    template: "领域字段、正文格式和异常处理规则由 connector-sync Agent 的 notion-sync Skill 提供。",
  },
  {
    id: "google-calendar-event-sync-v1", service: "google_calendar", resourceType: "calendar" as const,
    name: "Google Calendar 日程标准化", version: 1, schemaVersion: 1,
    template: "领域字段、时区语义和异常处理规则由 connector-sync Agent 的 google-calendar-sync Skill 提供。",
  },
  {
    id: "google-tasks-sync-v1", service: "google_tasks", resourceType: "todo" as const,
    name: "Google Tasks 待办标准化", version: 1, schemaVersion: 1,
    template: "领域字段、状态语义和异常处理规则由 connector-sync Agent 的 google-tasks-sync Skill 提供。",
  },
];

type ConnectorResourceType = "email" | "document" | "calendar" | "todo";

interface AgentSyncStats {
  inserted: number;
  updated: number;
  unchanged: number;
  quarantined: number;
}

interface AgentSyncRunState {
  runId: string;
  job: typeof connectorSyncJobs.$inferSelect;
  stats: AgentSyncStats;
  seenSourceIds: Set<string>;
  finishRequested: boolean;
  discovered: number | null;
  checkpoint: Record<string, unknown> | null;
}

export interface AgentBatchWriteResult {
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: Array<{ index: number; sourceRecordId: string | null; reason: string }>;
}

export interface ConnectorSyncLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface ConnectorRecordQuery {
  ownerId: string;
  service?: string;
  dataset?: string;
  query?: string;
  limit?: number;
  offset?: number;
  includeExpired?: boolean;
}

export type ConnectorJobStatus = "draft" | "active" | "paused" | "archived";
export type ConnectorScheduleType = "manual" | "interval";

export interface ConnectorSyncJobInput {
  name: string;
  service: string;
  dataset: string;
  resourceType: "email" | "document" | "calendar" | "todo" | "generic";
  connectionName?: string | null;
  allowedActions: string[];
  input: Record<string, unknown>;
  goal: string;
  promptProfileId?: string | null;
  promptOverride?: string | null;
  schemaVersion?: number;
  scheduleType: ConnectorScheduleType;
  intervalMs: number;
  timezone: string;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  priority?: number;
  status: ConnectorJobStatus;
}

export interface ConnectorSyncJobPatch extends Partial<ConnectorSyncJobInput> {
  configVersion: number;
}

export interface ConnectorSyncJobSummary {
  id: string;
  ownerId: string;
  name: string;
  service: string;
  action: string;
  dataset: string;
  connectionName: string | null;
  resourceType: string;
  allowedActions: string[];
  input: Record<string, unknown>;
  goal: string;
  promptProfileId: string | null;
  promptOverride: string | null;
  promptVersion: number;
  schemaVersion: number;
  scheduleType: ConnectorScheduleType;
  timezone: string;
  retryPolicy: { maxAttempts: number; baseDelayMs: number };
  priority: number;
  status: ConnectorJobStatus;
  configVersion: number;
  intervalMs: number;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  checkpoint: Record<string, unknown> | null;
  consecutiveFailures: number;
  running: boolean;
}

export interface ConnectorSyncRunner {
  (config: OpenConnectorCliConfig, args: string[], signal?: AbortSignal): Promise<unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function redactText(value: string, secret?: string): string {
  return secret ? value.split(secret).join("<redacted>") : value;
}

function redactValue(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return redactText(value, secret);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secret)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function recordItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(objectValue).filter((item) => Object.keys(item).length > 0);
  const object = objectValue(value);
  for (const key of ["items", "records", "data", "results"]) {
    if (Array.isArray(object[key])) {
      return (object[key] as unknown[]).map(objectValue).filter((item) => Object.keys(item).length > 0);
    }
  }
  return Object.keys(object).length > 0 ? [object] : [];
}

function sourceRecordId(record: Record<string, unknown>, index: number): string {
  return textValue(record.source_record_id)
    ?? textValue(record.sourceRecordId)
    ?? textValue(record.remote_id)
    ?? textValue(record.remoteId)
    ?? textValue(record.id)
    ?? contentHash(record).slice(0, 32)
    ?? `record-${String(index)}`;
}

function sourceUpdatedAt(record: Record<string, unknown>): Date | null {
  const value = record.source_updated_at ?? record.sourceUpdatedAt ?? record.updated_at ?? record.updatedAt;
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function jobSummary(
  row: typeof connectorSyncJobs.$inferSelect,
  state?: typeof connectorSyncJobStates.$inferSelect | null,
  running = false,
): ConnectorSyncJobSummary {
  return {
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    service: row.service,
    action: row.action,
    dataset: row.dataset,
    connectionName: row.connectionName,
    resourceType: row.resourceType,
    allowedActions: row.allowedActions,
    input: row.input,
    goal: row.goal,
    promptProfileId: row.promptProfileId,
    promptOverride: row.promptOverride,
    promptVersion: row.promptVersion,
    schemaVersion: row.schemaVersion,
    scheduleType: row.scheduleType,
    timezone: row.timezone,
    retryPolicy: row.retryPolicy,
    priority: row.priority,
    status: row.status,
    configVersion: row.configVersion,
    intervalMs: row.intervalMs,
    enabled: row.status === "active",
    nextRunAt: iso(state ? state.nextRunAt : row.nextRunAt),
    lastRunAt: iso(state ? state.lastRunAt : row.lastRunAt),
    lastSuccessAt: iso(state ? state.lastSuccessAt : row.lastSuccessAt),
    lastError: state ? state.lastError : row.lastError,
    checkpoint: state ? state.checkpoint : row.checkpoint,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    running,
  };
}

export class ConnectorConfigVersionConflictError extends Error {
  constructor() {
    super("Connector sync job was changed by another request");
  }
}

export class ConnectorSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running = new Set<string>();
  private readonly activeAgentRuns = new Map<string, AgentSyncRunState>();
  private readonly instanceId = randomUUID();
  private agentRuntime: AgentRuntime | null = null;
  private disposeAgentRuntime = true;
  private filesService: FilesService | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly config: GatewayConfig,
    private readonly logger: ConnectorSyncLogger,
    private readonly runner: ConnectorSyncRunner = runOpenConnector,
  ) {}

  attachAgentRuntime(runtime: AgentRuntime, options: { disposeRuntime?: boolean } = {}): void {
    if (this.agentRuntime) throw new Error("Connector sync Agent runtime is already attached");
    this.agentRuntime = runtime;
    this.disposeAgentRuntime = options.disposeRuntime ?? true;
  }

  /**
   * runtime config 热应用：替换同步 agent runtime（不做双挂载防御，
   * 旧实例的 dispose 由调用方决定——onChange 路径经 AgentResolver.reload
   * 返回的 previous 自行处置）。
   */
  replaceAgentRuntime(runtime: AgentRuntime): void {
    this.agentRuntime = runtime;
  }

  setFilesService(service: FilesService): void {
    this.filesService = service;
    for (const row of this.db.select().from(connectorDocuments).where(isNull(connectorDocuments.deletedAt)).all()) {
      void this.importConnectorDocument(row);
    }
  }

  async initialize(): Promise<void> {
    const now = new Date();
    this.seedPromptProfiles(now);
    const existingJobs = this.db.select({ id: connectorSyncJobs.id }).from(connectorSyncJobs).all();
    if (existingJobs.length === 0) {
      for (const job of this.config.cliConnectorSyncJobs ?? []) this.seedJob(job, now);
    }
    this.backfillDerivedGmailQueries(now);
    for (const job of this.db.select().from(connectorSyncJobs).all()) this.ensureJobStateAndVersion(job, now);
    if (!this.config.cliConnectorSyncEnabled || !this.config.cliConnector) return;
    await this.refreshAccountsAndProvisionJobs(now);
    for (const job of this.db.select().from(connectorSyncJobs).all()) this.ensureJobStateAndVersion(job, now);
    this.timer = setInterval(() => void this.tick(), this.config.cliConnectorSyncIntervalMs ?? 300_000);
    this.timer.unref?.();
    void this.tick();
  }

  currentOwnerId(): string {
    return this.config.cliConnectorSyncOwnerId ?? this.config.connectorSyncOwnerId ?? "local-user";
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async dispose(): Promise<void> {
    this.close();
    if (this.disposeAgentRuntime) await this.agentRuntime?.dispose();
    this.agentRuntime = null;
  }

  authorizeAgentConnectorCall(
    input: StartRuntimeRunInput,
    toolName: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const state = this.requireAgentRun(input.runId);
    const service = typeof params.service === "string" && params.service.trim()
      ? params.service.trim()
      : state.job.service;
    if (service !== state.job.service) {
      throw new Error(`Sync Agent is restricted to connector service "${state.job.service}"`);
    }
    const normalized: Record<string, unknown> = { ...params, service };
    if (toolName === "connector_schema" || toolName === "connector_run") {
      const action = typeof params.name === "string" ? params.name.trim() : "";
      if (!state.job.allowedActions.includes(action)) {
        throw new Error(`Connector action "${action || "<missing>"}" is not approved for sync job ${state.job.id}`);
      }
    }
    if (toolName === "connector_run" && state.job.connectionName) {
      if (params.connectionName !== undefined && params.connectionName !== state.job.connectionName) {
        throw new Error(`Sync Agent cannot change connectionName for job ${state.job.id}`);
      }
      normalized.connectionName = state.job.connectionName;
    }
    return normalized;
  }

  writeAgentBatch(runId: string, resourceType: ConnectorResourceType, records: unknown[]): AgentBatchWriteResult {
    const state = this.requireAgentRun(runId);
    if (state.finishRequested) throw new Error("Sync run is already finalized");
    if (resourceType !== state.job.resourceType) {
      throw new Error(`Sync job ${state.job.id} only accepts ${state.job.resourceType} records`);
    }
    if (records.length === 0 || records.length > MAX_AGENT_BATCH_SIZE) {
      throw new Error(`sync_write_batch requires 1 to ${String(MAX_AGENT_BATCH_SIZE)} records`);
    }
    if (Buffer.byteLength(JSON.stringify(records)) > MAX_AGENT_BATCH_BYTES) {
      throw new Error("sync_write_batch payload exceeds 512 KiB");
    }
    const accepted: Array<{ index: number; record: Record<string, unknown>; sourceRecordId: string }> = [];
    const rejected: AgentBatchWriteResult["rejected"] = [];
    records.forEach((value, index) => {
      try {
        const record = objectValue(value);
        const sourceId = requiredText(record.sourceRecordId, "sourceRecordId");
        if (state.seenSourceIds.has(sourceId)) {
          rejected.push({ index, sourceRecordId: sourceId, reason: "duplicate sourceRecordId in this run" });
          return;
        }
        validateDomainRecord(resourceType, record);
        state.seenSourceIds.add(sourceId);
        accepted.push({ index, record, sourceRecordId: sourceId });
      } catch (error) {
        const record = objectValue(value);
        rejected.push({
          index,
          sourceRecordId: textValue(record.sourceRecordId),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const result: AgentBatchWriteResult = { inserted: 0, updated: 0, unchanged: 0, rejected };
    const syncedAt = new Date();
    this.db.transaction((tx) => {
      for (const item of accepted) {
        const outcome = upsertDomainRecord(tx, state, resourceType, item.record, syncedAt);
        result[outcome] += 1;
      }
    });
    if (resourceType === "document") {
      this.enqueueConnectorDocuments(state, accepted.map((item) => item.sourceRecordId));
    }
    state.stats.inserted += result.inserted;
    state.stats.updated += result.updated;
    state.stats.unchanged += result.unchanged;
    return result;
  }

  quarantineAgentRecords(
    runId: string,
    records: Array<{ sourceRecordId?: string; reason?: string; payload: Record<string, unknown> }>,
  ): { quarantined: number } {
    const state = this.requireAgentRun(runId);
    if (state.finishRequested) throw new Error("Sync run is already finalized");
    if (records.length === 0 || records.length > MAX_AGENT_BATCH_SIZE) {
      throw new Error(`sync_quarantine requires 1 to ${String(MAX_AGENT_BATCH_SIZE)} records`);
    }
    const now = new Date();
    this.db.transaction((tx) => {
      for (const record of records) {
        const reason = (textValue(record.reason) ?? "Agent could not map record to the target schema").slice(0, 1_000);
        tx.insert(connectorQuarantinedRecords).values({
          id: randomUUID(),
          ownerId: state.job.ownerId,
          jobId: state.job.id,
          runId,
          sourceRecordId: textValue(record.sourceRecordId),
          reason,
          payload: objectValue(record.payload),
          createdAt: now,
        }).run();
      }
    });
    state.stats.quarantined += records.length;
    return { quarantined: records.length };
  }

  finishAgentRun(
    runId: string,
    input: { discovered: number; checkpoint?: Record<string, unknown> | null },
  ): { status: "ready_to_commit"; stats: AgentSyncStats } {
    const state = this.requireAgentRun(runId);
    if (state.finishRequested) throw new Error("sync_finish has already been called");
    const accounted = state.stats.inserted + state.stats.updated
      + state.stats.unchanged + state.stats.quarantined;
    if (!Number.isInteger(input.discovered) || input.discovered < 0 || input.discovered !== accounted) {
      throw new Error(`discovered must equal inserted + updated + unchanged + quarantined (${String(accounted)})`);
    }
    state.finishRequested = true;
    state.discovered = input.discovered;
    state.checkpoint = input.checkpoint ? objectValue(input.checkpoint) : null;
    return { status: "ready_to_commit", stats: { ...state.stats } };
  }

  listAccounts(ownerId = this.currentOwnerId()) {
    return this.db.select().from(connectorAccounts)
      .where(eq(connectorAccounts.ownerId, ownerId))
      .orderBy(asc(connectorAccounts.createdAt)).all()
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  }

  listPromptProfiles(service?: string, resourceType?: string) {
    const conditions = [eq(connectorPromptProfiles.status, "published" as const)];
    if (service) conditions.push(eq(connectorPromptProfiles.service, service));
    if (resourceType === "email" || resourceType === "document" || resourceType === "calendar"
      || resourceType === "todo" || resourceType === "generic") {
      conditions.push(eq(connectorPromptProfiles.resourceType, resourceType));
    }
    return this.db.select().from(connectorPromptProfiles).where(and(...conditions))
      .orderBy(asc(connectorPromptProfiles.service), desc(connectorPromptProfiles.version)).all()
      .map((row) => ({ ...row, template: undefined, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }));
  }

  listJobs(ownerId = this.currentOwnerId()): ConnectorSyncJobSummary[] {
    const rows = this.db.select().from(connectorSyncJobs)
      .where(eq(connectorSyncJobs.ownerId, ownerId))
      .orderBy(asc(connectorSyncJobs.createdAt))
      .all();
    return rows.map((row) => jobSummary(row, this.jobState(row.id), this.running.has(row.id)));
  }

  getJob(id: string, ownerId = this.currentOwnerId()): ConnectorSyncJobSummary | null {
    const row = this.db.select().from(connectorSyncJobs)
      .where(and(eq(connectorSyncJobs.id, id), eq(connectorSyncJobs.ownerId, ownerId))).get();
    return row ? jobSummary(row, this.jobState(row.id), this.running.has(row.id)) : null;
  }

  createJob(input: ConnectorSyncJobInput, actor = "local-user"): ConnectorSyncJobSummary {
    const ownerId = this.currentOwnerId();
    const now = new Date();
    const normalized = this.normalizeJobInput(input);
    const profile = this.resolvePromptProfile(normalized.promptProfileId, normalized.service, normalized.resourceType);
    const id = randomUUID();
    this.db.transaction((tx) => {
      if (normalized.connectionName) {
        tx.insert(connectorAccounts).values({
          id: randomUUID(), ownerId, service: normalized.service, connectionName: normalized.connectionName,
          displayName: normalized.connectionName, accountLabel: normalized.connectionName,
          credentialRef: `open-connector:${normalized.service}:${normalized.connectionName}`,
          status: "active", createdAt: now, updatedAt: now,
        }).onConflictDoUpdate({
          target: [connectorAccounts.ownerId, connectorAccounts.service, connectorAccounts.connectionName],
          set: { status: "active", updatedAt: now },
        }).run();
      }
      tx.insert(connectorSyncJobs).values({
        id, ownerId, name: normalized.name, service: normalized.service,
        action: normalized.allowedActions[0] ?? "", allowedActions: normalized.allowedActions,
        dataset: normalized.dataset, resourceType: normalized.resourceType,
        connectionName: normalized.connectionName, input: normalized.input, goal: normalized.goal,
        prompt: null, promptProfileId: profile?.id ?? null, promptOverride: normalized.promptOverride,
        promptVersion: profile?.version ?? 1, schemaVersion: normalized.schemaVersion,
        intervalMs: normalized.intervalMs, scheduleType: normalized.scheduleType,
        timezone: normalized.timezone, retryPolicy: normalized.retryPolicy, priority: normalized.priority,
        status: normalized.status, configVersion: 1, enabled: normalized.status === "active",
        createdAt: now, updatedAt: now,
      }).run();
      tx.insert(connectorSyncJobStates).values({
        jobId: id,
        nextRunAt: normalized.status === "active" && normalized.scheduleType === "interval"
          ? new Date(now.getTime() + normalized.intervalMs) : null,
        updatedAt: now,
      }).run();
    });
    const row = this.requireOwnedJob(id, ownerId);
    this.persistJobVersion(row, actor, "created");
    this.auditConfiguration(row, actor, "connector_sync_job.created");
    return jobSummary(row, this.jobState(id));
  }

  updateJob(id: string, patch: ConnectorSyncJobPatch, actor = "local-user"): ConnectorSyncJobSummary | null {
    const ownerId = this.currentOwnerId();
    const current = this.db.select().from(connectorSyncJobs)
      .where(and(eq(connectorSyncJobs.id, id), eq(connectorSyncJobs.ownerId, ownerId))).get();
    if (!current) return null;
    if (current.status === "archived") throw new Error("Archived connector sync jobs are read-only");
    if (current.configVersion !== patch.configVersion) throw new ConnectorConfigVersionConflictError();
    const normalized = this.normalizeJobInput({
      name: patch.name ?? current.name,
      service: patch.service ?? current.service,
      dataset: patch.dataset ?? current.dataset,
      resourceType: patch.resourceType ?? current.resourceType,
      connectionName: patch.connectionName === undefined ? current.connectionName : patch.connectionName,
      allowedActions: patch.allowedActions ?? current.allowedActions,
      input: patch.input ?? current.input,
      goal: patch.goal ?? current.goal,
      promptProfileId: patch.promptProfileId === undefined ? current.promptProfileId : patch.promptProfileId,
      promptOverride: patch.promptOverride === undefined ? current.promptOverride : patch.promptOverride,
      schemaVersion: patch.schemaVersion ?? current.schemaVersion,
      scheduleType: patch.scheduleType ?? current.scheduleType,
      intervalMs: patch.intervalMs ?? current.intervalMs,
      timezone: patch.timezone ?? current.timezone,
      retryPolicy: patch.retryPolicy ?? current.retryPolicy,
      priority: patch.priority ?? current.priority,
      status: patch.status ?? current.status,
    });
    const profile = this.resolvePromptProfile(normalized.promptProfileId, normalized.service, normalized.resourceType);
    const now = new Date();
    const result = this.db.update(connectorSyncJobs).set({
      name: normalized.name, service: normalized.service,
      action: normalized.allowedActions[0] ?? "", allowedActions: normalized.allowedActions,
      dataset: normalized.dataset, resourceType: normalized.resourceType,
      connectionName: normalized.connectionName, input: normalized.input, goal: normalized.goal,
      promptProfileId: profile?.id ?? null, promptOverride: normalized.promptOverride,
      promptVersion: profile?.version ?? current.promptVersion, schemaVersion: normalized.schemaVersion,
      intervalMs: normalized.intervalMs, scheduleType: normalized.scheduleType,
      timezone: normalized.timezone, retryPolicy: normalized.retryPolicy, priority: normalized.priority,
      status: normalized.status, enabled: normalized.status === "active",
      configVersion: current.configVersion + 1, updatedAt: now,
    }).where(and(
      eq(connectorSyncJobs.id, id), eq(connectorSyncJobs.ownerId, ownerId),
      eq(connectorSyncJobs.configVersion, patch.configVersion),
    )).run() as { changes: number };
    if (result.changes !== 1) throw new ConnectorConfigVersionConflictError();
    const scheduleChanged = normalized.scheduleType !== current.scheduleType || normalized.intervalMs !== current.intervalMs;
    const state = this.jobState(id);
    this.db.update(connectorSyncJobStates).set({
      nextRunAt: normalized.status === "active" && normalized.scheduleType === "interval"
        ? (!state?.nextRunAt || scheduleChanged || current.status !== "active"
            ? new Date(now.getTime() + normalized.intervalMs)
            : state.nextRunAt)
        : null,
      leaseOwner: normalized.status === "active" ? state?.leaseOwner ?? null : null,
      leaseExpiresAt: normalized.status === "active" ? state?.leaseExpiresAt ?? null : null,
      updatedAt: now,
    }).where(eq(connectorSyncJobStates.jobId, id)).run();
    const updated = this.requireOwnedJob(id, ownerId);
    this.persistJobVersion(updated, actor, "updated");
    this.auditConfiguration(updated, actor, "connector_sync_job.updated");
    return jobSummary(updated, this.jobState(id), this.running.has(id));
  }

  setJobStatus(id: string, status: Exclude<ConnectorJobStatus, "draft">, configVersion: number, actor = "local-user") {
    return this.updateJob(id, { configVersion, status }, actor);
  }

  listJobVersions(id: string) {
    const job = this.requireOwnedJob(id, this.currentOwnerId());
    return this.db.select().from(connectorSyncJobVersions)
      .where(eq(connectorSyncJobVersions.jobId, job.id))
      .orderBy(desc(connectorSyncJobVersions.version)).all()
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  listRuns(jobId: string, limit = 50) {
    const job = this.requireOwnedJob(jobId, this.currentOwnerId());
    return this.db.select().from(connectorSyncRuns).where(eq(connectorSyncRuns.jobId, job.id))
      .orderBy(desc(connectorSyncRuns.startedAt)).limit(Math.min(Math.max(limit, 1), 100)).all()
      .map(serializeRun);
  }

  getRun(runId: string) {
    const run = this.db.select().from(connectorSyncRuns).where(eq(connectorSyncRuns.id, runId)).get();
    if (!run) return null;
    this.requireOwnedJob(run.jobId, this.currentOwnerId());
    return serializeRun(run);
  }

  listRunQuarantine(runId: string) {
    const run = this.db.select().from(connectorSyncRuns).where(eq(connectorSyncRuns.id, runId)).get();
    if (!run) return null;
    this.requireOwnedJob(run.jobId, this.currentOwnerId());
    return this.db.select().from(connectorQuarantinedRecords)
      .where(eq(connectorQuarantinedRecords.runId, runId))
      .orderBy(desc(connectorQuarantinedRecords.createdAt)).all()
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
  }

  async triggerJob(id: string, ownerId = this.currentOwnerId()): Promise<ConnectorSyncJobSummary | null> {
    const row = this.db.select().from(connectorSyncJobs)
      .where(and(eq(connectorSyncJobs.id, id), eq(connectorSyncJobs.ownerId, ownerId))).get();
    if (!row) return null;
    if (row.status === "archived") throw new Error("Archived connector sync jobs cannot run");
    await this.runJob(row);
    return this.getJob(id, ownerId);
  }

  queryRecords(query: ConnectorRecordQuery) {
    return this.queryRecordPage({ ...query, offset: 0 }).items;
  }

  queryRecordPage(query: ConnectorRecordQuery) {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const requestedDataset = query.dataset?.trim();
    const resourceType = requestedDataset ? resourceTypeFromDataset(requestedDataset) : null;
    const searchAllDomains = !requestedDataset;
    const domainLimit = offset + limit;
    const domainRecords = resourceType || searchAllDomains
      ? [
          ...(searchAllDomains || resourceType === "email" ? this.queryEmails(query, domainLimit) : []),
          ...(searchAllDomains || resourceType === "document" ? this.queryDocuments(query, domainLimit) : []),
          ...(searchAllDomains || resourceType === "calendar" ? this.queryCalendarEvents(query, domainLimit) : []),
          ...(searchAllDomains || resourceType === "todo" ? this.queryTodos(query, domainLimit) : []),
        ].sort((left, right) => right.syncedAt.localeCompare(left.syncedAt) || right.id.localeCompare(left.id))
      : [];
    const domainTotal = resourceType || searchAllDomains
      ? (searchAllDomains || resourceType === "email" ? this.countEmails(query) : 0)
        + (searchAllDomains || resourceType === "document" ? this.countDocuments(query) : 0)
        + (searchAllDomains || resourceType === "calendar" ? this.countCalendarEvents(query) : 0)
        + (searchAllDomains || resourceType === "todo" ? this.countTodos(query) : 0)
      : 0;
    if (domainTotal > 0) {
      return { items: domainRecords.slice(offset, offset + limit), total: domainTotal, limit, offset };
    }

    const conditions = [eq(connectorRecords.ownerId, query.ownerId), isNull(connectorRecords.deletedAt)];
    if (query.service) conditions.push(eq(connectorRecords.service, query.service));
    if (query.dataset) conditions.push(eq(connectorRecords.dataset, query.dataset));
    if (!query.includeExpired) {
      conditions.push(or(isNull(connectorRecords.expiresAt), gte(connectorRecords.expiresAt, new Date()))!);
    }
    if (query.query?.trim()) conditions.push(like(connectorRecords.payload, `%${query.query.trim()}%`));
    const where = and(...conditions);
    const items = this.db.select().from(connectorRecords)
      .where(where)
      .orderBy(desc(connectorRecords.syncedAt), desc(connectorRecords.id))
      .limit(limit)
      .offset(offset)
      .all()
      .map((row) => ({
        id: row.id,
        ownerId: row.ownerId,
        service: row.service,
        dataset: row.dataset,
        sourceRecordId: row.sourceRecordId,
        payload: row.payload,
        sourceUpdatedAt: iso(row.sourceUpdatedAt),
        syncedAt: row.syncedAt.toISOString(),
        expiresAt: iso(row.expiresAt),
      }));
    const total = this.db.select({ id: connectorRecords.id }).from(connectorRecords).where(where).all().length;
    return { items, total, limit, offset };
  }

  getRecord(ownerId: string, recordId: string) {
    const email = this.db.select().from(connectorEmails)
      .where(and(eq(connectorEmails.ownerId, ownerId), eq(connectorEmails.id, recordId), isNull(connectorEmails.deletedAt))).get();
    if (email) return { resourceType: "email" as const, ...email, syncedAt: email.syncedAt.toISOString(), sourceUpdatedAt: iso(email.sourceUpdatedAt), sentAt: iso(email.sentAt) };
    const document = this.db.select().from(connectorDocuments)
      .where(and(eq(connectorDocuments.ownerId, ownerId), eq(connectorDocuments.id, recordId), isNull(connectorDocuments.deletedAt))).get();
    if (document) return { resourceType: "document" as const, ...document, syncedAt: document.syncedAt.toISOString(), sourceUpdatedAt: iso(document.sourceUpdatedAt) };
    const event = this.db.select().from(connectorCalendarEvents)
      .where(and(eq(connectorCalendarEvents.ownerId, ownerId), eq(connectorCalendarEvents.id, recordId), isNull(connectorCalendarEvents.deletedAt))).get();
    if (event) return {
      resourceType: "calendar" as const,
      ...event,
      syncedAt: event.syncedAt.toISOString(),
      sourceUpdatedAt: iso(event.sourceUpdatedAt),
      startAt: iso(event.startAt),
      endAt: iso(event.endAt),
    };
    const todo = this.db.select().from(connectorTodos)
      .where(and(eq(connectorTodos.ownerId, ownerId), eq(connectorTodos.id, recordId), isNull(connectorTodos.deletedAt))).get();
    if (todo) return {
      resourceType: "todo" as const,
      ...todo,
      syncedAt: todo.syncedAt.toISOString(),
      sourceUpdatedAt: iso(todo.sourceUpdatedAt),
      dueAt: iso(todo.dueAt),
      completedAt: iso(todo.completedAt),
    };
    const generic = this.db.select().from(connectorRecords).where(and(
      eq(connectorRecords.ownerId, ownerId),
      eq(connectorRecords.id, recordId),
      isNull(connectorRecords.deletedAt),
    )).get();
    if (generic) return {
      resourceType: "generic" as const,
      ...generic,
      syncedAt: generic.syncedAt.toISOString(),
      sourceUpdatedAt: iso(generic.sourceUpdatedAt),
      expiresAt: iso(generic.expiresAt),
    };
    return null;
  }

  status(ownerId?: string) {
    const jobs = this.listJobs(ownerId);
    const legacyRecords = this.db.select({ id: connectorRecords.id })
      .from(connectorRecords)
      .where(ownerId ? and(eq(connectorRecords.ownerId, ownerId), isNull(connectorRecords.deletedAt)) : isNull(connectorRecords.deletedAt))
      .all().length;
    const domainRecordCount = this.domainRecordCount(ownerId);
    return {
      enabled: this.config.cliConnectorSyncEnabled,
      runtimeConfigured: Boolean(this.config.cliConnector),
      jobs,
      recordCount: legacyRecords + domainRecordCount,
      domainRecordCount,
    };
  }

  private queryEmails(query: ConnectorRecordQuery, limit = Math.min(query.limit ?? 20, 100)) {
    const conditions = [eq(connectorEmails.ownerId, query.ownerId), isNull(connectorEmails.deletedAt)];
    if (query.service) conditions.push(eq(connectorEmails.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorEmails.messageId, value),
        like(connectorEmails.subject, value),
        like(connectorEmails.senderAddress, value),
        like(connectorEmails.bodyText, value),
      )!);
    }
    return this.db.select().from(connectorEmails).where(and(...conditions))
      .orderBy(desc(connectorEmails.syncedAt), desc(connectorEmails.id)).limit(limit).all()
      .map((row) => ({
        id: row.id, resourceType: "email" as const, service: row.service, sourceRecordId: row.sourceRecordId,
        title: row.subject, snippet: row.bodyText.slice(0, 500), senderAddress: row.senderAddress,
        sentAt: iso(row.sentAt), sourceUpdatedAt: iso(row.sourceUpdatedAt), syncedAt: row.syncedAt.toISOString(),
        freshness: "fresh" as const, matchedBy: query.query ? ["email_text"] : ["dataset"],
      }));
  }

  private queryDocuments(query: ConnectorRecordQuery, limit = Math.min(query.limit ?? 20, 100)) {
    const conditions = [eq(connectorDocuments.ownerId, query.ownerId), isNull(connectorDocuments.deletedAt)];
    if (query.service) conditions.push(eq(connectorDocuments.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(like(connectorDocuments.documentId, value), like(connectorDocuments.title, value), like(connectorDocuments.bodyText, value))!);
    }
    return this.db.select().from(connectorDocuments).where(and(...conditions))
      .orderBy(desc(connectorDocuments.syncedAt), desc(connectorDocuments.id)).limit(limit).all()
      .map((row) => ({
        id: row.id, resourceType: "document" as const, service: row.service, sourceRecordId: row.sourceRecordId,
        title: row.title, snippet: row.bodyText.slice(0, 500), sourceUrl: row.sourceUrl,
        sourceUpdatedAt: iso(row.sourceUpdatedAt), syncedAt: row.syncedAt.toISOString(),
        freshness: "fresh" as const, matchedBy: query.query ? ["document_text"] : ["dataset"],
      }));
  }

  private queryCalendarEvents(query: ConnectorRecordQuery, limit = Math.min(query.limit ?? 20, 100)) {
    const conditions = [eq(connectorCalendarEvents.ownerId, query.ownerId), isNull(connectorCalendarEvents.deletedAt)];
    if (query.service) conditions.push(eq(connectorCalendarEvents.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorCalendarEvents.eventId, value), like(connectorCalendarEvents.title, value),
        like(connectorCalendarEvents.description, value), like(connectorCalendarEvents.location, value),
      )!);
    }
    return this.db.select().from(connectorCalendarEvents).where(and(...conditions))
      .orderBy(desc(connectorCalendarEvents.syncedAt), desc(connectorCalendarEvents.id)).limit(limit).all()
      .map((row) => ({
        id: row.id, resourceType: "calendar" as const, service: row.service, sourceRecordId: row.sourceRecordId,
        title: row.title, snippet: row.description.slice(0, 500), location: row.location,
        startAt: iso(row.startAt), endAt: iso(row.endAt), sourceUpdatedAt: iso(row.sourceUpdatedAt),
        syncedAt: row.syncedAt.toISOString(), freshness: "fresh" as const,
        matchedBy: query.query ? ["calendar_text"] : ["dataset"],
      }));
  }

  private queryTodos(query: ConnectorRecordQuery, limit = Math.min(query.limit ?? 20, 100)) {
    const conditions = [eq(connectorTodos.ownerId, query.ownerId), isNull(connectorTodos.deletedAt)];
    if (query.service) conditions.push(eq(connectorTodos.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorTodos.todoId, value), like(connectorTodos.title, value),
        like(connectorTodos.notes, value), like(connectorTodos.listName, value),
      )!);
    }
    return this.db.select().from(connectorTodos).where(and(...conditions))
      .orderBy(desc(connectorTodos.syncedAt), desc(connectorTodos.id)).limit(limit).all()
      .map((row) => ({
        id: row.id, resourceType: "todo" as const, service: row.service, sourceRecordId: row.sourceRecordId,
        title: row.title, snippet: row.notes.slice(0, 500), status: row.status,
        dueAt: iso(row.dueAt), completedAt: iso(row.completedAt), priority: row.priority,
        listName: row.listName, sourceUpdatedAt: iso(row.sourceUpdatedAt),
        syncedAt: row.syncedAt.toISOString(), freshness: "fresh" as const,
        matchedBy: query.query ? ["todo_text"] : ["dataset"],
      }));
  }

  private countEmails(query: ConnectorRecordQuery): number {
    const conditions = [eq(connectorEmails.ownerId, query.ownerId), isNull(connectorEmails.deletedAt)];
    if (query.service) conditions.push(eq(connectorEmails.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorEmails.messageId, value), like(connectorEmails.subject, value),
        like(connectorEmails.senderAddress, value), like(connectorEmails.bodyText, value),
      )!);
    }
    return this.db.select({ id: connectorEmails.id }).from(connectorEmails).where(and(...conditions)).all().length;
  }

  private countDocuments(query: ConnectorRecordQuery): number {
    const conditions = [eq(connectorDocuments.ownerId, query.ownerId), isNull(connectorDocuments.deletedAt)];
    if (query.service) conditions.push(eq(connectorDocuments.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorDocuments.documentId, value), like(connectorDocuments.title, value),
        like(connectorDocuments.bodyText, value),
      )!);
    }
    return this.db.select({ id: connectorDocuments.id }).from(connectorDocuments).where(and(...conditions)).all().length;
  }

  private countCalendarEvents(query: ConnectorRecordQuery): number {
    const conditions = [eq(connectorCalendarEvents.ownerId, query.ownerId), isNull(connectorCalendarEvents.deletedAt)];
    if (query.service) conditions.push(eq(connectorCalendarEvents.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorCalendarEvents.eventId, value), like(connectorCalendarEvents.title, value),
        like(connectorCalendarEvents.description, value), like(connectorCalendarEvents.location, value),
      )!);
    }
    return this.db.select({ id: connectorCalendarEvents.id })
      .from(connectorCalendarEvents).where(and(...conditions)).all().length;
  }

  private countTodos(query: ConnectorRecordQuery): number {
    const conditions = [eq(connectorTodos.ownerId, query.ownerId), isNull(connectorTodos.deletedAt)];
    if (query.service) conditions.push(eq(connectorTodos.service, query.service));
    if (query.query?.trim()) {
      const value = `%${query.query.trim()}%`;
      conditions.push(or(
        like(connectorTodos.todoId, value), like(connectorTodos.title, value),
        like(connectorTodos.notes, value), like(connectorTodos.listName, value),
      )!);
    }
    return this.db.select({ id: connectorTodos.id })
      .from(connectorTodos).where(and(...conditions)).all().length;
  }

  private domainRecordCount(ownerId?: string): number {
    const emailCondition = ownerId ? and(eq(connectorEmails.ownerId, ownerId), isNull(connectorEmails.deletedAt)) : isNull(connectorEmails.deletedAt);
    const documentCondition = ownerId ? and(eq(connectorDocuments.ownerId, ownerId), isNull(connectorDocuments.deletedAt)) : isNull(connectorDocuments.deletedAt);
    const calendarCondition = ownerId ? and(eq(connectorCalendarEvents.ownerId, ownerId), isNull(connectorCalendarEvents.deletedAt)) : isNull(connectorCalendarEvents.deletedAt);
    const todoCondition = ownerId ? and(eq(connectorTodos.ownerId, ownerId), isNull(connectorTodos.deletedAt)) : isNull(connectorTodos.deletedAt);
    return this.db.select({ id: connectorEmails.id }).from(connectorEmails).where(emailCondition).all().length
      + this.db.select({ id: connectorDocuments.id }).from(connectorDocuments).where(documentCondition).all().length
      + this.db.select({ id: connectorCalendarEvents.id }).from(connectorCalendarEvents).where(calendarCondition).all().length
      + this.db.select({ id: connectorTodos.id }).from(connectorTodos).where(todoCondition).all().length;
  }

  private seedPromptProfiles(now: Date): void {
    for (const profile of BUILTIN_PROMPT_PROFILES) {
      this.db.insert(connectorPromptProfiles).values({
        ...profile,
        contentHash: contentHash(profile.template),
        status: "published",
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing().run();
    }
  }

  private resolvePromptProfile(
    profileId: string | null,
    service: string,
    resourceType: ConnectorSyncJobInput["resourceType"],
  ): typeof connectorPromptProfiles.$inferSelect | null {
    if (profileId) {
      const profile = this.db.select().from(connectorPromptProfiles)
        .where(and(eq(connectorPromptProfiles.id, profileId), eq(connectorPromptProfiles.status, "published"))).get();
      if (!profile) throw new Error("Prompt Profile does not exist or is not published");
      if (profile.service !== service || profile.resourceType !== resourceType) {
        throw new Error("Prompt Profile is not compatible with the selected connector and data type");
      }
      return profile;
    }
    return this.db.select().from(connectorPromptProfiles).where(and(
      eq(connectorPromptProfiles.service, service),
      eq(connectorPromptProfiles.resourceType, resourceType),
      eq(connectorPromptProfiles.status, "published"),
    )).orderBy(desc(connectorPromptProfiles.version)).get() ?? null;
  }

  private normalizeJobInput(input: ConnectorSyncJobInput) {
    const name = input.name.trim();
    const service = input.service.trim();
    const dataset = input.dataset.trim();
    const goal = input.goal.trim();
    if (!name || !service || !dataset || !goal) throw new Error("name, service, dataset, and goal are required");
    const allowedActions = [...new Set(input.allowedActions.map((action) => action.trim()).filter(Boolean))];
    if (allowedActions.length === 0) throw new Error("At least one connector Action is required");
    const unsafeAction = allowedActions.find(isObviouslyMutatingConnectorAction);
    if (unsafeAction) throw new Error(`Connector Action "${unsafeAction}" is not read-only`);
    const promptOverride = input.promptOverride?.trim() || null;
    if (promptOverride && promptOverride.length > MAX_PROMPT_OVERRIDE_LENGTH) {
      throw new Error(`promptOverride must not exceed ${String(MAX_PROMPT_OVERRIDE_LENGTH)} characters`);
    }
    if (input.resourceType !== "email" && input.resourceType !== "document"
      && input.resourceType !== "calendar" && input.resourceType !== "todo"
      && input.resourceType !== "generic") {
      throw new Error("Unsupported connector resource type");
    }
    const intervalMs = Math.max(Math.trunc(input.intervalMs), MIN_INTERVAL_MS);
    const retryPolicy = input.retryPolicy ?? { maxAttempts: 3, baseDelayMs: 30_000 };
    if (!Number.isInteger(retryPolicy.maxAttempts) || retryPolicy.maxAttempts < 1 || retryPolicy.maxAttempts > 10) {
      throw new Error("retryPolicy.maxAttempts must be between 1 and 10");
    }
    if (!Number.isInteger(retryPolicy.baseDelayMs) || retryPolicy.baseDelayMs < 1_000 || retryPolicy.baseDelayMs > 3_600_000) {
      throw new Error("retryPolicy.baseDelayMs must be between 1000 and 3600000");
    }
    const normalizedInput = objectValue(input.input);
    const gmailQuery = service === "gmail" ? inferGmailQuery(name, goal, normalizedInput) : null;
    return {
      ...input,
      name,
      service,
      dataset,
      goal,
      connectionName: input.connectionName?.trim() || null,
      allowedActions,
      input: gmailQuery && !textValue(normalizedInput.query)
        ? { ...normalizedInput, query: gmailQuery }
        : normalizedInput,
      promptProfileId: input.promptProfileId?.trim() || null,
      promptOverride,
      schemaVersion: Math.max(Math.trunc(input.schemaVersion ?? 1), 1),
      intervalMs,
      timezone: input.timezone.trim() || "Asia/Shanghai",
      retryPolicy,
      priority: Math.trunc(input.priority ?? 0),
    };
  }

  private requireOwnedJob(id: string, ownerId: string): typeof connectorSyncJobs.$inferSelect {
    const job = this.db.select().from(connectorSyncJobs)
      .where(and(eq(connectorSyncJobs.id, id), eq(connectorSyncJobs.ownerId, ownerId))).get();
    if (!job) throw new Error("Connector sync job not found");
    return job;
  }

  private jobState(jobId: string): typeof connectorSyncJobStates.$inferSelect | null {
    return this.db.select().from(connectorSyncJobStates)
      .where(eq(connectorSyncJobStates.jobId, jobId)).get() ?? null;
  }

  private ensureJobStateAndVersion(job: typeof connectorSyncJobs.$inferSelect, now: Date): void {
    this.db.insert(connectorSyncJobStates).values({
      jobId: job.id,
      checkpoint: job.checkpoint,
      nextRunAt: job.nextRunAt,
      lastRunAt: job.lastRunAt,
      lastSuccessAt: job.lastSuccessAt,
      lastError: job.lastError,
      updatedAt: now,
    }).onConflictDoNothing().run();
    const version = this.db.select({ id: connectorSyncJobVersions.id }).from(connectorSyncJobVersions)
      .where(and(eq(connectorSyncJobVersions.jobId, job.id), eq(connectorSyncJobVersions.version, job.configVersion))).get();
    if (!version) this.persistJobVersion(job, "system:migration", "migrated");
  }

  private persistJobVersion(job: typeof connectorSyncJobs.$inferSelect, actor: string, reason: string): void {
    this.db.insert(connectorSyncJobVersions).values({
      id: randomUUID(),
      jobId: job.id,
      version: job.configVersion,
      configSnapshot: jobConfigSnapshot(job),
      changedBy: actor,
      changeReason: reason,
      createdAt: new Date(),
    }).onConflictDoNothing().run();
  }

  private auditConfiguration(job: typeof connectorSyncJobs.$inferSelect, actor: string, operation: string): void {
    this.db.insert(connectorAuditEvents).values({
      id: randomUUID(), ownerId: job.ownerId, requestId: randomUUID(), actor,
      operation, effect: "configure", result: { jobId: job.id, configVersion: job.configVersion },
      createdAt: new Date(),
    }).run();
  }

  private backfillDerivedGmailQueries(now: Date): void {
    const jobs = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.service, "gmail")).all();
    for (const job of jobs) {
      if (gmailSyncMode(job.input) !== "snapshot" || textValue(job.input.query)) continue;
      const query = inferGmailQuery(job.name, job.goal, job.input);
      if (!query) continue;
      const configVersion = job.configVersion + 1;
      this.db.update(connectorSyncJobs).set({
        input: { ...job.input, query }, configVersion, updatedAt: now,
      }).where(eq(connectorSyncJobs.id, job.id)).run();
      const updated = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, job.id)).get();
      if (updated) this.persistJobVersion(updated, "system", "derived Gmail query from task description");
    }
  }

  private acquireLease(jobId: string, now: Date): boolean {
    const result = this.db.update(connectorSyncJobStates).set({
      leaseOwner: this.instanceId,
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
      updatedAt: now,
    }).where(and(
      eq(connectorSyncJobStates.jobId, jobId),
      or(
        isNull(connectorSyncJobStates.leaseOwner),
        eq(connectorSyncJobStates.leaseOwner, this.instanceId),
        lte(connectorSyncJobStates.leaseExpiresAt, now),
      ),
    )).run() as { changes: number };
    return result.changes === 1;
  }

  private releaseLease(jobId: string): void {
    this.db.update(connectorSyncJobStates).set({
      leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date(),
    }).where(and(
      eq(connectorSyncJobStates.jobId, jobId),
      eq(connectorSyncJobStates.leaseOwner, this.instanceId),
    )).run();
  }

  private seedJob(job: ConnectorSyncJobConfig, now: Date): void {
    const intervalMs = Math.max(job.intervalMs ?? this.config.cliConnectorSyncIntervalMs ?? 300_000, MIN_INTERVAL_MS);
    const existing = this.db.select({ id: connectorSyncJobs.id })
      .from(connectorSyncJobs).where(eq(connectorSyncJobs.id, job.id)).get();
    if (existing) {
      this.db.update(connectorSyncJobs).set({
        ownerId: job.ownerId,
        name: job.id,
        service: job.service,
        action: job.action ?? "",
        allowedActions: job.allowedActions,
        dataset: job.dataset,
        resourceType: job.resourceType,
        connectionName: job.connectionName ?? null,
        input: job.input,
        goal: job.goal,
        prompt: job.prompt ?? null,
        promptProfileId: null,
        promptVersion: job.promptVersion,
        schemaVersion: job.schemaVersion,
        intervalMs,
        scheduleType: "interval",
        status: "active",
        enabled: true,
        updatedAt: now,
      }).where(eq(connectorSyncJobs.id, job.id)).run();
      return;
    }
    this.db.insert(connectorSyncJobs).values({
      id: job.id,
      ownerId: job.ownerId,
      name: job.id,
      service: job.service,
      action: job.action ?? "",
      allowedActions: job.allowedActions,
      dataset: job.dataset,
      resourceType: job.resourceType,
      connectionName: job.connectionName ?? null,
      input: job.input,
      goal: job.goal,
      prompt: job.prompt ?? null,
      promptProfileId: null,
      promptVersion: job.promptVersion,
      schemaVersion: job.schemaVersion,
      intervalMs,
      scheduleType: "interval",
      status: "active",
      enabled: true,
      nextRunAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  private async tick(): Promise<void> {
    if (!this.config.cliConnectorSyncEnabled || !this.config.cliConnector) return;
    const now = new Date();
    await this.refreshAccountsAndProvisionJobs(now);
    const due = this.db.select().from(connectorSyncJobs)
      .where(and(eq(connectorSyncJobs.status, "active"), eq(connectorSyncJobs.scheduleType, "interval")))
      .orderBy(desc(connectorSyncJobs.priority), asc(connectorSyncJobs.createdAt)).all()
      .filter((job) => {
        const state = this.jobState(job.id);
        if (gmailSyncMode(job.input) === "incremental" && !textValue(state?.checkpoint?.historyId)) return false;
        if (managedDocumentSyncMode(job.input) === "incremental" && !this.hasDocumentIncrementalCheckpoint(job, state?.checkpoint)) {
          return false;
        }
        return !state?.nextRunAt || state.nextRunAt <= now;
      });
    await Promise.all(due.map((job) => this.runJob(job)));
  }

  private async runJob(job: typeof connectorSyncJobs.$inferSelect): Promise<void> {
    if (!this.config.cliConnector || this.running.has(job.id)) return;
    const startedAt = new Date();
    if (!this.acquireLease(job.id, startedAt)) return;
    this.running.add(job.id);
    const runId = randomUUID();
    const state = this.jobState(job.id);
    const profile = job.promptProfileId
      ? this.db.select().from(connectorPromptProfiles).where(eq(connectorPromptProfiles.id, job.promptProfileId)).get()
      : null;
    const jobForRun = {
      ...job,
      checkpoint: state?.checkpoint ?? job.checkpoint,
      prompt: [profile?.template, job.promptOverride].filter(Boolean).join("\n") || job.prompt,
      promptVersion: profile?.version ?? job.promptVersion,
    };
    const jobVersion = this.db.select().from(connectorSyncJobVersions).where(and(
      eq(connectorSyncJobVersions.jobId, job.id),
      eq(connectorSyncJobVersions.version, job.configVersion),
    )).get();
    const renderedPrompt = job.resourceType === "generic" ? null : connectorSyncPrompt(jobForRun);
    const scheduledNextRunAt = this.scheduledNextRunAt(job, startedAt);
    this.db.insert(connectorSyncRuns).values({
      id: runId,
      jobId: job.id,
      jobVersionId: jobVersion?.id ?? null,
      status: "running",
      agentModel: this.isDeterministicGmailJob(job) || this.isDeterministicDocumentJob(job)
        ? null
        : this.config.backgroundPi?.model ?? null,
      renderedPromptHash: renderedPrompt ? contentHash(renderedPrompt) : null,
      promptProfileVersion: profile?.version ?? null,
      inputCheckpoint: state?.checkpoint ?? null,
      promptVersion: jobForRun.promptVersion,
      schemaVersion: job.schemaVersion,
      startedAt,
    }).run();
    this.db.update(connectorSyncJobStates).set({
      lastRunAt: startedAt,
      nextRunAt: scheduledNextRunAt,
      updatedAt: startedAt,
    }).where(eq(connectorSyncJobStates.jobId, job.id)).run();
    this.db.update(connectorSyncJobs).set({
      lastRunAt: startedAt,
      nextRunAt: scheduledNextRunAt,
      updatedAt: startedAt,
    }).where(eq(connectorSyncJobs.id, job.id)).run();
    try {
      if (this.isDeterministicGmailJob(jobForRun)) {
        await this.runGmailJob(jobForRun, runId);
        return;
      }
      if (this.isDeterministicDocumentJob(jobForRun)) {
        await this.runDocumentJob(jobForRun, runId);
        return;
      }
      if (this.agentRuntime && job.resourceType !== "generic") {
        await this.runAgentJob(jobForRun, runId);
        return;
      }
      await this.runLegacyJob(jobForRun, runId);
    } catch (error) {
      this.failRun(jobForRun, runId, error);
    } finally {
      this.activeAgentRuns.delete(runId);
      this.running.delete(job.id);
      this.releaseLease(job.id);
    }
  }

  private async runAgentJob(
    job: typeof connectorSyncJobs.$inferSelect,
    runId: string,
  ): Promise<void> {
    if (!this.agentRuntime) throw new Error("Connector sync Agent runtime is unavailable");
    if (job.resourceType === "generic") throw new Error("Generic connector jobs cannot use the domain sync Agent");
    const state: AgentSyncRunState = {
      runId,
      job,
      stats: { inserted: 0, updated: 0, unchanged: 0, quarantined: 0 },
      seenSourceIds: new Set(),
      finishRequested: false,
      discovered: null,
      checkpoint: null,
    };
    this.activeAgentRuns.set(runId, state);
    const sessionId = `connector-sync:${job.id}:${runId}`;
    let runtimeSessionRef: string | null = null;
    try {
      const runtimeRun = await this.agentRuntime.start({
        runId,
        sessionId,
        runtimeSessionRef: null,
        originalPrompt: job.goal,
        prompt: connectorSyncPrompt(job),
        pageLabel: `${job.resourceType} 同步 Agent`,
        roomId: null,
        captureMemory: false,
      });
      runtimeSessionRef = runtimeRun.runtimeSessionRef;
      for await (const event of runtimeRun.events) {
        if (event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") {
          const message = (event.payload as { message?: unknown }).message;
          throw new Error(typeof message === "string" ? message : "Connector sync Agent run failed");
        }
      }
      if (!state.finishRequested || state.discovered === null) {
        throw new Error("Connector sync Agent completed without calling sync_finish");
      }
      const finishedAt = new Date();
      this.db.transaction((tx) => {
        tx.update(connectorSyncRuns).set({
          status: "success",
          cursor: state.checkpoint ? stableJson(state.checkpoint) : null,
          discovered: state.discovered!,
          inserted: state.stats.inserted,
          updated: state.stats.updated,
          unchanged: state.stats.unchanged,
          quarantined: state.stats.quarantined,
          failed: state.stats.quarantined,
          outputCheckpoint: state.checkpoint,
          finishedAt,
        }).where(eq(connectorSyncRuns.id, runId)).run();
        tx.update(connectorSyncJobStates).set({
          checkpoint: state.checkpoint,
          lastSuccessAt: finishedAt,
          lastError: null,
          consecutiveFailures: 0,
          updatedAt: finishedAt,
        }).where(eq(connectorSyncJobStates.jobId, job.id)).run();
        tx.update(connectorSyncJobs).set({
          checkpoint: state.checkpoint, lastSuccessAt: finishedAt, lastError: null, updatedAt: finishedAt,
        }).where(eq(connectorSyncJobs.id, job.id)).run();
        tx.insert(connectorAuditEvents).values({
          id: randomUUID(),
          ownerId: job.ownerId,
          requestId: runId,
          actor: `connector-sync-agent:${job.resourceType}`,
          operation: `${job.service}.${job.allowedActions.join(",")}`,
          effect: "read_and_local_write",
          result: { status: "success", dataset: job.dataset, ...state.stats },
          createdAt: finishedAt,
        }).run();
      });
      this.logger.info({ jobId: job.id, runId, ...state.stats }, "connector sync Agent completed");
    } finally {
      if (runtimeSessionRef) {
        await this.agentRuntime.deleteSession(runtimeSessionRef).catch(() => undefined);
      }
    }
  }

  private isDeterministicGmailJob(job: typeof connectorSyncJobs.$inferSelect): boolean {
    if (job.service !== "gmail" || job.resourceType !== "email") return false;
    const mode = gmailSyncMode(job.input);
    if (mode !== "snapshot") return true;
    return job.action === "fetch_emails";
  }

  private scheduledNextRunAt(job: typeof connectorSyncJobs.$inferSelect, startedAt: Date): Date | null {
    if (job.status !== "active" || job.scheduleType !== "interval") return null;
    const managed = gmailSyncMode(job.input) !== "snapshot" || managedDocumentSyncMode(job.input) !== null;
    if (!managed) return new Date(startedAt.getTime() + job.intervalMs);
    const bucket = Number.parseInt(createHash("sha256").update(job.id).digest("hex").slice(0, 8), 16) / 0xffff_ffff;
    const jitter = Math.round(job.intervalMs * (bucket * 0.1 - 0.05));
    return new Date(startedAt.getTime() + job.intervalMs + jitter);
  }

  private isDeterministicDocumentJob(job: typeof connectorSyncJobs.$inferSelect): boolean {
    return job.resourceType === "document"
      && managedDocumentSyncMode(job.input) !== null
      && (isNotionDocumentService(job.service) || isGoogleDocsService(job.service));
  }

  private hasDocumentIncrementalCheckpoint(
    job: typeof connectorSyncJobs.$inferSelect,
    checkpoint: Record<string, unknown> | null | undefined,
  ): boolean {
    if (isGoogleDocsService(job.service)) return Boolean(textValue(checkpoint?.pageToken));
    if (isNotionDocumentService(job.service)) return Boolean(textValue(checkpoint?.lastEditedTime));
    return false;
  }

  private async runGmailJob(job: typeof connectorSyncJobs.$inferSelect, runId: string): Promise<void> {
    const mode = gmailSyncMode(job.input);
    const state: AgentSyncRunState = {
      runId,
      job,
      stats: { inserted: 0, updated: 0, unchanged: 0, quarantined: 0 },
      seenSourceIds: new Set(),
      finishRequested: false,
      discovered: 0,
      checkpoint: null,
    };
    const checkpoint = mode === "incremental"
      ? await this.runGmailIncremental(job, state)
      : await this.runGmailSnapshot(job, state, mode);
    this.completeGmailRun(job, runId, state, checkpoint, mode);
  }

  private async runGmailSnapshot(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
    mode: GmailSyncMode,
  ): Promise<Record<string, unknown>> {
    const profile = mode === "bootstrap"
      ? await this.runConnectorAction(job, "get_profile", {})
      : null;
    const query = mode === "bootstrap" ? null : inferGmailQuery(job.name, job.goal, job.input);
    const requestedPageSize = Number(job.input.maxResults);
    const maxResults = Number.isInteger(requestedPageSize)
      ? Math.min(Math.max(requestedPageSize, 1), 100)
      : 50;
    let pageToken: string | null = null;
    let pages = 0;
    do {
      if (pages >= MAX_CONNECTOR_PAGES) throw new Error("Gmail pagination exceeded the safety limit");
      const page = await this.runConnectorAction(job, "fetch_emails", {
        ...(query ? { query } : {}),
        ...(mode === "bootstrap" ? { includeSpamTrash: true } : {}),
        detail: "full",
        maxResults,
        ...(pageToken ? { pageToken } : {}),
      });
      const messages = Array.isArray(page.messages) ? page.messages : [];
      this.writeGmailMessages(state, messages);
      pageToken = textValue(page.nextPageToken);
      pages += 1;
    } while (pageToken);

    return mode === "bootstrap"
      ? {
          syncMode: "incremental",
          historyId: requiredText(profile?.historyId, "Gmail profile historyId"),
          bootstrappedAt: new Date().toISOString(),
        }
      : {
          syncMode: "snapshot",
          ...(query ? { query } : {}),
          completedAt: new Date().toISOString(),
        };
  }

  private async runGmailIncremental(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
  ): Promise<Record<string, unknown>> {
    const startHistoryId = textValue(job.checkpoint?.historyId);
    if (!startHistoryId) throw new Error("Gmail incremental sync requires a completed bootstrap historyId");
    const changed = new Set<string>();
    const deleted = new Set<string>();
    let historyId = startHistoryId;
    let pageToken: string | null = null;
    let pages = 0;
    do {
      if (pages >= MAX_CONNECTOR_PAGES) throw new Error("Gmail history pagination exceeded the safety limit");
      const page = await this.runConnectorAction(job, "list_history", {
        startHistoryId,
        maxResults: 500,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        ...(pageToken ? { pageToken } : {}),
      });
      const delta = gmailHistoryDelta(page.history);
      for (const id of delta.changedMessageIds) {
        changed.add(id);
        deleted.delete(id);
      }
      for (const id of delta.deletedMessageIds) {
        deleted.add(id);
        changed.delete(id);
      }
      historyId = textValue(page.historyId) ?? historyId;
      pageToken = textValue(page.nextPageToken);
      pages += 1;
    } while (pageToken);

    for (const messageId of changed) {
      try {
        const message = await this.runConnectorAction(job, "fetch_message_by_message_id", {
          messageId,
          format: "full",
        });
        this.writeGmailMessages(state, [message]);
      } catch (error) {
        if (/404|not found/i.test(error instanceof Error ? error.message : String(error))) deleted.add(messageId);
        else throw error;
      }
    }
    if (deleted.size > 0) {
      const deletedAt = new Date();
      this.db.transaction((tx) => {
        for (const messageId of deleted) {
          const existing = tx.select({ id: connectorEmails.id, contentHash: connectorEmails.contentHash })
            .from(connectorEmails).where(and(
              eq(connectorEmails.ownerId, job.ownerId),
              eq(connectorEmails.service, "gmail"),
              eq(connectorEmails.connectionName, job.connectionName ?? ""),
              eq(connectorEmails.sourceRecordId, messageId),
              isNull(connectorEmails.deletedAt),
            )).get();
          if (!existing) continue;
          const result = tx.update(connectorEmails).set({ deletedAt, syncedAt: deletedAt })
            .where(eq(connectorEmails.id, existing.id)).run() as { changes: number };
          if (result.changes > 0) {
            enqueueMarkdown(tx, job.ownerId, "email", existing.id, "delete", existing.contentHash, deletedAt);
          }
          state.stats.updated += result.changes;
        }
      });
    }
    state.discovered = state.stats.inserted + state.stats.updated + state.stats.unchanged;
    return { syncMode: "incremental", historyId, completedAt: new Date().toISOString() };
  }

  private writeGmailMessages(state: AgentSyncRunState, messages: unknown[]): void {
    const syncedAt = new Date();
    this.db.transaction((tx) => {
      for (const message of messages) {
        const record = gmailMessageToDomainRecord(message);
        const sourceId = requiredText(record.sourceRecordId, "sourceRecordId");
        if (state.seenSourceIds.has(sourceId)) continue;
        state.seenSourceIds.add(sourceId);
        validateDomainRecord("email", record);
        const outcome = upsertDomainRecord(tx, state, "email", record, syncedAt);
        state.stats[outcome] += 1;
      }
    });
    state.discovered = state.stats.inserted + state.stats.updated + state.stats.unchanged;
  }

  private async runConnectorAction(
    job: typeof connectorSyncJobs.$inferSelect,
    action: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const connector = this.config.cliConnector;
    if (!connector) throw new Error("OpenConnector runtime is unavailable");
    const args = ["connector", "run", job.service, "--action", action, "--data", JSON.stringify(input)];
    if (job.connectionName) args.push("--connection-name", job.connectionName);
    args.push("--json");
    return connectorResultData(await this.runner(connector, args));
  }

  private completeGmailRun(
    job: typeof connectorSyncJobs.$inferSelect,
    runId: string,
    state: AgentSyncRunState,
    checkpoint: Record<string, unknown>,
    mode: GmailSyncMode,
  ): void {
    const finishedAt = new Date();
    const discovered = state.stats.inserted + state.stats.updated + state.stats.unchanged;
    this.db.transaction((tx) => {
      tx.update(connectorSyncRuns).set({
        status: "success",
        cursor: stableJson(checkpoint),
        discovered,
        ...state.stats,
        failed: state.stats.quarantined,
        outputCheckpoint: checkpoint,
        finishedAt,
      }).where(eq(connectorSyncRuns.id, runId)).run();
      tx.update(connectorSyncJobStates).set({
        checkpoint,
        lastSuccessAt: finishedAt,
        lastError: null,
        consecutiveFailures: 0,
        ...(mode === "bootstrap" ? { nextRunAt: null } : {}),
        updatedAt: finishedAt,
      }).where(eq(connectorSyncJobStates.jobId, job.id)).run();
      tx.update(connectorSyncJobs).set({
        checkpoint,
        lastSuccessAt: finishedAt,
        lastError: null,
        ...(mode === "bootstrap" ? { status: "paused" as const, enabled: false, nextRunAt: null } : {}),
        updatedAt: finishedAt,
      }).where(eq(connectorSyncJobs.id, job.id)).run();
      tx.insert(connectorAuditEvents).values({
        id: randomUUID(), ownerId: job.ownerId, requestId: runId,
        actor: "connector-sync-worker:gmail", operation: `gmail.${mode}`,
        effect: "read_and_local_write", result: { status: "success", ...state.stats }, createdAt: finishedAt,
      }).run();
    });
    if (mode === "bootstrap") this.activateManagedGmailIncremental(job, checkpoint, finishedAt);
    this.logger.info({ jobId: job.id, runId, mode, ...state.stats }, "deterministic Gmail sync completed");
  }

  private async runDocumentJob(job: typeof connectorSyncJobs.$inferSelect, runId: string): Promise<void> {
    const mode = managedDocumentSyncMode(job.input);
    if (!mode) throw new Error("Managed document sync mode is missing");
    const state: AgentSyncRunState = {
      runId,
      job,
      stats: { inserted: 0, updated: 0, unchanged: 0, quarantined: 0 },
      seenSourceIds: new Set(),
      finishRequested: false,
      discovered: 0,
      checkpoint: null,
    };
    const scanStartedAt = new Date();
    let checkpoint: Record<string, unknown>;
    try {
      if (isNotionDocumentService(job.service)) {
        checkpoint = mode === "reconcile"
          ? await this.runNotionReconcile(job, state, scanStartedAt)
          : await this.runNotionIncremental(job, state);
      } else if (isGoogleDocsService(job.service)) {
        checkpoint = mode === "reconcile"
          ? await this.runGoogleDocsReconcile(job, state, scanStartedAt)
          : await this.runGoogleDocsIncremental(job, state);
      } else {
        throw new Error(`Unsupported managed document service: ${job.service}`);
      }
    } catch (error) {
      if (mode === "incremental" && isGoogleDocsService(job.service)
        && /410|page token.*(?:expired|invalid)|invalid.*page token/i.test(error instanceof Error ? error.message : String(error))) {
        this.fallbackDocumentIncrementalToReconcile(job, new Date());
        throw new Error("Google Drive change token is no longer valid; a full reconciliation was scheduled");
      }
      throw error;
    }
    state.discovered = state.stats.inserted + state.stats.updated + state.stats.unchanged;
    this.completeDocumentRun(job, runId, state, checkpoint, mode);
  }

  private async runNotionReconcile(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
    scanStartedAt: Date,
  ): Promise<Record<string, unknown>> {
    let cursor: string | null = null;
    let pages = 0;
    let newestEditedAt: string | null = null;
    do {
      if (pages >= MAX_CONNECTOR_PAGES) throw new Error("Notion pagination exceeded the safety limit");
      const result = await this.runConnectorAction(job, "search", {
        query: "",
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        pageSize: 100,
        ...(cursor ? { startCursor: cursor } : {}),
      });
      const items = Array.isArray(result.results) ? result.results : [];
      for (const item of items) {
        const page = objectValue(item);
        if (page.object !== "page") continue;
        const editedAt = notionPageUpdatedAt(page);
        if (editedAt && (!newestEditedAt || editedAt > newestEditedAt)) newestEditedAt = editedAt;
        if (notionPageIsDeleted(page)) {
          this.deleteDocumentBySourceId(state, requiredText(page.id, "Notion page id"));
          continue;
        }
        const markdownResult = await this.runConnectorAction(job, "retrieve_page_markdown", {
          pageId: requiredText(page.id, "Notion page id"),
          includeTranscript: false,
        });
        this.writeDocuments(state, [notionPageToDocument(page, notionMarkdownFromResult(markdownResult))]);
      }
      cursor = result.has_more === true ? textValue(result.next_cursor) : null;
      pages += 1;
    } while (cursor);
    const missingSourceIds = this.reconcileMissingDocuments(state, scanStartedAt);
    return {
      syncMode: "incremental",
      lastEditedTime: newestEditedAt ?? scanStartedAt.toISOString(),
      missingSourceIds,
      reconciledAt: new Date().toISOString(),
    };
  }

  private async runNotionIncremental(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
  ): Promise<Record<string, unknown>> {
    const watermark = textValue(job.checkpoint?.lastEditedTime);
    if (!watermark) throw new Error("Notion incremental sync requires a completed reconciliation checkpoint");
    const parsedWatermark = new Date(watermark);
    if (Number.isNaN(parsedWatermark.getTime())) throw new Error("Notion incremental checkpoint is invalid");
    const overlapStart = new Date(parsedWatermark.getTime() - NOTION_INCREMENTAL_OVERLAP_MS);
    let cursor: string | null = null;
    let pages = 0;
    let newestEditedAt = watermark;
    let reachedOlderPage = false;
    do {
      if (pages >= MAX_CONNECTOR_PAGES) throw new Error("Notion incremental pagination exceeded the safety limit");
      const result = await this.runConnectorAction(job, "search", {
        query: "",
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        pageSize: 100,
        ...(cursor ? { startCursor: cursor } : {}),
      });
      const items = Array.isArray(result.results) ? result.results : [];
      for (const item of items) {
        const page = objectValue(item);
        if (page.object !== "page") continue;
        const editedAt = notionPageUpdatedAt(page);
        const editedDate = editedAt ? new Date(editedAt) : null;
        if (editedDate && editedDate < overlapStart) {
          reachedOlderPage = true;
          continue;
        }
        if (editedAt && editedAt > newestEditedAt) newestEditedAt = editedAt;
        const id = requiredText(page.id, "Notion page id");
        if (notionPageIsDeleted(page)) {
          this.deleteDocumentBySourceId(state, id);
          continue;
        }
        const markdownResult = await this.runConnectorAction(job, "retrieve_page_markdown", {
          pageId: id,
          includeTranscript: false,
        });
        this.writeDocuments(state, [notionPageToDocument(page, notionMarkdownFromResult(markdownResult))]);
      }
      cursor = !reachedOlderPage && result.has_more === true ? textValue(result.next_cursor) : null;
      pages += 1;
    } while (cursor);
    return { syncMode: "incremental", lastEditedTime: newestEditedAt, completedAt: new Date().toISOString() };
  }

  private async runGoogleDocsReconcile(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
    scanStartedAt: Date,
  ): Promise<Record<string, unknown>> {
    const tokenResult = await this.runConnectorAction(job, "changes.getStartPageToken", {
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const pageToken = requiredText(tokenResult.startPageToken, "Google Drive startPageToken");
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (pages >= MAX_CONNECTOR_PAGES) throw new Error("Google Docs pagination exceeded the safety limit");
      const result = await this.runConnectorAction(job, "files.list", {
        q: `mimeType = '${GOOGLE_DOC_MIME_TYPE}' and trashed = false`,
        spaces: "drive",
        pageSize: 1000,
        orderBy: "modifiedTime desc",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        ...(cursor ? { pageToken: cursor } : {}),
      });
      const files = Array.isArray(result.files) ? result.files : [];
      for (const file of files) await this.upsertGoogleDocument(job, state, file);
      cursor = textValue(result.nextPageToken);
      pages += 1;
    } while (cursor);
    const missingSourceIds = this.reconcileMissingDocuments(state, scanStartedAt);
    return { syncMode: "incremental", pageToken, missingSourceIds, reconciledAt: new Date().toISOString() };
  }

  private async runGoogleDocsIncremental(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
  ): Promise<Record<string, unknown>> {
    const startingToken = textValue(job.checkpoint?.pageToken);
    if (!startingToken) throw new Error("Google Docs incremental sync requires a completed reconciliation checkpoint");
    let cursor = startingToken;
    let nextCheckpoint = startingToken;
    let pages = 0;
    const latestChanges = new Map<string, Record<string, unknown>>();
    do {
      if (pages >= MAX_CONNECTOR_PAGES) throw new Error("Google Drive changes pagination exceeded the safety limit");
      const result = await this.runConnectorAction(job, "changes.list", {
        pageToken: cursor,
        pageSize: 1000,
        spaces: "drive",
        includeRemoved: true,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      const changes = Array.isArray(result.changes) ? result.changes : [];
      for (const value of changes) {
        const change = objectValue(value);
        const fileId = textValue(change.fileId) ?? textValue(objectValue(change.file).id);
        if (!fileId) continue;
        latestChanges.set(fileId, change);
      }
      const nextPageToken = textValue(result.nextPageToken);
      const newStartPageToken = textValue(result.newStartPageToken);
      if (newStartPageToken) nextCheckpoint = newStartPageToken;
      cursor = nextPageToken ?? "";
      pages += 1;
    } while (cursor);
    for (const [fileId, change] of latestChanges) {
      const file = objectValue(change.file);
      if (change.removed === true || Object.keys(file).length === 0 || googleFileIsDeleted(file) || !googleFileIsDocument(file)) {
        this.deleteDocumentBySourceId(state, fileId);
        continue;
      }
      await this.upsertGoogleDocument(job, state, file);
    }
    return { syncMode: "incremental", pageToken: nextCheckpoint, completedAt: new Date().toISOString() };
  }

  private async upsertGoogleDocument(
    job: typeof connectorSyncJobs.$inferSelect,
    state: AgentSyncRunState,
    value: unknown,
  ): Promise<void> {
    const file = objectValue(value);
    if (!googleFileIsDocument(file) || googleFileIsDeleted(file)) return;
    const fileId = requiredText(file.id, "Google Docs file id");
    const exported = await this.runConnectorAction(job, "files.export", {
      fileId,
      includeSharedDrives: true,
      mimeType: "text/html",
    });
    const bytes = await this.downloadConnectorTransitFile(exported);
    this.writeDocuments(state, [googleFileToDocument(file, googleDocsHtmlToMarkdown(bytes))]);
  }

  private async downloadConnectorTransitFile(value: unknown): Promise<Buffer> {
    const file = objectValue(objectValue(value).file);
    const downloadUrl = requiredText(file.downloadUrl, "connector transit downloadUrl");
    const connector = this.config.cliConnector;
    if (!connector) throw new Error("OpenConnector runtime is unavailable");
    const expectedUrl = new URL(connector.baseUrl);
    const url = new URL(downloadUrl);
    const sameLocalService = url.origin === expectedUrl.origin || (
      url.protocol === expectedUrl.protocol
      && url.port === expectedUrl.port
      && isLoopbackHostname(url.hostname)
      && isLoopbackHostname(expectedUrl.hostname)
    );
    if (!sameLocalService || !url.pathname.startsWith("/api/files/")) {
      throw new Error("Connector returned an untrusted transit download URL");
    }
    const declaredSize = Number(file.sizeBytes);
    if (Number.isFinite(declaredSize) && declaredSize > MAX_EXPORTED_DOCUMENT_BYTES) {
      throw new Error("Google Docs export exceeds the 32 MiB sync limit");
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new Error(`Connector transit download failed (${String(response.status)})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_EXPORTED_DOCUMENT_BYTES) throw new Error("Google Docs export exceeds the 32 MiB sync limit");
    return bytes;
  }

  private writeDocuments(state: AgentSyncRunState, documents: unknown[]): void {
    const syncedAt = new Date();
    this.db.transaction((tx) => {
      for (const value of documents) {
        const document = objectValue(value);
        const sourceId = requiredText(document.sourceRecordId, "sourceRecordId");
        if (state.seenSourceIds.has(sourceId)) continue;
        state.seenSourceIds.add(sourceId);
        validateDomainRecord("document", document);
        const outcome = upsertDomainRecord(tx, state, "document", document, syncedAt);
        state.stats[outcome] += 1;
      }
    });
    this.enqueueConnectorDocuments(state, documents.map((value) => textValue(objectValue(value).sourceRecordId)).filter((id): id is string => Boolean(id)));
  }

  private enqueueConnectorDocuments(state: AgentSyncRunState, sourceRecordIds: string[]): void {
    if (!this.filesService || sourceRecordIds.length === 0) return;
    for (const sourceRecordId of sourceRecordIds) {
      const row = this.db.select().from(connectorDocuments).where(and(
        eq(connectorDocuments.ownerId, state.job.ownerId),
        eq(connectorDocuments.service, state.job.service),
        eq(connectorDocuments.connectionName, state.job.connectionName ?? ""),
        eq(connectorDocuments.sourceRecordId, sourceRecordId),
        isNull(connectorDocuments.deletedAt),
      )).get();
      if (row) void this.importConnectorDocument(row);
    }
  }

  private async importConnectorDocument(row: typeof connectorDocuments.$inferSelect): Promise<void> {
    if (!this.filesService) return;
    const cleanTitle = row.title.replace(/[\\/]/g, "-").trim() || "无标题文档";
    const originalName = /\.(?:md|markdown|mdx)$/i.test(cleanTitle) ? cleanTitle : `${cleanTitle}.md`;
    try {
      await this.filesService.importFile({
        sourceKind: "connector",
        sourceKey: `connector:${row.service}:${row.connectionName}:${row.sourceRecordId}`,
        originalName,
        buffer: Buffer.from(row.bodyText, "utf8"),
        mime: "text/markdown",
        provider: row.service,
        connectionId: row.connectionName ?? undefined,
        sourceUri: row.sourceUrl ?? undefined,
        sourceModifiedAt: row.sourceUpdatedAt ?? undefined,
      });
    } catch (error) {
      this.logger.warn({
        connectorDocumentId: row.id,
        error: error instanceof Error ? error.message : String(error),
      }, "connector document file import failed");
    }
  }

  private deleteDocumentBySourceId(state: AgentSyncRunState, sourceId: string): void {
    if (state.seenSourceIds.has(sourceId)) return;
    state.seenSourceIds.add(sourceId);
    const now = new Date();
    this.db.transaction((tx) => {
      const existing = tx.select({ id: connectorDocuments.id, contentHash: connectorDocuments.contentHash })
        .from(connectorDocuments).where(and(
          eq(connectorDocuments.ownerId, state.job.ownerId),
          eq(connectorDocuments.service, state.job.service),
          eq(connectorDocuments.connectionName, state.job.connectionName ?? ""),
          eq(connectorDocuments.sourceRecordId, sourceId),
          isNull(connectorDocuments.deletedAt),
        )).get();
      if (!existing) return;
      const result = tx.update(connectorDocuments).set({ deletedAt: now, syncedAt: now })
        .where(eq(connectorDocuments.id, existing.id)).run() as { changes: number };
      if (result.changes > 0) {
        enqueueMarkdown(tx, state.job.ownerId, "document", existing.id, "delete", existing.contentHash, now);
        state.stats.updated += result.changes;
      }
    });
  }

  private reconcileMissingDocuments(state: AgentSyncRunState, scanStartedAt: Date): string[] {
    const missing = this.db.select({ sourceRecordId: connectorDocuments.sourceRecordId })
      .from(connectorDocuments).where(and(
        eq(connectorDocuments.ownerId, state.job.ownerId),
        eq(connectorDocuments.service, state.job.service),
        eq(connectorDocuments.connectionName, state.job.connectionName ?? ""),
        isNull(connectorDocuments.deletedAt),
        lt(connectorDocuments.syncedAt, scanStartedAt),
      )).all();
    const previousMissing = new Set(Array.isArray(state.job.checkpoint?.missingSourceIds)
      ? state.job.checkpoint.missingSourceIds.filter((item): item is string => typeof item === "string")
      : []);
    for (const row of missing) {
      if (previousMissing.has(row.sourceRecordId)) this.deleteDocumentBySourceId(state, row.sourceRecordId);
    }
    return missing.map((row) => row.sourceRecordId).sort();
  }

  private completeDocumentRun(
    job: typeof connectorSyncJobs.$inferSelect,
    runId: string,
    state: AgentSyncRunState,
    checkpoint: Record<string, unknown>,
    mode: ManagedDocumentSyncMode,
  ): void {
    const finishedAt = new Date();
    const discovered = state.stats.inserted + state.stats.updated + state.stats.unchanged;
    this.db.transaction((tx) => {
      tx.update(connectorSyncRuns).set({
        status: "success",
        cursor: stableJson(checkpoint),
        discovered,
        ...state.stats,
        failed: state.stats.quarantined,
        outputCheckpoint: checkpoint,
        finishedAt,
      }).where(eq(connectorSyncRuns.id, runId)).run();
      tx.update(connectorSyncJobStates).set({
        checkpoint,
        lastSuccessAt: finishedAt,
        lastError: null,
        consecutiveFailures: 0,
        updatedAt: finishedAt,
      }).where(eq(connectorSyncJobStates.jobId, job.id)).run();
      tx.update(connectorSyncJobs).set({
        checkpoint,
        lastSuccessAt: finishedAt,
        lastError: null,
        updatedAt: finishedAt,
      }).where(eq(connectorSyncJobs.id, job.id)).run();
      tx.insert(connectorAuditEvents).values({
        id: randomUUID(),
        ownerId: job.ownerId,
        requestId: runId,
        actor: `connector-sync-worker:${job.service}`,
        operation: `${job.service}.documents.${mode}`,
        effect: "read_and_local_write",
        result: { status: "success", ...state.stats },
        createdAt: finishedAt,
      }).run();
    });
    if (mode === "reconcile") this.activateManagedDocumentIncremental(job, checkpoint, finishedAt);
    this.logger.info({ jobId: job.id, runId, mode, ...state.stats }, "deterministic document sync completed");
  }

  private async refreshAccountsAndProvisionJobs(now: Date): Promise<void> {
    const connector = this.config.cliConnector;
    if (!connector) return;
    let result: unknown;
    try {
      result = await this.runner(connector, ["connector", "apps", "--json"]);
    } catch (error) {
      this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "connector account discovery failed");
      return;
    }
    const accounts = Array.isArray(result) ? result : [];
    for (const value of accounts) {
      const account = objectValue(value);
      const service = textValue(account.service);
      const connectionName = textValue(account.connectionName) ?? textValue(account.name);
      const status = textValue(account.status)?.toLowerCase();
      if (!service || !connectionName || status && !["active", "connected", "ready"].includes(status)) continue;
      const displayName = textValue(account.displayName) ?? textValue(account.accountLabel) ?? connectionName;
      this.db.insert(connectorAccounts).values({
        id: randomUUID(), ownerId: this.currentOwnerId(), service, connectionName,
        displayName, accountLabel: textValue(account.accountLabel) ?? displayName,
        credentialRef: `open-connector:${service}:${connectionName}`,
        status: "active", createdAt: now, updatedAt: now,
      }).onConflictDoUpdate({
        target: [connectorAccounts.ownerId, connectorAccounts.service, connectorAccounts.connectionName],
        set: { displayName, accountLabel: textValue(account.accountLabel) ?? displayName, status: "active", updatedAt: now },
      }).run();
      if (service === "gmail") this.ensureManagedGmailJobs(connectionName, displayName, now);
      if (isNotionDocumentService(service) || isGoogleDocsService(service)) {
        this.ensureManagedDocumentJobs(service, connectionName, displayName, now);
      }
    }
  }

  private managedGmailJobId(connectionName: string, mode: "bootstrap" | "incremental"): string {
    const suffix = createHash("sha256").update(connectionName).digest("hex").slice(0, 12);
    return `managed-gmail-${suffix}-${mode}`;
  }

  private ensureManagedGmailJobs(connectionName: string, displayName: string, now: Date): void {
    const definitions = [
      {
        mode: "bootstrap" as const,
        name: `Gmail 全量初始化 · ${displayName}`,
        action: "fetch_emails",
        allowedActions: ["get_profile", "fetch_emails"],
        intervalMs: GMAIL_BOOTSTRAP_RETRY_INTERVAL_MS,
        nextRunAt: now,
        status: "active" as const,
        goal: "首次完整同步该授权 Gmail 账号的全部邮件，完成后交接到增量同步",
      },
      {
        mode: "incremental" as const,
        name: `Gmail 增量同步 · ${displayName}`,
        action: "list_history",
        allowedActions: ["list_history", "fetch_message_by_message_id"],
        intervalMs: GMAIL_INCREMENTAL_INTERVAL_MS,
        nextRunAt: null,
        status: "paused" as const,
        goal: "基于 Gmail historyId 持续同步新增、修改和删除的邮件",
      },
    ];
    for (const definition of definitions) {
      const id = this.managedGmailJobId(connectionName, definition.mode);
      const existing = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, id)).get();
      if (existing) {
        const state = this.jobState(id);
        const hasHistoryCheckpoint = Boolean(textValue(state?.checkpoint?.historyId));
        if (definition.mode === "incremental" && !hasHistoryCheckpoint) {
          this.db.update(connectorSyncJobs).set({ status: "paused", enabled: false, nextRunAt: null, updatedAt: now })
            .where(eq(connectorSyncJobs.id, id)).run();
          this.db.update(connectorSyncJobStates).set({ nextRunAt: null, updatedAt: now })
            .where(eq(connectorSyncJobStates.jobId, id)).run();
        }
        const canRecoverCancelledBootstrap = definition.mode === "bootstrap"
          && !hasHistoryCheckpoint
          && existing.status === "paused"
          && /OpenConnector sync cancelled|output exceeded/i.test(state?.lastError ?? existing.lastError ?? "");
        if (canRecoverCancelledBootstrap) {
          this.db.update(connectorSyncJobs).set({ status: "active", enabled: true, nextRunAt: now, lastError: null, updatedAt: now })
            .where(eq(connectorSyncJobs.id, id)).run();
          this.db.update(connectorSyncJobStates).set({
            nextRunAt: now, lastError: null, consecutiveFailures: 0, updatedAt: now,
          }).where(eq(connectorSyncJobStates.jobId, id)).run();
        }
        continue;
      }
      this.db.insert(connectorSyncJobs).values({
        id, ownerId: this.currentOwnerId(), name: definition.name, service: "gmail",
        action: definition.action, allowedActions: definition.allowedActions,
        dataset: "emails", resourceType: "email", connectionName,
        input: { everroomSyncMode: definition.mode, detail: "full", maxResults: 50 },
        goal: definition.goal, prompt: null, promptProfileId: "gmail-email-sync-v1",
        promptOverride: null, promptVersion: 1, schemaVersion: 1,
        intervalMs: definition.intervalMs, scheduleType: "interval", timezone: "Asia/Shanghai",
        retryPolicy: { maxAttempts: 3, baseDelayMs: 30_000 }, priority: definition.mode === "bootstrap" ? 100 : 50,
        status: definition.status, configVersion: 1, enabled: definition.status === "active", nextRunAt: definition.nextRunAt,
        createdAt: now, updatedAt: now,
      }).run();
      this.db.insert(connectorSyncJobStates).values({ jobId: id, nextRunAt: definition.nextRunAt, updatedAt: now }).run();
      const job = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, id)).get()!;
      this.persistJobVersion(job, "system", "managed connector job provisioned");
    }
  }

  private activateManagedGmailIncremental(
    bootstrapJob: typeof connectorSyncJobs.$inferSelect,
    checkpoint: Record<string, unknown>,
    now: Date,
  ): void {
    if (gmailSyncMode(bootstrapJob.input) !== "bootstrap" || !bootstrapJob.connectionName) return;
    const id = this.managedGmailJobId(bootstrapJob.connectionName, "incremental");
    this.db.update(connectorSyncJobStates).set({ checkpoint, nextRunAt: now, updatedAt: now })
      .where(eq(connectorSyncJobStates.jobId, id)).run();
    this.db.update(connectorSyncJobs).set({ checkpoint, nextRunAt: now, status: "active", enabled: true, updatedAt: now })
      .where(eq(connectorSyncJobs.id, id)).run();
  }

  private managedDocumentJobId(
    service: string,
    connectionName: string,
    mode: ManagedDocumentSyncMode,
  ): string {
    const suffix = createHash("sha256").update(`${service}:${connectionName}`).digest("hex").slice(0, 12);
    return `managed-${service.replace(/[^a-z0-9_-]/gi, "-")}-documents-${suffix}-${mode}`;
  }

  private ensureManagedDocumentJobs(service: string, connectionName: string, displayName: string, now: Date): void {
    const notion = isNotionDocumentService(service);
    const definitions = [
      {
        mode: "reconcile" as const,
        name: `${notion ? "Notion" : "Google Docs"} 全量校准 · ${displayName}`,
        action: notion ? "search" : "files.list",
        allowedActions: notion
          ? ["search", "retrieve_page", "retrieve_page_markdown"]
          : ["changes.getStartPageToken", "files.list", "files.export"],
        intervalMs: notion ? NOTION_RECONCILE_INTERVAL_MS : GOOGLE_DOCS_RECONCILE_INTERVAL_MS,
        nextRunAt: now,
        status: "active" as const,
        priority: 90,
        goal: notion
          ? "全量枚举当前授权可访问的 Notion 页面，校准新增、更新、删除与权限丢失"
          : "全量枚举当前授权可访问的 Google Docs 文档，校准新增、更新、删除与权限丢失",
      },
      {
        mode: "incremental" as const,
        name: `${notion ? "Notion" : "Google Docs"} 增量同步 · ${displayName}`,
        action: notion ? "search" : "changes.list",
        allowedActions: notion
          ? ["search", "retrieve_page", "retrieve_page_markdown"]
          : ["changes.list", "files.export"],
        intervalMs: notion ? NOTION_INCREMENTAL_INTERVAL_MS : GOOGLE_DOCS_INCREMENTAL_INTERVAL_MS,
        nextRunAt: null,
        status: "paused" as const,
        priority: 50,
        goal: notion
          ? "基于 last_edited_time 水位和重叠窗口同步最近变更的 Notion 页面"
          : "基于 Google Drive Changes pageToken 同步 Google Docs 的新增、更新和删除",
      },
    ];
    for (const definition of definitions) {
      const id = this.managedDocumentJobId(service, connectionName, definition.mode);
      const existing = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, id)).get();
      if (existing) {
        const state = this.jobState(id);
        if (definition.mode === "incremental" && !this.hasDocumentIncrementalCheckpoint(existing, state?.checkpoint)) {
          this.db.update(connectorSyncJobs).set({ status: "paused", enabled: false, nextRunAt: null, updatedAt: now })
            .where(eq(connectorSyncJobs.id, id)).run();
          this.db.update(connectorSyncJobStates).set({ nextRunAt: null, updatedAt: now })
            .where(eq(connectorSyncJobStates.jobId, id)).run();
        }
        continue;
      }
      this.db.insert(connectorSyncJobs).values({
        id,
        ownerId: this.currentOwnerId(),
        name: definition.name,
        service,
        action: definition.action,
        allowedActions: definition.allowedActions,
        dataset: "documents",
        resourceType: "document",
        connectionName,
        input: { everroomDocumentSyncMode: definition.mode },
        goal: definition.goal,
        prompt: null,
        promptProfileId: notion ? "notion-document-sync-v1" : null,
        promptOverride: null,
        promptVersion: 1,
        schemaVersion: 1,
        intervalMs: definition.intervalMs,
        scheduleType: "interval",
        timezone: "Asia/Shanghai",
        retryPolicy: { maxAttempts: 5, baseDelayMs: 30_000 },
        priority: definition.priority,
        status: definition.status,
        configVersion: 1,
        enabled: definition.status === "active",
        nextRunAt: definition.nextRunAt,
        createdAt: now,
        updatedAt: now,
      }).run();
      this.db.insert(connectorSyncJobStates).values({ jobId: id, nextRunAt: definition.nextRunAt, updatedAt: now }).run();
      const job = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, id)).get()!;
      this.persistJobVersion(job, "system", "managed document connector job provisioned");
    }
  }

  private activateManagedDocumentIncremental(
    reconcileJob: typeof connectorSyncJobs.$inferSelect,
    checkpoint: Record<string, unknown>,
    now: Date,
  ): void {
    if (managedDocumentSyncMode(reconcileJob.input) !== "reconcile" || !reconcileJob.connectionName) return;
    const id = this.managedDocumentJobId(reconcileJob.service, reconcileJob.connectionName, "incremental");
    const incremental = this.db.select().from(connectorSyncJobs).where(eq(connectorSyncJobs.id, id)).get();
    if (!incremental) return;
    const state = this.jobState(id);
    const hadCheckpoint = this.hasDocumentIncrementalCheckpoint(incremental, state?.checkpoint);
    const shouldActivate = incremental.status === "active" || !hadCheckpoint;
    this.db.update(connectorSyncJobStates).set({
      checkpoint,
      nextRunAt: shouldActivate ? now : null,
      lastError: shouldActivate ? null : state?.lastError ?? null,
      consecutiveFailures: shouldActivate ? 0 : state?.consecutiveFailures ?? 0,
      updatedAt: now,
    }).where(eq(connectorSyncJobStates.jobId, id)).run();
    this.db.update(connectorSyncJobs).set({
      checkpoint,
      nextRunAt: shouldActivate ? now : null,
      ...(shouldActivate ? { status: "active" as const, enabled: true, lastError: null } : {}),
      updatedAt: now,
    }).where(eq(connectorSyncJobs.id, id)).run();
  }

  private fallbackDocumentIncrementalToReconcile(
    incrementalJob: typeof connectorSyncJobs.$inferSelect,
    now: Date,
  ): void {
    if (!incrementalJob.connectionName) return;
    const reconcileId = this.managedDocumentJobId(incrementalJob.service, incrementalJob.connectionName, "reconcile");
    this.db.update(connectorSyncJobStates).set({ checkpoint: null, nextRunAt: null, updatedAt: now })
      .where(eq(connectorSyncJobStates.jobId, incrementalJob.id)).run();
    this.db.update(connectorSyncJobs).set({
      checkpoint: null,
      status: "paused",
      enabled: false,
      nextRunAt: null,
      updatedAt: now,
    }).where(eq(connectorSyncJobs.id, incrementalJob.id)).run();
    this.db.update(connectorSyncJobStates).set({ nextRunAt: now, updatedAt: now })
      .where(eq(connectorSyncJobStates.jobId, reconcileId)).run();
    this.db.update(connectorSyncJobs).set({
      status: "active",
      enabled: true,
      nextRunAt: now,
      updatedAt: now,
    }).where(eq(connectorSyncJobs.id, reconcileId)).run();
  }

  private async runLegacyJob(
    job: typeof connectorSyncJobs.$inferSelect,
    runId: string,
  ): Promise<void> {
      if (!job.action) throw new Error("Connector sync Agent runtime is unavailable and no legacy action is configured");
      const connector = this.config.cliConnector;
      if (!connector) throw new Error("OpenConnector runtime is unavailable");
      const args = ["connector", "run", job.service, "--action", job.action, "--data", JSON.stringify(job.input)];
      if (job.connectionName) args.push("--connection-name", job.connectionName);
      args.push("--json");
      const result = await this.runner(connector, args);
      const items = recordItems(result);
      const syncedAt = new Date();
      let inserted = 0;
      let updated = 0;
      this.db.transaction((tx) => {
        items.forEach((record, index) => {
          const sourceId = sourceRecordId(record, index);
          const hash = contentHash(record);
          const existing = tx.select({ id: connectorRecords.id, contentHash: connectorRecords.contentHash })
            .from(connectorRecords)
            .where(and(
              eq(connectorRecords.ownerId, job.ownerId),
              eq(connectorRecords.service, job.service),
              eq(connectorRecords.dataset, job.dataset),
              eq(connectorRecords.sourceRecordId, sourceId),
            )).get();
          const ingestSourceId = existing?.id ?? randomUUID();
          tx.insert(connectorRecords).values({
            id: ingestSourceId,
            ownerId: job.ownerId,
            service: job.service,
            dataset: job.dataset,
            sourceRecordId: sourceId,
            payload: record,
            sourceUpdatedAt: sourceUpdatedAt(record),
            contentHash: hash,
            syncedAt,
            expiresAt: new Date(syncedAt.getTime() + DEFAULT_RECORD_TTL_MS),
            deletedAt: null,
          }).onConflictDoUpdate({
            target: [connectorRecords.ownerId, connectorRecords.service, connectorRecords.dataset, connectorRecords.sourceRecordId],
            set: {
              payload: record,
              sourceUpdatedAt: sourceUpdatedAt(record),
              contentHash: hash,
              syncedAt,
              expiresAt: new Date(syncedAt.getTime() + DEFAULT_RECORD_TTL_MS),
              deletedAt: null,
            },
          }).run();
          if (existing) {
            if (existing.contentHash !== hash) {
              updated += 1;
              enqueueMarkdown(tx, job.ownerId, "generic", ingestSourceId, "upsert", hash, syncedAt);
            }
          } else {
            inserted += 1;
            enqueueMarkdown(tx, job.ownerId, "generic", ingestSourceId, "upsert", hash, syncedAt);
          }
        });
      });
      this.db.update(connectorSyncRuns).set({
        status: "success", discovered: items.length, inserted, updated, finishedAt: syncedAt,
      }).where(eq(connectorSyncRuns.id, runId)).run();
      this.db.update(connectorSyncJobStates).set({
        lastSuccessAt: syncedAt, lastError: null, consecutiveFailures: 0, updatedAt: syncedAt,
      }).where(eq(connectorSyncJobStates.jobId, job.id)).run();
      this.db.update(connectorSyncJobs).set({
        lastSuccessAt: syncedAt, lastError: null, updatedAt: syncedAt,
      }).where(eq(connectorSyncJobs.id, job.id)).run();
      this.db.insert(connectorAuditEvents).values({
        id: randomUUID(),
        ownerId: job.ownerId,
        requestId: runId,
        actor: "connector-sync-worker",
        operation: `${job.service}.${job.action}`,
        effect: "read",
        result: { status: "success", dataset: job.dataset, discovered: items.length },
        createdAt: syncedAt,
      }).run();
      this.logger.info({ jobId: job.id, runId, discovered: items.length }, "connector sync completed");
  }

  private failRun(job: typeof connectorSyncJobs.$inferSelect, runId: string, error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      const needsConnection = /401|403|oauth|authorization|connection/i.test(message);
      const finishedAt = new Date();
      this.db.update(connectorSyncRuns).set({
        status: needsConnection ? "needs_connection" : "failed",
        errorCode: needsConnection ? "needs_connection" : "sync_failed",
        errorMessage: message.slice(0, 1_000),
        finishedAt,
      }).where(eq(connectorSyncRuns.id, runId)).run();
      const state = this.jobState(job.id);
      const consecutiveFailures = (state?.consecutiveFailures ?? 0) + 1;
      const shouldPause = consecutiveFailures >= job.retryPolicy.maxAttempts;
      const retryDelay = Math.min(
        job.retryPolicy.baseDelayMs * 2 ** Math.max(consecutiveFailures - 1, 0),
        24 * 60 * 60 * 1_000,
      );
      this.db.update(connectorSyncJobStates).set({
        lastError: message.slice(0, 1_000),
        consecutiveFailures,
        nextRunAt: shouldPause ? null : new Date(finishedAt.getTime() + retryDelay),
        updatedAt: finishedAt,
      }).where(eq(connectorSyncJobStates.jobId, job.id)).run();
      this.db.update(connectorSyncJobs).set({
        lastError: message.slice(0, 1_000), updatedAt: finishedAt,
      }).where(eq(connectorSyncJobs.id, job.id)).run();
      if (shouldPause) {
        this.db.update(connectorSyncJobs).set({
          status: "paused", enabled: false, updatedAt: finishedAt,
        }).where(eq(connectorSyncJobs.id, job.id)).run();
      }
      this.db.insert(connectorAuditEvents).values({
        id: randomUUID(),
        ownerId: job.ownerId,
        requestId: runId,
        actor: "connector-sync-worker",
        operation: `${job.service}.${job.action}`,
        effect: "read",
        result: { status: needsConnection ? "needs_connection" : "failed", error: message.slice(0, 500) },
        createdAt: finishedAt,
      }).run();
      this.logger.warn({ jobId: job.id, runId, error: message }, "connector sync failed");
  }

  private requireAgentRun(runId: string): AgentSyncRunState {
    const state = this.activeAgentRuns.get(runId);
    if (!state) throw new Error("Sync tool is not bound to an active connector sync run");
    return state;
  }
}

type ConnectorWriteDatabase = Pick<GatewayDatabase, "select" | "insert" | "update">;

function enqueueMarkdown(
  db: ConnectorWriteDatabase,
  ownerId: string,
  resourceType: "email" | "document" | "calendar" | "todo" | "generic",
  ingestSourceId: string,
  operation: "upsert" | "delete",
  sourceContentHash: string,
  now: Date,
): void {
  db.insert(connectorMarkdownOutbox).values({
    id: randomUUID(),
    ownerId,
    resourceType,
    ingestSourceId,
    operation,
    sourceContentHash,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string or null`);
  return value.trim() || null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function dateValue(value: unknown, field: string): Date | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`${field} must be an ISO date, timestamp, or null`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} is not a valid date`);
  return date;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function objectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${field} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

function validateAddressList(value: unknown, field: string): void {
  for (const item of objectArray(value, field)) requiredText(item.address, `${field}.address`);
}

function validateDomainRecord(resourceType: ConnectorResourceType, record: Record<string, unknown>): void {
  requiredText(record.sourceRecordId, "sourceRecordId");
  dateValue(record.sourceUpdatedAt, "sourceUpdatedAt");
  if (record.extensionPayload != null) objectValue(record.extensionPayload);
  if (resourceType === "email") {
    requiredText(record.messageId, "messageId");
    requiredText(record.subject, "subject");
    if (typeof record.bodyText !== "string") throw new Error("bodyText must be a string");
    optionalText(record.threadId, "threadId");
    optionalText(record.senderName, "senderName");
    optionalText(record.senderAddress, "senderAddress");
    validateAddressList(record.recipients, "recipients");
    stringArray(record.labels, "labels");
    dateValue(record.sentAt, "sentAt");
    if (typeof record.hasAttachments !== "boolean") throw new Error("hasAttachments must be a boolean");
    return;
  }
  if (resourceType === "document") {
    requiredText(record.documentId, "documentId");
    requiredText(record.title, "title");
    if (typeof record.bodyText !== "string") throw new Error("bodyText must be a string");
    optionalText(record.ownerName, "ownerName");
    optionalText(record.documentType, "documentType");
    optionalText(record.sourceUrl, "sourceUrl");
    return;
  }
  if (resourceType === "todo") {
    requiredText(record.todoId, "todoId");
    requiredText(record.title, "title");
    if (typeof record.notes !== "string") throw new Error("notes must be a string");
    optionalText(record.status, "status");
    dateValue(record.dueAt, "dueAt");
    dateValue(record.completedAt, "completedAt");
    optionalText(record.priority, "priority");
    optionalText(record.listId, "listId");
    optionalText(record.listName, "listName");
    return;
  }
  requiredText(record.eventId, "eventId");
  requiredText(record.title, "title");
  if (typeof record.description !== "string") throw new Error("description must be a string");
  if (record.organizer != null) objectValue(record.organizer);
  objectArray(record.attendees, "attendees");
  dateValue(record.startAt, "startAt");
  dateValue(record.endAt, "endAt");
  if (typeof record.allDay !== "boolean") throw new Error("allDay must be a boolean");
  optionalText(record.status, "status");
  optionalText(record.location, "location");
}

function commonDomainValues(
  state: AgentSyncRunState,
  record: Record<string, unknown>,
) {
  return {
    ownerId: state.job.ownerId,
    service: state.job.service,
    connectionName: state.job.connectionName ?? "",
    sourceRecordId: requiredText(record.sourceRecordId, "sourceRecordId"),
    sourceUpdatedAt: dateValue(record.sourceUpdatedAt, "sourceUpdatedAt"),
    schemaVersion: state.job.schemaVersion,
    promptVersion: state.job.promptVersion,
    extensionPayload: record.extensionPayload == null ? null : objectValue(record.extensionPayload),
  };
}

function upsertDomainRecord(
  db: ConnectorWriteDatabase,
  state: AgentSyncRunState,
  resourceType: ConnectorResourceType,
  record: Record<string, unknown>,
  syncedAt: Date,
): "inserted" | "updated" | "unchanged" {
  const common = commonDomainValues(state, record);
  if (resourceType === "email") {
    const existing = db.select({
      id: connectorEmails.id,
      contentHash: connectorEmails.contentHash,
      deletedAt: connectorEmails.deletedAt,
    })
      .from(connectorEmails).where(and(
        eq(connectorEmails.ownerId, common.ownerId),
        eq(connectorEmails.service, common.service),
        eq(connectorEmails.connectionName, common.connectionName),
        eq(connectorEmails.sourceRecordId, common.sourceRecordId),
      )).get();
    const normalized = {
      ...common,
      messageId: requiredText(record.messageId, "messageId"),
      threadId: optionalText(record.threadId, "threadId"),
      senderName: optionalText(record.senderName, "senderName"),
      senderAddress: optionalText(record.senderAddress, "senderAddress"),
      recipients: objectArray(record.recipients, "recipients") as Array<{ name?: string; address: string }>,
      subject: requiredText(record.subject, "subject"),
      sentAt: dateValue(record.sentAt, "sentAt"),
      bodyText: String(record.bodyText),
      labels: stringArray(record.labels, "labels"),
      hasAttachments: record.hasAttachments === true,
    };
    const hash = contentHash(normalized);
    const values = {
      ...normalized,
      id: existing?.id ?? randomUUID(),
      syncedAt,
      contentHash: hash,
      deletedAt: null,
    };
    db.insert(connectorEmails).values(values).onConflictDoUpdate({
      target: [connectorEmails.ownerId, connectorEmails.service, connectorEmails.connectionName, connectorEmails.sourceRecordId],
      set: values,
    }).run();
    const outcome = existing ? existing.contentHash === hash && !existing.deletedAt ? "unchanged" : "updated" : "inserted";
    if (outcome !== "unchanged") enqueueMarkdown(db, common.ownerId, "email", values.id, "upsert", hash, syncedAt);
    return outcome;
  }
  if (resourceType === "document") {
    const existing = db.select({
      id: connectorDocuments.id,
      contentHash: connectorDocuments.contentHash,
      deletedAt: connectorDocuments.deletedAt,
    })
      .from(connectorDocuments).where(and(
        eq(connectorDocuments.ownerId, common.ownerId),
        eq(connectorDocuments.service, common.service),
        eq(connectorDocuments.connectionName, common.connectionName),
        eq(connectorDocuments.sourceRecordId, common.sourceRecordId),
      )).get();
    const normalized = {
      ...common,
      documentId: requiredText(record.documentId, "documentId"),
      title: requiredText(record.title, "title"),
      ownerName: optionalText(record.ownerName, "ownerName"),
      documentType: optionalText(record.documentType, "documentType"),
      bodyText: String(record.bodyText),
      sourceUrl: optionalText(record.sourceUrl, "sourceUrl"),
    };
    const hash = contentHash(normalized);
    const values = {
      ...normalized,
      id: existing?.id ?? randomUUID(),
      syncedAt,
      contentHash: hash,
      deletedAt: null,
    };
    db.insert(connectorDocuments).values(values).onConflictDoUpdate({
      target: [connectorDocuments.ownerId, connectorDocuments.service, connectorDocuments.connectionName, connectorDocuments.sourceRecordId],
      set: values,
    }).run();
    const outcome = existing ? existing.contentHash === hash && !existing.deletedAt ? "unchanged" : "updated" : "inserted";
    if (outcome !== "unchanged") enqueueMarkdown(db, common.ownerId, "document", values.id, "upsert", hash, syncedAt);
    return outcome;
  }
  if (resourceType === "todo") {
    const existing = db.select({
      id: connectorTodos.id,
      contentHash: connectorTodos.contentHash,
      deletedAt: connectorTodos.deletedAt,
    })
      .from(connectorTodos).where(and(
        eq(connectorTodos.ownerId, common.ownerId),
        eq(connectorTodos.service, common.service),
        eq(connectorTodos.connectionName, common.connectionName),
        eq(connectorTodos.sourceRecordId, common.sourceRecordId),
      )).get();
    const normalized = {
      ...common,
      todoId: requiredText(record.todoId, "todoId"),
      title: requiredText(record.title, "title"),
      notes: String(record.notes ?? ""),
      status: optionalText(record.status, "status"),
      dueAt: dateValue(record.dueAt, "dueAt"),
      completedAt: dateValue(record.completedAt, "completedAt"),
      priority: optionalText(record.priority, "priority"),
      listId: optionalText(record.listId, "listId"),
      listName: optionalText(record.listName, "listName"),
    };
    const hash = contentHash(normalized);
    const values = {
      ...normalized,
      id: existing?.id ?? randomUUID(),
      syncedAt,
      contentHash: hash,
      deletedAt: null,
    };
    db.insert(connectorTodos).values(values).onConflictDoUpdate({
      target: [connectorTodos.ownerId, connectorTodos.service, connectorTodos.connectionName, connectorTodos.sourceRecordId],
      set: values,
    }).run();
    const outcome = existing ? existing.contentHash === hash && !existing.deletedAt ? "unchanged" : "updated" : "inserted";
    if (outcome !== "unchanged") enqueueMarkdown(db, common.ownerId, "todo", values.id, "upsert", hash, syncedAt);
    return outcome;
  }
  const existing = db.select({
    id: connectorCalendarEvents.id,
    contentHash: connectorCalendarEvents.contentHash,
    deletedAt: connectorCalendarEvents.deletedAt,
  })
    .from(connectorCalendarEvents).where(and(
      eq(connectorCalendarEvents.ownerId, common.ownerId),
      eq(connectorCalendarEvents.service, common.service),
      eq(connectorCalendarEvents.connectionName, common.connectionName),
      eq(connectorCalendarEvents.sourceRecordId, common.sourceRecordId),
    )).get();
  const normalized = {
    ...common,
    eventId: requiredText(record.eventId, "eventId"),
    title: requiredText(record.title, "title"),
    description: String(record.description),
    organizer: record.organizer == null ? null : objectValue(record.organizer),
    attendees: objectArray(record.attendees, "attendees") as Array<{ name?: string; address?: string; status?: string }>,
    startAt: dateValue(record.startAt, "startAt"),
    endAt: dateValue(record.endAt, "endAt"),
    allDay: record.allDay === true,
    status: optionalText(record.status, "status"),
    location: optionalText(record.location, "location"),
  };
  const hash = contentHash(normalized);
  const values = {
    ...normalized,
    id: existing?.id ?? randomUUID(),
    syncedAt,
    contentHash: hash,
    deletedAt: null,
  };
  db.insert(connectorCalendarEvents).values(values).onConflictDoUpdate({
    target: [connectorCalendarEvents.ownerId, connectorCalendarEvents.service, connectorCalendarEvents.connectionName, connectorCalendarEvents.sourceRecordId],
    set: values,
  }).run();
  const outcome = existing ? existing.contentHash === hash && !existing.deletedAt ? "unchanged" : "updated" : "inserted";
  if (outcome !== "unchanged") enqueueMarkdown(db, common.ownerId, "calendar", values.id, "upsert", hash, syncedAt);
  return outcome;
}

function connectorSyncPrompt(job: typeof connectorSyncJobs.$inferSelect): string {
  if (job.resourceType === "generic") throw new Error("Generic connector jobs do not have a domain Agent prompt");
  const resourceType = job.resourceType;
  const skillName = job.service === "gmail"
    ? "gmail-sync"
    : job.service === "notion"
      ? "notion-sync"
      : job.service === "google_calendar"
        ? "google-calendar-sync"
        : job.service === "google_tasks"
          ? "google-tasks-sync"
          : null;
  return [
    `使用 connector-sync Agent 的 ${skillName ?? "通用连接器同步规则"} Skill 处理本次 ${job.service}/${resourceType} 同步。`,
    `同步目标：${job.goal}`,
    `唯一允许访问的服务：${job.service}`,
    `允许执行的只读 Action：${job.allowedActions.join(", ")}`,
    job.connectionName ? `固定连接账号：${job.connectionName}` : "连接账号必须来自 connector_apps，不得猜测。",
    `Action 初始参数提示：${stableJson(job.input)}`,
    `上次成功检查点：${job.checkpoint ? stableJson(job.checkpoint) : "无，执行首次同步"}`,
    `目标数据类型：${resourceType}；目标 Schema 版本：${String(job.schemaVersion)}（具体字段以所选 Skill 和 sync_write_batch 校验为准）`,
    `提示词版本：${String(job.promptVersion)}`,
    ...(job.prompt ? ["领域补充说明：", job.prompt] : []),
  ].join("\n");
}

function isObviouslyMutatingConnectorAction(action: string): boolean {
  return /^(?:send|create|update|delete|remove|modify|mark|archive|trash|move|share|invite|reply|upload|post|put|patch|add|set)(?:_|-)/i.test(action);
}

function jobConfigSnapshot(job: typeof connectorSyncJobs.$inferSelect): Record<string, unknown> {
  return {
    id: job.id,
    ownerId: job.ownerId,
    name: job.name,
    service: job.service,
    dataset: job.dataset,
    resourceType: job.resourceType,
    connectionName: job.connectionName,
    allowedActions: job.allowedActions,
    input: job.input,
    goal: job.goal,
    promptProfileId: job.promptProfileId,
    promptOverride: job.promptOverride,
    promptVersion: job.promptVersion,
    schemaVersion: job.schemaVersion,
    scheduleType: job.scheduleType,
    intervalMs: job.intervalMs,
    timezone: job.timezone,
    retryPolicy: job.retryPolicy,
    priority: job.priority,
    status: job.status,
    configVersion: job.configVersion,
  };
}

function serializeRun(row: typeof connectorSyncRuns.$inferSelect) {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  };
}

function resourceTypeFromDataset(dataset: string): ConnectorResourceType | null {
  const normalized = dataset.trim().toLowerCase();
  if (/mail|email|message/.test(normalized)) return "email";
  if (/doc|page|file/.test(normalized)) return "document";
  if (/task|todo/.test(normalized)) return "todo";
  if (/calendar|event|schedule/.test(normalized)) return "calendar";
  return null;
}

export async function runOpenConnector(
  config: OpenConnectorCliConfig,
  args: string[],
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, args, {
      env: {
        ...process.env,
        OO_CONNECTOR_URL: config.baseUrl,
        ...(config.runtimeToken ? { OO_CONNECTOR_TOKEN: config.runtimeToken } : {}),
        OO_CONFIG_DIR: config.configDirectory,
        OO_DATA_DIR: config.dataDirectory,
        NO_COLOR: "1",
      },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else {
        try {
          resolve(redactValue(stdout.trim() ? JSON.parse(stdout) : null, config.runtimeToken));
        } catch {
          reject(new Error("OpenConnector sync returned invalid JSON"));
        }
      }
    };
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("OpenConnector sync timed out"));
    }, 120_000);
    const abort = (): void => {
      child.kill("SIGTERM");
      finish(new Error("OpenConnector sync cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OPEN_CONNECTOR_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("OpenConnector sync output exceeded 64 MiB"));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += redactText(chunk, config.runtimeToken); });
    child.once("error", finish);
    child.once("close", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `oo exited with code ${String(code)}`)));
  });
}
