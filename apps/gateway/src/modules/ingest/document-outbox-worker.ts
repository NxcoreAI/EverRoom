import { and, asc, eq, inArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";
import {
  DOCUMENT_DELETE_JOB_TYPE,
  DOCUMENT_INGEST_JOB_TYPE,
  type DocumentDeleteJobPayload,
  type DocumentIngestJobPayload,
} from "../documents/integration-outbox.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { MemoryService } from "../memory/service.js";
import type { IngestService } from "./service.js";

const OUTBOX_JOB_TYPES = [DOCUMENT_INGEST_JOB_TYPE, DOCUMENT_DELETE_JOB_TYPE] as const;
const MAX_ATTEMPTS = 5;

interface DocumentOutboxLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface DocumentOutboxWorkerOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
}

export class DocumentOutboxWorker {
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly ingest: IngestService,
    private readonly knowledge: KnowledgeService,
    private readonly memory: MemoryService,
    private readonly logger: DocumentOutboxLogger,
    private readonly options: DocumentOutboxWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const now = new Date();
    this.db.update(jobs).set({ status: "pending", updatedAt: now }).where(and(
      inArray(jobs.type, [...OUTBOX_JOB_TYPES]),
      eq(jobs.status, "running"),
    )).run();
    this.timer = setInterval(() => void this.drain(), this.options.pollIntervalMs ?? 1_000);
    this.timer.unref();
    void this.drain();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainPending().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainPending(): Promise<void> {
    const candidates = this.db.select().from(jobs).where(and(
      inArray(jobs.type, [...OUTBOX_JOB_TYPES]),
      eq(jobs.status, "pending"),
    )).orderBy(asc(jobs.createdAt)).all();
    const latestIngestVersion = new Map<string, number>();
    for (const job of candidates) {
      if (job.type !== DOCUMENT_INGEST_JOB_TYPE) continue;
      const payload = job.payload as DocumentIngestJobPayload;
      latestIngestVersion.set(
        payload.documentId,
        Math.max(latestIngestVersion.get(payload.documentId) ?? 0, payload.version),
      );
    }

    const blockedDocumentIds = new Set<string>();
    for (const job of candidates) {
      const payload = job.payload as DocumentIngestJobPayload | DocumentDeleteJobPayload;
      if (blockedDocumentIds.has(payload.documentId)) continue;
      if (job.type === DOCUMENT_INGEST_JOB_TYPE) {
        const payload = job.payload as DocumentIngestJobPayload;
        if (payload.version < (latestIngestVersion.get(payload.documentId) ?? payload.version)) {
          this.complete(job.id, { superseded: true });
          continue;
        }
        const debounceMs = Math.max(0, this.options.debounceMs ?? 0);
        if (Date.now() - job.createdAt.getTime() < debounceMs) {
          blockedDocumentIds.add(payload.documentId);
          continue;
        }
      }
      if (!this.retryReady(job, payload.attempts ?? 0)) {
        blockedDocumentIds.add(payload.documentId);
        continue;
      }
      if (!await this.process(job)) blockedDocumentIds.add(payload.documentId);
    }
  }

  private retryReady(job: typeof jobs.$inferSelect, attempts: number): boolean {
    if (attempts <= 0) return true;
    const baseDelay = Math.max(0, this.options.retryBaseDelayMs ?? 5_000);
    const delay = Math.min(baseDelay * (2 ** (attempts - 1)), 5 * 60_000);
    return Date.now() - job.updatedAt.getTime() >= delay;
  }

  private async process(job: typeof jobs.$inferSelect): Promise<boolean> {
    const claimed = this.db.update(jobs).set({ status: "running", updatedAt: new Date() }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.status, "pending"),
    )).run();
    if (claimed.changes !== 1) return true;

    try {
      if (job.type === DOCUMENT_INGEST_JOB_TYPE) {
        const payload = job.payload as DocumentIngestJobPayload;
        const result = await this.ingest.ingestCommittedDocument(payload.documentId, payload.version);
        this.complete(job.id, result ? { eventId: result.eventId, deduped: result.deduped } : { skipped: true });
      } else {
        const payload = job.payload as DocumentDeleteJobPayload;
        if (this.knowledge.enabled) this.knowledge.requestDocumentCleanup(payload.documentId);
        if (this.memory.enabled) await this.memory.deleteDocumentsByCallerRef(payload.documentId);
        this.complete(job.id, { deleted: true });
      }
      return true;
    } catch (error) {
      this.failOrRetry(job, error);
      return false;
    }
  }

  private complete(jobId: string, result: Record<string, unknown>): void {
    this.db.update(jobs).set({
      status: "completed",
      result,
      error: null,
      updatedAt: new Date(),
    }).where(eq(jobs.id, jobId)).run();
  }

  private failOrRetry(job: typeof jobs.$inferSelect, error: unknown): void {
    const payload = job.payload as DocumentIngestJobPayload | DocumentDeleteJobPayload;
    const attempts = (payload.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attempts >= MAX_ATTEMPTS;
    this.db.update(jobs).set({
      status: terminal ? "failed" : "pending",
      payload: { ...payload, attempts },
      error: { message, attempts },
      updatedAt: new Date(),
    }).where(eq(jobs.id, job.id)).run();
    const bindings = { event: "document.outbox.failed", jobId: job.id, attempts, error: message };
    if (terminal) this.logger.error(bindings, "document outbox job failed permanently");
    else this.logger.warn(bindings, "document outbox job scheduled for retry");
  }
}
