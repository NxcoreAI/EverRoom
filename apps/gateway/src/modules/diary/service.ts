import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lte, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  diaryDays,
  diaryRuns,
  diarySchedules,
  diaryVersionSources,
  diaryVersions,
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
  private readonly options: Required<Pick<DiaryServiceOptions, "ownerId" | "workerId" | "pollIntervalMs" | "leaseMs" | "maxAttempts">>;
  private readonly scheduleManagedExternally: boolean;
  private readonly generator: DiaryGenerator;
  private readonly sourceCollector: DiarySourceCollector;
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;

  constructor(private readonly db: GatewayDatabase, options: DiaryServiceOptions = {}) {
    this.options = {
      ownerId: options.ownerId ?? "local-user",
      workerId: options.workerId ?? `diary-${randomUUID()}`,
      pollIntervalMs: options.pollIntervalMs ?? 30_000,
      leaseMs: options.leaseMs ?? 30_000,
      maxAttempts: options.maxAttempts ?? 5,
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
    await this.drainPromise;
  }

  getSettings(): typeof diarySchedules.$inferSelect {
    const row = this.db.select().from(diarySchedules).where(eq(diarySchedules.ownerId, this.options.ownerId)).get();
    if (row) return row;
    const now = this.now();
    this.db.insert(diarySchedules).values({ ownerId: this.options.ownerId, timezone: DEFAULT_TIMEZONE, createdAt: now, updatedAt: now }).run();
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
    const sources = sourceRows.map((source) => {
      const file = source.assetFileId ? filesById.get(source.assetFileId) : undefined;
      return { ...source, assetKind: file?.assetKind ?? null, mime: file?.mime ?? null };
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

  createRun(date: string, trigger: "scheduled" | "catch_up" | "manual" = "manual"): string {
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
    const existing = this.db.select().from(diaryRuns).where(eq(diaryRuns.date, date)).all()
      .find((run) => run.trigger !== "manual");
    if (existing && trigger !== "manual") {
      this.logger?.debug({ event: "diary.run.reused", runId: existing.id, date, trigger, status: existing.status }, "diary run reused");
      return existing.id;
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
    const date = dateInTimezone(occurredAt, this.getSettings().timezone);
    const result = this.db.update(diaryDays).set({ status: "stale", updatedAt: this.now() })
      .where(and(eq(diaryDays.date, date), eq(diaryDays.status, "ready"))).run();
    if (result.changes > 0) {
      this.logger?.info({ event: "diary.day.marked_stale", date, reason: "source_event", occurredAt: occurredAt.toISOString() }, "diary day marked stale");
    }
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainInternal().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
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
    const start = new Date(`${enabledFrom}T00:00:00Z`);
    const cursor = new Date(start);
    const todayStart = zonedTimeToUtc(today, "00:00", settings.timezone);
    while (cursor < todayStart) { this.createRun(dateOnly(cursor), "catch_up"); cursor.setUTCDate(cursor.getUTCDate() + 1); }
    if (today >= enabledFrom && settings.nextRunAt && settings.nextRunAt <= now) {
      this.createRun(today, "scheduled");
      this.db.update(diarySchedules).set({ nextRunAt: this.nextSchedule(now, settings.localTime, settings.timezone), updatedAt: now }).where(eq(diarySchedules.ownerId, this.options.ownerId)).run();
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
      const sources = await this.sourceCollector.collect(new Date(run.windowStart), new Date(run.windowEnd));
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
      const manifest = new Map(sources.map((source) => [source.sourceId, source]));
      const generationStartedAt = Date.now();
      const payload = sources.length === 0
        ? emptyPayload(run.date, run.windowStart, run.windowEnd)
        : await this.generator.generate({
          date: run.date,
          range: { start: iso(run.windowStart), end: iso(run.windowEnd) },
          timezone: settings.timezone,
          sources,
          runId: run.id,
          readSource: async (ref) => {
            const source = manifest.get(ref);
            return source ? source.content ?? source.evidenceSummary : null;
          },
        });
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
      const sourceFingerprint = hash(sources.map((s) => [s.sourceId, s.fingerprint]));
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
      const version = this.db.select().from(diaryVersions).where(eq(diaryVersions.id, day.currentVersionId)).get();
      if (!version) continue;
      const collectionState = { memoryFailed: false };
      const collectionEnd = day.date === today && now > version.windowEnd ? now : version.windowEnd;
      const current = await this.sourceCollector.collect(version.windowStart, collectionEnd, collectionState);
      if (collectionState.memoryFailed) continue;
      const fingerprint = hash(current.map((source) => [source.sourceId, source.fingerprint]));
      if (fingerprint !== day.sourceFingerprint) {
        const result = this.db.update(diaryDays).set({ status: "stale", updatedAt: this.now() }).where(and(eq(diaryDays.date, day.date), eq(diaryDays.status, "ready"))).run();
        if (result.changes > 0) {
          this.logger?.info({ event: "diary.day.marked_stale", date: day.date, reason: "source_fingerprint", sourceCount: current.length }, "diary day marked stale");
          // A changed ready day must immediately get a new run. Using the
          // manual trigger bypasses the completed scheduled-run reuse rule.
          if (settings.enabled) this.createRun(day.date, "manual");
        }
      }
    }
  }

}
