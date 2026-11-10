import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentSchedules } from "../../infrastructure/database/schema.js";
import type { AgentService } from "../agent/service.js";
import { dateInTimezone, zonedTimeToUtc } from "../../infrastructure/time/zone-time.js";

export interface AgentScheduledTask {
  id: string;
  agentId: string;
  name: string;
  description: string;
  prompt?: string;
  enabled: boolean;
  builtin: boolean;
  scheduleType: "daily";
  localTime: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: "pending" | "running" | "completed" | "failed" | null;
  lastError: string | null;
  configVersion: number;
}

export interface CreateAgentScheduleInput {
  agentId: string;
  name: string;
  description?: string;
  prompt: string;
  localTime?: string;
  timezone?: string;
  enabled?: boolean;
}

type SchedulePatch = Partial<Pick<CreateAgentScheduleInput, "name" | "description" | "prompt" | "enabled" | "localTime" | "timezone">> & { configVersion: number };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function nextDaily(localTime: string, timezone: string, now = new Date()): Date {
  const localDate = dateInTimezone(now, timezone);
  let next = zonedTimeToUtc(localDate, localTime, timezone);
  if (next.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.parse(`${localDate}T12:00:00Z`) + 86_400_000);
    next = zonedTimeToUtc(dateInTimezone(tomorrow, timezone), localTime, timezone);
  }
  return next;
}

function customTask(row: typeof agentSchedules.$inferSelect): AgentScheduledTask {
  return {
    id: row.id, agentId: row.agentId, name: row.name, description: row.description, prompt: row.prompt,
    enabled: row.enabled, builtin: false, scheduleType: row.scheduleType, localTime: row.localTime,
    timezone: row.timezone, nextRunAt: row.nextRunAt?.toISOString() ?? null, lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus, lastError: row.lastError, configVersion: row.configVersion,
  };
}

export class AgentSchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly agent?: AgentService,
    /** 可注入时钟：tick 的到点判定与 due 查询走它，测试里可固定推进。 */
    private readonly now: () => Date = () => new Date(),
  ) {}

  initialize(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickPromise;
  }

  /** Phase 1：日记内置日程已移除，这里只返回用户自建日程。 */
  list(): AgentScheduledTask[] {
    return this.db.select().from(agentSchedules).orderBy(agentSchedules.createdAt).all().map(customTask);
  }

  create(input: CreateAgentScheduleInput): AgentScheduledTask {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const localTime = input.localTime ?? "09:00";
    const timezone = input.timezone ?? "UTC";
    if (!name || !prompt || !input.agentId.trim()) throw new Error("agent_schedule_invalid_input");
    if (!TIME.test(localTime)) throw new Error("agent_schedule_invalid_time");
    // 与 tick 用同一个时钟：否则注入时钟的测试/巡检会在真实 wall clock 上错位。
    const now = this.now();
    const row = this.db.insert(agentSchedules).values({
      id: `schedule-${randomUUID()}`, agentId: input.agentId.trim(), name,
      description: input.description?.trim() ?? "", prompt, scheduleType: "daily",
      enabled: input.enabled ?? true, localTime, timezone,
      nextRunAt: (input.enabled ?? true) ? nextDaily(localTime, timezone, now) : null,
      createdAt: now, updatedAt: now,
    }).returning().get();
    return customTask(row);
  }

  update(id: string, input: SchedulePatch): AgentScheduledTask {
    const current = this.db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).get();
    if (!current) throw new Error("agent_schedule_not_found");
    if (input.configVersion !== current.configVersion) throw new Error("agent_schedule_conflict");
    const enabled = input.enabled ?? current.enabled;
    const localTime = input.localTime ?? current.localTime;
    const timezone = input.timezone ?? current.timezone;
    if (!TIME.test(localTime)) throw new Error("agent_schedule_invalid_time");
    const row = this.db.update(agentSchedules).set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.prompt !== undefined ? { prompt: input.prompt.trim() } : {}),
      enabled, localTime, timezone,
      nextRunAt: enabled ? nextDaily(localTime, timezone, this.now()) : null,
      configVersion: current.configVersion + 1, updatedAt: this.now(),
    }).where(eq(agentSchedules.id, id)).returning().get();
    return customTask(row!);
  }

  remove(id: string): void {
    const result = this.db.delete(agentSchedules).where(eq(agentSchedules.id, id)).run();
    if (result.changes === 0) throw new Error("agent_schedule_not_found");
  }

  async runNow(id: string): Promise<{ runId: string }> {
    const row = this.db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).get();
    if (!row) throw new Error("agent_schedule_not_found");
    if (!this.agent) throw new Error("agent_scheduler_runtime_unavailable");
    const run = await this.agent.startRemoteRun({
      commandId: `${id}-${Date.now()}`,
      idempotencyKey: `${id}-${Date.now()}-${randomUUID()}`,
      prompt: row.prompt,
      title: row.name,
    });
    const now = this.now();
    this.db.update(agentSchedules).set({ lastRunAt: now, lastStatus: "running", lastError: null, nextRunAt: nextDaily(row.localTime, row.timezone, now), updatedAt: now }).where(eq(agentSchedules.id, id)).run();
    return { runId: run.id };
  }

  private async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      // 顶层兜底：tick 由 void 调用（30s 一跳），任何未接住的异常都是未处理
      // 拒绝、直接杀死网关进程（2026-10-17 排障：线上频繁死亡根因）。任务行
      // 单独 catch，单个坏任务不阻塞同轮其他任务。
      try {
        const due = this.db.select().from(agentSchedules).where(and(eq(agentSchedules.enabled, true), lte(agentSchedules.nextRunAt, this.now()))).all();
        for (const row of due) {
          try {
            await this.runNow(row.id);
          } catch (error) {
            // runNow 失败不前移 nextRunAt，下轮 30s 重试；只记日志不中断其他任务。
            console.error(`[agent-scheduler] schedule ${row.id} 运行失败：`, error);
          }
        }
      } catch (error) {
        console.error("[agent-scheduler] 定时巡检失败（下轮重试）：", error);
      }
    })().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
}
