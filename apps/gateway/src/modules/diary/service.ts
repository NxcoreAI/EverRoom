import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lte, lt, or } from "drizzle-orm";
import type { Logger } from "pino";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import {
  connectorCalendarEvents,
  connectorDocuments,
  connectorEmails,
  diaryDays,
  diaryRuns,
  diarySchedules,
  diaryVersionSources,
  diaryVersions,
  documentVersions,
  documents,
  parsedContents,
  realityEvents,
  uploadedFiles,
  visualNodes,
  visualObservations,
  type DiaryPayload,
} from "../../infrastructure/database/schema.js";

export type DiarySourceKind = "document_version" | "file" | "visual_node" | "recording" | "connector_email" | "connector_document" | "connector_calendar" | "memory";

export interface DiarySource {
  sourceId: string;
  kind: DiarySourceKind;
  version: string;
  occurredAt: string;
  endedAt?: string;
  timeBasis?: string;
  fingerprint: string;
  evidenceSummary: string;
  assetFileId?: string;
  content?: string;
}

export interface DiaryGenerationInput {
  date: string;
  range: { start: string; end: string };
  timezone: string;
  sources: DiarySource[];
  readSource: (sourceId: string) => Promise<string | null>;
  runId: string;
}

export interface DiaryGenerator {
  model?: string;
  generate(input: DiaryGenerationInput): Promise<DiaryPayload>;
}

export interface DiaryMemoryProvider {
  query?: (input: { start: Date; end: Date }) => Promise<DiarySource[]>;
}

export interface DiaryServiceOptions {
  generator?: DiaryGenerator | undefined;
  memory?: DiaryMemoryProvider | undefined;
  ownerId?: string;
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
  now?: () => Date;
  logger?: Logger;
}

const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function iso(date: Date): string { return date.toISOString(); }
function dateOnly(date: Date): string { return date.toISOString().slice(0, 10); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function clampDate(value: Date, minimum: Date, maximum: Date): Date {
  return new Date(Math.min(maximum.getTime(), Math.max(minimum.getTime(), value.getTime())));
}

function localParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}

function zonedTimeToUtc(date: string, time: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let result = new Date(target);
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(result, timezone);
    const observed = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    result = new Date(target + (target - observed));
  }
  return result;
}

function dateInTimezone(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  return `${String(p.year!).padStart(4, "0")}-${String(p.month!).padStart(2, "0")}-${String(p.day!).padStart(2, "0")}`;
}

export function localDateTime(date: Date, timezone: string): string {
  const p = localParts(date, timezone);
  return `${String(p.year!).padStart(4, "0")}-${String(p.month!).padStart(2, "0")}-${String(p.day!).padStart(2, "0")} ${String(p.hour!).padStart(2, "0")}:${String(p.minute!).padStart(2, "0")}:${String(p.second!).padStart(2, "0")}`;
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

function sourceRef(kind: string, id: string): string { return `${kind}:${id}`; }
function textFromJson(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromJson).filter(Boolean).join(" ");
  if (value && typeof value === "object") return Object.values(value).map(textFromJson).filter(Boolean).join(" ");
  return "";
}

export class DiaryService {
  private readonly options: Required<Pick<DiaryServiceOptions, "ownerId" | "workerId" | "pollIntervalMs" | "leaseMs" | "maxAttempts">>;
  private readonly generator: DiaryGenerator;
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
    this.generator = options.generator ?? defaultGenerator();
    this.memory = options.memory;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger;
  }

  private readonly memory: DiaryMemoryProvider | undefined;
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
      const sources = await this.collectSources(new Date(run.windowStart), new Date(run.windowEnd));
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
        : await this.generator.generate({ date: run.date, range: { start: iso(run.windowStart), end: iso(run.windowEnd) }, timezone: settings.timezone, sources, runId: run.id, readSource: async (ref) => manifest.get(ref)?.content ?? null });
      this.logger?.info({
        event: "diary.payload.generated",
        runId: id,
        mode: sources.length === 0 ? "empty" : "agent",
        model: sources.length === 0 ? null : this.generator.model ?? null,
        eventCount: payload.events.length,
        elapsedMs: Date.now() - generationStartedAt,
      }, "diary payload generated");
      this.validatePayload(payload, run, manifest);
      const correctedTimes = this.alignEventTimesToSources(payload, manifest);
      if (correctedTimes > 0) {
        this.logger?.info({ event: "diary.payload.times_aligned", runId: id, correctedEventCount: correctedTimes }, "diary event times aligned to evidence");
      }
      this.validatePayload(payload, run, manifest);
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
      const terminal = run.attempt >= this.options.maxAttempts;
      this.db.update(diaryRuns).set({ status: terminal ? "failed" : "pending", nextAttemptAt: new Date(this.now().getTime() + Math.min(300_000, 1_000 * 2 ** Math.max(0, run.attempt - 1))), leaseOwner: null, leaseExpiresAt: null, error: message }).where(eq(diaryRuns.id, id)).run();
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
    for (const day of ready) {
      if (!day.currentVersionId || !day.sourceFingerprint) continue;
      const version = this.db.select().from(diaryVersions).where(eq(diaryVersions.id, day.currentVersionId)).get();
      if (!version) continue;
      const memoryState = { failed: false };
      const current = await this.collectSources(version.windowStart, version.windowEnd, memoryState);
      if (memoryState.failed) continue;
      const fingerprint = hash(current.map((source) => [source.sourceId, source.fingerprint]));
      if (fingerprint !== day.sourceFingerprint) {
        const result = this.db.update(diaryDays).set({ status: "stale", updatedAt: this.now() }).where(and(eq(diaryDays.date, day.date), eq(diaryDays.status, "ready"))).run();
        if (result.changes > 0) {
          this.logger?.info({ event: "diary.day.marked_stale", date: day.date, reason: "source_fingerprint", sourceCount: current.length }, "diary day marked stale");
        }
      }
    }
  }

  private validatePayload(payload: DiaryPayload, run: typeof diaryRuns.$inferSelect, manifest: Map<string, DiarySource>): void {
    if (!payload || typeof payload.headline !== "string" || typeof payload.summary !== "string" || typeof payload.reflection !== "string" || typeof payload.closing !== "string" || !payload.range || !Array.isArray(payload.events)) throw new Error("invalid_diary_payload");
    if (payload.range.start !== iso(new Date(run.windowStart)) || payload.range.end !== iso(new Date(run.windowEnd))) throw new Error("invalid_diary_range");
    for (const event of payload.events) {
      if (!event || typeof event.time !== "string" || (event.endTime !== undefined && typeof event.endTime !== "string") || typeof event.title !== "string" || typeof event.summary !== "string"
        || !Array.isArray(event.sourceRefs) || event.sourceRefs.length === 0
        || event.sourceRefs.some((ref) => typeof ref !== "string" || !manifest.has(ref))
        || (event.tags !== undefined && (!Array.isArray(event.tags) || event.tags.some((tag) => typeof tag !== "string")))) {
        throw new Error("invalid_diary_event");
      }
      const time = new Date(event.time);
      if (Number.isNaN(time.getTime()) || time < new Date(run.windowStart) || time >= new Date(run.windowEnd)) throw new Error("event_outside_window");
      if (event.endTime !== undefined) {
        const endTime = new Date(event.endTime);
        if (Number.isNaN(endTime.getTime()) || endTime < time || endTime > new Date(run.windowEnd)) throw new Error("invalid_diary_event_range");
      }
    }
  }

  private alignEventTimesToSources(payload: DiaryPayload, manifest: Map<string, DiarySource>): number {
    let corrected = 0;
    for (const event of payload.events) {
      const sources = event.sourceRefs.map((ref) => manifest.get(ref)).filter((source): source is DiarySource => Boolean(source));
      const starts = sources.map((source) => new Date(source.occurredAt).getTime());
      const ends = sources.map((source) => new Date(source.endedAt ?? source.occurredAt).getTime());
      const start = new Date(Math.min(...starts));
      const end = new Date(Math.max(...ends));
      const alignedTime = iso(start);
      const spansMultipleMinutes = Math.floor(end.getTime() / 60_000) > Math.floor(start.getTime() / 60_000);
      const alignedEndTime = spansMultipleMinutes ? iso(end) : undefined;
      if (event.time !== alignedTime || event.endTime !== alignedEndTime) corrected += 1;
      event.time = alignedTime;
      if (alignedEndTime) event.endTime = alignedEndTime;
      else delete event.endTime;
    }
    return corrected;
  }

  private async collectSources(start: Date, end: Date, memoryState?: { failed: boolean }): Promise<DiarySource[]> {
    const rows: DiarySource[] = [];
    const add = (source: DiarySource) => rows.push(source);
    const registeredVisualFileIds = new Set(this.db.select({ fileId: visualObservations.fileId })
      .from(visualObservations).all().map(({ fileId }) => fileId));
    for (const row of this.db.select().from(documentVersions).where(and(gte(documentVersions.createdAt, start), lt(documentVersions.createdAt, end))).all()) {
      const doc = this.db.select().from(documents).where(eq(documents.id, row.documentId)).get();
      const content = textFromJson(row.contentJson);
      add({ sourceId: sourceRef("document_version", row.id), kind: "document_version", version: String(row.version), occurredAt: iso(row.createdAt), timeBasis: "document_version_created", fingerprint: hash([row.id, row.version, row.createdAt, row.contentJson]), evidenceSummary: `${row.title || doc?.title || "文档"}: ${content.slice(0, 240)}`, content });
    }
    for (const row of this.db.select().from(uploadedFiles).all().filter((item) => {
      const occurredAt = item.capturedAt ?? item.updatedAt;
      return !registeredVisualFileIds.has(item.id) && occurredAt >= start && occurredAt < end;
    })) {
      let content: string | undefined;
      if (row.currentParsedId) content = this.db.select().from(parsedContents).where(eq(parsedContents.id, row.currentParsedId)).get()?.markdown;
      const occurredAt = row.capturedAt ?? row.updatedAt;
      add({ sourceId: sourceRef("file", row.id), kind: "file", version: row.contentHash, occurredAt: iso(occurredAt), timeBasis: row.capturedAt ? "file_captured" : "file_updated", fingerprint: hash([row.contentHash, occurredAt]), evidenceSummary: row.originalName, assetFileId: row.id, ...(content === undefined ? {} : { content }) });
    }
    for (const row of this.db.select().from(visualNodes).where(and(lt(visualNodes.startAt, end), gte(visualNodes.endAt, start), isNull(visualNodes.deletedAt))).all()) {
      const obs = this.db.select().from(visualObservations).where(eq(visualObservations.nodeId, row.id)).orderBy(asc(visualObservations.capturedAt)).get();
      const occurredAt = clampDate(row.startAt, start, end);
      const endedAt = clampDate(row.endAt, occurredAt, end);
      add({ sourceId: sourceRef("visual_node", row.id), kind: "visual_node", version: String(row.resultVersion), occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: "visual_capture_range", fingerprint: hash([row.id, row.resultVersion, row.startAt, row.endAt, row.sampleCount, row.summary]), evidenceSummary: row.summary ?? row.title ?? row.kind, ...(obs ? { assetFileId: obs.fileId } : {}) });
    }
    for (const row of this.db.select().from(realityEvents).all().filter((item) => item.startedAt < end && (item.endedAt ?? item.startedAt) >= start)) {
      const occurredAt = clampDate(row.startedAt, start, end);
      const endedAt = clampDate(row.endedAt ?? row.startedAt, occurredAt, end);
      add({ sourceId: sourceRef("recording", row.id), kind: "recording", version: String(row.resultVersion), occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: "recording_range", fingerprint: hash([row.id, row.resultVersion, row.startedAt, row.endedAt, row.transcript]), evidenceSummary: row.currentTopic ?? row.title, content: row.transcript });
    }
    for (const row of this.db.select().from(connectorEmails).all()) {
      const occurredAt = row.sentAt ?? row.sourceUpdatedAt ?? row.syncedAt;
      if (!row.deletedAt && occurredAt >= start && occurredAt < end) add({ sourceId: sourceRef("connector_email", row.id), kind: "connector_email", version: row.contentHash, occurredAt: iso(occurredAt), timeBasis: row.sentAt ? "email_sent" : "connector_updated", fingerprint: hash([row.contentHash, occurredAt]), evidenceSummary: row.subject, content: row.bodyText });
    }
    for (const row of this.db.select().from(connectorDocuments).all()) {
      const occurredAt = row.sourceUpdatedAt ?? row.syncedAt;
      if (!row.deletedAt && occurredAt >= start && occurredAt < end) add({ sourceId: sourceRef("connector_document", row.id), kind: "connector_document", version: row.contentHash, occurredAt: iso(occurredAt), timeBasis: "connector_updated", fingerprint: hash([row.contentHash, occurredAt]), evidenceSummary: row.title, content: row.bodyText });
    }
    for (const row of this.db.select().from(connectorCalendarEvents).all()) {
      const sourceStart = row.startAt ?? row.sourceUpdatedAt ?? row.syncedAt;
      const sourceEnd = row.endAt ?? sourceStart;
      if (!row.deletedAt && sourceStart < end && sourceEnd >= start) {
        const occurredAt = clampDate(sourceStart, start, end);
        const endedAt = clampDate(sourceEnd, occurredAt, end);
        add({ sourceId: sourceRef("connector_calendar", row.id), kind: "connector_calendar", version: row.contentHash, occurredAt: iso(occurredAt), endedAt: iso(endedAt), timeBasis: row.startAt ? "calendar_range" : "connector_updated", fingerprint: hash([row.contentHash, sourceStart, sourceEnd]), evidenceSummary: row.title, content: row.description });
      }
    }
    if (this.memory?.query) {
      try { rows.push(...await this.memory.query({ start, end })); }
      catch (error) {
        if (memoryState) memoryState.failed = true;
        this.logger?.warn({ error }, "diary memory source query failed");
      }
    }
    const unique = new Map<string, DiarySource>();
    for (const source of rows) {
      const sourceStart = new Date(source.occurredAt);
      const sourceEnd = new Date(source.endedAt ?? source.occurredAt);
      if (Number.isNaN(sourceStart.getTime()) || Number.isNaN(sourceEnd.getTime())
        || sourceStart >= end || sourceEnd < start || sourceEnd < sourceStart) continue;
      const occurredAt = clampDate(sourceStart, start, end);
      const endedAt = clampDate(sourceEnd, occurredAt, end);
      unique.set(source.sourceId, {
        ...source,
        occurredAt: iso(occurredAt),
        ...(source.endedAt ? { endedAt: iso(endedAt) } : {}),
      });
    }
    return [...unique.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
}
