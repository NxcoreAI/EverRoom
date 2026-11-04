import type { JournalGenerateResult, JournalService } from "./service.js";
import type { JournalTrigger } from "./types.js";

/**
 * 每日洞察的触发与节流。
 *
 * 「实时更新」不是「一有信号就重算」：一次 Agent run 结束会连着产生记忆写入
 * （可能 2–3 条），直接重算就是连打几次模型。这里的四道闸：
 *
 * 1. **去抖**：最后一条信号之后静默 `debounceMs`（默认 45s）才动手；
 * 2. **最小间隔**：两次生成至少隔 `minIntervalMs`（默认 5 分钟）——手动刷新不受限；
 * 3. **单飞行**：正在生成时把后续信号合成一次"补跑"，不排队堆任务；
 * 4. **每日上限**：一天最多 `dailyCap` 版（默认 24），防止异常循环把模型额度烧光。
 *
 * 另有一个低频 tick（默认 5 分钟）：只负责**跨日**（本地 0 点后建当天日行、把昨天的稿冻结）
 * 和进程睡眠后的补跑，不参与内容重算。
 */

const DEFAULT_DEBOUNCE_MS = 45_000;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;
const DEFAULT_DAILY_CAP = 24;
const DEFAULT_TICK_MS = 5 * 60_000;

export interface JournalSchedulerOptions {
  service: JournalService;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
  debounceMs?: number;
  minIntervalMs?: number;
  dailyCap?: number;
  tickMs?: number;
}

export class JournalScheduler {
  private readonly service: JournalService;
  private readonly logger: NonNullable<JournalSchedulerOptions["logger"]>;
  private readonly now: () => Date;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  private readonly dailyCap: number;
  private readonly tickMs: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private running = false;
  private pendingRerun = false;
  private lastRunAt = 0;
  private lastSeenDate: string | null = null;

  constructor(options: JournalSchedulerOptions) {
    this.service = options.service;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? (() => new Date());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.dailyCap = options.dailyCap ?? DEFAULT_DAILY_CAP;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  /** 启动：立刻补一次（覆盖"上次退出后又有新记忆"），再挂 tick。 */
  start(): void {
    if (this.tickTimer) return;
    void this.requestRun("boot");
    this.tickTimer = setInterval(() => void this.onTick(), this.tickMs);
    this.tickTimer.unref?.();
  }

  stop(): void {
    for (const timer of [this.debounceTimer, this.intervalTimer, this.tickTimer]) {
      if (timer) clearTimeout(timer as NodeJS.Timeout);
    }
    this.debounceTimer = null;
    this.intervalTimer = null;
    this.tickTimer = null;
  }

  /** 有新信号（记忆写入 / 会话结束 …）：去抖后补一版。 */
  noteSignal(reason: Exclude<JournalTrigger, "boot" | "tick" | "manual"> = "memory"): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.requestRun(reason);
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  /**
   * 立刻算一版（手动刷新 / 启动 / 去抖到期）。
   *
   * 返回结果里的 `skipped` 直接说明"为什么没更新"（unchanged / no-signals / inflight / failed），
   * 排查时不用猜。
   */
  async requestRun(trigger: JournalTrigger, options: { force?: boolean } = {}): Promise<JournalGenerateResult> {
    const force = options.force === true;
    if (this.running) {
      this.pendingRerun = true;
      return { view: this.service.today(), generated: false, skipped: "inflight" };
    }

    if (!force) {
      const wait = this.minIntervalMs - (this.now().getTime() - this.lastRunAt);
      if (wait > 0) {
        // 挂在最小间隔上，而不是直接丢掉：这期间来的信号仍然会生效一次。
        this.armIntervalTimer(wait, trigger);
        return { view: this.service.today(), generated: false, skipped: null };
      }
      const current = this.service.today();
      const used = current.entry?.version ?? 0;
      if (used >= this.dailyCap) {
        this.logger("warn", "journal.capped", { date: current.date, versions: used, cap: this.dailyCap });
        return { view: current, generated: false, skipped: null };
      }
    }

    this.running = true;
    this.lastRunAt = this.now().getTime();
    try {
      const result = await this.service.generate(trigger, { force });
      this.lastSeenDate = result.view.date;
      return result;
    } finally {
      this.running = false;
      if (this.pendingRerun) {
        this.pendingRerun = false;
        void this.requestRun("tick");
      }
    }
  }

  private armIntervalTimer(waitMs: number, trigger: JournalTrigger): void {
    if (this.intervalTimer) clearTimeout(this.intervalTimer);
    this.intervalTimer = setTimeout(() => {
      this.intervalTimer = null;
      void this.requestRun(trigger);
    }, Math.max(0, waitMs) + 50);
    this.intervalTimer.unref?.();
  }

  /** 低频 tick：只处理跨日（和跨日后的第一次补写）。 */
  private async onTick(): Promise<void> {
    const view = this.service.today();
    if (this.lastSeenDate && this.lastSeenDate !== view.date) {
      this.logger("info", "journal.rollover", { from: this.lastSeenDate, to: view.date });
      this.lastRunAt = 0;
    }
    this.lastSeenDate = view.date;
    // 当天还没有任何版本（例如 0 点后应用一直开着）→ 补一版；已有版本就交给信号触发。
    if (!view.entry && view.signalCount > 0) {
      await this.requestRun("tick");
    }
  }

  /** 当前调度参数（日志/调试用）。 */
  describe(): { debounceMs: number; minIntervalMs: number; dailyCap: number; tickMs: number } {
    return {
      debounceMs: this.debounceMs,
      minIntervalMs: this.minIntervalMs,
      dailyCap: this.dailyCap,
      tickMs: this.tickMs,
    };
  }
}
