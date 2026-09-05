import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { contextRooms, jobs } from "../src/infrastructure/database/schema.js";
import { DOCUMENT_INDEX_BACKFILL_JOB_TYPE } from "../src/modules/documents/index-backfill/jobs.js";
import { DocumentIndexBackfillReadTrigger } from "../src/modules/documents/index-backfill/read-trigger.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentService } from "../src/modules/documents/service.js";
import type { TiptapJsonContent } from "@nxcore/agent-contract";

const PARAGRAPH = "PyTorch 是一种基于 Torch 的开源深度学习框架，由 Meta AI 维护，"
  + "支持动态计算图、自动求导机制与张量系统，采用 Python 优先的设计哲学，"
  + "兼顾易用性与性能，是学术界与工业界的主流深度学习框架之一。";

const temporaryDirectories: string[] = [];
const closables: Array<() => void> = [];

const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

function body(text: string): TiptapJsonContent {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-index-read-trigger-test-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  closables.push(() => database.sqlite.close());
  const documents = new DocumentService(database.db, new DocumentEventBroker());
  database.db.insert(contextRooms).values({ id: "room-1", title: "测试房间", data: {} }).run();
  const warn = vi.fn();
  const createTrigger = (cooldownMs: number) =>
    new DocumentIndexBackfillReadTrigger(database.db, { warn }, cooldownMs);
  return { database, documents, warn, createTrigger };
}

async function importDocument(documents: DocumentService, id: string) {
  return documents.import({ id, roomId: "room-1", title: `文档 ${id}`, contentJson: body(PARAGRAPH) });
}

function pendingJob(db: ReturnType<typeof createDatabase>["db"], documentId: string) {
  return db.select().from(jobs).where(and(
    eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE),
    eq(jobs.id, `document-index-backfill:${documentId}`),
  )).all();
}

afterEach(async () => {
  for (const close of closables.splice(0)) close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("document index backfill read trigger", () => {
  it("enqueues a pending backfill job with the read document identity", async () => {
    const { database, documents, createTrigger } = await createHarness();
    const document = await importDocument(documents, "doc-target");
    const trigger = createTrigger(60_000);

    trigger.trigger(document);

    const rows = pendingJob(database.db, "doc-target");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.payload).toMatchObject({
      documentId: "doc-target",
      roomId: "room-1",
      version: document.version,
    });
  });

  it("skips re-triggering within the cooldown window", async () => {
    const { database, documents, createTrigger } = await createHarness();
    const document = await importDocument(documents, "doc-target");
    const trigger = createTrigger(60_000);

    trigger.trigger(document);
    const first = pendingJob(database.db, "doc-target")[0]!;
    trigger.trigger(document);
    const second = pendingJob(database.db, "doc-target")[0]!;

    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("re-enqueues on every read when cooldown is zero", async () => {
    const { database, documents, createTrigger } = await createHarness();
    const document = await importDocument(documents, "doc-target");
    const trigger = createTrigger(0);

    trigger.trigger(document);
    const first = pendingJob(database.db, "doc-target")[0]!;
    await wait(5);
    trigger.trigger(document);
    const second = pendingJob(database.db, "doc-target")[0]!;

    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
  });

  it("swallows enqueue failures and clears the cooldown so the next read retries", async () => {
    const { database, documents, warn, createTrigger } = await createHarness();
    const document = await importDocument(documents, "doc-target");
    const trigger = createTrigger(60_000);
    database.sqlite.close();

    expect(() => trigger.trigger(document)).not.toThrow();
    expect(() => trigger.trigger(document)).not.toThrow();
    // 第二次仍尝试入队（而非被冷却挡下）→ 冷却记录在失败时被撤销。
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toMatchObject({ event: "document.index-backfill.read_trigger_failed" });
  });
});
