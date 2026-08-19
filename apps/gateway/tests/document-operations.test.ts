import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/infrastructure/database/client.js";
import {
  documentOperationCommands,
  documentOperationEvents,
  documentOperationItems,
  documentBlocks,
  documentVersions,
  documents,
  roomDocumentLinks,
} from "../src/infrastructure/database/schema.js";
import { DocumentEventBroker } from "../src/modules/documents/event-broker.js";
import { DocumentServiceError } from "../src/modules/documents/errors.js";
import { DocumentOperationService } from "../src/modules/documents/operations/service.js";
import { assertDocumentOperationTransition } from "../src/modules/documents/operations/state-machine.js";
import { DocumentService } from "../src/modules/documents/service.js";

const temporaryDirectories: string[] = [];
const disposables: Array<() => void> = [];

async function createHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-document-operations-test-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  disposables.push(() => database.sqlite.close());
  const broker = new DocumentEventBroker();
  const service = new DocumentOperationService(database.db, broker);
  return { ...database, broker, service };
}

afterEach(async () => {
  for (const dispose of disposables.splice(0)) dispose();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createReviewOperation(service: DocumentOperationService, overrides: {
  id?: string;
  documentId?: string;
  baseVersion?: number;
  status?: "running" | "awaiting_input" | "awaiting_review" | "applying";
  expiresAt?: Date;
} = {}) {
  return service.create({
    ...(overrides.id ? { id: overrides.id } : {}),
    capabilityId: "document.edit",
    capabilityVersion: 1,
    interactionMode: "atomic_review",
    presenterKey: "atomic-diff",
    roomId: "room-1",
    ...(overrides.documentId ? { documentId: overrides.documentId } : {}),
    documentTitle: "Review target",
    sessionId: "session-1",
    runId: "run-1",
    baseVersion: overrides.baseVersion ?? 1,
    status: overrides.status ?? "running",
    summary: "Review change",
    ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
  });
}

async function createStreamingDraft(
  service: DocumentOperationService,
  input: {
    operationId: string;
    documentId: string;
    sessionId?: string;
    expiresAt?: Date;
  },
) {
  const operation = service.create({
    id: input.operationId,
    capabilityId: "document.create",
    capabilityVersion: 1,
    interactionMode: "streaming_commit",
    presenterKey: "streaming-document",
    roomId: "room-1",
    documentId: null,
    documentTitle: "Streaming draft",
    sessionId: input.sessionId ?? "session-1",
    runId: "run-1",
    status: "running",
    summary: "Create streaming draft",
    input: { draftDocumentId: input.documentId, nextSequence: 1, totalBytes: 0 },
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
  const started = await service.execute(operation.id, {
    commandId: `${operation.id}:begin`,
    expectedRevision: operation.revision,
    type: "stream.begin",
  }, () => ({
    status: "running",
    draftCreate: {
      documentId: input.documentId,
      roomId: "room-1",
      title: "Streaming draft",
      content: { type: "doc", content: [] },
    },
  }));
  return started.operation;
}

describe("document operation kernel", () => {
  it("persists commands and events and makes command retries idempotent", async () => {
    const { db, service } = await createHarness();
    const operation = createReviewOperation(service);
    let executions = 0;
    const command = {
      commandId: "command-1",
      expectedRevision: operation.revision,
      type: "operation.prepare",
      payload: { finalSequence: 1 },
    };

    const first = await service.execute(operation.id, command, () => {
      executions += 1;
      return {
        status: "awaiting_review",
        addItems: [{
          id: "item-1",
          sequence: 1,
          operation: "replace",
          markdown: "replacement",
          contentHash: "hash-1",
        }],
      };
    });
    const duplicate = await service.execute(operation.id, command, () => {
      executions += 1;
      return { status: "failed" };
    });

    expect(executions).toBe(1);
    expect(first).toMatchObject({ duplicate: false, operation: { revision: 2, status: "awaiting_review" } });
    expect(first.operation.items).toEqual([expect.objectContaining({ id: "item-1", status: "pending" })]);
    expect(duplicate).toMatchObject({ duplicate: true, operation: { revision: 2, status: "awaiting_review" } });
    expect(db.select().from(documentOperationCommands).all()).toHaveLength(1);
    expect(db.select().from(documentOperationEvents).all().map((event) => event.revision)).toEqual([1, 2]);
  });

  it("rejects stale revisions before executing the command handler", async () => {
    const { service } = await createHarness();
    const operation = createReviewOperation(service);
    await service.execute(operation.id, {
      commandId: "command-1", expectedRevision: 1, type: "operation.prepare",
    }, () => ({ status: "awaiting_review" }));
    let executed = false;

    await expect(service.execute(operation.id, {
      commandId: "command-2", expectedRevision: 1, type: "review.reject",
    }, () => {
      executed = true;
      return { status: "rejected" };
    })).rejects.toMatchObject({
      code: "OPERATION_REVISION_CONFLICT",
      statusCode: 409,
    } satisfies Partial<DocumentServiceError>);
    expect(executed).toBe(false);
  });

  it("cancels only active operations owned by the finished Agent run", async () => {
    const { service } = await createHarness();
    const finishedRun = createReviewOperation(service, { id: "operation-finished-run" });
    const otherRun = service.create({
      id: "operation-other-run",
      capabilityId: "document.edit",
      capabilityVersion: 1,
      interactionMode: "atomic_review",
      presenterKey: "atomic-diff",
      roomId: "room-1",
      documentTitle: "Other run",
      sessionId: "session-1",
      runId: "run-2",
      baseVersion: 1,
      status: "running",
      summary: "Other run change",
    });

    expect(service.cancelActiveForSession("session-1", "run-finished", "run-1")).toBe(1);
    expect(service.get(finishedRun.id)).toMatchObject({
      status: "cancelled",
      result: { reason: "run-finished" },
    });
    expect(service.get(otherRun.id)).toMatchObject({ status: "running" });
  });

  it("preserves review-owned operations when a completed Agent run is cleaned up", async () => {
    const { service } = await createHarness();
    const building = createReviewOperation(service, { id: "operation-building", status: "running" });
    const review = createReviewOperation(service, { id: "operation-review", status: "awaiting_review" });
    const applying = createReviewOperation(service, { id: "operation-applying", status: "applying" });

    expect(service.cancelIncompleteForSession("session-1", "run-completed", "run-1")).toBe(1);
    expect(service.get(building.id)).toMatchObject({ status: "cancelled" });
    expect(service.get(review.id)).toMatchObject({ status: "awaiting_review" });
    expect(service.get(applying.id)).toMatchObject({ status: "applying" });
  });

  it("serializes commands from different operations targeting the same document", async () => {
    const { db, service } = await createHarness();
    const now = new Date();
    db.insert(documents).values({
      id: "doc-serialized", title: "Serialized", contentJson: { type: "doc", content: [] },
      contentSchemaVersion: 3, version: 1, status: "active", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomDocumentLinks).values({
      roomId: "room-1", documentId: "doc-serialized", linkedAt: now,
    }).run();
    const first = createReviewOperation(service, {
      id: "serialized-first", documentId: "doc-serialized", status: "running",
    });
    const second = createReviewOperation(service, {
      id: "serialized-second", documentId: "doc-serialized", status: "running",
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => { firstEntered = resolve; });
    let secondHandlerStarted = false;

    const firstCommand = service.execute(first.id, {
      commandId: "serialized-first-command", expectedRevision: 1, type: "operation.prepare",
    }, async () => {
      firstEntered();
      await firstBlocked;
      return { status: "awaiting_review" };
    });
    await firstStarted;
    const secondCommand = service.execute(second.id, {
      commandId: "serialized-second-command", expectedRevision: 1, type: "operation.prepare",
    }, () => {
      secondHandlerStarted = true;
      return { status: "awaiting_review" };
    });
    await Promise.resolve();
    expect(secondHandlerStarted).toBe(false);

    releaseFirst();
    await Promise.all([firstCommand, secondCommand]);
    expect(secondHandlerStarted).toBe(true);
  });

  it("records the applying transition before a reviewed mutation completes", async () => {
    const { db, service } = await createHarness();
    const operation = createReviewOperation(service, { status: "awaiting_review" });
    const now = new Date().toISOString();
    const document = {
      id: "doc-result",
      roomId: "room-1",
      title: "Result",
      contentJson: { type: "doc" as const, content: [] },
      contentSchemaVersion: 1,
      version: 2,
      status: "active" as const,
      activeTransactionId: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await service.execute(operation.id, {
      commandId: "apply-1", expectedRevision: 1, type: "review.apply",
    }, () => ({ status: "completed", document, complete: true }));

    expect(result).toMatchObject({ operation: { status: "completed", revision: 3 }, document });
    expect(db.select().from(documentOperationEvents).all().map((event) => ({
      revision: event.revision,
      type: event.type,
    }))).toEqual([
      { revision: 1, type: "operation.created" },
      { revision: 2, type: "review.apply.applying" },
      { revision: 3, type: "review.apply" },
    ]);
  });

  it("recovers interrupted operations according to their interaction mode", async () => {
    const { service } = await createHarness();
    service.create({
      id: "streaming", capabilityId: "document.create", capabilityVersion: 1,
      interactionMode: "streaming_commit", presenterKey: "streaming-document",
      roomId: "room-1", documentTitle: "Draft", sessionId: "session-1", runId: "run-1",
      status: "running", summary: "Create draft",
    });
    createReviewOperation(service, { id: "applying", status: "applying" });

    expect(service.recoverInterrupted()).toBe(2);
    expect(service.get("streaming")).toMatchObject({ status: "failed", error: { code: "gateway_restarted" } });
    expect(service.get("applying")).toMatchObject({ status: "awaiting_review" });
  });

  it("expires only unfinished input operations whose deadline has passed", async () => {
    const { service } = await createHarness();
    createReviewOperation(service, { id: "expired", status: "awaiting_input", expiresAt: new Date(1) });
    createReviewOperation(service, { id: "future", status: "awaiting_input", expiresAt: new Date(Date.now() + 60_000) });

    expect(service.expire(new Date())).toBe(1);
    expect(service.get("expired")?.status).toBe("expired");
    expect(service.get("future")?.status).toBe("awaiting_input");
  });

  it("deletes owned drafts on cancel, recovery, and expiry while retaining their Operations", async () => {
    const { db, service } = await createHarness();
    const cancelled = await createStreamingDraft(service, {
      operationId: "stream-cancelled",
      documentId: "00000000-0000-4000-8000-000000000101",
      sessionId: "session-cancelled",
    });
    expect(service.cancelActiveForSession("session-cancelled", "run-finished", "run-1")).toBe(1);
    expect(db.select().from(documents).where(eq(documents.id, cancelled.input.draftDocumentId as string)).get())
      .toBeUndefined();
    expect(service.get(cancelled.id)).toMatchObject({
      id: cancelled.id,
      status: "cancelled",
      result: { reason: "run-finished" },
    });

    const expired = await createStreamingDraft(service, {
      operationId: "stream-expired",
      documentId: "00000000-0000-4000-8000-000000000102",
      sessionId: "session-expired",
      expiresAt: new Date(1),
    });
    expect(service.expire(new Date())).toBe(1);
    expect(db.select().from(documents).where(eq(documents.id, expired.input.draftDocumentId as string)).get())
      .toBeUndefined();
    expect(service.get(expired.id)).toMatchObject({ id: expired.id, status: "expired" });

    const recovered = await createStreamingDraft(service, {
      operationId: "stream-recovered",
      documentId: "00000000-0000-4000-8000-000000000103",
      sessionId: "session-recovered",
    });
    expect(service.recoverInterrupted()).toBe(1);
    expect(db.select().from(documents).where(eq(documents.id, recovered.input.draftDocumentId as string)).get())
      .toBeUndefined();
    expect(service.get(recovered.id)).toMatchObject({
      id: recovered.id,
      status: "failed",
      error: { code: "gateway_restarted" },
    });
    expect(db.select().from(documentVersions).all()).toEqual([]);
  });

  it("rolls an appended draft and its Operation command back together", async () => {
    const { db, service } = await createHarness();
    const operation = await createStreamingDraft(service, {
      operationId: "stream-append-rollback",
      documentId: "00000000-0000-4000-8000-000000000104",
    });
    const draftDocumentId = operation.input.draftDocumentId as string;

    await expect(service.execute(operation.id, {
      commandId: "stream-append-rollback:append:1",
      expectedRevision: operation.revision,
      type: "stream.append",
    }, () => ({
      status: "running",
      input: { ...operation.input, nextSequence: 2, totalBytes: 7 },
      draftUpdate: {
        documentId: draftDocumentId,
        roomId: "room-1",
        title: "Streaming draft",
        content: {
          type: "doc",
          content: [{
            type: "paragraph",
            attrs: { id: "00000000-0000-4000-8000-000000000105" },
            content: [{ type: "text", text: "changed" }],
          }],
        },
      },
      addItems: [
        { id: "duplicate-stream-item-a", sequence: 1, operation: "stream_chunk", contentHash: "a" },
        { id: "duplicate-stream-item-b", sequence: 1, operation: "stream_chunk", contentHash: "b" },
      ],
    }))).rejects.toThrow();

    expect(db.select().from(documents).where(eq(documents.id, draftDocumentId)).get()).toMatchObject({
      status: "draft",
      version: 0,
      contentJson: { type: "doc", content: [] },
    });
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, draftDocumentId)).all())
      .toEqual([]);
    expect(db.select().from(documentOperationItems).where(eq(documentOperationItems.operationId, operation.id)).all())
      .toEqual([]);
    expect(db.select().from(documentOperationCommands)
      .where(eq(documentOperationCommands.id, "stream-append-rollback:append:1")).get()).toBeUndefined();
    expect(db.select().from(documentOperationEvents).where(eq(documentOperationEvents.operationId, operation.id)).all())
      .toHaveLength(2);
    expect(service.get(operation.id)).toMatchObject({ revision: 2, status: "running" });
  });

  it("never lets a missing draft cleanup target another document", async () => {
    const { db, service } = await createHarness();
    const operation = service.create({
      id: "stream-missing-draft",
      capabilityId: "document.create",
      capabilityVersion: 1,
      interactionMode: "streaming_commit",
      presenterKey: "streaming-document",
      roomId: "room-1",
      documentId: null,
      documentTitle: "Missing draft",
      sessionId: "session-1",
      runId: "run-1",
      status: "running",
      summary: "Missing draft",
      input: { draftDocumentId: "00000000-0000-4000-8000-000000000106" },
    });
    const now = new Date();
    db.insert(documents).values({
      id: "00000000-0000-4000-8000-000000000107",
      title: "Keep me",
      contentJson: { type: "doc", content: [] },
      contentSchemaVersion: 3,
      version: 1,
      status: "active",
      createdAt: now,
      updatedAt: now,
    }).run();

    await expect(service.execute(operation.id, {
      commandId: "delete-wrong-document",
      expectedRevision: operation.revision,
      type: "operation.cancel",
    }, () => ({
      status: "cancelled",
      complete: true,
      draftDeleteDocumentId: "00000000-0000-4000-8000-000000000107",
    }))).rejects.toMatchObject({ code: "OPERATION_DOCUMENT_MISMATCH", statusCode: 409 });
    expect(db.select().from(documents).where(eq(
      documents.id,
      "00000000-0000-4000-8000-000000000107",
    )).get()).toMatchObject({ title: "Keep me", status: "active", version: 1 });
  });

  it("conflicts stale peer proposals after the document version advances", async () => {
    const { db, service } = await createHarness();
    const now = new Date();
    db.insert(documents).values({
      id: "doc-1", title: "Target", contentJson: { type: "doc", content: [] },
      version: 1, status: "active", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: "doc-1", linkedAt: now }).run();
    createReviewOperation(service, { id: "winner", documentId: "doc-1", status: "awaiting_review" });
    createReviewOperation(service, { id: "stale", documentId: "doc-1", status: "awaiting_review" });
    createReviewOperation(service, { id: "stale-running", documentId: "doc-1", status: "running" });

    service.conflictOtherActive("doc-1", 2, "winner");

    expect(service.get("winner")?.status).toBe("awaiting_review");
    expect(service.get("stale")).toMatchObject({ status: "conflicted", conflictVersion: 2 });
    expect(service.get("stale-running")).toMatchObject({ status: "conflicted", conflictVersion: 2 });
    expect(service.list({ active: true }).map((item) => item.id)).toEqual(["winner"]);
    expect(service.list({ sessionId: "session-1" }).map((item) => item.id).sort()).toEqual([
      "stale", "stale-running", "winner",
    ]);
    expect(service.list({ sessionId: "another-session" })).toEqual([]);
  });

  it("propagates manual saves and history restores to pending Operations", async () => {
    const { db, broker, service } = await createHarness();
    const documentsService = new DocumentService(
      db,
      broker,
      undefined,
      undefined,
      (documentId, currentVersion) => service.prepareExternalVersionAdvance(documentId, currentVersion),
    );
    const document = await documentsService.import({
      id: "doc-manual-conflict",
      roomId: "room-1",
      title: "Manual conflict",
      contentJson: { type: "doc", content: [{ type: "paragraph" }] },
    });
    createReviewOperation(service, {
      id: "pending-before-save",
      documentId: document.id,
      status: "awaiting_review",
    });

    const saved = await documentsService.save(document.id, {
      baseVersion: 1,
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "saved" }] }] },
    });
    expect(service.get("pending-before-save")).toMatchObject({ status: "conflicted", conflictVersion: 2 });

    const afterSave = createReviewOperation(service, {
      id: "pending-before-restore",
      documentId: document.id,
      baseVersion: saved.version,
      status: "awaiting_review",
    });
    expect(afterSave.baseVersion).toBe(2);
    await documentsService.restoreVersion(document.id, 1, saved.version);
    expect(service.get("pending-before-restore")).toMatchObject({ status: "conflicted", conflictVersion: 3 });
  });

  it("rejects illegal state transitions", () => {
    expect(() => assertDocumentOperationTransition("completed", "running")).toThrowError(
      expect.objectContaining({ code: "INVALID_OPERATION_TRANSITION" }),
    );
    expect(() => assertDocumentOperationTransition("awaiting_review", "completed")).toThrowError(
      expect.objectContaining({ code: "INVALID_OPERATION_TRANSITION" }),
    );
  });

  it.each([
    ["document.edit", "atomic_review", "atomic-diff"],
    ["document.continue", "incremental_review", "continuation"],
    ["document.selection-rewrite", "preview_replace", "selection-rewrite"],
  ] as const)("commits %s document and operation state atomically and deduplicates callbacks", async (
    capabilityId,
    interactionMode,
    presenterKey,
  ) => {
    const { db, service } = await createHarness();
    const now = new Date();
    const original = {
      type: "doc" as const,
      content: [{
        type: "paragraph",
        attrs: { id: "original-block" },
        content: [{ type: "text", text: "before" }],
      }],
    };
    db.insert(documents).values({
      id: "doc-atomic", title: "Atomic", contentJson: original,
      contentSchemaVersion: 1, version: 1, status: "active", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: "doc-atomic", linkedAt: now }).run();
    db.insert(documentVersions).values({
      id: "version-1", documentId: "doc-atomic", version: 1, title: "Atomic",
      contentJson: original, contentSchemaVersion: 1, createdAt: now,
    }).run();
    const operation = service.create({
      capabilityId, capabilityVersion: 1, interactionMode, presenterKey,
      roomId: "room-1", documentId: "doc-atomic", documentTitle: "Atomic",
      sessionId: "session-1", runId: "run-1", baseVersion: 1,
      status: "running", summary: "Atomic mutation",
    });
    const prepared = await service.execute(operation.id, {
      commandId: `${capabilityId}:prepare`, expectedRevision: 1, type: "operation.prepare",
    }, () => ({
      status: "awaiting_review",
      addItems: [{ id: `${capabilityId}:item`, sequence: 1, operation: "replace",
        contentHash: capabilityId }],
    }));
    service.create({
      id: `${capabilityId}:peer`, capabilityId: "document.edit", capabilityVersion: 1,
      interactionMode: "atomic_review", presenterKey: "atomic-diff", roomId: "room-1",
      documentId: "doc-atomic", documentTitle: "Atomic", sessionId: "session-2", runId: "run-2",
      baseVersion: 1, status: "awaiting_review", summary: "Stale peer",
    });
    let afterCommits = 0;
    const command = {
      commandId: `${capabilityId}:apply`,
      expectedRevision: prepared.operation.revision,
      type: interactionMode === "incremental_review" ? "item.accept" : "review.apply",
    };
    const content = {
      type: "doc" as const,
      content: [{
        type: "paragraph",
        attrs: { id: "00000000-0000-4000-8000-000000000002" },
        content: [{ type: "text", text: capabilityId }],
      }],
    };
    const apply = () => service.execute(operation.id, command, () => ({
      status: "completed",
      baseVersion: 2,
      result: { version: 2 },
      updateItems: [{ id: `${capabilityId}:item`, status: "applied", appliedVersion: 2 }],
      commit: {
        documentId: "doc-atomic", roomId: "room-1", title: "Atomic",
        content, expectedVersion: 1, version: 2,
      },
      complete: true,
      afterCommit: (document) => {
        expect(document?.version).toBe(2);
        afterCommits += 1;
      },
    }));

    const applied = await apply();
    const duplicate = await apply();

    expect(applied).toMatchObject({ duplicate: false, document: { version: 2, contentJson: content } });
    expect(duplicate).toMatchObject({ duplicate: true, document: { version: 2 } });
    expect(afterCommits).toBe(1);
    expect(service.get(operation.id)).toMatchObject({
      status: "completed", revision: 4, baseVersion: 2,
      items: [expect.objectContaining({ status: "applied", appliedVersion: 2 })],
    });
    expect(service.get(`${capabilityId}:peer`)).toMatchObject({ status: "conflicted", conflictVersion: 2 });
    expect(db.select().from(documentVersions).all()).toHaveLength(2);
    expect(db.select().from(documentBlocks).where(eq(documentBlocks.documentId, "doc-atomic")).get())
      .toMatchObject({ blockId: "00000000-0000-4000-8000-000000000002", indexedVersion: 2 });
  });

  it("rolls back document, projection, command, and operation when the atomic mutation fails", async () => {
    const { db, service } = await createHarness();
    const now = new Date();
    const original = { type: "doc" as const, content: [{
      type: "paragraph", attrs: { id: "before-block" }, content: [{ type: "text", text: "before" }],
    }] };
    db.insert(documents).values({
      id: "doc-rollback", title: "Rollback", contentJson: original,
      contentSchemaVersion: 1, version: 1, status: "active", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: "doc-rollback", linkedAt: now }).run();
    db.insert(documentVersions).values({
      id: "rollback-version-1", documentId: "doc-rollback", version: 1, title: "Rollback",
      contentJson: original, contentSchemaVersion: 1, createdAt: now,
    }).run();
    const operation = createReviewOperation(service, { documentId: "doc-rollback", status: "running" });
    const prepared = await service.execute(operation.id, {
      commandId: "rollback-prepare", expectedRevision: 1, type: "operation.prepare",
    }, () => ({ status: "awaiting_review", addItems: [{
      id: "existing-item", sequence: 1, operation: "replace", contentHash: "existing",
    }] }));
    let afterCommits = 0;

    await expect(service.execute(operation.id, {
      commandId: "rollback-apply", expectedRevision: prepared.operation.revision, type: "review.apply",
    }, () => ({
      status: "completed",
      commit: {
        documentId: "doc-rollback", roomId: "room-1", title: "Rollback",
        content: { type: "doc", content: [{ type: "paragraph", attrs: { id: "after-block" } }] },
        expectedVersion: 1, version: 2,
      },
      addItems: [{ id: "duplicate-sequence", sequence: 1, operation: "replace", contentHash: "duplicate" }],
      complete: true,
      afterCommit: () => { afterCommits += 1; },
    }))).rejects.toThrow();

    expect(db.select().from(documents).where(eq(documents.id, "doc-rollback")).get())
      .toMatchObject({ version: 1, contentJson: original });
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, "doc-rollback")).all())
      .toHaveLength(1);
    expect(db.select().from(documentBlocks).where(eq(documentBlocks.documentId, "doc-rollback")).all())
      .toEqual([]);
    expect(db.select().from(documentOperationCommands)
      .where(eq(documentOperationCommands.id, "rollback-apply")).get()).toBeUndefined();
    expect(db.select().from(documentOperationItems).where(eq(documentOperationItems.operationId, operation.id)).all())
      .toHaveLength(1);
    expect(service.get(operation.id)).toMatchObject({ status: "awaiting_review", revision: 2 });
    expect(db.select().from(documentOperationEvents).where(eq(documentOperationEvents.operationId, operation.id)).all())
      .toHaveLength(2);
    expect(afterCommits).toBe(0);
  });

  it("does not retry a committed command when its afterCommit hook throws", async () => {
    const { db, service } = await createHarness();
    const now = new Date();
    db.insert(documents).values({
      id: "doc-hook", title: "Hook", contentJson: { type: "doc", content: [] },
      contentSchemaVersion: 1, version: 1, status: "active", createdAt: now, updatedAt: now,
    }).run();
    db.insert(roomDocumentLinks).values({ roomId: "room-1", documentId: "doc-hook", linkedAt: now }).run();
    db.insert(documentVersions).values({
      id: "hook-version-1", documentId: "doc-hook", version: 1, title: "Hook",
      contentJson: { type: "doc", content: [] }, contentSchemaVersion: 1, createdAt: now,
    }).run();
    const operation = createReviewOperation(service, { documentId: "doc-hook", status: "awaiting_review" });
    let callbacks = 0;
    const command = { commandId: "hook-apply", expectedRevision: 1, type: "review.apply" };
    const handler = () => ({
      status: "completed" as const,
      commit: {
        documentId: "doc-hook", roomId: "room-1", title: "Hook",
        content: { type: "doc", content: [{ type: "paragraph" }] },
        expectedVersion: 1, version: 2,
      },
      complete: true,
      afterCommit: () => {
        callbacks += 1;
        throw new Error("memory unavailable");
      },
    });

    await expect(service.execute(operation.id, command, handler)).resolves.toMatchObject({
      duplicate: false, document: { version: 2 }, operation: { status: "completed" },
    });
    await expect(service.execute(operation.id, command, handler)).resolves.toMatchObject({ duplicate: true });
    expect(callbacks).toBe(1);
    expect(db.select().from(documentVersions).where(eq(documentVersions.documentId, "doc-hook")).all())
      .toHaveLength(2);
  });

  it("creates a document and completes its Operation in one idempotent transaction", async () => {
    const { db, service } = await createHarness();
    const operation = service.create({
      capabilityId: "document.create", capabilityVersion: 1,
      interactionMode: "streaming_commit", presenterKey: "streaming-document",
      roomId: "room-1", documentId: null, documentTitle: "Created Atomically",
      sessionId: "session-1", runId: "run-1", status: "running", summary: "Create",
      input: { draftDocumentId: "00000000-0000-4000-8000-000000000010" },
    });
    let memoryHooks = 0;
    const command = { commandId: "create-commit", expectedRevision: 1, type: "stream.commit" };
    const handler = () => ({
      status: "completed" as const,
      result: { finalSequence: 0 },
      create: {
        documentId: "00000000-0000-4000-8000-000000000010",
        roomId: "room-1",
        title: "Created Atomically",
        content: { type: "doc", content: [{
          type: "paragraph",
          attrs: { id: "00000000-0000-4000-8000-000000000011" },
          content: [{ type: "text", text: "created" }],
        }] },
      },
      complete: true,
      afterCommit: (document?: { version: number }) => {
        expect(document?.version).toBe(1);
        memoryHooks += 1;
      },
    });

    const created = await service.execute(operation.id, command, handler);
    const duplicate = await service.execute(operation.id, command, handler);

    expect(created).toMatchObject({
      duplicate: false,
      document: { id: "00000000-0000-4000-8000-000000000010", version: 1 },
      operation: {
        status: "completed",
        documentId: "00000000-0000-4000-8000-000000000010",
        documentTitle: "Created Atomically",
        baseVersion: 1,
      },
    });
    expect(duplicate).toMatchObject({ duplicate: true, document: { version: 1 } });
    expect(memoryHooks).toBe(1);
    expect(db.select().from(documents).all()).toHaveLength(1);
    expect(db.select().from(roomDocumentLinks).all()).toHaveLength(1);
    expect(db.select().from(documentVersions).all()).toHaveLength(1);
    expect(db.select().from(documentBlocks).all()).toEqual([
      expect.objectContaining({ blockId: "00000000-0000-4000-8000-000000000011", indexedVersion: 1 }),
    ]);
  });

  it("rejects mismatched create intents and rolls document creation back with the command", async () => {
    const { db, service } = await createHarness();
    const operation = service.create({
      capabilityId: "document.create", capabilityVersion: 1,
      interactionMode: "streaming_commit", presenterKey: "streaming-document",
      roomId: "room-1", documentId: null, documentTitle: "Draft",
      sessionId: "session-1", runId: "run-1", status: "running", summary: "Create",
      input: { draftDocumentId: "00000000-0000-4000-8000-000000000020" },
    });
    await expect(service.execute(operation.id, {
      commandId: "create-mismatch", expectedRevision: 1, type: "stream.commit",
    }, () => ({
      status: "completed",
      create: {
        documentId: "00000000-0000-4000-8000-000000000099",
        roomId: "room-1", title: "Draft", content: { type: "doc", content: [] },
      },
      complete: true,
    }))).rejects.toMatchObject({ code: "OPERATION_DOCUMENT_MISMATCH", statusCode: 409 });
    expect(db.select().from(documents).all()).toEqual([]);
    expect(db.select().from(documentOperationCommands).all()).toEqual([]);

    await expect(service.execute(operation.id, {
      commandId: "create-rollback", expectedRevision: 1, type: "stream.commit",
    }, () => ({
      status: "completed",
      create: {
        documentId: "00000000-0000-4000-8000-000000000020",
        roomId: "room-1", title: "Draft", content: { type: "doc", content: [] },
      },
      addItems: [
        { id: "create-item-a", sequence: 1, operation: "stream_chunk", contentHash: "a" },
        { id: "create-item-b", sequence: 1, operation: "stream_chunk", contentHash: "b" },
      ],
      complete: true,
    }))).rejects.toThrow();

    expect(db.select().from(documents).all()).toEqual([]);
    expect(db.select().from(roomDocumentLinks).all()).toEqual([]);
    expect(db.select().from(documentVersions).all()).toEqual([]);
    expect(db.select().from(documentBlocks).all()).toEqual([]);
    expect(db.select().from(documentOperationCommands).all()).toEqual([]);
    expect(service.get(operation.id)).toMatchObject({ status: "running", revision: 1, documentId: null });
  });
});
