import type { PlanService } from "./service.js";

export interface PlanLeaseReaperOptions {
  service: PlanService;
  /** 扫描间隔（毫秒）；默认 60s。 */
  intervalMs?: number;
  /**
   * 自动认领开关：默认关。打开后每轮挑一条「待开始 + 未指派 + 高优先级」起会话，
   * 一次仅一条（见 PlanService.autoClaim 的取舍说明）。
   */
  autoClaim?: boolean;
  /** 已取消任务的保留天数；默认 30。传 0 关闭清理。 */
  droppedRetentionDays?: number;
  /** 清理检查间隔（毫秒）；默认 24h。 */
  cleanupIntervalMs?: number;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

/**
 * 计划的后台维护：认领租约回收（每 60s）+ 可选自动认领 + 已取消任务清理（每天）。
 *
 * 为什么必须有后台扫：Agent 可能中途崩掉（run 失败、进程被杀），没有回收就会出现
 * "卡片显示进行中，但没有任何会话在做"的僵尸状态，也就没人能再认领。
 *
 * 与 `AgentSchedulerService` 同款：`setInterval(...).unref()`，启动即扫一次。
 */
export class PlanLeaseReaper {
  private timer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private autoClaiming = false;

  constructor(private readonly options: PlanLeaseReaperOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.options.intervalMs ?? 60_000;
    this.timer = setInterval(() => this.tick(), interval);
    this.timer.unref?.();
    this.tick();

    const retention = this.options.droppedRetentionDays ?? 30;
    if (retention > 0) {
      const cleanupInterval = this.options.cleanupIntervalMs ?? 24 * 60 * 60_000;
      this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
      this.cleanupTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.timer = null;
    this.cleanupTimer = null;
  }

  /** 扫一次租约（返回回收条数；测试可直接调用）。自动认领是 fire-and-forget。 */
  tick(): number {
    let expired = 0;
    try {
      expired = this.options.service.expireLeases();
    } catch (error) {
      this.options.logger?.("warn", "plan.lease.reap_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.options.autoClaim) void this.runAutoClaim();
    return expired;
  }

  private async runAutoClaim(): Promise<void> {
    // 上一轮还没跑完就不叠加（一轮可能包含一次完整的建会话 + 起 run）。
    if (this.autoClaiming) return;
    this.autoClaiming = true;
    try {
      await this.options.service.autoClaim();
    } catch (error) {
      this.options.logger?.("warn", "plan.auto_claim_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.autoClaiming = false;
    }
  }

  /** 清一次已取消任务。 */
  cleanup(): number {
    const retention = this.options.droppedRetentionDays ?? 30;
    if (retention <= 0) return 0;
    try {
      return this.options.service.cleanupDropped(retention);
    } catch (error) {
      this.options.logger?.("warn", "plan.cleanup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}
