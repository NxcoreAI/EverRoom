import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { documentYjsVersions, documents, jobs } from "../src/infrastructure/database/schema.js";
import { DocumentHistoryBackfillWorker } from "../src/modules/ingest/document-history-backfill-worker.js";
import { enqueueDocumentHistoryBackfill, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE } from "../src/modules/documents/integration-outbox.js";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document history backfill worker", () => {
  it("queues missing documents, completes idempotently, and records the result", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-history-worker-test-"));
    temporaryDirectories.push(dataDir);
    const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    disposables.push(() => sqlite.close());
    db.insert(documents).values({
      id: "doc-history-worker",
      title: "历史",
      contentJson: { type: "doc", content: [] },
      version: 2,
      status: "active",
    }).run();
    const backfill = vi.fn().mockReturnValueOnce(2).mockReturnValueOnce(0);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const worker = new DocumentHistoryBackfillWorker(db, { backfillYjsHistory: backfill }, logger, {
      retryBaseDelayMs: 0,
      pollIntervalMs: 60_000,
    });

    await worker.drain();
    expect(backfill).toHaveBeenCalledWith("doc-history-worker", 50);
    expect(db.select().from(jobs).where(eq(jobs.type, DOCUMENT_HISTORY_BACKFILL_JOB_TYPE)).all())
      .toMatchObject([expect.objectContaining({
        status: "completed",
        result: { documentId: "doc-history-worker", backfilled: 2, complete: true },
      })]);

    await worker.drain();
    expect(backfill).toHaveBeenCalledTimes(1);
  });

  it("retries failed backfills and does not duplicate an existing job", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-history-worker-retry-"));
    temporaryDirectories.push(dataDir);
    const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
    disposables.push(() => sqlite.close());
    db.insert(documents).values({
      id: "doc-history-retry",
      title: "历史",
      contentJson: { type: "doc", content: [] },
      version: 1,
      status: "active",
    }).run();
    const now = new Date(Date.now() - 1_000);
    db.transaction((tx) => {
      enqueueDocumentHistoryBackfill(tx, "doc-history-retry", now);
      enqueueDocumentHistoryBackfill(tx, "doc-history-retry", now);
    });
    const backfill = vi.fn()
      .mockImplementationOnce(() => { throw new Error("temporary failure"); })
      .mockReturnValueOnce(1);
    const worker = new DocumentHistoryBackfillWorker(db, { backfillYjsHistory: backfill }, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, {
      retryBaseDelayMs: 0,
      pollIntervalMs: 60_000,
    });

    await worker.drain();
    expect(db.select().from(jobs).where(eq(jobs.id, "document-history-backfill:doc-history-retry")).get())
      .toMatchObject({ status: "pending", payload: { attempts: 1 } });
    await worker.drain();
    expect(backfill).toHaveBeenCalledTimes(2);
    expect(db.select().from(documentYjsVersions).all()).toHaveLength(0);
  });
});
