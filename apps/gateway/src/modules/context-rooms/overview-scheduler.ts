/**
 * room-overview 后台自动再生调度（方案：connector 路由/文档落库 → 受影响 Room
 * 去抖后再生成；每 Room 成功冷却 1h，避免每封邮件烧一次子 Agent）。
 *
 * 状态全部在内存：网关重启即清零，等价于"重启后允许每房立即再生成一次"，
 * 与 room-enrich 的失败降级语义一致（不落库、不重放）。
 */
export interface RoomOverviewSchedulerOptions {
  /** 同房两次成功再生之间的最小间隔（默认 1 小时）。 */
  cooldownMs?: number;
  /** 去抖静默窗口：持续的路由/落库活动只延后触发，不放大次数（默认 3 分钟）。 */
  debounceMs?: number;
  /** 失败退避：出错后同房短时间内不再尝试（默认 10 分钟）。 */
  failureCooldownMs?: number;
}

export interface RoomOverviewSchedulerLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface RoomOverviewNotifyOptions {
  /** 覆盖本次去抖窗口（如 boot 初始扫描不需要等静默期）。 */
  delayMs?: number;
  /** 跳过失败退避检查（成功冷却仍生效；runtime config 变更后重试 AI 未就绪期间的失败）。 */
  ignoreFailureCooldown?: boolean;
}

export class RoomOverviewScheduler {
  private regenerate: ((roomId: string) => Promise<unknown>) | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private readonly lastSuccessAt = new Map<string, number>();
  private readonly lastFailureAt = new Map<string, number>();
  private readonly concurrencyRetries = new Map<string, number>();
  private disposed = false;
  private readonly cooldownMs: number;
  private readonly debounceMs: number;
  private readonly failureCooldownMs: number;

  constructor(
    private readonly logger: RoomOverviewSchedulerLogger,
    options: RoomOverviewSchedulerOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? 3_600_000;
    this.debounceMs = options.debounceMs ?? 180_000;
    this.failureCooldownMs = options.failureCooldownMs ?? 600_000;
  }

  setRegenerate(regenerate: (roomId: string) => Promise<unknown>): void {
    this.regenerate = regenerate;
  }

  /** 路由投影/文档沉淀完成后通知：各受影响 Room 进入（或重置）去抖窗口。 */
  notifySourcesChanged(roomIds: Iterable<string>, reason: string, options: RoomOverviewNotifyOptions = {}): void {
    for (const roomId of roomIds) this.schedule(roomId, reason, options);
  }

  /** Room 创建后初始一次：新 Room 无冷却记录，必然放行。 */
  notifyRoomCreated(roomId: string): void {
    this.schedule(roomId, "room-created", {});
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(roomId: string, reason: string, options: RoomOverviewNotifyOptions): void {
    if (this.disposed || !this.regenerate) return;
    const now = Date.now();
    if (now - (this.lastSuccessAt.get(roomId) ?? 0) < this.cooldownMs) return;
    if (!options.ignoreFailureCooldown
      && now - (this.lastFailureAt.get(roomId) ?? 0) < this.failureCooldownMs) return;
    const existing = this.timers.get(roomId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      this.fire(roomId, reason);
    }, options.delayMs ?? this.debounceMs);
    timer.unref();
    this.timers.set(roomId, timer);
  }

  private fire(roomId: string, reason: string): void {
    const regenerate = this.regenerate;
    if (!regenerate || this.disposed) return;
    if (this.inFlight.has(roomId)) {
      // 正在再生中：本次变更不在其读取范围内，重挂去抖窗补一次。
      this.schedule(roomId, reason, {});
      return;
    }
    this.inFlight.add(roomId);
    void regenerate(roomId)
      .then(() => {
        this.lastSuccessAt.set(roomId, Date.now());
        this.lastFailureAt.delete(roomId);
        this.concurrencyRetries.delete(roomId);
        this.logger.info({ event: "room_overview.scheduler.regenerated", roomId, reason }, "room overview auto-regenerated");
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "context_room_not_found") return; // 房间已删：静默丢弃
        if (message.includes("subagent_concurrency_limit")) {
          // 并发限额拒绝（boot 扫描/活动突发下的正常竞争）：短退避重排而非记失败，
          // 连续多次仍挤不进去才转失败退避，避免限额饱和时空转。
          const retries = (this.concurrencyRetries.get(roomId) ?? 0) + 1;
          if (retries <= 5) {
            this.concurrencyRetries.set(roomId, retries);
            this.schedule(roomId, reason, { delayMs: 60_000, ignoreFailureCooldown: true });
            return;
          }
          this.concurrencyRetries.delete(roomId);
        }
        this.lastFailureAt.set(roomId, Date.now());
        this.logger.warn(
          { event: "room_overview.scheduler.failed", roomId, reason, error: message },
          "room overview auto-regeneration failed",
        );
      })
      .finally(() => {
        this.inFlight.delete(roomId);
      });
  }
}
