import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import { uploadedFiles } from "../src/infrastructure/database/schema.js";
import { AgentSchedulerService } from "../src/modules/agent-scheduler/service.js";
import { DiaryService, type DiaryGenerator } from "../src/modules/diary/service.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const NOW = new Date("2026-08-20T12:00:00.000Z"); // 20:00 CST
const SLOT = "2026-08-20T15:30:00.000Z"; // 23:30 CST

async function setup(): Promise<{
  database: DatabaseClient;
  diary: DiaryService;
  generate: ReturnType<typeof vi.fn>;
  state: { now: Date };
  tick: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-scheduler-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const state = { now: new Date(NOW) };
  const clock = () => new Date(state.now);
  const generate = vi.fn<DiaryGenerator["generate"]>(async (input) => ({
    headline: "一天", summary: "摘要", reflection: "", range: input.range,
    events: input.sources.map((source) => ({
      time: source.occurredAt, title: source.evidenceSummary, summary: source.evidenceSummary, sourceRefs: [source.sourceId],
    })), closing: "",
  }));
  // 生产接线：scheduleManagedExternally=true，调度完全由 AgentSchedulerService.tick 驱动。
  const diary = new DiaryService(database.db, { generator: { model: "test", generate }, scheduleManagedExternally: true, now: clock });
  const scheduler = new AgentSchedulerService(database.db, diary, undefined, clock);
  const tick = () => (scheduler as unknown as { tick(): Promise<void> }).tick();
  return { database, diary, generate, state, tick };
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentSchedulerService daily diary slot", () => {
  it("queues today's run on enable and regenerates when the daily slot fires", async () => {
    const { database, diary, generate, state, tick } = await setup();
    database.db.insert(uploadedFiles).values({
      id: "file-a", contentHash: "hash-a", storagePath: "files/a", originalName: "a.md",
      bytes: 1, capturedAt: new Date("2026-08-20T10:00:00.000Z"), createdAt: NOW, updatedAt: NOW,
    }).run();
    diary.updateSettings({ timezone: "Asia/Shanghai", enabled: true, localTime: "23:30" });

    // 首个 tick：立刻排今天的首次生成，但定时槽（23:30）还没到。
    await tick();
    expect(database.sqlite.prepare("SELECT count(*) AS count, group_concat(trigger) AS triggers FROM diary_runs").get())
      .toEqual({ count: 1, triggers: "scheduled" });
    expect(diary.listVersions("2026-08-20")).toHaveLength(1);
    expect(diary.getDay("2026-08-20").day?.status).toBe("ready");
    expect(diary.getSettings().nextRunAt?.toISOString()).toBe(SLOT);
    expect(generate).toHaveBeenCalledTimes(1);

    // 同一天重复 tick：不得重复排队。
    await tick();
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM diary_runs").get()).toEqual({ count: 1 });

    // 23:30 槽位到点 + 当天来源有变化 → 重建全量版本，nextRunAt 推进到明天。
    state.now = new Date("2026-08-20T15:30:30.000Z");
    database.db.update(uploadedFiles).set({ contentHash: "hash-b" }).where(eq(uploadedFiles.id, "file-a")).run();
    await tick();
    const runs = database.sqlite.prepare("SELECT count(*) AS count, group_concat(trigger) AS triggers FROM diary_runs").get() as { count: number; triggers: string };
    expect(runs.count).toBe(2);
    expect(runs.triggers.split(",").every((trigger) => trigger === "scheduled")).toBe(true);
    const versions = diary.listVersions("2026-08-20");
    expect(versions).toHaveLength(2);
    expect(diary.getDay("2026-08-20").currentVersion?.id).toBe(versions[0]?.id);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(diary.getSettings().nextRunAt?.toISOString()).toBe("2026-08-21T15:30:00.000Z");

    // 槽位已推进，同刻再 tick 不得再触发。
    await tick();
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM diary_runs").get()).toEqual({ count: 2 });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("starts the next day after rollover and backfills the missed day without re-running it", async () => {
    const { database, diary, generate, state, tick } = await setup();
    database.db.insert(uploadedFiles).values({
      id: "file-a", contentHash: "hash-a", storagePath: "files/a", originalName: "a.md",
      bytes: 1, capturedAt: new Date("2026-08-20T10:00:00.000Z"), createdAt: NOW, updatedAt: NOW,
    }).run();
    diary.updateSettings({ timezone: "Asia/Shanghai", enabled: true, localTime: "23:30" });
    await tick(); // 20:00 CST：今天的首版
    state.now = new Date(SLOT);
    database.db.update(uploadedFiles).set({ contentHash: "hash-b" }).where(eq(uploadedFiles.id, "file-a")).run();
    await tick(); // 23:30 CST：全量重生成
    expect(generate).toHaveBeenCalledTimes(2);

    // 次日 10:00 CST（模拟整夜停机后恢复/常规跨天）：新的一天开始首版，
    // 前一天已完成 → catch_up 回填复用既有结果，不得重跑。
    state.now = new Date("2026-08-21T02:00:00.000Z");
    database.db.insert(uploadedFiles).values({
      id: "file-b", contentHash: "hash-c", storagePath: "files/b", originalName: "b.md",
      bytes: 1, capturedAt: new Date("2026-08-21T01:00:00.000Z"), createdAt: state.now, updatedAt: state.now,
    }).run();
    await tick();
    expect(database.sqlite.prepare("SELECT count(*) AS count FROM diary_runs WHERE date = '2026-08-20'").get()).toEqual({ count: 2 });
    expect(diary.listVersions("2026-08-20")).toHaveLength(2);
    const nextDay = diary.getDay("2026-08-21");
    expect(nextDay.day?.status).toBe("ready");
    expect(nextDay.versions).toHaveLength(1);
    expect(database.sqlite.prepare("SELECT trigger FROM diary_runs WHERE date = '2026-08-21'").get()).toEqual({ trigger: "scheduled" });
    expect(generate).toHaveBeenCalledTimes(3);
    expect(diary.getSettings().nextRunAt?.toISOString()).toBe("2026-08-21T15:30:00.000Z");
  });
});
