import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "../src/infrastructure/database/client.js";
import { FilesService } from "../src/modules/files/service.js";
import { clipperRoutes } from "../src/modules/clipper/routes.js";
import { ClipperService, MAX_CLIPPER_ASSETS } from "../src/modules/clipper/service.js";
import type { CreateClipperCaptureInput } from "../src/modules/clipper/service.js";
import type { ClipImageAnalysisClient } from "../src/modules/perception/vlm-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

async function serviceForTest(visualProvider: ClipImageAnalysisClient | null = null) {
  const dataDir = await mkdtemp(join(tmpdir(), "everroom-clipper-"));
  temporaryDirectories.push(dataDir);
  const database = createDatabase(join(dataDir, "gateway.sqlite"), resolve("drizzle"));
  const files = new FilesService(database.db, dataDir);
  files.initializeCatalog();
  const service = new ClipperService(database.db, files, dataDir, visualProvider);
  return {
    ...database,
    files,
    service,
    close: async () => {
      await service.dispose();
      await files.dispose();
      database.sqlite.close();
    },
  };
}

function captureInput(captureId: string): CreateClipperCaptureInput {
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
  it("accepts captures with more than twenty assets up to the shared limit", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-many-assets-1");
    input.assets = Array.from({ length: 21 }, (_, index) => ({
      id: `asset-many-images-${String(index + 1).padStart(3, "0")}`,
      referenceKey: `ref-many-images-${String(index + 1).padStart(3, "0")}`,
      originalUrl: `https://example.com/image-${index + 1}.png`,
      altText: `image ${index + 1}`,
    }));

    const app = Fastify({ logger: false });
    await app.register(clipperRoutes(test.service));
    const response = await app.inject({ method: "POST", url: "/v1/clipper/captures", payload: input });
    const created = response.json();

    expect(MAX_CLIPPER_ASSETS).toBe(100);
    expect(response.statusCode).toBe(202);
    expect(created.capture).toMatchObject({ assetCount: 21, status: "assets_pending" });
    expect(created.pendingAssetIds).toHaveLength(21);
    await app.close();
    await test.close();
  });

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
    await test.close();
  });

  it("lists captures from the local clipper registry", async () => {
    const test = await serviceForTest();
    await test.service.createCapture(captureInput("capture-example-list-1"));
    await test.service.createCapture({ ...captureInput("capture-example-list-2"), title: "Second article", capturedAt: "2026-08-23T08:00:00.000Z" });

    expect(test.service.listCaptures(1, 0)).toMatchObject({
      total: 2,
      items: [{ title: "Example article", fileEntryId: expect.any(String) }],
    });
    await test.close();
  });

  it("stores verified image bytes in the shared CAS and finalizes partial failures", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-0003");
    input.assets.push({ id: "asset-example-0002", referenceKey: "ref-example-missing", originalUrl: "https://example.com/missing.png", altText: "missing" });
    await test.service.createCapture(input);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

    const stored = await test.service.storeAsset(input.captureId, input.assets[0]!.id, png);
    const finalized = await test.service.finalizeCapture(input.captureId, [{ assetId: input.assets[1]!.id, code: "asset_fetch_failed" }]);

    expect(stored).toMatchObject({ mime: "image/png", status: "stored", byteSize: png.byteLength });
    expect(finalized).toMatchObject({ status: "ready_with_missing_assets", storedAssetCount: 1, failedAssetCount: 1 });
    expect(test.service.retryCapture(input.captureId)).toMatchObject({
      capture: { status: "assets_pending", failedAssetCount: 0 },
      pendingAssetIds: [input.assets[1]!.id],
    });
    await expect(test.service.assetContent(input.assets[0]!.referenceKey)).resolves.toMatchObject({ mime: "image/png", buffer: png });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_blobs").get()).toMatchObject({ count: 2 });
    await test.close();
  });

  it("finalizes asset uploads left pending across an app restart", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-interrupted-1");
    await test.service.createCapture(input);

    await test.service.initialize();

    expect(test.service.detail(input.captureId)).toMatchObject({
      status: "ready_with_missing_assets",
      storedAssetCount: 0,
      failedAssetCount: 1,
      assets: [{ status: "failed", errorCode: "asset_upload_interrupted" }],
    });
    expect(test.service.retryCapture(input.captureId)).toMatchObject({
      capture: { status: "assets_pending" },
      pendingAssetIds: [input.assets[0]!.id],
    });
    await test.close();
  });

  it("rejects unrecognized image payloads before writing the object store", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-0004");
    await test.service.createCapture(input);

    await expect(test.service.storeAsset(input.captureId, input.assets[0]!.id, Buffer.from("not an image")))
      .rejects.toThrow("clipper_asset_type_invalid");
    expect(test.service.detail(input.captureId)?.storedAssetCount).toBe(0);
    await test.close();
  });

  it("rasterizes safe SVG assets to PNG and selects a fallback cover without a VLM", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-svg-1");
    input.assets[0] = {
      ...input.assets[0]!,
      originalUrl: "https://example.com/article-illustration.svg",
      width: 640,
      height: 360,
    };
    const svg = Buffer.from(`<?xml version="1.0"?>
      <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
        <defs><clipPath id="round"><rect width="640" height="360" rx="8" /></clipPath></defs>
        <g clip-path="url(#round)"><rect width="640" height="360" fill="#6dd0c5" /></g>
      </svg>`);
    await test.service.createCapture(input);

    const stored = await test.service.storeAsset(input.captureId, input.assets[0]!.id, svg);
    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();
    const content = await test.service.assetContent(input.assets[0]!.referenceKey);

    expect(stored).toMatchObject({
      mime: "image/png",
      status: "stored",
      width: 640,
      height: 360,
    });
    expect(content?.mime).toBe("image/png");
    expect(content?.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(test.service.detail(input.captureId)?.artifact).toMatchObject({
      coverAssetId: input.assets[0]!.id,
      coverUrl: `nxcore-clipper-asset://local/${input.assets[0]!.referenceKey}`,
    });
    await test.files.dispose();
    test.sqlite.close();
  });

  it("rejects active or externally referenced SVG content", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-svg-unsafe-1");
    await test.service.createCapture(input);
    const scripted = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>`);
    const external = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/tracker.png" /></svg>`);

    await expect(test.service.storeAsset(input.captureId, input.assets[0]!.id, scripted))
      .rejects.toThrow("clipper_svg_unsafe");
    await expect(test.service.storeAsset(input.captureId, input.assets[0]!.id, external))
      .rejects.toThrow("clipper_svg_unsafe");
    expect(test.service.detail(input.captureId)?.storedAssetCount).toBe(0);
    await test.close();
  });

  it("does not use a logo or wordmark as the fallback cover", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-svg-logo-1");
    input.assets[0] = {
      ...input.assets[0]!,
      originalUrl: "https://example.com/assets/brand-wordmark.svg",
      altText: "Company logo",
    };
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="48"><rect width="240" height="48" fill="#17323b" /></svg>`);
    await test.service.createCapture(input);
    await test.service.storeAsset(input.captureId, input.assets[0]!.id, svg);
    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();

    expect(test.service.detail(input.captureId)?.artifact?.coverAssetId).toBeNull();
    await test.files.dispose();
    test.sqlite.close();
  });

  it("does not use a tiny UI icon as the fallback cover", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-svg-icon-1");
    input.assets[0] = {
      ...input.assets[0]!,
      originalUrl: "https://example.com/assets/devices/phone.svg",
      altText: "Phone",
    };
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#17323b" /></svg>`);
    await test.service.createCapture(input);
    await test.service.storeAsset(input.captureId, input.assets[0]!.id, svg);
    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();

    expect(test.service.detail(input.captureId)?.artifact?.coverAssetId).toBeNull();
    await test.files.dispose();
    test.sqlite.close();
  });

  it("collects child asset blobs when the Clipper file is deleted", async () => {
    const test = await serviceForTest();
    const input = captureInput("capture-example-0005");
    const created = await test.service.createCapture(input);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await test.service.storeAsset(input.captureId, input.assets[0]!.id, png);
    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();

    await expect(test.files.deleteCatalogEntry(created.fileEntryId)).resolves.toMatchObject({ deletedMemoryDocuments: [] });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM clipper_captures").get()).toMatchObject({ count: 0 });
    expect(test.sqlite.prepare("SELECT COUNT(*) count FROM file_blobs").get()).toMatchObject({ count: 0 });
    await test.files.dispose();
    test.sqlite.close();
  });

  it("deletes the corresponding memory documents with a Clipper file", async () => {
    const test = await serviceForTest();
    const created = await test.service.createCapture({ ...captureInput("capture-example-delete-memory-1"), assets: [] });
    const deletedCallerRefs: string[] = [];

    const result = await test.files.deleteCatalogEntry(created.fileEntryId, {
      deleteMemoryDocuments: async (fileEntryId) => {
        deletedCallerRefs.push(fileEntryId);
        return ["memory-document-1"];
      },
    });

    expect(deletedCallerRefs).toEqual([created.fileEntryId]);
    expect(result?.deletedMemoryDocuments).toEqual(["memory-document-1"]);
    expect(test.service.detail(created.capture.id)).toBeNull();
    await test.close();
  });

  it("keeps a Clipper file when its memory cleanup fails", async () => {
    const test = await serviceForTest();
    const created = await test.service.createCapture({ ...captureInput("capture-example-delete-memory-2"), assets: [] });

    await expect(test.files.deleteCatalogEntry(created.fileEntryId, {
      deleteMemoryDocuments: async () => { throw new Error("memory_unavailable"); },
    })).rejects.toThrow("memory_unavailable");

    expect(test.service.detail(created.capture.id)).not.toBeNull();
    await test.close();
  });

  it("keeps display Markdown faithful and ingests VLM-enriched semantic Markdown through every pipeline", async () => {
    const visual: ClipImageAnalysisClient = {
      model: "test-vlm",
      analyzeClipImage: async () => ({
        kind: "diagram",
        summary: "一张展示采集、解析和记忆关系的架构图。",
        ocrText: "Capture -> Parse -> Memory",
        keyPoints: ["解析结果进入记忆"],
        entities: [{ name: "MemoryCore", kind: "产品", evidence: "图中可见 Memory" }],
        relevance: 0.95,
        quality: 0.9,
        contentRole: "primary",
        noiseReason: "none",
      }),
    };
    const test = await serviceForTest(visual);
    const input = captureInput("capture-example-vlm-1");
    await test.service.createCapture(input);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await test.service.storeAsset(input.captureId, input.assets[0]!.id, png);
    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();

    const detail = test.service.detail(input.captureId);
    expect(detail?.artifact).toMatchObject({
      displayMarkdown: input.markdown,
      coverAssetId: input.assets[0]!.id,
      coverUrl: `nxcore-clipper-asset://local/${input.assets[0]!.referenceKey}`,
    });
    expect(detail?.assets[0]).toMatchObject({
      visualStatus: "ready",
      visualKind: "diagram",
      visualSummary: expect.stringContaining("架构图"),
    });
    const artifact = test.sqlite.prepare("SELECT semantic_markdown semanticMarkdown FROM clipper_artifacts WHERE capture_id = ?")
      .get(input.captureId) as { semanticMarkdown: string };
    expect(artifact.semanticMarkdown).toContain("图片理解：一张展示采集、解析和记忆关系的架构图");
    expect(input.markdown).not.toContain("图片理解：");
    const ingestJob = test.sqlite.prepare("SELECT payload FROM jobs WHERE type = 'file.ingest' ORDER BY created_at DESC LIMIT 1")
      .get() as { payload: string };
    expect(JSON.parse(ingestJob.payload)).toMatchObject({ pipelines: { room: true, wiki: true, memory: true } });
    await test.files.dispose();
    test.sqlite.close();
  });

  it("keeps acquired noise images for audit but removes them from article reading and memory content", async () => {
    const visual: ClipImageAnalysisClient = {
      model: "test-vlm",
      analyzeClipImage: async (_image, context) => context.altText === "Course advertisement"
        ? {
            kind: "illustration",
            summary: "课程促销广告图，包含购买引导。",
            ocrText: "限时优惠",
            keyPoints: ["促销信息"],
            entities: [],
            relevance: 0.05,
            quality: 0.8,
            contentRole: "noise",
            noiseReason: "advertisement",
          }
        : {
            kind: "chart",
            summary: "文章用于比较产品指标的柱状图。",
            ocrText: "To B / To C",
            keyPoints: ["对比产品指标"],
            entities: [],
            relevance: 0.9,
            quality: 0.9,
            contentRole: "primary",
            noiseReason: "none",
          },
    };
    const test = await serviceForTest(visual);
    const input = captureInput("capture-example-noise-filter-1");
    input.assets = [
      { id: "asset-useful-chart-001", referenceKey: "ref-useful-chart-001", originalUrl: "https://example.com/chart.png", altText: "Product chart" },
      { id: "asset-course-ad-001", referenceKey: "ref-course-ad-001", originalUrl: "https://example.com/ad.png", altText: "Course advertisement" },
    ];
    input.markdown = `# Product analysis

<!-- everroom:image-grid:start columns=2 -->
![Product chart](nxcore-clipper-asset://local/ref-useful-chart-001)
![Course advertisement](nxcore-clipper-asset://local/ref-course-ad-001)
<!-- everroom:image-grid:end -->`;
    await test.service.createCapture(input);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await Promise.all(input.assets.map((asset) => test.service.storeAsset(input.captureId, asset.id, png)));
    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();

    const detail = test.service.detail(input.captureId);
    expect(detail?.artifact?.displayMarkdown).toContain("ref-useful-chart-001");
    expect(detail?.artifact?.displayMarkdown).not.toContain("ref-course-ad-001");
    expect(detail?.artifact?.displayMarkdown).not.toContain("everroom:image-grid");
    expect(detail?.artifact?.coverAssetId).toBe("asset-useful-chart-001");
    expect(detail?.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "asset-course-ad-001", status: "stored", visualContentRole: "noise", visualNoiseReason: "advertisement" }),
    ]));
    const artifact = test.sqlite.prepare("SELECT semantic_markdown semanticMarkdown FROM clipper_artifacts WHERE capture_id = ?")
      .get(input.captureId) as { semanticMarkdown: string };
    expect(artifact.semanticMarkdown).toContain("文章用于比较产品指标的柱状图");
    expect(artifact.semanticMarkdown).not.toContain("课程促销广告图");
    expect(artifact.semanticMarkdown).not.toContain("ref-course-ad-001");
    await test.files.dispose();
    test.sqlite.close();
  });

  it("revives a previously failed ingest job when finalizing an unchanged clip", async () => {
    const test = await serviceForTest();
    const input = { ...captureInput("capture-example-revive-1"), assets: [] };
    const created = await test.service.createCapture(input);
    test.sqlite.prepare("UPDATE file_versions SET status = 'failed' WHERE id = ?").run(created.fileVersionId);
    test.sqlite.prepare(`INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
      VALUES (?, 'file.ingest', 'failed', ?, ?, ?)`)
      .run(created.jobId, JSON.stringify({ fileEntryId: created.fileEntryId, fileVersionId: created.fileVersionId, attempts: 3 }), Date.now(), Date.now());

    await test.service.finalizeCapture(input.captureId, []);
    await test.service.dispose();

    expect(test.sqlite.prepare("SELECT status FROM file_versions WHERE id = ?").get(created.fileVersionId))
      .toMatchObject({ status: "queued" });
    const job = test.sqlite.prepare("SELECT status, payload FROM jobs WHERE id = ?").get(created.jobId) as { status: string; payload: string };
    expect(job.status).toBe("pending");
    expect(JSON.parse(job.payload)).toMatchObject({
      attempts: 0,
      pipelines: { room: true, wiki: true, memory: true },
    });
    await test.files.dispose();
    test.sqlite.close();
  });
});
