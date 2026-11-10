import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase, type DatabaseClient } from "../src/infrastructure/database/client.js";
import type { AgentService } from "../src/modules/agent/service.js";
import { AgentSchedulerService } from "../src/modules/agent-scheduler/service.js";

const temporaryDirectories: string[] = [];
const databases: DatabaseClient[] = [];
const NOW = new Date("2026-08-20T12:00:00.000Z"); // 20:00 CST

async function setup(): Promise<{
  database: DatabaseClient;
  startRemoteRun: ReturnType<typeof vi.fn>;
  scheduler: AgentSchedulerService;
  state: { now: Date };
  tick: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "nxcore-scheduler-test-"));
  temporaryDirectories.push(dir);
  const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
  databases.push(database);
  const state = { now: new Date(NOW) };
  const clock = () => new Date(state.now);
  const startRemoteRun = vi.fn(async (input: { prompt: string }) => ({ id: `run-${input.prompt}` }));
  const scheduler = new AgentSchedulerService(
    database.db,
    { startRemoteRun } as unknown as AgentService,
    clock,
  );
  const tick = () => (scheduler as unknown as { tick(): Promise<void> }).tick();
  return { database, startRemoteRun, scheduler, state, tick };
}

afterEach(async () => {
  databases.splice(0).forEach((database) => database.sqlite.close());
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AgentSchedulerService", () => {
  it("只暴露用户自建日程（Phase 1 移除了 diary 内置槽位）", async () => {
    const { scheduler } = await setup();

    expect(scheduler.list()).toEqual([]);

    const created = scheduler.create({
      agentId: "main", name: "每日复盘", prompt: "总结今天的进展",
      localTime: "09:00", timezone: "Asia/Shanghai",
    });
    expect(scheduler.list().map((task) => task.id)).toEqual([created.id]);
    expect(created.builtin).toBe(false);
    // 2026-08-20 12:00Z = 20:00 CST → 下一次 09:00 CST 落在次日 01:00Z。
    expect(created.nextRunAt).toBe("2026-08-21T01:00:00.000Z");
  });

  it("到点触发用户日程并前移下一次，未启用的不触发", async () => {
    const { scheduler, startRemoteRun, state, tick } = await setup();
    const due = scheduler.create({
      agentId: "main", name: "到点任务", prompt: "做点事", localTime: "09:00", timezone: "Asia/Shanghai",
    });
    scheduler.create({
      agentId: "main", name: "停用任务", prompt: "不该跑", localTime: "09:00", timezone: "Asia/Shanghai", enabled: false,
    });

    await tick();
    expect(startRemoteRun).not.toHaveBeenCalled();

    state.now = new Date("2026-08-21T01:00:30.000Z"); // 09:00:30 CST
    await tick();
    expect(startRemoteRun).toHaveBeenCalledTimes(1);
    expect(startRemoteRun.mock.calls[0]?.[0]).toMatchObject({ prompt: "做点事", title: "到点任务" });

    const after = scheduler.list().find((task) => task.id === due.id);
    expect(after?.lastStatus).toBe("running");
    expect(after?.nextRunAt).toBe("2026-08-22T01:00:00.000Z");

    // 下一次未到：不再重复触发。
    await tick();
    expect(startRemoteRun).toHaveBeenCalledTimes(1);
  });

  it("更新带版本冲突校验，删除后不可再触发", async () => {
    const { scheduler, startRemoteRun, state, tick } = await setup();
    const created = scheduler.create({
      agentId: "main", name: "任务", prompt: "原提示", localTime: "09:00", timezone: "Asia/Shanghai",
    });

    expect(() => scheduler.update(created.id, { prompt: "改", configVersion: created.configVersion + 99 }))
      .toThrowError("agent_schedule_conflict");
    const updated = scheduler.update(created.id, { prompt: "新提示", configVersion: created.configVersion });
    expect(updated.prompt).toBe("新提示");
    expect(updated.configVersion).toBe(created.configVersion + 1);

    scheduler.remove(created.id);
    expect(scheduler.list()).toEqual([]);
    expect(() => scheduler.remove(created.id)).toThrowError("agent_schedule_not_found");

    state.now = new Date("2026-08-21T01:00:30.000Z");
    await tick();
    expect(startRemoteRun).not.toHaveBeenCalled();
  });

  it("运行期不可用时 tick 记录错误但不抛未处理拒绝", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nxcore-scheduler-test-"));
    temporaryDirectories.push(dir);
    const database = createDatabase(join(dir, "gateway.sqlite"), resolve("drizzle"));
    databases.push(database);
    const state = { now: new Date(NOW) };
    const scheduler = new AgentSchedulerService(database.db, undefined, () => new Date(state.now));
    scheduler.create({ agentId: "main", name: "任务", prompt: "p", localTime: "09:00", timezone: "Asia/Shanghai" });
    const tick = () => (scheduler as unknown as { tick(): Promise<void> }).tick();

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      state.now = new Date("2026-08-21T01:00:30.000Z");
      await expect(tick()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
