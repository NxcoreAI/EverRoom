import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  connectorMarkdownArtifacts,
  connectorMarkdownOutbox,
  connectorRecords,
  connectorTodos,
} from "../../infrastructure/database/schema.js";
import type { IngestService } from "../ingest/service.js";
import type { RefSourceKind } from "../ingest/types.js";
import {
  connectorCalendarEventToMarkdown,
  connectorDocumentToMarkdown,
  connectorEmailToMarkdown,
  connectorGenericRecordToMarkdown,
  connectorTodoToMarkdown,
} from "../ingest/connector-markdown.js";

const WORK_INTERVAL_MS = 2_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 10;

type ResourceType = "email" | "document" | "calendar" | "todo" | "generic";
type ArtifactRow = typeof connectorMarkdownArtifacts.$inferSelect;
type OutboxRow = typeof connectorMarkdownOutbox.$inferSelect;
type DomainRow =
  | { resourceType: "email"; row: typeof connectorEmails.$inferSelect }
  | { resourceType: "document"; row: typeof connectorDocuments.$inferSelect }
  | { resourceType: "calendar"; row: typeof connectorCalendarEvents.$inferSelect }
  | { resourceType: "todo"; row: typeof connectorTodos.$inferSelect }
  | { resourceType: "generic"; row: typeof connectorRecords.$inferSelect };

export interface ConnectorMarkdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface ConnectorMarkdownStats {
  total: number;
  ready: number;
  queued: number;
  processing: number;
  pending: number;
  failed: number;
  deleted: number;
  ingestSucceeded: number;
  ingestPending: number;
  ingestFailed: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function artifactIdOf(domain: DomainRow): string {
  const row = domain.row;
  return `cma-${sha256([
    row.ownerId,
    row.service,
    connectionScope(domain),
    domain.resourceType,
    row.sourceRecordId,
  ].join("\u0000")).slice(0, 24)}`;
}

function connectionScope(domain: DomainRow): string {
  return domain.resourceType === "generic" ? domain.row.dataset : domain.row.connectionName ?? "";
}

function rendererVersion(resourceType: ResourceType): string {
  if (resourceType === "email") return "email-v3";
  return `${resourceType}-v${resourceType === "document" ? "2" : "1"}`;
}

function servicePathKey(service: string): string {
  const label = service.normalize("NFKC").toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "connector";
  return `${label}-${sha256(service).slice(0, 8)}`;
}

function refSourceKind(resourceType: ResourceType): RefSourceKind {
  if (resourceType === "email") return "connector-email";
  if (resourceType === "document") return "connector-document";
  if (resourceType === "todo") return "connector-todo";
  if (resourceType === "generic") return "connector-record";
  return "connector-calendar";
}

function ledgerSourceKind(resourceType: ResourceType): "mail" | "cloud-doc" | "calendar-event" | "todo" | "connector-record" {
  if (resourceType === "email") return "mail";
  if (resourceType === "document") return "cloud-doc";
  if (resourceType === "calendar") return "calendar-event";
  if (resourceType === "todo") return "todo";
  return "connector-record";
}

function artifactRelativePath(domain: DomainRow): string {
  const row = domain.row;
  const connectionKey = sha256(connectionScope(domain)).slice(0, 16);
  const sourceKey = sha256(row.sourceRecordId).slice(0, 24);
  return join("connectors", "markdown", servicePathKey(row.service), connectionKey, domain.resourceType, `${sourceKey}.md`);
}

function manifestPathOf(markdownPath: string): string {
  return markdownPath.endsWith(".md")
    ? `${markdownPath.slice(0, -3)}.manifest.json`
    : `${markdownPath}.manifest.json`;
}

function artifactManifest(domain: DomainRow, markdownHash: string): string {
  const row = domain.row;
  const sourceMetadata = domain.resourceType === "generic"
    ? domain.row.payload
    : domain.row.extensionPayload ?? {};
  return `${JSON.stringify({
    ermdVersion: 1,
    connector: row.service,
    connectionScope: connectionScope(domain),
    resourceType: domain.resourceType,
    sourceRecordId: row.sourceRecordId,
    ingestSourceId: row.id,
    sourceUpdatedAt: row.sourceUpdatedAt?.toISOString() ?? null,
    sourceContentHash: row.contentHash,
    markdownContentHash: markdownHash,
    rendererVersion: rendererVersion(domain.resourceType),
    sourceMetadata,
  }, null, 2)}\n`;
}

function render(domain: DomainRow): string {
  if (domain.resourceType === "email") return connectorEmailToMarkdown(domain.row);
  if (domain.resourceType === "document") return connectorDocumentToMarkdown(domain.row);
  if (domain.resourceType === "calendar") return connectorCalendarEventToMarkdown(domain.row);
  if (domain.resourceType === "todo") return connectorTodoToMarkdown(domain.row);
  return connectorGenericRecordToMarkdown(domain.row);
}

function retryDelayMs(attempt: number): number {
  const schedule = [30_000, 120_000, 600_000, 3_600_000];
  return schedule[Math.min(attempt - 1, schedule.length - 1)]!;
}

export class ConnectorMarkdownService {
  private readonly instanceId = randomUUID();
  private timer: ReturnType<typeof setInterval> | null = null;
  private workPromise: Promise<number> | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly dataDir: string,
    private readonly ingest: IngestService,
    private readonly logger: ConnectorMarkdownLogger,
  ) {}

  async initialize(): Promise<void> {
    const now = new Date();
    this.db.update(connectorMarkdownOutbox).set({
      status: "pending",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
    }).where(and(
      eq(connectorMarkdownOutbox.status, "processing"),
      or(isNull(connectorMarkdownOutbox.leaseUntil), lte(connectorMarkdownOutbox.leaseUntil, now)),
    )).run();
    this.backfill(now);
    this.timer = setInterval(() => void this.processPending(), WORK_INTERVAL_MS);
    this.timer.unref?.();
    void this.processPending();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.workPromise;
  }

  processPending(limit = 100): Promise<number> {
    if (this.workPromise) return this.workPromise;
    const work = this.drainPending(limit).finally(() => {
      if (this.workPromise === work) this.workPromise = null;
    });
    this.workPromise = work;
    return work;
  }

  private async drainPending(limit: number): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const event = this.claimNext();
      if (!event) break;
      await this.processEvent(event);
      processed += 1;
    }
    return processed;
  }

  stats(ownerId?: string): ConnectorMarkdownStats {
    const artifacts = this.db.select().from(connectorMarkdownArtifacts).all()
      .filter((row) => !ownerId || row.ownerId === ownerId);
    const outbox = this.db.select().from(connectorMarkdownOutbox).all()
      .filter((row) => !ownerId || row.ownerId === ownerId);
    const activeSources = new Set<string>();
    const addSources = (resourceType: ResourceType, rows: Array<{ id: string; ownerId: string; deletedAt: Date | null }>) => {
      for (const row of rows) {
        if ((!ownerId || row.ownerId === ownerId) && !row.deletedAt) activeSources.add(`${resourceType}:${row.id}`);
      }
    };
    addSources("email", this.db.select({
      id: connectorEmails.id,
      ownerId: connectorEmails.ownerId,
      deletedAt: connectorEmails.deletedAt,
    }).from(connectorEmails).all());
    addSources("document", this.db.select({
      id: connectorDocuments.id,
      ownerId: connectorDocuments.ownerId,
      deletedAt: connectorDocuments.deletedAt,
    }).from(connectorDocuments).all());
    addSources("calendar", this.db.select({
      id: connectorCalendarEvents.id,
      ownerId: connectorCalendarEvents.ownerId,
      deletedAt: connectorCalendarEvents.deletedAt,
    }).from(connectorCalendarEvents).all());
    addSources("todo", this.db.select({
      id: connectorTodos.id,
      ownerId: connectorTodos.ownerId,
      deletedAt: connectorTodos.deletedAt,
    }).from(connectorTodos).all());
    addSources("generic", this.db.select({
      id: connectorRecords.id,
      ownerId: connectorRecords.ownerId,
      deletedAt: connectorRecords.deletedAt,
    }).from(connectorRecords).all());

    const artifactBySource = new Map(artifacts.map((row) => [`${row.resourceType}:${row.ingestSourceId}`, row]));
    const processingSources = new Set(outbox
      .filter((row) => row.operation === "upsert" && row.status === "processing")
      .map((row) => `${row.resourceType}:${row.ingestSourceId}`));
    const deadSources = new Set(outbox
      .filter((row) => row.operation === "upsert" && row.status === "dead")
      .map((row) => `${row.resourceType}:${row.ingestSourceId}`));
    let ready = 0;
    let processing = 0;
    let failed = 0;
    let ingestSucceeded = 0;
    let ingestPending = 0;
    let ingestFailed = 0;
    for (const source of activeSources) {
      const artifact = artifactBySource.get(source);
      if (artifact?.status === "ready") {
        ready += 1;
        if (artifact.ingestStatus === "succeeded") ingestSucceeded += 1;
        else if (artifact.ingestStatus === "failed") ingestFailed += 1;
        else if (artifact.ingestStatus === "pending") ingestPending += 1;
      } else if (artifact?.status === "failed" || deadSources.has(source)) {
        failed += 1;
      } else if (processingSources.has(source)) {
        processing += 1;
      }
    }
    const queued = Math.max(0, activeSources.size - ready - processing - failed);
    return {
      total: activeSources.size,
      ready,
      queued,
      processing,
      pending: queued + processing,
      failed,
      deleted: artifacts.filter((row) => row.status === "deleted").length,
      ingestSucceeded,
      ingestPending,
      ingestFailed,
    };
  }

  getByIngestSource(resourceType: ResourceType, ingestSourceId: string): ArtifactRow | null {
    return this.db.select().from(connectorMarkdownArtifacts).where(and(
      eq(connectorMarkdownArtifacts.resourceType, resourceType),
      eq(connectorMarkdownArtifacts.ingestSourceId, ingestSourceId),
    )).get() ?? null;
  }

  private backfill(now: Date): void {
    const records: Array<{
      resourceType: ResourceType;
      id: string;
      ownerId: string;
      contentHash: string;
      deletedAt: Date | null;
    }> = [
      ...this.db.select({
        id: connectorEmails.id,
        ownerId: connectorEmails.ownerId,
        contentHash: connectorEmails.contentHash,
        deletedAt: connectorEmails.deletedAt,
      }).from(connectorEmails).all().map((row) => ({ resourceType: "email" as const, ...row })),
      ...this.db.select({
        id: connectorDocuments.id,
        ownerId: connectorDocuments.ownerId,
        contentHash: connectorDocuments.contentHash,
        deletedAt: connectorDocuments.deletedAt,
      }).from(connectorDocuments).all().map((row) => ({ resourceType: "document" as const, ...row })),
      ...this.db.select({
        id: connectorCalendarEvents.id,
        ownerId: connectorCalendarEvents.ownerId,
        contentHash: connectorCalendarEvents.contentHash,
        deletedAt: connectorCalendarEvents.deletedAt,
      }).from(connectorCalendarEvents).all().map((row) => ({ resourceType: "calendar" as const, ...row })),
      ...this.db.select({
        id: connectorTodos.id,
        ownerId: connectorTodos.ownerId,
        contentHash: connectorTodos.contentHash,
        deletedAt: connectorTodos.deletedAt,
      }).from(connectorTodos).all().map((row) => ({ resourceType: "todo" as const, ...row })),
      ...this.db.select({
        id: connectorRecords.id,
        ownerId: connectorRecords.ownerId,
        contentHash: connectorRecords.contentHash,
        deletedAt: connectorRecords.deletedAt,
      }).from(connectorRecords).all().map((row) => ({ resourceType: "generic" as const, ...row })),
    ];
    for (const record of records) {
      const artifact = this.getByIngestSource(record.resourceType, record.id);
      const operation = record.deletedAt ? "delete" : "upsert";
      if (operation === "delete" && (!artifact || artifact.status === "deleted")) continue;
      if (operation === "upsert"
        && artifact?.sourceContentHash === record.contentHash
        && artifact.rendererVersion === rendererVersion(record.resourceType)
        && artifact.status === "ready") continue;
      const queued = this.db.select({ id: connectorMarkdownOutbox.id }).from(connectorMarkdownOutbox).where(and(
        eq(connectorMarkdownOutbox.resourceType, record.resourceType),
        eq(connectorMarkdownOutbox.ingestSourceId, record.id),
        eq(connectorMarkdownOutbox.sourceContentHash, record.contentHash),
        or(eq(connectorMarkdownOutbox.status, "pending"), eq(connectorMarkdownOutbox.status, "processing")),
      )).get();
      if (queued) continue;
      this.db.insert(connectorMarkdownOutbox).values({
        id: randomUUID(),
        ownerId: record.ownerId,
        resourceType: record.resourceType,
        ingestSourceId: record.id,
        operation,
        sourceContentHash: record.contentHash,
        availableAt: now,
        createdAt: now,
        updatedAt: now,
      }).run();
    }
  }

  private claimNext(): OutboxRow | null {
    const now = new Date();
    const event = this.db.select().from(connectorMarkdownOutbox).where(and(
      eq(connectorMarkdownOutbox.status, "pending"),
      lte(connectorMarkdownOutbox.availableAt, now),
    )).orderBy(asc(connectorMarkdownOutbox.createdAt)).get();
    if (!event) return null;
    const claimed = this.db.update(connectorMarkdownOutbox).set({
      status: "processing",
      leaseOwner: this.instanceId,
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    }).where(and(
      eq(connectorMarkdownOutbox.id, event.id),
      eq(connectorMarkdownOutbox.status, "pending"),
    )).run() as { changes: number };
    return claimed.changes === 1
      ? { ...event, status: "processing", leaseOwner: this.instanceId, leaseUntil: new Date(now.getTime() + LEASE_MS) }
      : null;
  }

  private async processEvent(event: OutboxRow): Promise<void> {
    let artifactReady = false;
    try {
      const domain = this.domainRecord(event.resourceType, event.ingestSourceId);
      if (!domain) {
        this.completeEvent(event.id);
        return;
      }
      if (event.operation === "delete" && !domain.row.deletedAt) {
        this.completeEvent(event.id);
        this.enqueueCurrent(domain);
        return;
      }
      if (domain.row.deletedAt) {
        await this.deleteArtifact(domain);
        this.completeEvent(event.id);
        return;
      }
      if (domain.row.contentHash !== event.sourceContentHash) {
        this.completeEvent(event.id);
        this.enqueueCurrent(domain);
        return;
      }

      const markdown = render(domain);
      const markdownHash = sha256(markdown);
      const relativePath = artifactRelativePath(domain);
      const absolutePath = join(this.dataDir, relativePath);
      const id = artifactIdOf(domain);
      const existing = this.getByIngestSource(domain.resourceType, domain.row.id);
      const unchanged = existing?.markdownContentHash === markdownHash
        && existing.rendererVersion === rendererVersion(domain.resourceType)
        && existing.status === "ready";
      if (!unchanged) await this.writeArtifact(absolutePath, markdown, artifactManifest(domain, markdownHash));

      const now = new Date();
      const values = {
        id,
        ownerId: domain.row.ownerId,
        service: domain.row.service,
        connectionName: connectionScope(domain),
        resourceType: domain.resourceType,
        sourceRecordId: domain.row.sourceRecordId,
        ingestSourceId: domain.row.id,
        activePath: relativePath,
        sourceContentHash: domain.row.contentHash,
        markdownContentHash: markdownHash,
        rendererVersion: rendererVersion(domain.resourceType),
        version: unchanged ? existing.version : (existing?.version ?? 0) + 1,
        status: "ready" as const,
        ingestStatus: unchanged && existing.ingestStatus === "succeeded" ? "succeeded" as const : "pending" as const,
        lastError: null,
        deletedAt: null,
        updatedAt: now,
      };
      this.db.insert(connectorMarkdownArtifacts).values({ ...values, createdAt: existing?.createdAt ?? now })
        .onConflictDoUpdate({ target: connectorMarkdownArtifacts.id, set: values }).run();
      artifactReady = true;

      if (!unchanged || existing?.ingestStatus !== "succeeded") {
        const result = await this.ingest.ingest({
          source: { ref: { sourceKind: refSourceKind(domain.resourceType), sourceId: domain.row.id } },
          originChannel: "connector",
        });
        this.db.update(connectorMarkdownArtifacts).set({
          ingestStatus: "succeeded",
          ingestEventId: result.eventId,
          parsedId: result.parsedId,
          lastError: null,
          updatedAt: new Date(),
        }).where(eq(connectorMarkdownArtifacts.id, id)).run();
      }
      this.completeEvent(event.id);
      this.logger.info({
        artifactId: id,
        resourceType: domain.resourceType,
        ingestSourceId: domain.row.id,
        version: values.version,
      }, "connector Markdown artifact materialized");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failEvent(event, message);
      const artifact = this.getByIngestSource(event.resourceType, event.ingestSourceId);
      if (artifact) {
        this.db.update(connectorMarkdownArtifacts).set({
          status: artifactReady ? "ready" : "failed",
          ingestStatus: artifactReady ? "failed" : artifact.ingestStatus,
          lastError: message.slice(0, 1_000),
          updatedAt: new Date(),
        }).where(eq(connectorMarkdownArtifacts.id, artifact.id)).run();
      }
      this.logger.warn({
        eventId: event.id,
        resourceType: event.resourceType,
        ingestSourceId: event.ingestSourceId,
        error: message,
      }, "connector Markdown materialization failed");
    }
  }

  private domainRecord(resourceType: ResourceType, id: string): DomainRow | null {
    if (resourceType === "email") {
      const row = this.db.select().from(connectorEmails).where(eq(connectorEmails.id, id)).get();
      return row ? { resourceType, row } : null;
    }
    if (resourceType === "document") {
      const row = this.db.select().from(connectorDocuments).where(eq(connectorDocuments.id, id)).get();
      return row ? { resourceType, row } : null;
    }
    if (resourceType === "calendar") {
      const row = this.db.select().from(connectorCalendarEvents).where(eq(connectorCalendarEvents.id, id)).get();
      return row ? { resourceType, row } : null;
    }
    if (resourceType === "todo") {
      const row = this.db.select().from(connectorTodos).where(eq(connectorTodos.id, id)).get();
      return row ? { resourceType, row } : null;
    }
    const row = this.db.select().from(connectorRecords).where(eq(connectorRecords.id, id)).get();
    return row ? { resourceType, row } : null;
  }

  private enqueueCurrent(domain: DomainRow): void {
    const now = new Date();
    this.db.insert(connectorMarkdownOutbox).values({
      id: randomUUID(),
      ownerId: domain.row.ownerId,
      resourceType: domain.resourceType,
      ingestSourceId: domain.row.id,
      operation: domain.row.deletedAt ? "delete" : "upsert",
      sourceContentHash: domain.row.contentHash,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  private async writeArtifact(path: string, markdown: string, manifest: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${this.instanceId}.tmp`;
    const manifestPath = manifestPathOf(path);
    const temporaryManifestPath = `${manifestPath}.${this.instanceId}.tmp`;
    await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
    await writeFile(temporaryManifestPath, manifest, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryManifestPath, manifestPath).catch(async (error: NodeJS.ErrnoException) => {
      await unlink(temporaryPath).catch(() => undefined);
      await unlink(temporaryManifestPath).catch(() => undefined);
      throw error;
    });
    await rename(temporaryPath, path).catch(async (error: NodeJS.ErrnoException) => {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    });
    await chmod(path, 0o600).catch(() => undefined);
    await chmod(manifestPath, 0o600).catch(() => undefined);
  }

  private async deleteArtifact(domain: DomainRow): Promise<void> {
    await this.ingest.cleanupSource(ledgerSourceKind(domain.resourceType), domain.row.id);
    const artifact = this.getByIngestSource(domain.resourceType, domain.row.id);
    if (!artifact) return;
    await unlink(join(this.dataDir, artifact.activePath)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await unlink(manifestPathOf(join(this.dataDir, artifact.activePath))).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    const now = new Date();
    this.db.update(connectorMarkdownArtifacts).set({
      status: "deleted",
      ingestStatus: "skipped",
      deletedAt: now,
      lastError: null,
      updatedAt: now,
    }).where(eq(connectorMarkdownArtifacts.id, artifact.id)).run();
  }

  private completeEvent(id: string): void {
    this.db.update(connectorMarkdownOutbox).set({
      status: "done",
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      updatedAt: new Date(),
    }).where(and(
      eq(connectorMarkdownOutbox.id, id),
      eq(connectorMarkdownOutbox.leaseOwner, this.instanceId),
    )).run();
  }

  private failEvent(event: OutboxRow, message: string): void {
    const attempts = event.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    this.db.update(connectorMarkdownOutbox).set({
      status: dead ? "dead" : "pending",
      attempts,
      availableAt: new Date(Date.now() + retryDelayMs(attempts)),
      leaseOwner: null,
      leaseUntil: null,
      lastError: message.slice(0, 1_000),
      updatedAt: new Date(),
    }).where(and(
      eq(connectorMarkdownOutbox.id, event.id),
      eq(connectorMarkdownOutbox.leaseOwner, this.instanceId),
    )).run();
  }
}
