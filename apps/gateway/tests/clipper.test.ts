import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { ClipperService } from "../src/modules/clipper/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function serviceForTest() {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-clipper-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const files = new FilesService(database.db, dataDir);
  files.initializeCatalog();
  return { ...database, files, service: new ClipperService(database.db, files, dataDir) };
}

function captureInput(captureId: string) {
  const assetId = `asset-${captureId}-1`;
  return {
    captureId,
    sourceUrl: "https://example.com/article?utm_source=test",
    canonicalUrl: "https://example.com/article",
    title: "Example article",
    author: "Example Author",
    publishedAt: "2026-08-20T08:00:00.000Z",
    capturedAt: "2026-08-24T08:00:00.000Z",
    extractionMode: "article" as const,
    markdown: "# Example\n\n![diagram](nxcore-clipper-asset://local/ref-example-diagram)",
    assets: [{ id: assetId, referenceKey: "ref-example-diagram", originalUrl: "https://example.com/diagram.png", altText: "diagram" }],
  };
}

describe("web clipper", () => {
  it("creates an idempotent capture and versions one logical file per canonical URL", async () => {
    const test = await serviceForTest();
    const first = await test.service.createCapture(captureInput("capture-example-0001"));
    const retry = await test.service.createCapture(captureInput("capture-example-0001"));
    const repeated = await test.service.createCapture(captureInput("capture-example-0002"));

    expect(first.capture.status).toBe("assets_pending");
    expect(first.pendingAssetIds).toEqual(["asset-capture-example-0001-1"]);
    expect(retry.fileEntryId).toBe(first.fileEntryId);
    expect(retry.fileVersionId).toBe(first.fileVersionId);
    expect(repeated.fileEntryId).toBe(first.fileEntryId);
    expect(repeated.fileVersionId).toBe(first.fileVersionId);
    expect(repeated.versionDeduped).toBe(true);
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM clipper_captures").get()).toMatchObject({ count: 2 });
    test.sqlite.close();
  });

  it("lists captures from the local clipper registry", async () => {
    const test = await serviceForTest();
    await test.service.createCapture(captureInput("capture-example-list-1"));
    await test.service.createCapture({ ...captureInput("capture-example-list-2"), title: "Second article", capturedAt: "2026-08-23T08:00:00.000Z" });

    expect(test.service.listCaptures(1, 0)).toMatchObject({
      total: 2,
      items: [{ title: "Example article", fileEntryId: expect.any(String) }],
    });
    test.sqlite.close();
  });

  it("stores verified image bytes in the shared CAS and finalizes partial failures", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-0003");
    input.assets.push({ id: "asset-example-0002", referenceKey: "ref-example-missing", originalUrl: "https://example.com/missing.png", altText: "missing" });
    await test.service.createCapture(input);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    const stored = await test.service.storeAsset(input.captureId, input.assets[0]!.id, png);
    const finalized = test.service.finalizeCapture(input.captureId, [{ assetId: input.assets[1]!.id, code: "asset_fetch_failed" }]);

    expect(stored).toMatchObject({ mime: "image/png", status: "stored", byteSize: png.byteLength });
    expect(finalized).toMatchObject({ status: "ready_with_missing_assets", storedAssetCount: 1, failedAssetCount: 1 });
    expect(test.service.retryCapture(input.captureId)).toMatchObject({
      capture: { status: "assets_pending", failedAssetCount: 0 },
      pendingAssetIds: [input.assets[1]!.id],
    });
    await expect(test.service.assetContent(input.assets[0]!.referenceKey)).resolves.toMatchObject({ mime: "image/png", buffer: png });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_blobs").get()).toMatchObject({ count: 2 });
    test.sqlite.close();
  });

  it("rejects unrecognized image payloads before writing the object store", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-0004");
    await test.service.createCapture(input);

    await expect(test.service.storeAsset(input.captureId, input.assets[0]!.id, Buffer.from("not an image")))
      .rejects.toThrow("clipper_asset_type_invalid");
    expect(test.service.detail(input.captureId)?.storedAssetCount).toBe(0);
    test.sqlite.close();
  });

  it("collects child asset blobs when the Clipper file is deleted", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-0005");
    const created = await test.service.createCapture(input);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await test.service.storeAsset(input.captureId, input.assets[0]!.id, png);
    test.service.finalizeCapture(input.captureId, []);

    await expect(test.files.deleteCatalogEntry(created.fileEntryId)).resolves.toMatchObject({ deletedMemoryDocuments: [] });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM clipper_captures").get()).toMatchObject({ count: 0 });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_blobs").get()).toMatchObject({ count: 0 });
    test.sqlite.close();
  });
});
