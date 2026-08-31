import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  diaryDays,
  diaryRuns,
  diarySchedules,
  diaryVersionSources,
  diaryVersions,
  documentVersions,
  roomDocumentLinks,
  uploadedFiles,
  type DiaryPayload,
} from "../../infrastructure/database/schema.js";
import { alignDiaryEventTimes, validateDiaryPayload } from "./payload.js";
import { DiarySourceCollector } from "./source-collector.js";
import type { DiaryGenerator, DiaryServiceOptions, DiarySource } from "./types.js";
import { dateInTimezone, dateOnly, hash, iso, zonedTimeToUtc } from "./utils.js";

export type {
  DiaryGenerationInput,
  DiaryGenerator,
  DiaryMemoryProvider,
  DiaryServiceOptions,
  DiarySource,
  DiarySourceKind,
} from "./types.js";

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
// 定时总结默认开启：新装与从未配置过的老库都直接进入自动生成状态。
const DEFAULT_LOCAL_TIME = "23:30";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function isNonRetryableGenerationError(message: string): boolean {
  return message.includes("模型输出上限");
}

function defaultGenerator(): DiaryGenerator {
  return {
    model: "builtin-empty",
    async generate(input) {
      const first = input.sources[0];
      return {
        headline: first ? `${input.date} 的记录` : `${input.date} 的一天`,
        summary: first ? `这一天有 ${input.sources.length} 条可用记录。` : "这一天没有可用来源。",
        reflection: "",
        range: input.range,
        events: input.sources.slice(0, 50).map((source) => ({
          time: source.occurredAt,
          title: source.evidenceSummary.slice(0, 80) || source.kind,
          summary: source.evidenceSummary,
          sourceRefs: [source.sourceId],
        })),
        closing: "",
      };
    },
  };
}

function emptyPayload(date: string, start: Date, end: Date): DiaryPayload {
  return {
    headline: `${date} 的一天`,
    summary: "这一天没有可用来源。",
    reflection: "",
    range: { start: iso(start), end: iso(end) },
    events: [],
    closing: "",
  };
}

export class DiaryService {
  private readonly options: Required<Pick<DiaryServiceOptions, "ownerId" | "workerId" | "pollIntervalMs" | "leaseMs" | "maxAttempts" | "collectTimeoutMs" | "maxRunMs" | "autoRefreshCooldownMs" | "staleCheckIntervalMs">>;
  private readonly scheduleManagedExternally: boolean;
  private readonly generator: DiaryGenerator;
  private readonly sourceCollector: DiarySourceCollector;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private drainAgain = false;
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly staleCheckAt = new Map<string, number>();
  private readonly backfilledDates = new Set<string>();

  constructor(private readonly db: GatewayDatabase, options: DiaryServiceOptions = {}) {
    this.options = {
      ownerId: options.ownerId ?? "local-user",
      workerId: options.workerId ?? `diary-${randomUUID()}`,
      pollIntervalMs: options.pollIntervalMs ?? 30_000,
      leaseMs: options.leaseMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 5,
      collectTimeoutMs: options.collectTimeoutMs ?? 120_000,
      maxRunMs: options.maxRunMs ?? 15 * 60_000,
      autoRefreshCooldownMs: options.autoRefreshCooldownMs ?? 30 * 60_000,
      staleCheckIntervalMs: options.staleCheckIntervalMs ?? 5 * 60_000,
    };
    this.scheduleManagedExternally = options.scheduleManagedExternally ?? false;
    this.generator = options.generator ?? defaultGenerator();
    this.sourceCollector = new DiarySourceCollector(db, options.memory, options.logger);
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  private readonly now: () => Date;
  private readonly logger: Logger | undefined;

  initialize(): void {
    if (this.timer) return;
    this.recoverLeases();
    this.timer = setInterval(() => void this.drain(), this.options.pollIntervalMs);
    this.timer.unref();
    this.logger?.info({
      event: "diary.service.initialized",
      workerId: this.options.workerId,
      pollIntervalMs: this.options.pollIntervalMs,
      leaseMs: this.options.leaseMs,
      maxAttempts: this.options.maxAttempts,
      model: this.generator.model ?? null,
    }, "diary service initialized");
    void this.drain();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.refreshTimers.values()) clearTimeout(timer);
    this.refreshTimers.clear();
    this.staleCheckAt.clear();
    this.backfilledDates.clear();
    await this.drainPromise;
  }

  /** 给可能悬挂的 await 加期限：来源采集（MemoryCore）和生成（Agent 会话）
   *  卡死时，租约心跳会一直续期，运行会永久停在 running 且无自愈。 */
  private async withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    if (ms <= 0) return work;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${Math.round(ms / 1000)}s）`)), ms);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getSettings(): typeof diarySchedules.$inferSelect {
    let row = this.db.select().from(diarySchedules).where(eq(diarySchedules.ownerId, this.options.ownerId)).get();
    if (row) {
      // 老库里“从未配置过”的行（默认关闭时代自动建出、用户没动过开关）升级为
      // 默认开启；用户显式关闭过的行（configVersion 已前移或已写过 enabledFrom）
      // 不动。enabledFrom 落在升级当天，避免突然回填数月的历史日记。
      if (!row.enabled && row.enabledFrom === null && row.configVersion === 1) {
        const now = this.now();
        const timezone = row.timezone || DEFAULT_TIMEZONE;
        this.db.update(diarySchedules).set({
          enabled: true,
          enabledFrom: dateInTimezone(now, timezone),
          nextRunAt: this.nextSchedule(now, row.localTime, timezone),
          updatedAt: now,
        }).where(eq(diarySchedules.ownerId, this.options.ownerId)).run();
        this.logger?.info({ event: "diary.settings.default_enabled", timezone, localTime: row.localTime }, "diary scheduling upgraded to default-on");
        row = this.db.select().from(diarySchedules).where(eq(diarySchedules.ownerId, this.options.ownerId)).get()!;
      }
      return row;
    }
    const now = this.now();
    // 首次建行即默认开启：enabledFrom=今天、nextRunAt=下一个 23:30 槽位。
    // 只把 enabled 置 true 而缺 nextRunAt 的话，外部调度器的定时槽位永远不触发
    // （tick 只认 nextRunAt），当天之外的每日总结会静默丢失。
    this.db.insert(diarySchedules).values({
      ownerId: this.options.ownerId,
      enabled: true,
      localTime: DEFAULT_LOCAL_TIME,
      timezone: DEFAULT_TIMEZONE,
      enabledFrom: dateInTimezone(now, DEFAULT_TIMEZONE),
      nextRunAt: this.nextSchedule(now, DEFAULT_LOCAL_TIME, DEFAULT_TIMEZONE),
      createdAt: now,
      updatedAt: now,
    }).run();
    return this.db.select().from(diarySchedules).where(eq(diarySchedules.ownerId, this.options.ownerId)).get()!;
  }

  updateSettings(input: { enabled?: boolean; localTime?: string; timezone?: string; enabledFrom?: string | null; configVersion?: number }): typeof diarySchedules.$inferSelect {
    const current = this.getSettings();
    if (input.configVersion !== undefined && input.configVersion !== current.configVersion) throw new Error("diary_settings_conflict");
    if (input.localTime !== undefined && !TIME.test(input.localTime)) throw new Error("invalid_local_time");
    if (input.enabledFrom !== undefined && input.enabledFrom !== null
      && (!ISO_DATE.test(input.enabledFrom) || dateOnly(new Date(`${input.enabledFrom}T00:00:00Z`)) !== input.enabledFrom)) {
      throw new Error("invalid_enabled_from");
    }
    if (input.timezone !== undefined) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(); } catch { throw new Error("invalid_timezone"); }
    }
    const now = this.now();
    const enabled = input.enabled ?? current.enabled;
    const timezone = input.timezone ?? current.timezone;
    const enabledFrom = input.enabledFrom === undefined
      ? (enabled && !current.enabled && !current.enabledFrom ? dateInTimezone(now, timezone) : current.enabledFrom)
      : input.enabledFrom;
    this.db.update(diarySchedules).set({
      enabled, localTime: input.localTime ?? current.localTime, timezone,
      enabledFrom, nextRunAt: enabled ? this.nextSchedule(now, input.localTime ?? current.localTime, timezone) : null,
      configVersion: current.configVersion + 1, updatedAt: now,
    }).where(eq(diarySchedules.ownerId, this.options.ownerId)).run();
    const updated = this.getSettings();
    this.logger?.info({
      event: "diary.settings.updated",
      enabled: updated.enabled,
      localTime: updated.localTime,
      timezone: updated.timezone,
      enabledFrom: updated.enabledFrom,
      nextRunAt: updated.nextRunAt?.toISOString() ?? null,
      configVersion: updated.configVersion,
    }, "diary settings updated");
    if (updated.enabled) void this.drain();
    return updated;
  }

  listDays(limit = 100, offset = 0, start?: string, end?: string): Array<typeof diaryDays.$inferSelect> {
    const conditions = [
      ...(start ? [gte(diaryDays.date, start)] : []),
      ...(end ? [lte(diaryDays.date, end)] : []),
    ];
    return this.db.select().from(diaryDays).where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(diaryDays.date)).limit(limit).offset(offset).all();
  }

  getDay(date: string): {
    day: typeof diaryDays.$inferSelect | null;
    versions: Array<typeof diaryVersions.$inferSelect>;
    currentVersion: typeof diaryVersions.$inferSelect | null;
    sources: Array<typeof diaryVersionSources.$inferSelect & {
      assetKind: typeof uploadedFiles.$inferSelect["assetKind"] | null;
      mime: string | null;
      documentId: string | null;
      roomId: string | null;
      realityEventId: string | null;
    }>;
  } {
    const day = this.db.select().from(diaryDays).where(eq(diaryDays.date, date)).get() ?? null;
    const versions = day ? this.db.select().from(diaryVersions).where(eq(diaryVersions.date, date)).orderBy(desc(diaryVersions.version)).all() : [];
    const currentVersion = day?.currentVersionId
      ? this.db.select().from(diaryVersions).where(eq(diaryVersions.id, day.currentVersionId)).get() ?? null
      : null;
    const sourceRows = currentVersion
      ? this.db.select().from(diaryVersionSources).where(eq(diaryVersionSources.versionId, currentVersion.id))
        .orderBy(asc(diaryVersionSources.occurredAt)).all()
      : [];
    const filesById = new Map(this.db.select().from(uploadedFiles).all().map((file) => [file.id, file]));
    const documentVersionIds = sourceRows
      .filter((source) => source.sourceId.startsWith("document_version:"))
      .map((source) => source.sourceId.slice("document_version:".length));
    const documentTargets = new Map<string, { documentId: string; roomId: string | null }>();
    if (documentVersionIds.length) {
      const versions = this.db.select({ versionId: documentVersions.id, documentId: documentVersions.documentId })
        .from(documentVersions)
        .where(inArray(documentVersions.id, documentVersionIds)).all();
      for (const version of versions) {
        const room = this.db.select({ roomId: roomDocumentLinks.roomId })
          .from(roomDocumentLinks)
          .where(eq(roomDocumentLinks.documentId, version.documentId))
          .orderBy(asc(roomDocumentLinks.linkedAt)).get();
        documentTargets.set(version.versionId, { documentId: version.documentId, roomId: room?.roomId ?? null });
      }
    }
    const sources = sourceRows.map((source) => {
      const file = source.assetFileId ? filesById.get(source.assetFileId) : undefined;
      const documentTarget = documentTargets.get(source.sourceId.slice("document_version:".length));
      const realityEventId = source.sourceId.startsWith("recording:")
        ? source.sourceId.slice("recording:".length)
        : null;
      return {
        ...source,
        assetKind: file?.assetKind ?? null,
        mime: file?.mime ?? null,
        documentId: documentTarget?.documentId ?? null,
        roomId: documentTarget?.roomId ?? null,
        realityEventId,
      };
    });
    return { day, versions, currentVersion, sources };
  }

  listVersions(date: string): Array<typeof diaryVersions.$inferSelect> { return this.db.select().from(diaryVersions).where(eq(diaryVersions.date, date)).orderBy(desc(diaryVersions.version)).all(); }

  activate(date: string, versionId: string): typeof diaryDays.$inferSelect {
    const version = this.db.select().from(diaryVersions).where(and(eq(diaryVersions.id, versionId), eq(diaryVersions.date, date))).get();
    if (!version) throw new Error("version_not_found");
    this.db.update(diaryDays).set({ currentVersionId: version.id, status: "ready", updatedAt: this.now() }).where(eq(diaryDays.date, date)).run();
    return this.db.select().from(diaryDays).where(eq(diaryDays.date, date)).get()!;
  }

  createRun(date: string, trigger: "scheduled" | "catch_up" | "manual" | "refresh" = "manual"): string {
    if (!ISO_DATE.test(date) || dateOnly(new Date(`${date}T00:00:00Z`)) !== date) throw new Error("invalid_date");
    const active = this.db.select().from(diaryRuns).where(and(
      eq(diaryRuns.date, date),
      or(eq(diaryRuns.status, "pending"), eq(diaryRuns.status, "running")),
    )).orderBy(desc(diaryRuns.createdAt)).get();
    if (active) {
      this.logger?.info({ event: "diary.run.reused", runId: active.id, date, trigger, status: active.status }, "active diary run reused");
      return active.id;
    }
    const settings = this.getSettings();
    const start = zonedTimeToUtc(date, "00:00", settings.timezone);
    const now = this.now();
    const end = dateInTimezone(now, settings.timezone) === date ? now : zonedTimeToUtc(date, "24:00", settings.timezone);
    // catch_up 只做幂等回填：已有非手动运行（含 refresh）且未失败的日子直接复用，
    // 不重建。失败的日子允许重建重试（每进程一次，见 backfillMissedDays）。
    // scheduled 每天的定时槽位必须建新运行，否则被当天早前的运行堵死、永不刷新。
    if (trigger === "catch_up") {
      const existing = this.db.select().from(diaryRuns).where(eq(diaryRuns.date, date)).all()
        .find((run) => run.trigger !== "manual" && run.status !== "failed");
      if (existing) {
        this.logger?.debug({ event: "diary.run.reused", runId: existing.id, date, trigger, status: existing.status }, "diary run reused");
        return existing.id;
      }
    }
    const runId = randomUUID();
    this.db.insert(diaryDays).values({ date, status: "pending", createdAt: now, updatedAt: now }).onConflictDoNothing().run();
    this.db.insert(diaryRuns).values({ id: runId, date, trigger, windowStart: start, windowEnd: end, nextAttemptAt: now, createdAt: now }).run();
    this.logger?.info({
      event: "diary.run.created",
      runId,
      date,
      trigger,
      timezone: settings.timezone,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
    }, "diary run created");
    return runId;
  }

  getRun(id: string): typeof diaryRuns.$inferSelect | null { return this.db.select().from(diaryRuns).where(eq(diaryRuns.id, id)).get() ?? null; }

  getLatestRun(): typeof diaryRuns.$inferSelect | null {
    return this.db.select().from(diaryRuns).orderBy(desc(diaryRuns.createdAt)).get() ?? null;
  }

  currentDate(): string {
    const settings = this.getSettings();
    return dateInTimezone(this.now(), settings.timezone);
  }

  /** Queue the current local day as soon as scheduling is enabled.
   * The configured daily time remains the later refresh point; it must not
   * prevent the first version of today's diary from appearing during the day.
   */
  ensureCurrentDayRun(): string | null {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    const date = dateInTimezone(this.now(), settings.timezone);
    const day = this.db.select().from(diaryDays).where(eq(diaryDays.date, date)).get();
    const latestRun = this.db.select().from(diaryRuns).where(eq(diaryRuns.date, date)).orderBy(desc(diaryRuns.createdAt)).get();
    if (latestRun && (latestRun.status === "pending" || latestRun.status === "running")) return null;
    // A day that was manually/previously generated before auto-generation was
    // enabled must get one scheduled refresh, even if it already has an empty
    // or stale version.
    if (day && latestRun?.trigger === "scheduled" && latestRun.createdAt >= settings.updatedAt) return null;
    return this.createRun(date, "scheduled");
  }

  advanceSchedule(now = this.now()): void {
    const settings = this.getSettings();
    if (!settings.enabled) return;
    this.db.update(diarySchedules).set({ nextRunAt: this.nextSchedule(now, settings.localTime, settings.timezone), updatedAt: now })
      .where(eq(diarySchedules.ownerId, this.options.ownerId)).run();
  }

  getActiveRun(): typeof diaryRuns.$inferSelect | null {
    return this.db.select().from(diaryRuns).where(or(
      eq(diaryRuns.status, "pending"),
      eq(diaryRuns.status, "running"),
    )).orderBy(desc(diaryRuns.createdAt)).get() ?? null;
  }

  markStaleAt(occurredAt: Date): void {
    const settings = this.getSettings();
    if (!settings.enabled) return;
    const date = dateInTimezone(occurredAt, settings.timezone);
    const result = this.db.update(diaryDays).set({ status: "stale", updatedAt: this.now() })
      .where(and(eq(diaryDays.date, date), eq(diaryDays.status, "ready"))).run();
    if (result.changes > 0) {
      this.logger?.info({ event: "diary.day.marked_stale", date, reason: "source_event", occurredAt: occurredAt.toISOString() }, "diary day marked stale");
    }
    // Source sinks can fire several times while a recording/perception job is
    // being finalized. Coalesce them into one refresh and let createRun reuse
    // an already pending/running run.
    if (this.refreshTimers.has(date)) return;
    const timer = setTimeout(() => {
      this.refreshTimers.delete(date);
      this.queueAutoRefresh(date);
    }, 1_000);
    timer.unref();
    this.refreshTimers.set(date, timer);
  }

  /** 自动刷新入口（感知完成/来源变化触发）：带每日期冷却。没有冷却时，
   *  活跃白天每个 30s 巡检周期都会重新生成一次当日日记，版本无限膨胀。 */
  private queueAutoRefresh(date: string): void {
    const settings = this.getSettings();
    if (!settings.enabled) return;
    const latest = this.db.select().from(diaryRuns).where(eq(diaryRuns.date, date)).orderBy(desc(diaryRuns.createdAt)).get();
    if (latest && (latest.status === "pending" || latest.status === "running")) return;
    const lastFinishedAt = latest?.finishedAt ?? latest?.createdAt;
    if (lastFinishedAt && this.now().getTime() - lastFinishedAt.getTime() < this.options.autoRefreshCooldownMs) return;
    this.createRun(date, "refresh");
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.drainPromise) {
      // 已有 drain 在飞：标记补扫并让调用方等待完整循环。否则运行创建于本轮
      // due 查询之后时，调用方拿到的 promise 不覆盖它，只能等 30s 轮询捡起
      // （updateSettings 的 void drain() 与手动生成路由都会踩中这个窗口）。
      this.drainAgain = true;
      return this.drainPromise;
    }
    const execution = (async () => {
      try {
        do {
          this.drainAgain = false;
          await this.drainInternal();
        } while (this.drainAgain);
      } finally {
        this.drainPromise = null;
      }
    })();
    this.drainPromise = execution;
    return execution;
  }

  private async drainInternal(): Promise<void> {
    this.recoverLeases();
    this.scheduleDueRuns();
    await this.markChangedDaysStale();
    const now = this.now();
    const due = this.db.select().from(diaryRuns).where(and(
      eq(diaryRuns.status, "pending"), lte(diaryRuns.nextAttemptAt, now),
      or(isNull(diaryRuns.leaseExpiresAt), lt(diaryRuns.leaseExpiresAt, now)),
    )).orderBy(asc(diaryRuns.date), asc(diaryRuns.createdAt)).limit(10).all();
    if (due.length > 0) {
      this.logger?.info({ event: "diary.queue.batch_started", runCount: due.length, runIds: due.map((run) => run.id) }, "diary queue batch started");
    }
    for (const run of due) await this.process(run.id);
  }

  private recoverLeases(): void {
    const now = this.now();
    const result = this.db.update(diaryRuns).set({ status: "pending", leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: now }).where(and(
      eq(diaryRuns.status, "running"), or(isNull(diaryRuns.leaseExpiresAt), lte(diaryRuns.leaseExpiresAt, now)),
    )).run();
    if (result.changes > 0) {
      this.logger?.warn({ event: "diary.lease.recovered", runCount: result.changes }, "expired diary run leases recovered");
    }
  }

  private scheduleDueRuns(): void {
    if (this.scheduleManagedExternally) return;
    const settings = this.getSettings();
    if (!settings.enabled) return;
    const now = this.now();
    const today = dateInTimezone(now, settings.timezone);
    const enabledFrom = settings.enabledFrom && ISO_DATE.test(settings.enabledFrom) ? settings.enabledFrom : today;
    this.backfillMissedDays(now);
    if (today >= enabledFrom && settings.nextRunAt && settings.nextRunAt <= now) {
      this.createRun(today, "scheduled");
      this.db.update(diarySchedules).set({ nextRunAt: this.nextSchedule(now, settings.localTime, settings.timezone), updatedAt: now }).where(eq(diarySchedules.ownerId, this.options.ownerId)).run();
    }
  }

  /** 补齐 enabledFrom→昨天 的漏跑日（外部调度器的回填入口，内部调度同样复用）。
   *  幂等：已完成/进行中的日子由 createRun 复用；失败的日子每个进程生命周期
   *  只重排一次，避免定时循环对失败日无限重试。 */
  backfillMissedDays(now = this.now()): void {
    const settings = this.getSettings();
    if (!settings.enabled || !settings.enabledFrom || !ISO_DATE.test(settings.enabledFrom)) return;
    const todayStart = zonedTimeToUtc(dateInTimezone(now, settings.timezone), "00:00", settings.timezone);
    const cursor = new Date(`${settings.enabledFrom}T00:00:00Z`);
    while (cursor < todayStart) {
      const date = dateOnly(cursor);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (this.backfilledDates.has(date)) continue;
      this.backfilledDates.add(date);
      this.createRun(date, "catch_up");
    }
  }

  private nextSchedule(now: Date, localTime: string, timezone: string): Date {
    const today = dateInTimezone(now, timezone);
    let next = zonedTimeToUtc(today, localTime, timezone);
    if (next <= now) { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); next = zonedTimeToUtc(dateOnly(d), localTime, timezone); }
    return next;
  }

  private async process(id: string): Promise<void> {
    const now = this.now();
    const candidate = this.getRun(id);
    if (!candidate || candidate.status !== "pending") return;
    const claimed = this.db.update(diaryRuns).set({ status: "running", attempt: candidate.attempt + 1, leaseOwner: this.options.workerId, leaseExpiresAt: new Date(now.getTime() + this.options.leaseMs), startedAt: candidate.startedAt ?? now }).where(and(eq(diaryRuns.id, id), eq(diaryRuns.status, "pending"))).run();
    if (claimed.changes !== 1) return;
    const processStartedAt = Date.now();
    this.logger?.info({
      event: "diary.run.started",
      runId: id,
      date: candidate.date,
      trigger: candidate.trigger,
      attempt: candidate.attempt + 1,
    }, "diary run started");
    this.db.update(diaryDays).set({ status: "generating", lastError: null, updatedAt: now }).where(eq(diaryDays.date, candidate.date)).run();
    const heartbeat = setInterval(() => {
      this.db.update(diaryRuns).set({ leaseExpiresAt: new Date(this.now().getTime() + this.options.leaseMs) }).where(and(
        eq(diaryRuns.id, id), eq(diaryRuns.status, "running"), eq(diaryRuns.leaseOwner, this.options.workerId),
      )).run();
    }, Math.max(250, Math.floor(this.options.leaseMs / 3)));
    heartbeat.unref();
    try {
      let run = this.getRun(id)!;
      const settings = this.getSettings();
      if (dateInTimezone(now, settings.timezone) === run.date && run.windowEnd.getTime() !== now.getTime()) {
        this.db.update(diaryRuns).set({ windowEnd: now }).where(eq(diaryRuns.id, id)).run();
        run = this.getRun(id)!;
      }
      const completedVersion = this.db.select().from(diaryVersions).where(eq(diaryVersions.runId, run.id)).get();
      if (completedVersion) {
        this.logger?.info({ event: "diary.run.version_reused", runId: id, versionId: completedVersion.id, version: completedVersion.version }, "existing diary version reused");
        this.finishRun(run, completedVersion);
        return;
      }
      const sources = await this.withTimeout(
        this.sourceCollector.collect(new Date(run.windowStart), new Date(run.windowEnd)),
        this.options.collectTimeoutMs,
        "日记来源采集",
      );
      const sourceKinds = sources.reduce<Record<string, number>>((counts, source) => {
        counts[source.kind] = (counts[source.kind] ?? 0) + 1;
        return counts;
      }, {});
      this.logger?.info({
        event: "diary.sources.collected",
        runId: id,
        sourceCount: sources.length,
        sourceKinds,
        usesAgent: sources.length > 0,
      }, "diary sources collected");
      const sourceFingerprint = hash(sources.map((s) => [s.sourceId, s.fingerprint]));
      // 非用户触发的运行（调度/回填/自动刷新）：来源与当前版本一致时直接复用，
      // 不再烧一次 Agent 产出内容相同的新版本。手动“重新生成”不受此影响。
      if (run.trigger !== "manual") {
        const dayRow = this.db.select().from(diaryDays).where(eq(diaryDays.date, run.date)).get();
        const currentVersion = dayRow?.currentVersionId
          ? this.db.select().from(diaryVersions).where(eq(diaryVersions.id, dayRow.currentVersionId)).get()
          : null;
        if (currentVersion?.sourceFingerprint === sourceFingerprint) {
          this.logger?.info({ event: "diary.run.sources_unchanged", runId: id, date: run.date, versionId: currentVersion.id }, "diary sources unchanged; current version reused");
          this.finishRun(run, currentVersion);
          return;
        }
      }
      const manifest = new Map(sources.map((source) => [source.sourceId, source]));
      const generationStartedAt = Date.now();
      const payload = sources.length === 0
        ? emptyPayload(run.date, run.windowStart, run.windowEnd)
        : await this.withTimeout(this.generator.generate({
          date: run.date,
          range: { start: iso(run.windowStart), end: iso(run.windowEnd) },
          timezone: settings.timezone,
          sources,
          runId: run.id,
          readSource: async (ref) => {
            const source = manifest.get(ref);
            return source ? source.content ?? source.evidenceSummary : null;
          },
        }), this.options.maxRunMs, "日记生成");
      this.logger?.info({
        event: "diary.payload.generated",
        runId: id,
        mode: sources.length === 0 ? "empty" : "agent",
        model: sources.length === 0 ? null : this.generator.model ?? null,
        eventCount: payload.events.length,
        elapsedMs: Date.now() - generationStartedAt,
      }, "diary payload generated");
      const range = { windowStart: new Date(run.windowStart), windowEnd: new Date(run.windowEnd) };
      validateDiaryPayload(payload, range, manifest);
      const correctedTimes = alignDiaryEventTimes(payload, manifest);
      if (correctedTimes > 0) {
        this.logger?.info({ event: "diary.payload.times_aligned", runId: id, correctedEventCount: correctedTimes }, "diary event times aligned to evidence");
      }
      validateDiaryPayload(payload, range, manifest);
      const versionId = randomUUID();
      this.db.transaction((tx) => {
        tx.insert(diaryVersions).values({ id: versionId, date: run.date, version: (this.listVersions(run.date)[0]?.version ?? 0) + 1, content: payload, windowStart: run.windowStart, windowEnd: run.windowEnd, sourceFingerprint, agentModel: this.generator.model ?? null, runId: run.id }).run();
        for (const source of sources) tx.insert(diaryVersionSources).values({ versionId, sourceId: source.sourceId, sourceKind: source.kind, sourceVersion: source.version, occurredAt: new Date(source.occurredAt), endedAt: source.endedAt ? new Date(source.endedAt) : null, timeBasis: source.timeBasis ?? "recorded_at", contentFingerprint: source.fingerprint, evidenceSummary: source.evidenceSummary, assetFileId: source.assetFileId ?? null }).run();
      });
      const version = this.db.select().from(diaryVersions).where(eq(diaryVersions.id, versionId)).get()!;
      this.finishRun(run, version);
    } catch (error) {
      const run = this.getRun(id); if (!run) return;
      const message = error instanceof Error ? error.message : String(error);
      const terminal = run.attempt >= this.options.maxAttempts || isNonRetryableGenerationError(message);
      this.db.update(diaryRuns).set({
        status: terminal ? "failed" : "pending",
        nextAttemptAt: new Date(this.now().getTime() + Math.min(300_000, 1_000 * 2 ** Math.max(0, run.attempt - 1))),
        leaseOwner: null,
        leaseExpiresAt: null,
        error: message,
        finishedAt: terminal ? this.now() : null,
      }).where(eq(diaryRuns.id, id)).run();
      if (terminal) this.db.update(diaryDays).set({ status: "failed", lastError: message, updatedAt: this.now() }).where(eq(diaryDays.date, run.date)).run();
      this.logger?.warn({
        event: "diary.run.failed",
        runId: id,
        date: run.date,
        attempt: run.attempt,
        terminal,
        error: message,
        elapsedMs: Date.now() - processStartedAt,
      }, "diary run failed");
    } finally {
      clearInterval(heartbeat);
    }
  }

  private finishRun(run: typeof diaryRuns.$inferSelect, version: typeof diaryVersions.$inferSelect): void {
    const finishedAt = this.now();
    this.db.update(diaryRuns).set({ status: "completed", versionId: version.id, leaseOwner: null, leaseExpiresAt: null, finishedAt, error: null }).where(eq(diaryRuns.id, run.id)).run();
    this.db.update(diaryDays).set({ status: "ready", currentVersionId: version.id, sourceFingerprint: version.sourceFingerprint, eventCount: version.content.events.length, lastError: null, updatedAt: finishedAt }).where(eq(diaryDays.date, run.date)).run();
    this.logger?.info({
      event: "diary.run.completed",
      runId: run.id,
      date: run.date,
      versionId: version.id,
      version: version.version,
      sourceCount: this.db.select().from(diaryVersionSources).where(eq(diaryVersionSources.versionId, version.id)).all().length,
      eventCount: version.content.events.length,
      elapsedMs: run.startedAt ? Math.max(0, finishedAt.getTime() - run.startedAt.getTime()) : null,
    }, "diary run completed");
  }

  private async markChangedDaysStale(): Promise<void> {
    const ready = this.db.select().from(diaryDays).where(eq(diaryDays.status, "ready")).all();
    const settings = this.getSettings();
    const now = this.now();
    const today = dateInTimezone(now, settings.timezone);
    for (const day of ready) {
      if (!day.currentVersionId || !day.sourceFingerprint) continue;
      // 稳态下 ready 日子的指纹不变，但每次巡检都要全量采集（含 yjs materialize
      //  和 connector 全表扫描）。每个日子限频复查，把 30s 一轮的 CPU 烧掉的部分
      //  摊薄；新源到达的即时标记由 markStaleAt 负责，不受此间隔影响。
      if (now.getTime() - (this.staleCheckAt.get(day.date) ?? 0) < this.options.staleCheckIntervalMs) continue;
      const version = this.db.select().from(diaryVersions).where(eq(diaryVersions.id, day.currentVersionId)).get();
      if (!version) continue;
      const collectionState = { memoryFailed: false };
      const collectionEnd = day.date === today && now > version.windowEnd ? now : version.windowEnd;
      const current = await this.sourceCollector.collect(version.windowStart, collectionEnd, collectionState);
      if (collectionState.memoryFailed) continue;
      this.staleCheckAt.set(day.date, now.getTime());
      const fingerprint = hash(current.map((source) => [source.sourceId, source.fingerprint]));
      if (fingerprint !== day.sourceFingerprint) {
        const result = this.db.update(diaryDays).set({ status: "stale", updatedAt: this.now() }).where(and(eq(diaryDays.date, day.date), eq(diaryDays.status, "ready"))).run();
        if (result.changes > 0) {
          this.logger?.info({ event: "diary.day.marked_stale", date: day.date, reason: "source_fingerprint", sourceCount: current.length }, "diary day marked stale");
          this.queueAutoRefresh(day.date);
        }
      }
    }
  }

}
