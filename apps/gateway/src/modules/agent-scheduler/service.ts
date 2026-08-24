import { randomUUID } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { agentSchedules } from "../../infrastructure/database/schema.js";
import type { AgentService } from "../agent/service.js";
import { dateInTimezone, zonedTimeToUtc } from "../diary/utils.js";
import type { DiaryService } from "../diary/service.js";

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

const BUILTIN_ID = "diary.daily";
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
    private readonly diary: DiaryService,
    private readonly agent?: AgentService,
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

  list(): AgentScheduledTask[] {
    const settings = this.diary.getSettings();
    const run = this.diary.getLatestRun();
    const builtin: AgentScheduledTask = {
      id: BUILTIN_ID, agentId: "diary", name: "每日整理日记",
      description: "汇总当天的记忆、录音、现实感知和文档来源",
      enabled: settings.enabled, builtin: true, scheduleType: "daily", localTime: settings.localTime,
      timezone: settings.timezone, nextRunAt: settings.nextRunAt?.toISOString() ?? null,
      lastRunAt: run?.finishedAt?.toISOString() ?? run?.createdAt?.toISOString() ?? null,
      lastStatus: run?.status ?? null, lastError: run?.error ?? null, configVersion: settings.configVersion,
    };
    return [builtin, ...this.db.select().from(agentSchedules).orderBy(agentSchedules.createdAt).all().map(customTask)];
  }

  create(input: CreateAgentScheduleInput): AgentScheduledTask {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    const localTime = input.localTime ?? "09:00";
    const timezone = input.timezone ?? "UTC";
    if (!name || !prompt || !input.agentId.trim()) throw new Error("agent_schedule_invalid_input");
    if (!TIME.test(localTime)) throw new Error("agent_schedule_invalid_time");
    const now = new Date();
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
    if (id === BUILTIN_ID) {
      this.diary.updateSettings(input);
      return this.list()[0]!;
    }
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
      nextRunAt: enabled ? nextDaily(localTime, timezone) : null,
      configVersion: current.configVersion + 1, updatedAt: new Date(),
    }).where(eq(agentSchedules.id, id)).returning().get();
    return customTask(row!);
  }

  remove(id: string): void {
    if (id === BUILTIN_ID) throw new Error("agent_schedule_builtin");
    const result = this.db.delete(agentSchedules).where(eq(agentSchedules.id, id)).run();
    if (result.changes === 0) throw new Error("agent_schedule_not_found");
  }

  async runNow(id: string): Promise<{ runId: string }> {
    if (id === BUILTIN_ID) {
      const runId = this.diary.createRun(this.diary.currentDate(), "manual");
      // Queue the diary generation and return immediately. Generation may
      // scan many sources or call a model, so waiting here makes the desktop
      // button appear frozen and can exceed the HTTP request timeout.
      void this.diary.drain();
      return { runId };
    }
    const row = this.db.select().from(agentSchedules).where(eq(agentSchedules.id, id)).get();
    if (!row) throw new Error("agent_schedule_not_found");
    if (!this.agent) throw new Error("agent_scheduler_runtime_unavailable");
    const run = await this.agent.startRemoteRun({
      commandId: `${id}-${Date.now()}`,
      idempotencyKey: `${id}-${Date.now()}-${randomUUID()}`,
      prompt: row.prompt,
      title: row.name,
    });
    this.db.update(agentSchedules).set({ lastRunAt: new Date(), lastStatus: "running", lastError: null, nextRunAt: nextDaily(row.localTime, row.timezone), updatedAt: new Date() }).where(eq(agentSchedules.id, id)).run();
    return { runId: run.id };
  }

  private async tick(): Promise<void> {
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = (async () => {
      const task = this.list()[0]!;
      const currentDayRunId = task.enabled ? this.diary.ensureCurrentDayRun() : null;
      if (currentDayRunId) await this.diary.drain();
      if (task.enabled && task.nextRunAt && new Date(task.nextRunAt) <= new Date()) {
        this.diary.createRun(this.diary.currentDate(), "scheduled");
        this.diary.advanceSchedule();
        await this.diary.drain();
      }
      const due = this.db.select().from(agentSchedules).where(and(eq(agentSchedules.enabled, true), lte(agentSchedules.nextRunAt, new Date()))).all();
      for (const row of due) await this.runNow(row.id);
    })().finally(() => { this.tickPromise = null; });
    return this.tickPromise;
  }
}
