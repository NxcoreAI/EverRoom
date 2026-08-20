import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { visualNodes, visualProcessingJobs } from "../src/infrastructure/database/schema.js";
import { FilesService } from "../src/modules/files/service.js";
import { PerceptionService } from "../src/modules/perception/service.js";
import type { VisualInferenceClient } from "../src/modules/perception/vlm-client.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];
const logger = { warn: vi.fn() } as unknown as FastifyBaseLogger;

async function setup(vlm: VisualInferenceClient | null) {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-perception-test-"));
  directories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const files = new FilesService(database.db, dir);
  const service = new PerceptionService(database.db, files, vlm, logger);
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
      representativeTags: ["屏幕"], confidence: 0.8,
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

  it("groups similar consecutive screenshots and invokes VLM only for the new node", async () => {
    const infer = vi.fn(async () => ({
      eventType: "WORK", title: "编辑文档", summary: "正在整理文档", keyPoints: ["编辑"],
      representativeTags: ["文档"], confidence: 0.9,
    }));
    const { database, files, service } = await setup({ model: "test-vlm", infer });
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
    await waitFor(() => infer.mock.calls.length === 1
      && database.db.select().from(visualNodes).all()[0]?.vlmStatus === "ready");

    expect(secondResult.grouped).toBe(true);
    expect(secondResult.node.id).toBe(firstResult.node.id);
    expect(database.db.select().from(visualNodes).all()).toHaveLength(1);
    expect(database.db.select().from(visualNodes).all()[0]).toMatchObject({
      sampleCount: 2, model: "test-vlm", title: "编辑文档",
    });
    expect(await files.contentOf(first.fileId)).toMatchObject({ mime: "image/jpeg" });
    service.dispose();
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
