import { and, asc, eq, gt } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { documentVersions, documentYjsVersions, documents, jobs } from "../../infrastructure/database/schema.js";
import {
  DOCUMENT_HISTORY_BACKFILL_JOB_TYPE,
  enqueueDocumentHistoryBackfill,
  type DocumentHistoryBackfillJobPayload,
} from "../documents/integration-outbox.js";

const MAX_ATTEMPTS = 5;
const BACKFILL_BATCH_SIZE = 50;
const MAX_BATCHES_PER_DRAIN = 10;

interface DocumentHistoryBackfillLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface DocumentHistoryBackfillWorkerOptions {
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
  maxBatchesPerDrain?: number;
}

export interface DocumentHistoryBackfiller {
  backfillYjsHistory(documentId: string, maxVersions?: number): number;
  isYjsHistoryComplete?(documentId: string): boolean;
}

export class DocumentHistoryBackfillWorker {
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly history: DocumentHistoryBackfiller,
    private readonly logger: DocumentHistoryBackfillLogger,
    private readonly options: DocumentHistoryBackfillWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(and(
      eq(jobs.type, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE),
      eq(jobs.status, "running"),
    )).run();
    this.timer = setInterval(() => void this.drain(), this.options.pollIntervalMs ?? 30_000);
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
    this.enqueueMissingDocuments();
    const maxBatches = Math.max(1, this.options.maxBatchesPerDrain ?? MAX_BATCHES_PER_DRAIN);
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const pendingJobs = this.db.select().from(jobs).where(and(
        eq(jobs.type, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE),
        eq(jobs.status, "pending"),
      )).orderBy(asc(jobs.createdAt)).limit(100).all();
      const job = pendingJobs.find((candidate) => {
        const payload = candidate.payload as DocumentHistoryBackfillJobPayload;
        return this.retryReady(candidate, payload.attempts);
      });
      if (!job) break;
      if (!await this.process(job)) break;
    }
  }

  private enqueueMissingDocuments(): void {
    const candidates = this.db.select({ id: documents.id, version: documents.version })
      .from(documents)
      .where(gt(documents.version, 0))
      .all();
    const expectedRows = this.db.select({ documentId: documentVersions.documentId, version: documentVersions.version })
      .from(documentVersions).all();
    const actualRows = this.db.select({ documentId: documentYjsVersions.documentId, version: documentYjsVersions.version })
      .from(documentYjsVersions).all();
    const expectedByDocument = new Map<string, Set<number>>();
    for (const row of expectedRows) {
      const versions = expectedByDocument.get(row.documentId) ?? new Set<number>();
      versions.add(row.version);
      expectedByDocument.set(row.documentId, versions);
    }
    const actualByDocument = new Map<string, Set<number>>();
    for (const row of actualRows) {
      const versions = actualByDocument.get(row.documentId) ?? new Set<number>();
      versions.add(row.version);
      actualByDocument.set(row.documentId, versions);
    }
    const now = new Date();
    this.db.transaction((tx) => {
      for (const document of candidates) {
        const expectedVersions = expectedByDocument.get(document.id) ?? new Set<number>();
        const actualVersions = actualByDocument.get(document.id) ?? new Set<number>();
        if (expectedVersions.size > 0 && [...expectedVersions].every((version) => actualVersions.has(version))) continue;
        enqueueDocumentHistoryBackfill(tx, document.id, now);
      }
    });
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
    const payload = job.payload as DocumentHistoryBackfillJobPayload;
    try {
      const count = this.history.backfillYjsHistory(payload.documentId, BACKFILL_BATCH_SIZE);
      const complete = this.isComplete(payload.documentId);
      this.db.update(jobs).set({
        status: complete ? "completed" : "pending",
        result: { documentId: payload.documentId, backfilled: count, complete },
        error: null,
        updatedAt: new Date(),
      }).where(eq(jobs.id, job.id)).run();
      this.logger.info({ event: complete ? "document.history.backfill.completed" : "document.history.backfill.progress", documentId: payload.documentId, backfilled: count, complete }, complete ? "document history backfill completed" : "document history backfill progressed");
      return complete || count > 0;
    } catch (error) {
      if (!this.documentExists(payload.documentId)) {
        this.db.update(jobs).set({
          status: "cancelled",
          result: { documentId: payload.documentId, skipped: "document_deleted" },
          error: null,
          updatedAt: new Date(),
        }).where(eq(jobs.id, job.id)).run();
        this.logger.info({ event: "document.history.backfill.cancelled", documentId: payload.documentId }, "document history backfill skipped for deleted document");
        return true;
      }
      this.failOrRetry(job, error);
      return false;
    }
  }

  private documentExists(documentId: string): boolean {
    return Boolean(this.db.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).get());
  }

  private isComplete(documentId: string): boolean {
    if (this.history.isYjsHistoryComplete && !this.history.isYjsHistoryComplete(documentId)) return false;
    const expected = this.db.select({ version: documentVersions.version })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId)).all();
    if (expected.length === 0) return true;
    const actual = new Set(this.db.select({ version: documentYjsVersions.version })
      .from(documentYjsVersions)
      .where(eq(documentYjsVersions.documentId, documentId)).all()
      .map((row) => row.version));
    return expected.every((row) => actual.has(row.version));
  }

  private failOrRetry(job: typeof jobs.$inferSelect, error: unknown): void {
    const payload = job.payload as DocumentHistoryBackfillJobPayload;
    const attempts = payload.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attempts >= MAX_ATTEMPTS;
    this.db.update(jobs).set({
      status: terminal ? "failed" : "pending",
      payload: { ...payload, attempts },
      error: { message, attempts },
      updatedAt: new Date(),
    }).where(eq(jobs.id, job.id)).run();
    const bindings = { event: "document.history.backfill.failed", jobId: job.id, documentId: payload.documentId, attempts, error: message };
    if (terminal) this.logger.error(bindings, "document history backfill failed permanently");
    else this.logger.warn(bindings, "document history backfill scheduled for retry");
  }
}
