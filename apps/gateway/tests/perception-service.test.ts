import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import {
  documentVersions,
  documents,
  parsedContents,
  uploadedFiles,
  visualNodes,
  visualProcessingJobs,
} from "../src/infrastructure/database/schema.js";
import { FilesService } from "../src/modules/files/service.js";
import { PerceptionService, type VisualReadyEvidence } from "../src/modules/perception/service.js";
import {
  MAX_SCREENSHOT_SEGMENT_MS,
  SCREENSHOT_REANALYSIS_INTERVAL_MS,
} from "../src/modules/perception/visual-segmentation.js";
import type { VisualInferenceClient } from "../src/modules/perception/vlm-client.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];
const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;

async function setup(vlm: VisualInferenceClient | null, markDiaryStale?: (at: Date) => void) {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-perception-test-"));
  directories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const files = new FilesService(database.db, dir);
  const service = new PerceptionService(database.db, files, vlm, logger, markDiaryStale);
  service.initialize();
  return { database, files, service };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("condition not reached");
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("PerceptionService", () => {
  it("backfills disabled visual nodes when online VLM is enabled", async () => {
    const infer = vi.fn(async () => ({
      eventType: "WORK", title: "历史截图", summary: "补处理完成", keyPoints: ["补处理"],
      representativeTags: [{ kind: "entity" as const, label: "屏幕", entityType: "other" as const }], confidence: 0.8,
    }));
    const { database, files, service } = await setup({ model: "test-vlm", infer });
    const file = await files.upload({ filename: "history.jpg", buffer: Buffer.from("history"), mime: "image/jpeg" });
    service.registerObservation({
      fileId: file.fileId, kind: "screenshot", capturedAt: new Date("2026-08-20T09:00:00Z"),
      perceptualHash: "0000000000000000", width: 100, height: 100,
    });
    expect(database.db.select().from(visualNodes).all()[0]?.vlmStatus).toBe("disabled");

    const settings = service.settings();
    service.updateSettings({ configVersion: settings.configVersion, onlineVlmEnabled: true });
    await waitFor(() => infer.mock.calls.length === 1
      && database.db.select().from(visualNodes).all()[0]?.vlmStatus === "ready");

    expect(database.db.select().from(visualProcessingJobs).all()).toEqual([
      expect.objectContaining({ status: "completed", attempt: 0 }),
    ]);
    service.dispose();
  });

  it("lists collected documents and files on the unified perception timeline", async () => {
    const { database, files, service } = await setup(null);
    const occurredAt = new Date("2026-08-20T11:00:00Z");

    database.db.insert(documents).values({
      id: "doc-1",
      title: "项目记录",
      contentJson: { type: "doc" },
      status: "active",
      version: 1,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }).run();
    database.db.insert(documentVersions).values({
      id: "doc-version-1",
      documentId: "doc-1",
      version: 1,
      title: "项目记录（第一版）",
      contentJson: { blocks: [{ text: "记录了本次项目进展" }] },
      createdAt: occurredAt,
    }).run();

    const file = await files.upload({
      filename: "会议纪要.md",
      buffer: Buffer.from("会议纪要正文"),
      mime: "text/markdown",
      capturedAt: new Date("2026-08-20T12:00:00Z"),
    });
    const parsedId = "parsed-file-1";
    database.db.insert(parsedContents).values({
      id: parsedId,
      contentHash: "parsed-file-hash",
      parserVersion: "1",
      markdown: "会议纪要正文",
      parsedAt: new Date("2026-08-20T12:00:01Z"),
    }).run();
    database.db.update(uploadedFiles).set({ currentParsedId: parsedId }).where(eq(uploadedFiles.id, file.fileId)).run();

    const screenshot = await files.upload({ filename: "screen.jpg", buffer: Buffer.from("screen"), mime: "image/jpeg" });
    service.registerObservation({
      fileId: screenshot.fileId,
      kind: "screenshot",
      capturedAt: new Date("2026-08-20T13:00:00Z"),
      perceptualHash: "0000000000000000",
    });

    const all = service.list({});
    expect(all.map((node) => node.kind)).toEqual(["document", "file", "screenshot"]);
    expect(service.list({ kind: "document" })).toEqual([
      expect.objectContaining({ id: "document_version:doc-version-1", kind: "document", title: "项目记录（第一版）" }),
    ]);
    expect(service.list({ kind: "file" })).toEqual([
      expect.objectContaining({ id: `file:${file.fileId}`, kind: "file", title: "会议纪要.md", summary: "会议纪要正文" }),
    ]);
    expect(service.list({ kind: "document" }).some((node) => node.kind === "screenshot")).toBe(false);
    expect(service.list({ kind: "file" }).some((node) => node.kind === "screenshot")).toBe(false);
    expect(service.list({ status: "failed" })).toEqual([]);
    expect(service.list({ status: "ready" }).map((node) => node.kind)).toEqual(["document", "file"]);
    await service.dispose();
  });

  it("groups similar consecutive screenshots and invokes VLM only for the new node", async () => {
    const infer = vi.fn(async () => ({
      eventType: "WORK", title: "编辑文档", summary: "正在整理文档", keyPoints: ["编辑"],
      representativeTags: [{ kind: "entity" as const, label: "文档", entityType: "other" as const }], confidence: 0.9,
    }));
    const { database, files, service } = await setup({ model: "test-vlm", infer });
    const readySink = vi.fn(async (_evidence: VisualReadyEvidence) => undefined);
    service.setReadySink(readySink);
    const settings = service.settings();
    service.updateSettings({ configVersion: settings.configVersion, onlineVlmEnabled: true });
    const first = await files.upload({ filename: "one.jpg", buffer: Buffer.from("one"), mime: "image/jpeg" });
    const second = await files.upload({ filename: "two.jpg", buffer: Buffer.from("two"), mime: "image/jpeg" });
    const firstResult = service.registerObservation({
      fileId: first.fileId, kind: "screenshot", capturedAt: new Date("2026-08-20T10:00:00Z"),
      perceptualHash: "0000000000000000", width: 100, height: 100,
    });
    const secondResult = service.registerObservation({
      fileId: second.fileId, kind: "screenshot", capturedAt: new Date("2026-08-20T10:01:00Z"),
      perceptualHash: "0000000000000003", width: 100, height: 100,
    });
    await waitFor(() => infer.mock.calls.length === 1 && readySink.mock.calls.length === 1
      && database.db.select().from(visualNodes).all()[0]?.vlmStatus === "ready");

    expect(secondResult.grouped).toBe(true);
    expect(secondResult.node.id).toBe(firstResult.node.id);
    expect(database.db.select().from(visualNodes).all()).toHaveLength(1);
    expect(database.db.select().from(visualNodes).all()[0]).toMatchObject({
      sampleCount: 2, model: "test-vlm", title: "编辑文档",
    });
    expect(service.list({ kind: "screenshot" })[0]).toMatchObject({
      keyPoints: ["编辑"],
      tags: ["文档"],
      insightTags: [expect.objectContaining({ kind: "entity", label: "文档" })],
    });
    expect(readySink).toHaveBeenCalledWith(expect.objectContaining({
      sourceVersion: 1,
      title: "编辑文档",
      markdown: expect.stringContaining("## 实体与事实"),
    }));
    expect(await files.contentOf(first.fileId)).toMatchObject({ mime: "image/jpeg" });
    service.dispose();
  });

  it("starts a new node when similar screenshots reach the maximum segment duration", async () => {
    const { database, files, service } = await setup(null);
    const start = new Date("2026-08-20T10:00:00Z");
    const offsets = [0, 9, 18, 27, MAX_SCREENSHOT_SEGMENT_MS / 60_000];
    const results = [];
    for (const [index, offsetMinutes] of offsets.entries()) {
      const file = await files.upload({
        filename: `segment-${index}.jpg`, buffer: Buffer.from(`segment-${index}`), mime: "image/jpeg",
      });
      results.push(service.registerObservation({
        fileId: file.fileId,
        kind: "screenshot",
        capturedAt: new Date(start.getTime() + offsetMinutes * 60_000),
        perceptualHash: "0000000000000000",
      }));
    }

    expect(results.slice(1, 4).every((result) => result.grouped)).toBe(true);
    expect(results[4]?.grouped).toBe(false);
    expect(results[4]?.node.id).not.toBe(results[0]?.node.id);
    expect(database.db.select().from(visualNodes).all().map((node) => node.sampleCount)).toEqual([4, 1]);
    await service.dispose();
  });

  it("refreshes the representative screenshot and VLM result within a continuing segment", async () => {
    const infer = vi.fn(async (image: { buffer: Buffer }) => {
      const latest = image.buffer.toString() === "later";
      return {
        eventType: "WORK",
        title: latest ? "后续工作" : "初始工作",
        summary: latest ? "已经切换到后续画面" : "最初的画面",
        keyPoints: [latest ? "后续" : "初始"],
        representativeTags: [],
        confidence: 0.9,
      };
    });
    const { database, files, service } = await setup({ model: "test-vlm", infer });
    const readySink = vi.fn(async (_evidence: VisualReadyEvidence) => undefined);
    service.setReadySink(readySink);
    const settings = service.settings();
    service.updateSettings({
      configVersion: settings.configVersion,
      captureIntervalSeconds: 600,
      onlineVlmEnabled: true,
    });
    const first = await files.upload({ filename: "initial.jpg", buffer: Buffer.from("initial"), mime: "image/jpeg" });
    const later = await files.upload({ filename: "later.jpg", buffer: Buffer.from("later"), mime: "image/jpeg" });
    const start = new Date("2026-08-20T10:00:00Z");
    const firstResult = service.registerObservation({
      fileId: first.fileId, kind: "screenshot", capturedAt: start,
      perceptualHash: "0000000000000000",
    });
    await waitFor(() => infer.mock.calls.length === 1 && readySink.mock.calls.length === 1);

    const laterResult = service.registerObservation({
      fileId: later.fileId,
      kind: "screenshot",
      capturedAt: new Date(start.getTime() + SCREENSHOT_REANALYSIS_INTERVAL_MS),
      perceptualHash: "0000000000000003",
    });
    await waitFor(() => infer.mock.calls.length === 2 && readySink.mock.calls.length === 2
      && database.db.select().from(visualNodes).all()[0]?.vlmStatus === "ready");

    expect(laterResult.grouped).toBe(true);
    expect(laterResult.node.id).toBe(firstResult.node.id);
    expect(service.list({ kind: "screenshot" })[0]).toMatchObject({
      mediaFileId: later.fileId,
      title: "后续工作",
      summary: "已经切换到后续画面",
    });
    expect(database.db.select().from(visualNodes).all()[0]).toMatchObject({ resultVersion: 2, sampleCount: 2 });
    expect(readySink.mock.calls.map(([evidence]) => evidence.sourceVersion)).toEqual([1, 2]);
    await service.dispose();
  });

  it("discards an in-flight VLM result when a newer representative screenshot is selected", async () => {
    let resolveFirst: ((result: Awaited<ReturnType<VisualInferenceClient["infer"]>>) => void) | undefined;
    const infer = vi.fn((image: { buffer: Buffer }) => {
      if (image.buffer.toString() === "initial") {
        return new Promise<Awaited<ReturnType<VisualInferenceClient["infer"]>>>((resolveInfer) => {
          resolveFirst = resolveInfer;
        });
      }
      return Promise.resolve({
        eventType: "WORK", title: "最新画面", summary: "使用新的代表截图", keyPoints: ["最新"],
        representativeTags: [], confidence: 0.95,
      });
    });
    const { database, files, service } = await setup({ model: "test-vlm", infer });
    const readySink = vi.fn(async (_evidence: VisualReadyEvidence) => undefined);
    service.setReadySink(readySink);
    const settings = service.settings();
    service.updateSettings({
      configVersion: settings.configVersion,
      captureIntervalSeconds: 600,
      onlineVlmEnabled: true,
    });
    const first = await files.upload({ filename: "in-flight.jpg", buffer: Buffer.from("initial"), mime: "image/jpeg" });
    const later = await files.upload({ filename: "replacement.jpg", buffer: Buffer.from("replacement"), mime: "image/jpeg" });
    const start = new Date("2026-08-20T10:00:00Z");
    service.registerObservation({
      fileId: first.fileId, kind: "screenshot", capturedAt: start,
      perceptualHash: "0000000000000000",
    });
    await waitFor(() => infer.mock.calls.length === 1 && resolveFirst !== undefined);

    service.registerObservation({
      fileId: later.fileId,
      kind: "screenshot",
      capturedAt: new Date(start.getTime() + SCREENSHOT_REANALYSIS_INTERVAL_MS),
      perceptualHash: "0000000000000001",
    });
    resolveFirst!({
      eventType: "WORK", title: "过期画面", summary: "不应被保存", keyPoints: ["过期"],
      representativeTags: [], confidence: 0.5,
    });
    await waitFor(() => infer.mock.calls.length === 2 && readySink.mock.calls.length === 1
      && database.db.select().from(visualNodes).all()[0]?.vlmStatus === "ready");

    expect(service.list({ kind: "screenshot" })[0]).toMatchObject({
      mediaFileId: later.fileId,
      title: "最新画面",
      summary: "使用新的代表截图",
    });
    expect(database.db.select().from(visualNodes).all()[0]?.resultVersion).toBe(1);
    expect(readySink).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it("marks the diary stale when visual evidence is added, understood, and deleted", async () => {
    const capturedAt = new Date("2026-08-20T10:00:00Z");
    const infer = vi.fn(async () => ({
      eventType: "WORK", title: "编辑文档", summary: "正在整理文档", keyPoints: ["编辑"],
      representativeTags: [], confidence: 0.9,
    }));
    const markDiaryStale = vi.fn();
    const { files, service } = await setup({ model: "test-vlm", infer }, markDiaryStale);
    const settings = service.settings();
    service.updateSettings({ configVersion: settings.configVersion, onlineVlmEnabled: true });
    const file = await files.upload({ filename: "diary.jpg", buffer: Buffer.from("image"), mime: "image/jpeg" });

    const registered = service.registerObservation({
      fileId: file.fileId, kind: "screenshot", capturedAt,
      perceptualHash: "0000000000000000", width: 100, height: 100,
    });
    await waitFor(() => infer.mock.calls.length === 1 && markDiaryStale.mock.calls.length >= 2);
    await service.delete(registered.node.id, false);

    expect(markDiaryStale).toHaveBeenCalledTimes(3);
    expect(markDiaryStale).toHaveBeenNthCalledWith(1, capturedAt);
    expect(markDiaryStale).toHaveBeenNthCalledWith(2, capturedAt);
    expect(markDiaryStale).toHaveBeenNthCalledWith(3, capturedAt);
    await service.dispose();
  });

  it("keeps the local image when VLM fails and persists the retry", async () => {
    const infer = vi.fn(async () => { throw new Error("provider unavailable"); });
    const { database, files, service } = await setup({ model: "test-vlm", infer });
    const settings = service.settings();
    service.updateSettings({ configVersion: settings.configVersion, onlineVlmEnabled: true });
    const file = await files.upload({ filename: "failure.jpg", buffer: Buffer.from("local-original"), mime: "image/jpeg" });
    service.registerObservation({
      fileId: file.fileId, kind: "photo", capturedAt: new Date("2026-08-20T10:00:00Z"),
    });
    await waitFor(() => database.db.select().from(visualProcessingJobs).all()[0]?.attempt === 1);

    expect((await files.contentOf(file.fileId))?.buffer.toString()).toBe("local-original");
    expect(database.db.select().from(visualProcessingJobs).all()[0]).toMatchObject({ status: "pending", attempt: 1 });
    service.dispose();
  });

  it("stops active visual inference when online VLM is disabled", async () => {
    let aborted = false;
    const infer = vi.fn((_image: { buffer: Buffer; mime: string }, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }));
    const { database, files, service } = await setup({ model: "test-vlm", infer });
    let settings = service.settings();
    service.updateSettings({ configVersion: settings.configVersion, onlineVlmEnabled: true });
    const file = await files.upload({ filename: "private.jpg", buffer: Buffer.from("private"), mime: "image/jpeg" });
    service.registerObservation({
      fileId: file.fileId, kind: "screenshot", capturedAt: new Date("2026-08-20T11:00:00Z"),
      perceptualHash: "0000000000000000", width: 100, height: 100,
    });
    await waitFor(() => infer.mock.calls.length === 1);

    settings = service.settings();
    service.updateSettings({ configVersion: settings.configVersion, onlineVlmEnabled: false });
    await waitFor(() => aborted && database.db.select().from(visualProcessingJobs).all()[0]?.status === "pending");

    expect(database.db.select().from(visualProcessingJobs).all()[0]).toMatchObject({ attempt: 0, error: null });
    expect(database.db.select().from(visualNodes).all()[0]).toMatchObject({ vlmStatus: "pending", error: null });
    await service.dispose();
  });
});
