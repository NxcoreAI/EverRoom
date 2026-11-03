import { randomUUID } from "node:crypto";

import { desc, eq, sql } from "drizzle-orm";

import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { journalDays, journalEntries } from "../../infrastructure/database/schema.js";
import { dateInTimezone } from "../../infrastructure/time/zone-time.js";
import type { MemoryHit } from "../memory/hippo-adapter.js";
import { collectJournalSignals } from "./collector.js";
import type { ComposeJournalResult } from "./composer.js";
import type {
  JournalEntryRecord,
  JournalSignal,
  JournalSnapshot,
  JournalTodayView,
  JournalTrigger,
} from "./types.js";

/**
 * 每日洞察的落盘与编排。
 *
 * 职责边界（都很窄，方便单测）：
 * - **采集**交给 `collectJournalSignals`（纯函数）；
 * - **写稿**交给 `composeJournal`（纯函数 + 一次模型调用）；
 * - 这里只管：日状态、指纹比对（决定"要不要重写"）、版本号、失败记录、版本裁剪。
 *
 * 「实时更新」的真正含义在这里：**指纹没变就不重写**。一次 run 结束会连着产生
 * 记忆写入 + 文件入库 + 会话更新，若不比对指纹就会连打好几次模型、卡片文案也跟着抖。
 */

/** 同一天最多保留多少版（一天写太多次不至于撑爆库）。 */
const DEFAULT_MAX_VERSIONS = 30;
/** 记忆读取上限（与 `/v1/memory/entries` 的服务端上限对齐）。 */
const MEMORY_LIST_LIMIT = 200;

export type JournalSkipReason =
  | "no-signals"
  | "unchanged"
  | "inflight"
  | "failed"
  | null;

export interface JournalGenerateResult {
  view: JournalTodayView;
  generated: boolean;
  skipped: JournalSkipReason;
}

export interface JournalServiceOptions {
  db: GatewayDatabase;
  /** 记忆条目读取（`MemoryService.list`）。 */
  list: () => MemoryHit[];
  /** 写稿（模型 + 兜底，见 composer.ts）。 */
  compose: (input: { date: string; signals: JournalSignal[] }) => Promise<ComposeJournalResult>;
  timezone: () => string;
  now?: () => Date;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  maxVersionsPerDay?: number;
}

export class JournalService {
  private readonly db: GatewayDatabase;
  private readonly list: () => MemoryHit[];
  private readonly compose: JournalServiceOptions["compose"];
  private readonly timezone: () => string;
  private readonly now: () => Date;
  private readonly logger: NonNullable<JournalServiceOptions["logger"]>;
  private readonly maxVersions: number;
  private running = false;

  constructor(options: JournalServiceOptions) {
    this.db = options.db;
    this.list = options.list;
    this.compose = options.compose;
    this.timezone = options.timezone;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? (() => {});
    this.maxVersions = options.maxVersionsPerDay ?? DEFAULT_MAX_VERSIONS;
  }

  /** 采集当天证据（服务端只读入口，`:today` 与调度器共用）。 */
  snapshot(): JournalSnapshot {
    return collectJournalSignals({
      list: this.list,
      timezone: this.timezone,
      now: this.now,
    });
  }

  /** 当前视图（只读，不触发模型调用）。 */
  today(): JournalTodayView {
    // 先看日行：卡片每 60s 轮询一次，已有日行时**一次记忆库扫描都不该发生**
    // （扫描要逐条读 .md），只在"当天还没建日行"时才去数条数。
    const date = dateInTimezone(this.now(), this.timezone());
    const day = this.readDay(date);
    if (day) {
      return {
        date: day.date,
        entry: this.readEntry(date, day.currentEntryId),
        status: day.status,
        signalCount: day.signalCount,
        lastError: day.lastError,
      };
    }
    const snapshot = this.snapshot();
    return {
      date: snapshot.date,
      entry: null,
      status: "pending",
      signalCount: snapshot.signalCount,
      lastError: null,
    };
  }

  /**
   * 重算当天并落一版（幂等：指纹未变直接返回，不调用模型）。
   *
   * `force` 只跳过"指纹未变"这一道，不跳过单飞行——手动刷新连点两次也只跑一次。
   */
  async generate(trigger: JournalTrigger, options: { force?: boolean } = {}): Promise<JournalGenerateResult> {
    if (this.running) {
      return { view: this.today(), generated: false, skipped: "inflight" };
    }
    this.running = true;
    try {
      return await this.generateLocked(trigger, options.force === true);
    } finally {
      this.running = false;
    }
  }

  private async generateLocked(trigger: JournalTrigger, force: boolean): Promise<JournalGenerateResult> {
    const snapshot = this.snapshot();
    const day = this.ensureDay(snapshot.date);

    // 当天没有任何新证据：不写条目，但把指纹与计数落下来，避免每次 tick 都重算一遍。
    if (snapshot.signals.length === 0) {
      this.updateDay(snapshot.date, {
        status: day.currentEntryId ? "ready" : "pending",
        signalCount: snapshot.signalCount,
        sourceFingerprint: snapshot.fingerprint,
        lastError: null,
      });
      return { view: this.today(), generated: false, skipped: "no-signals" };
    }

    const unchanged =
      !force &&
      day.status === "ready" &&
      Boolean(day.currentEntryId) &&
      day.sourceFingerprint === snapshot.fingerprint;
    if (unchanged) {
      // 证据没变，但条目可能被裁掉了（极端情况）：保守起见重新指一次最新版。
      return { view: this.today(), generated: false, skipped: "unchanged" };
    }

    this.updateDay(snapshot.date, { status: "generating", signalCount: snapshot.signalCount });
    try {
      const composed = await this.compose({ date: snapshot.date, signals: snapshot.signals });
      const version = this.nextVersion(snapshot.date);
      const id = `journal-${randomUUID()}`;
      const createdAt = this.now();
      this.db.insert(journalEntries).values({
        id,
        date: snapshot.date,
        version,
        trigger,
        headline: composed.composition.headline,
        summary: composed.composition.summary,
        bullets: composed.composition.bullets,
        actions: composed.composition.actions,
        evidence: snapshot.signals,
        model: composed.model,
        sourceFingerprint: snapshot.fingerprint,
        createdAt,
      }).run();
      this.updateDay(snapshot.date, {
        status: "ready",
        currentEntryId: id,
        signalCount: snapshot.signalCount,
        sourceFingerprint: snapshot.fingerprint,
        lastError: null,
      });
      this.pruneVersions(snapshot.date);
      this.logger("info", "journal.generated", {
        date: snapshot.date,
        version,
        trigger,
        signals: snapshot.signals.length,
        model: composed.model ?? "template",
      });
      return { view: this.today(), generated: true, skipped: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateDay(snapshot.date, { status: "failed", lastError: message.slice(0, 300) });
      this.logger("error", "journal.generate.failed", { date: snapshot.date, error: message });
      return { view: this.today(), generated: false, skipped: "failed" };
    }
  }

  /** 日行不存在就建一条 pending（并发安全：onConflictDoNothing）。 */
  private ensureDay(date: string) {
    const existing = this.readDay(date);
    if (existing) return existing;
    const now = this.now();
    this.db.insert(journalDays)
      .values({ date, status: "pending", signalCount: 0, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run();
    return this.readDay(date)!;
  }

  private readDay(date: string) {
    return this.db.select().from(journalDays).where(eq(journalDays.date, date)).get();
  }

  private updateDay(
    date: string,
    patch: {
      status?: "pending" | "generating" | "ready" | "failed";
      currentEntryId?: string | null;
      signalCount?: number;
      sourceFingerprint?: string;
      lastError?: string | null;
    },
  ): void {
    this.db.update(journalDays)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(journalDays.date, date))
      .run();
  }

  /** 当前版本条目（`currentEntryId` 丢了就退回该日最新一版——宁可显示旧稿也别空着）。 */
  private readEntry(date: string, entryId: string | null): JournalEntryRecord | null {
    const row = entryId
      ? this.db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).get()
      : this.db.select().from(journalEntries)
        .where(eq(journalEntries.date, date))
        .orderBy(desc(journalEntries.version))
        .limit(1)
        .get();
    if (!row) return null;
    return {
      id: row.id,
      date: row.date,
      version: row.version,
      headline: row.headline,
      summary: row.summary,
      bullets: row.bullets ?? [],
      actions: (row.actions ?? []) as JournalEntryRecord["actions"],
      model: row.model ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private nextVersion(date: string): number {
    const row = this.db
      .select({ max: sql<number | null>`max(${journalEntries.version})` })
      .from(journalEntries)
      .where(eq(journalEntries.date, date))
      .get();
    return (row?.max ?? 0) + 1;
  }

  /** 裁掉超量的旧版本（按 version 降序保留最近 N 版）。 */
  private pruneVersions(date: string): void {
    const stale = this.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.date, date))
      .orderBy(desc(journalEntries.version))
      .all()
      .slice(this.maxVersions);
    for (const row of stale) {
      this.db.delete(journalEntries).where(eq(journalEntries.id, row.id)).run();
    }
  }
}

export { MEMORY_LIST_LIMIT };
