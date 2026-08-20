import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { jobs } from "../src/infrastructure/database/schema.js";
import {
  DOCUMENT_DELETE_JOB_TYPE,
  DOCUMENT_INGEST_JOB_TYPE,
  enqueueDocumentDelete,
  enqueueDocumentIngest,
} from "../src/modules/documents/integration-outbox.js";
import { DocumentOutboxWorker } from "../src/modules/ingest/document-outbox-worker.js";
import type { IngestService } from "../src/modules/ingest/service.js";
import type { KnowledgeService } from "../src/modules/knowledge/service.js";
import type { MemoryService } from "../src/modules/memory/service.js";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-outbox-test-"));
  temporaryDirectories.push(dataDir);
  const { db, sqlite } = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  disposables.push(() => sqlite.close());
  const ingestCommittedDocument = vi.fn().mockResolvedValue(null);
  const requestDocumentCleanup = vi.fn();
  const deleteDocumentsByCallerRef = vi.fn().mockResolvedValue([]);
  const ingest = { ingestCommittedDocument } as unknown as IngestService;
  const knowledge = { enabled: true, requestDocumentCleanup } as unknown as KnowledgeService;
  const memory = { enabled: true, deleteDocumentsByCallerRef } as unknown as MemoryService;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const worker = new DocumentOutboxWorker(db, ingest, knowledge, memory, logger, {
    debounceMs: 0,
    pollIntervalMs: 60_000,
    retryBaseDelayMs: 0,
  });
  return {
    db,
    worker,
    ingestCommittedDocument,
    requestDocumentCleanup,
    deleteDocumentsByCallerRef,
  };
}

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document outbox worker", () => {
  it("supersedes older pending versions of the same document", async () => {
    const test = await createHarness();
    const now = new Date(Date.now() - 1_000);
    test.db.transaction((tx) => {
      enqueueDocumentIngest(tx, {
        documentId: "doc-1", roomId: "room-1", version: 1, sourceTransactionId: null,
      }, now);
      enqueueDocumentIngest(tx, {
        documentId: "doc-1", roomId: "room-1", version: 2, sourceTransactionId: null,
      }, new Date(now.getTime() + 1));
    });

    await test.worker.drain();

    expect(test.ingestCommittedDocument).toHaveBeenCalledOnce();
    expect(test.ingestCommittedDocument).toHaveBeenCalledWith("doc-1", 2);
    const rows = test.db.select().from(jobs).all();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "completed", result: { superseded: true } }),
      expect.objectContaining({ status: "completed", result: { skipped: true } }),
    ]));
  });

  it("recovers running work on startup and completes it", async () => {
    const test = await createHarness();
    let finish!: (value: null) => void;
    test.ingestCommittedDocument.mockImplementationOnce(() => new Promise((resolvePromise) => {
      finish = resolvePromise;
    }));
    test.db.insert(jobs).values({
      id: "recover-running",
      type: DOCUMENT_INGEST_JOB_TYPE,
      status: "running",
      payload: { documentId: "doc-recover", roomId: "room-1", version: 3, sourceTransactionId: null, attempts: 1 },
    }).run();

    test.worker.start();
    await vi.waitFor(() => expect(test.ingestCommittedDocument).toHaveBeenCalledWith("doc-recover", 3));
    expect(test.db.select().from(jobs).where(eq(jobs.id, "recover-running")).get()?.status).toBe("running");
    finish(null);
    await test.worker.dispose();

    expect(test.db.select().from(jobs).where(eq(jobs.id, "recover-running")).get()?.status).toBe("completed");
  });

  it("persists attempts and retries failed work", async () => {
    const test = await createHarness();
    test.ingestCommittedDocument
      .mockRejectedValueOnce(new Error("memory unavailable"))
      .mockResolvedValueOnce(null);
    test.db.transaction((tx) => enqueueDocumentIngest(tx, {
      documentId: "doc-retry", roomId: "room-1", version: 1, sourceTransactionId: null,
    }, new Date(Date.now() - 1_000)));

    await test.worker.drain();
    expect(test.db.select().from(jobs).all()[0]).toMatchObject({
      status: "pending",
      payload: expect.objectContaining({ attempts: 1 }),
      error: { message: "memory unavailable", attempts: 1 },
    });
    await test.worker.drain();

    expect(test.ingestCommittedDocument).toHaveBeenCalledTimes(2);
    expect(test.db.select().from(jobs).all()[0]).toMatchObject({ status: "completed" });
  });

  it("runs both Knowledge and Memory cleanup for permanent deletes", async () => {
    const test = await createHarness();
    test.db.transaction((tx) => enqueueDocumentDelete(tx, {
      documentId: "doc-delete", roomId: "room-1",
    }, new Date()));

    await test.worker.drain();

    expect(test.requestDocumentCleanup).toHaveBeenCalledWith("doc-delete");
    expect(test.deleteDocumentsByCallerRef).toHaveBeenCalledWith("doc-delete");
    expect(test.db.select().from(jobs).all()[0]).toMatchObject({
      type: DOCUMENT_DELETE_JOB_TYPE,
      status: "completed",
    });
  });
});
