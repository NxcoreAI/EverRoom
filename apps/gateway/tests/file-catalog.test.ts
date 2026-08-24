import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/infrastructure/database/client.js";
import { connectorCalendarEvents, connectorDocuments, connectorEmails } from "../src/infrastructure/database/schema.js";
import type { GatewayConfig } from "../src/config.js";
import { FilesService } from "../src/modules/files/service.js";
import { filesRoutes } from "../src/modules/files/routes.js";
import { FileClusteringService } from "../src/modules/files/clustering-service.js";
import { ConnectorSyncService } from "../src/modules/connectors/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  ));
});

async function catalogForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "nxcore-file-catalog-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const service = new FilesService(database.db, dataDir);
  service.initializeCatalog();
  return { ...database, service, dataDir };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("condition not reached");
}

describe("unified file catalog", () => {
  it("keeps two source identities while sharing one blob", async () => {
    const test = await catalogForTest();
    const buffer = Buffer.from("# shared", "utf8");
    const first = await test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:1", originalName: "shared.md", buffer,
    });
    const second = await test.service.importFile({
      sourceKind: "local-folder", sourceKey: "local:source:item", originalName: "shared.md", buffer,
    });

    expect(first.fileEntryId).not.toBe(second.fileEntryId);
    expect(second.blobDeduped).toBe(true);
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_entries").get()).toMatchObject({ count: 2 });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_blobs").get()).toMatchObject({ count: 1 });
    test.sqlite.close();
  });

  it("is idempotent per source and creates immutable versions on content change", async () => {
    const test = await catalogForTest();
    const input = { sourceKind: "local-folder" as const, sourceKey: "local:s:i", originalName: "draft.md" };
    const v1 = await test.service.importFile({ ...input, buffer: Buffer.from("v1") });
    const retry = await test.service.importFile({ ...input, buffer: Buffer.from("v1") });
    const v2 = await test.service.importFile({ ...input, buffer: Buffer.from("v2") });

    expect(retry).toMatchObject({ fileEntryId: v1.fileEntryId, fileVersionId: v1.fileVersionId, versionDeduped: true });
    expect(v2.fileEntryId).toBe(v1.fileEntryId);
    expect(v2.fileVersionId).not.toBe(v1.fileVersionId);
    expect(await readFile(test.service.getVersionContext(v1.fileEntryId, v1.fileVersionId)!.storagePath, "utf8")).toBe("v1");
    expect(await readFile(test.service.getVersionContext(v2.fileEntryId, v2.fileVersionId)!.storagePath, "utf8")).toBe("v2");
    expect(test.sqlite.prepare("SELECT version_no FROM file_versions ORDER BY version_no").all())
      .toEqual([{ version_no: 1 }, { version_no: 2 }]);
    test.sqlite.close();
  });

  it("recovers a running file job and disposes only after its worker settles", async () => {
    const test = await catalogForTest();
    const imported = await test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:recover", originalName: "recover.md", buffer: Buffer.from("body"),
    });
    test.sqlite.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(imported.jobId);
    test.service.initializeCatalog();
    let release!: () => void;
    const blocked = new Promise<void>((resolveBlocked) => { release = resolveBlocked; });
    const parsedId = test.service.ensureParsed(imported.contentHash, "body", "markdown@1");
    const ingestor = vi.fn(async () => {
      await blocked;
      return { eventId: "event-1", parsedId, dataType: "document" };
    });
    test.service.setVersionIngestor(ingestor);
    await waitFor(() => ingestor.mock.calls.length === 1);
    const disposing = test.service.dispose();
    let disposed = false;
    void disposing.then(() => { disposed = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(disposed).toBe(false);
    release();
    await disposing;
    expect(test.sqlite.prepare("SELECT status FROM jobs WHERE id = ?").get(imported.jobId)).toMatchObject({ status: "completed" });
    test.sqlite.close();
  });

  it("exposes one capability registry and filters unsupported formats", async () => {
    const test = await catalogForTest();
    const extensions = test.service.capabilities().map((item) => item.extension);
    expect(extensions).toContain(".docx");
    expect(extensions).toContain(".doc");
    expect(extensions).toContain(".docm");
    expect(extensions).toContain(".xls");
    expect(extensions).toContain(".xlsm");
    expect(extensions).toContain(".ppt");
    expect(extensions).toContain(".pptm");
    expect(extensions).toContain(".pdf");
    expect(extensions).not.toContain(".json");
    await expect(test.service.importFile({
      sourceKind: "local-folder", sourceKey: "local:json", originalName: "ignored.json", buffer: Buffer.from("{}"),
    })).rejects.toThrow("JSON 文件不会进入文件库");
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_entries").get()).toMatchObject({ count: 0 });
    test.sqlite.close();
  });

  it("accepts the streaming multipart import contract", async () => {
    const test = await catalogForTest();
    const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await app.register(filesRoutes(test.service));
    const form = new FormData();
    form.append("metadata", JSON.stringify({
      sourceKind: "manual-upload", sourceKey: "manual:multipart", originalName: "stream.md",
    }));
    form.append("file", new Blob(["# streamed"]), "stream.md");
    const response = await app.inject({ method: "POST", url: "/v1/file-imports", payload: form });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ versionDeduped: false });
    expect(test.service.listCatalog()).toMatchObject({ total: 1 });
    await app.close();
    await test.service.dispose();
    test.sqlite.close();
  });

  it("clusters exact content deterministically and lets users pin the shared title", async () => {
    const test = await catalogForTest();
    const clustering = new FileClusteringService(test.db, null, null, null);
    test.service.setVersionClassifier((entryId, versionId) => clustering.enqueue(entryId, versionId));
    clustering.initialize();
    const buffer = Buffer.from("# Launch plan\n\nMilestones", "utf8");
    const first = await test.service.importFile({
      sourceKind: "manual-upload", sourceKey: "manual:cluster-a", originalName: "plan.md", buffer,
    });
    const parsedId = test.service.ensureParsed(first.contentHash, buffer.toString("utf8"), "markdown@1");
    test.service.touchVersionParsed(first.fileEntryId, first.fileVersionId, parsedId, "event-a");
    await waitFor(() => Boolean(test.service.listCatalog().items[0]?.clusterId));

    const second = await test.service.importFile({
      sourceKind: "local-folder", sourceKey: "local:cluster-b", originalName: "copy.md", buffer,
    });
    test.service.touchVersionParsed(second.fileEntryId, second.fileVersionId, parsedId, "event-b");
    await waitFor(() => test.service.listCatalog().items.every((item) => Boolean(item.clusterId)));
    const catalog = test.service.listCatalog().items;
    expect(new Set(catalog.map((item) => item.clusterId)).size).toBe(1);
    const clusterId = catalog[0]!.clusterId!;
    expect(clustering.pinTitle(clusterId, "2026 Launch Plan")).toMatchObject({
      canonicalTitle: "2026 Launch Plan", titlePinned: true, titleSource: "user",
    });
    expect(test.service.listCatalog().items.every((item) => item.sharedTitle === "2026 Launch Plan")).toBe(true);
    await clustering.dispose();
    await test.service.dispose();
    test.sqlite.close();
  });

  it("backfills connector documents without admitting mail or calendar records", async () => {
    const test = await catalogForTest();
    const now = new Date();
    test.db.insert(connectorDocuments).values({
      id: "connector-doc-1",
      ownerId: "local-user",
      service: "notion",
      connectionName: "workspace-1",
      sourceRecordId: "page-1",
      sourceUpdatedAt: now,
      syncedAt: now,
      schemaVersion: 1,
      promptVersion: 1,
      contentHash: "connector-hash",
      extensionPayload: {},
      documentId: "page-1",
      title: "Product brief",
      documentType: "notion-page",
      bodyText: "# Product brief\n\nScope",
      sourceUrl: "https://notion.example/page-1",
    }).run();
    const common = {
      ownerId: "local-user", service: "gmail", connectionName: "mail-1",
      sourceUpdatedAt: now, syncedAt: now, schemaVersion: 1, promptVersion: 1,
      contentHash: "record-hash", extensionPayload: {},
    };
    test.db.insert(connectorEmails).values({
      ...common, id: "connector-mail-1", sourceRecordId: "message-1", messageId: "message-1",
      recipients: [], subject: "Do not import me", bodyText: "mail body", labels: [], hasAttachments: false,
    }).run();
    test.db.insert(connectorCalendarEvents).values({
      ...common, id: "connector-calendar-1", service: "google_calendar", sourceRecordId: "event-1",
      eventId: "event-1", title: "Do not import me", description: "calendar body", attendees: [], allDay: false,
    }).run();
    const connector = new ConnectorSyncService(
      test.db,
      {} as GatewayConfig,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );
    connector.setFilesService(test.service);
    await waitFor(() => test.service.listCatalog().total === 1);
    expect(test.service.listCatalog().items[0]).toMatchObject({
      sourceKind: "connector",
      provider: "notion",
      originalName: "Product brief.md",
    });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_entries WHERE source_kind != 'connector'").get())
      .toMatchObject({ count: 0 });
    await connector.dispose();
    await test.service.dispose();
    test.sqlite.close();
  });
});
