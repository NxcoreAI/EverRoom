import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  parsedContents,
  uploadedFiles,
  visualNodes,
  visualObservations,
  visualProcessingJobs,
} from "../src/infrastructure/database/schema.js";
import { FilesService } from "../src/modules/files/service.js";
import { ImageDescribeService } from "../src/modules/files/image-describe.js";
import { IngestService } from "../src/modules/ingest/service.js";
import type { KnowledgeService } from "../src/modules/knowledge/service.js";
import type { MemoryService } from "../src/modules/memory/service.js";
import { MaterialsService } from "../src/modules/materials/service.js";
import { PerceptionService } from "../src/modules/perception/service.js";
import type { VisualInferenceClient, VisualInferenceResult } from "../src/modules/perception/vlm-client.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];
const perceptions: PerceptionService[] = [];
const logger = pino({ level: "silent" });

// 1x1 透明 PNG：魔数满足 sniffImageMime
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const VLM_RESULT: VisualInferenceResult = {
  eventType: "照片记录",
  title: "海边日落",
  summary: "一张海边日落的照片",
  keyPoints: ["海平面", "日落"],
  representativeTags: [],
  confidence: 0.9,
};

async function setup(vlm: VisualInferenceClient | null, enableOnlineVlm = false) {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-image-describe-test-"));
  directories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const { db } = database;
  const files = new FilesService(db, dir);
  const perception = new PerceptionService(db, files, vlm, logger);
  perceptions.push(perception);
  if (enableOnlineVlm) {
    perception.updateSettings({ configVersion: perception.settings().configVersion, onlineVlmEnabled: true });
  }
  const knowledge = {
    enabled: true,
    routerEnabled: false,
    submitEnvelope: vi.fn().mockReturnValue({ queued: true, jobId: "route-job-1" }),
  } as unknown as KnowledgeService;
  const memory = {
    enabled: true,
    importToMemoryCore: vi.fn().mockResolvedValue({
      document: { id: "mdoc-1", title: "", callerRef: "", version: 1, sessionId: "s1", chunkCount: 1, derivedMemoryCount: null },
      version: 1,
      sessionId: "s1",
      chunkCount: 1,
      deduplicated: false,
      replacedVersions: [],
      acceptedChunks: 1,
    }),
  } as unknown as MemoryService;
  const describer = new ImageDescribeService(files, perception, logger);
  const ingest = new IngestService(db, files, knowledge, memory, logger, undefined, null, null, describer);
  files.setVersionIngestor(async (input) => ingest.ingest({
    source: { ref: { sourceKind: "file", sourceId: input.fileEntryId, sourceVersionId: input.fileVersionId } },
    pipelines: { room: false, wiki: false, memory: true },
  }));
  const materials = new MaterialsService(db, dir);
  return { db, sqlite: database.sqlite, files, perception, memory, materials };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition not reached");
}

afterEach(async () => {
  await Promise.allSettled(perceptions.splice(0).map((service) => service.dispose()));
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ImageDescribeService（文件导入 → 描述 → 视觉库）", () => {
  it("导入图片：VLM 描述落 parsed_contents 与 ready 视觉节点，素材检索命中", async () => {
    const infer = vi.fn(async () => VLM_RESULT);
    const { db, files, materials, memory } = await setup({ model: "test-vlm", infer }, true);

    const result = await files.importFile({
      sourceKind: "manual-upload", sourceKey: "t:1", originalName: "a.png",
      buffer: PNG_BYTES, mime: "image/png",
    });
    await waitFor(() => db.select().from(parsedContents).all().length > 0
      && db.select().from(visualNodes).all().length > 0);

    expect(files.catalogMarkdownOf(result.fileEntryId)).toContain("海边日落");
    const node = db.select().from(visualNodes).all()[0]!;
    expect(node.vlmStatus).toBe("ready");
    expect(node.title).toBe("海边日落");
    expect(db.select().from(visualObservations).all()).toHaveLength(1);
    expect(db.select().from(uploadedFiles).all()).toHaveLength(1);
    expect(db.select().from(visualProcessingJobs).all()).toEqual([]);
    expect(infer).toHaveBeenCalledTimes(1);

    const hits = materials.search("海边日落");
    expect(hits.some((hit) => hit.kind === "photo")).toBe(true);

    // 同内容再导入（不同 sourceKey）：复用 ready 节点，不重调 VLM
    await files.importFile({
      sourceKind: "manual-upload", sourceKey: "t:2", originalName: "a.png",
      buffer: PNG_BYTES, mime: "image/png",
    });
    await waitFor(() => (memory.importToMemoryCore as ReturnType<typeof vi.fn>).mock.calls.length === 2);
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it("VLM 未配置：占位描述 + disabled 节点（待 backfill）", async () => {
    const { db, files } = await setup(null);

    const result = await files.importFile({
      sourceKind: "manual-upload", sourceKey: "t:1", originalName: "b.png",
      buffer: PNG_BYTES, mime: "image/png",
    });
    await waitFor(() => db.select().from(parsedContents).all().length > 0);

    expect(files.catalogMarkdownOf(result.fileEntryId)).toContain("暂无 AI 描述");
    expect(db.select().from(visualNodes).all()[0]?.vlmStatus).toBe("disabled");
  });

  it("VLM 调用失败：占位描述 + pending 节点进感知队列重试", async () => {
    const infer = vi.fn(async () => { throw new Error("vlm down"); });
    const { db, files } = await setup({ model: "test-vlm", infer }, true);

    const result = await files.importFile({
      sourceKind: "manual-upload", sourceKey: "t:1", originalName: "c.png",
      buffer: PNG_BYTES, mime: "image/png",
    });
    await waitFor(() => db.select().from(parsedContents).all().length > 0);

    expect(files.catalogMarkdownOf(result.fileEntryId)).toContain("暂无 AI 描述");
    expect(db.select().from(visualNodes).all()[0]?.vlmStatus).toBe("pending");
    expect(db.select().from(visualProcessingJobs).all()).toHaveLength(1);
  });

  it("registerResolvedObservation：既有 pending 节点补写为 ready，job 置 completed", async () => {
    const infer = vi.fn(async () => { throw new Error("vlm down"); });
    const { db, files, perception } = await setup({ model: "test-vlm", infer }, true);
    const uploaded = await files.upload({ filename: "d.png", buffer: PNG_BYTES, mime: "image/png" });

    perception.registerObservation({ fileId: uploaded.fileId, kind: "photo", capturedAt: new Date() });
    // registerObservation 触发一次 tick：队列抢跑后失败进退避（attempt≥1、回到 pending）
    await waitFor(() => {
      const job = db.select().from(visualProcessingJobs).all()[0];
      return Boolean(job && job.status === "pending" && job.attempt >= 1);
    });
    expect(db.select().from(visualNodes).all()[0]?.vlmStatus).toBe("pending");

    perception.registerResolvedObservation({
      fileId: uploaded.fileId, kind: "photo", capturedAt: new Date(), result: VLM_RESULT, model: "test-vlm",
    });
    expect(db.select().from(visualNodes).all()[0]?.vlmStatus).toBe("ready");
    expect(db.select().from(visualProcessingJobs).all()[0]?.status).toBe("completed");
    expect(infer).toHaveBeenCalledTimes(1);

    // 幂等：再次 resolved 直接 deduped
    const again = perception.registerResolvedObservation({
      fileId: uploaded.fileId, kind: "photo", capturedAt: new Date(), result: VLM_RESULT, model: "test-vlm",
    });
    expect(again.deduped).toBe(true);
  });

  it("非图片字节：占位描述，不注册视觉库", async () => {
    const infer = vi.fn(async () => VLM_RESULT);
    const { db, files } = await setup({ model: "test-vlm", infer }, true);

    // 扩展名是 png 但内容不是图片
    await files.importFile({
      sourceKind: "manual-upload", sourceKey: "t:1", originalName: "fake.png",
      buffer: Buffer.from("not an image at all"), mime: "image/png",
    });
    await waitFor(() => db.select().from(parsedContents).all().length > 0);

    expect(db.select().from(visualNodes).all()).toEqual([]);
    expect(db.select().from(uploadedFiles).all()).toEqual([]);
  });
});
