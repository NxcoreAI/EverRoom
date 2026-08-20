import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { RealityService } from "../src/modules/reality/service.js";

const directories: string[] = [];
const databases: DatabaseClient[] = [];

async function setup(logger?: Logger) {
  const directory = await mkdtemp(join(tmpdir(), "nxcore-reality-ready-sink-test-"));
  directories.push(directory);
  const database = createDatabase(join(directory, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  return new RealityService(database.db, directory, logger);
}

function syncedEvent(id: string, resultVersion: number) {
  return {
    id,
    title: "同步录音",
    captureDevice: { id: "synced-iphone", name: "iPhone", kind: "iphone" as const },
    audioSource: "microphone" as const,
    durationMs: 10_000,
    transcript: "同步完成的录音内容。",
    transcriptSegments: [{ text: "同步完成的录音内容。", beginTime: 0, endTime: 10_000, speakerId: 0 }],
    resultVersion,
    startedAt: "2026-08-20T01:00:00.000Z",
    endedAt: "2026-08-20T01:00:10.000Z",
  };
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("RealityService ready sink", () => {
  it("delivers ASR completion and manual edits while ignoring a repeated result version", async () => {
    const service = await setup();
    const readySink = vi.fn(async () => undefined);
    service.setReadySink(readySink);
    service.createEvent({
      id: "local-recording",
      captureDevice: { id: "desktop-local", name: "This Mac", kind: "desktop" },
      audioSource: "microphone",
    });

    const asrInput = {
      jobId: "job-local-recording",
      source: "local" as const,
      status: "completed" as const,
      resultVersion: 1,
      result: {
        transcript: "完成后的录音内容。",
        segments: [{ text: "完成后的录音内容。", beginTime: 0, endTime: 1_000, speakerId: 0 }],
      },
    };
    const completed = service.applyAsr("local-recording", asrInput);
    service.applyAsr("local-recording", asrInput);

    expect(readySink).toHaveBeenCalledTimes(1);
    expect(readySink).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "local-recording",
      processingState: "ready",
      transcript: "完成后的录音内容。",
    }));

    const edited = service.updateTranscript("local-recording", {
      transcript: "人工编辑后的录音内容。",
      expectedVersion: completed.version,
    });
    expect(edited.transcript).toBe("人工编辑后的录音内容。");
    expect(readySink).toHaveBeenCalledTimes(2);
    expect(readySink).toHaveBeenLastCalledWith(expect.objectContaining({
      id: "local-recording",
      transcript: "人工编辑后的录音内容。",
    }));
  });

  it("delivers a synced import once per new result version", async () => {
    const service = await setup();
    const readySink = vi.fn(async () => undefined);
    service.setReadySink(readySink);

    const imported = service.importEvent(syncedEvent("synced-recording", 7));
    const repeated = service.importEvent(syncedEvent("synced-recording", 7));

    expect(imported.processingState).toBe("ready");
    expect(repeated.version).toBe(imported.version);
    expect(readySink).toHaveBeenCalledTimes(1);

    service.importEvent({
      ...syncedEvent("synced-recording", 8),
      transcript: "同步得到的更新内容。",
    });
    expect(readySink).toHaveBeenCalledTimes(2);
  });

  it("persists a ready recording when downstream delivery rejects", async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn } as unknown as Logger;
    const service = await setup(logger);
    service.setReadySink(async () => {
      throw new Error("downstream unavailable");
    });

    const imported = service.importEvent(syncedEvent("resilient-recording", 1));
    expect(imported).toMatchObject({
      id: "resilient-recording",
      status: "completed",
      processingState: "ready",
    });
    expect(service.getEvent("resilient-recording")).toMatchObject({
      transcript: "同步完成的录音内容。",
      processingState: "ready",
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ realityEventId: "resilient-recording", err: "downstream unavailable" }),
      "ready reality event downstream ingest failed",
    ));
  });
});
