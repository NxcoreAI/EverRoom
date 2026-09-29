import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type GatewayDatabase } from "../src/infrastructure/database/client.js";
import {
  clipperAssets,
  clipperCaptures,
  fileBlobs,
  fileClassifications,
  fileEntries,
  fileVersions,
  parsedDocuments,
  uploadedFiles,
  visualNodes,
  visualObservations,
} from "../src/infrastructure/database/schema.js";
import { MaterialsService } from "../src/modules/materials/service.js";

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 7),
]);

function hashOf(seed: string): string {
  // 64 位十六进制即可（内容哈希真实性不在本测试范围）
  return seed.padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");
}

let db: GatewayDatabase;
let dataDir: string;
let service: MaterialsService;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "materials-test-"));
  db = createDatabase(join(dataDir, "test.sqlite"), resolve("drizzle")).db;
  service = new MaterialsService(db, dataDir);

  const now = new Date();
  // —— 截图（perception）：VLM ready，描述含「城市 夜景」
  const screenshotHash = hashOf("screenshot");
  await db.insert(fileBlobs).values({
    contentHash: screenshotHash, storagePath: `files/sha256/${screenshotHash.slice(0, 2)}/${screenshotHash}`,
    byteSize: PNG_BYTES.length, mime: "image/png", createdAt: now,
  }).run();
  await mkdir(join(dataDir, "files/sha256", screenshotHash.slice(0, 2)), { recursive: true });
  await writeFile(join(dataDir, `files/sha256/${screenshotHash.slice(0, 2)}/${screenshotHash}`), PNG_BYTES);
  await db.insert(uploadedFiles).values({
    id: "file-shot", contentHash: screenshotHash,
    storagePath: `files/sha256/${screenshotHash.slice(0, 2)}/${screenshotHash}`,
    originalName: "city.png", bytes: PNG_BYTES.length, mime: "image/png", assetKind: "screenshot",
  }).run();
  await db.insert(visualNodes).values({
    id: "vn-1", kind: "screenshot", startAt: now, endAt: now,
    vlmStatus: "ready", title: "城市夜景", summary: "高楼林立的城市夜景，灯光璀璨",
    keyPoints: ["城市天际线"],
  }).run();
  await db.insert(visualObservations).values({
    id: "vo-1", nodeId: "vn-1", fileId: "file-shot", kind: "screenshot",
    capturedAt: now, width: 2560, height: 1440,
  }).run();

  // —— 网页剪藏图：一张 primary 可用，一张 noise 排除
  const capture = {
    id: "cap-1", captureKey: "cap-key-1", sourceUrl: "https://example.com/a",
    canonicalUrl: "https://example.com/a", title: "智能手表评测", capturedAt: now,
    extractionMode: "article" as const, rawContentHash: hashOf("raw"), extractorVersion: "1",
    parserVersion: "1", status: "ready" as const,
  };
  await db.insert(clipperCaptures).values(capture).run();
  for (const [assetId, hash, role] of [
    ["ca-primary", hashOf("watch"), "primary"],
    ["ca-noise", hashOf("qr"), "noise"],
  ] as const) {
    await db.insert(fileBlobs).values({
      contentHash: hash, storagePath: `files/sha256/${hash.slice(0, 2)}/${hash}`,
      byteSize: PNG_BYTES.length, mime: "image/png", createdAt: now,
    }).run();
    await db.insert(fileEntries).values({
      id: `entry-${assetId}`, sourceKind: "web-clipper", sourceKey: `clip:${assetId}`,
      originalName: "clip.html", extension: ".html", state: "ready",
    }).run();
    await db.insert(fileVersions).values({
      id: `fver-${assetId}`, fileEntryId: `entry-${assetId}`, versionNo: 1,
      contentHash: hash, parserId: "html-turndown", parserVersion: 1, status: "parsed",
    }).run();
    await db.insert(clipperAssets).values({
      id: assetId, captureId: "cap-1", fileVersionId: `fver-${assetId}`,
      referenceKey: `ref-${assetId}`, contentHash: hash, mime: "image/png",
      originalUrl: `https://example.com/${assetId}.png`,
      width: 1200, height: 800, status: "stored", visualStatus: "ready",
      visualKind: "photo", visualSummary: assetId === "ca-primary" ? "智能手表产品特写" : "二维码",
      visualContentRole: role,
    }).run();
  }

  // —— 文档内嵌图：parsed_documents.artifact 带 embedded-image + page-image
  const docHash = hashOf("docimg");
  const docFileHash = hashOf("docfile");
  await db.insert(fileBlobs).values({
    contentHash: docFileHash, storagePath: `files/sha256/${docFileHash.slice(0, 2)}/${docFileHash}`,
    byteSize: 1, mime: "application/zip", createdAt: now,
  }).run();
  await db.insert(fileEntries).values({
    id: "entry-doc", sourceKind: "manual-upload", sourceKey: "doc:1",
    originalName: "产品介绍.pptx", extension: ".pptx", displayName: "产品介绍", state: "ready",
  }).run();
  await db.insert(fileVersions).values({
    id: "fver-doc", fileEntryId: "entry-doc", versionNo: 1,
    contentHash: hashOf("docfile"), parserId: "pptx-jszip", parserVersion: 1, status: "parsed",
  }).run();
  await db.insert(parsedDocuments).values({
    id: "pd-doc", fileVersionId: "fver-doc", parserRevision: "r1", format: "pptx",
    artifact: {
      assets: [
        { id: "asset-1", kind: "embedded-image", pageNo: 3, mime: "image/png", contentHash: docHash, storageRef: `document-artifacts/sha256/${docHash.slice(0, 2)}/${docHash}.png` },
        { id: "asset-2", kind: "page-image", pageNo: 1, mime: "image/png", contentHash: hashOf("page"), storageRef: "x" },
      ],
    },
    markdown: "", quality: {},
  }).run();
  await db.insert(fileClassifications).values({
    id: "fc-doc", fileVersionId: "fver-doc", category: "slides",
    summary: "智能穿戴产品介绍", tags: ["智能手表", "产品"], confidence: 0.9,
    model: "test", promptVersion: 1, schemaVersion: 1,
  }).run();
  // 同文档第二版：分类文本在这一版、内嵌图在第一版（真实库的常态）
  const docFileHash2 = hashOf("docfile2");
  await db.insert(fileBlobs).values({
    contentHash: docFileHash2, storagePath: `files/sha256/${docFileHash2.slice(0, 2)}/${docFileHash2}`,
    byteSize: 1, mime: "application/zip", createdAt: now,
  }).run();
  await db.insert(fileVersions).values({
    id: "fver-doc-2", fileEntryId: "entry-doc", versionNo: 2,
    contentHash: docFileHash2, parserId: "pptx-jszip", parserVersion: 1, status: "parsed",
  }).run();
  await db.insert(parsedDocuments).values({
    id: "pd-doc-2", fileVersionId: "fver-doc-2", parserRevision: "r1", format: "pptx",
    artifact: { assets: [] }, markdown: "", quality: {},
  }).run();
  await db.insert(fileClassifications).values({
    id: "fc-doc-2", fileVersionId: "fver-doc-2", category: "slides",
    summary: "产品融资路演", tags: ["投资人"], confidence: 0.9,
    model: "test", promptVersion: 1, schemaVersion: 1,
  }).run();
  await mkdir(join(dataDir, "document-artifacts/sha256", docHash.slice(0, 2)), { recursive: true });
  await writeFile(join(dataDir, `document-artifacts/sha256/${docHash.slice(0, 2)}/${docHash}.png`), PNG_BYTES);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("MaterialsService.search", () => {
  it("截图命中：ref 指向内容哈希，meta 带尺寸", () => {
    const hits = service.search("城市 夜景");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.kind).toBe("screenshot");
    expect(hits[0]!.ref).toBe(`everroom-material://${hashOf("screenshot")}`);
    expect(hits[0]!.meta).toContain("2560×1440");
  });

  it("剪藏图命中 primary、排除 noise；文档内嵌图随文档命中浮出，page-image 不作素材", () => {
    const hits = service.search("智能手表");
    const refs = hits.map((hit) => hit.ref);
    expect(refs).toContain(`everroom-material://${hashOf("watch")}`);
    expect(refs).not.toContain(`everroom-material://${hashOf("qr")}`);
    expect(refs).toContain(`everroom-material://${hashOf("docimg")}`);
    expect(refs).not.toContain(`everroom-material://${hashOf("page")}`);
    const docHit = hits.find((hit) => hit.kind === "document")!;
    expect(docHit.desc).toContain("产品介绍");
  });

  it("AND 语义：任一词未命中即无结果", () => {
    expect(service.search("城市 海滩")).toHaveLength(0);
    expect(service.search("")).toHaveLength(0);
  });

  it("跨版本聚合：关键词在另一版的分类里，也能命中带图版本", () => {
    const hits = service.search("投资人");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ref).toBe(`everroom-material://${hashOf("docimg")}`);
  });
});

describe("MaterialsService.readByHash", () => {
  it("file_blobs 图片按字节回源", async () => {
    const content = await service.readByHash(hashOf("screenshot"));
    expect(content).not.toBeNull();
    expect(content!.mime).toBe("image/png");
    expect(content!.buffer.subarray(0, 4)).toEqual(PNG_BYTES.subarray(0, 4));
  });

  it("document-artifacts 路径兜底", async () => {
    const content = await service.readByHash(hashOf("docimg"));
    expect(content).not.toBeNull();
    expect(content!.mime).toBe("image/png");
  });

  it("非法哈希与未知哈希返回 null", async () => {
    expect(await service.readByHash("not-a-hash")).toBeNull();
    expect(await service.readByHash(hashOf("unknown"))).toBeNull();
  });
});

describe("materialsRoutes（GET /v1/materials/:hash）", () => {
  it("命中回图、坏哈希 400、未知 404", async () => {
    const Fastify = (await import("fastify")).default;
    const { materialsRoutes } = await import("../src/modules/materials/routes.js");
    const app = Fastify();
    await app.register(materialsRoutes(service));
    await app.ready();

    const ok = await app.inject({ method: "GET", url: `/v1/materials/${hashOf("screenshot")}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("image/png");
    expect(ok.headers["cache-control"]).toContain("immutable");

    const bad = await app.inject({ method: "GET", url: "/v1/materials/zzzz" });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({ method: "GET", url: `/v1/materials/${hashOf("unknown")}` });
    expect(missing.statusCode).toBe(404);

    await app.close();
  });
});
