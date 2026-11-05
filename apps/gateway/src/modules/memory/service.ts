import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HippoSleepResult } from "hippo-memory";
import { HippoMemoryAdapter, type MemoryCategory, type MemoryHit, type RecallInput, type RememberInput } from "./hippo-adapter.js";
import { MemoryOutcomeTracker, type RunVerdict, type SettleResult } from "./outcomes.js";

export interface MemoryServiceOptions {
  /** `.hippo` 库根目录，通常为 `<dataDir>/memory/hippo`（全局库）。 */
  root: string;
  /**
   * 空间记忆库根（P2）：返回 `<space>/.everoffice/memory` 时，该工作区的记忆单独落盘；
   * 返回 null/未注入 → 继续用全局库（兼容旧行为）。
   */
  spaceRootFor?: (workspaceId: string | null | undefined) => string | null;
  /** 关闭时不建库、不注册工具、不占内存。 */
  enabled: boolean;
  /** 整理回合间隔（默认 6 小时）；0 表示不定时整理。 */
  maintenanceIntervalMs?: number;
  /** 启动后首次整理延迟（默认 5 分钟），错开启动高峰。 */
  maintenanceInitialDelayMs?: number;
  logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
}

/**
 * 记忆服务：hippo-memory 适配层的持有者与生命周期管理。
 *
 * 与上一版（MemoryCore v3 HTTP 服务）不同，这里没有独立进程与端口：
 * 记忆库是 gateway 进程内的一层 SQLite（`node:sqlite`），
 * 见 docs/hippo-memory-adoption-plan.zh-CN.md。
 */
const DEFAULT_MAINTENANCE_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_MAINTENANCE_INITIAL_DELAY_MS = 5 * 60_000;

export class MemoryService {
  /** 全局记忆库。 */
  private readonly adapter: HippoMemoryAdapter;
  /** 已打开的记忆库（root → adapter）；键为绝对路径，含全局库。 */
  private readonly adapters = new Map<string, HippoMemoryAdapter>();
  private readonly spaceRootFor: ((workspaceId: string | null | undefined) => string | null) | null;
  private readonly outcomes: MemoryOutcomeTracker;
  private readonly enabled: boolean;
  private readonly logger: NonNullable<MemoryServiceOptions["logger"]>;
  private readonly root: string;
  private readonly maintenanceIntervalMs: number;
  private readonly maintenanceInitialDelayMs: number;
  private started = false;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private maintenanceRunning = false;
  private onRemembered: (() => void) | null = null;

  constructor(options: MemoryServiceOptions) {
    this.enabled = options.enabled;
    this.root = options.root;
    this.logger = options.logger ?? (() => {});
    this.maintenanceIntervalMs = options.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
    this.maintenanceInitialDelayMs = options.maintenanceInitialDelayMs ?? DEFAULT_MAINTENANCE_INITIAL_DELAY_MS;
    this.spaceRootFor = options.spaceRootFor ?? null;
    this.adapter = this.openAdapter(options.root);
    this.adapters.set(options.root, this.adapter);
    this.outcomes = new MemoryOutcomeTracker({
      service: this,
      ...(options.logger ? { logger: options.logger } : {}),
    });
  }

  /** 按 root 懒开库（幂等）；同一 root 复用同一个 adapter。 */
  private openAdapter(root: string): HippoMemoryAdapter {
    const existing = this.adapters.get(root);
    if (existing) return existing;
    const adapter = new HippoMemoryAdapter({
      root,
      actor: "gateway",
      ...(this.logger ? { logger: this.logger } : {}),
    });
    if (this.started || root === this.root) adapter.open();
    this.adapters.set(root, adapter);
    return adapter;
  }

  /** 该工作区的记忆库：空间绑了目录就用 `<space>/.everoffice/memory`，否则全局库。 */
  private adapterFor(workspaceId: string | null | undefined): HippoMemoryAdapter {
    const root = this.spaceRootFor?.(workspaceId);
    if (!root) return this.adapter;
    const adapter = this.openAdapter(root);
    adapter.open();
    return adapter;
  }

  /** 所有已打开的记忆库（按 id 操作时逐个试）。 */
  private allAdapters(): HippoMemoryAdapter[] {
    return [...this.adapters.values()];
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** 打开记忆库（幂等）。关闭记忆时为空操作。 */
  start(): void {
    if (!this.enabled || this.started) return;
    try {
      this.disableExtraction();
      for (const adapter of this.allAdapters()) adapter.open();
      this.adapter.open();
      this.started = true;
      this.logger("info", "memory.started", { stats: this.adapter.stats() });
      this.scheduleMaintenance();
    } catch (error) {
      // 记忆是增强能力：初始化失败不阻断 gateway 启动。
      this.logger("error", "memory.start.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  isStarted(): boolean {
    return this.started;
  }

  /** 停止定时整理（进程退出前调用）。 */
  stop(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this.started = false;
  }

  /**
   * 整理回合：衰减 / 去重 / 情景合并 / 冲突刷新。定时任务与手动触发共用。
   * 并发调用会被丢弃（一次整理可能持续数秒）。
   */
  async maintain(options: { dryRun?: boolean } = {}): Promise<HippoSleepResult | null> {
    if (!this.enabled || !this.started || this.maintenanceRunning) return null;
    this.maintenanceRunning = true;
    try {
      const result = await this.adapter.maintain(options);
      // 空间记忆库各自整理（失败只记日志，不影响全局整理结果）。
      for (const adapter of this.allAdapters()) {
        if (adapter === this.adapter) continue;
        await adapter.maintain(options).catch(() => null);
      }
      // 合并会把经验（episodic）卷成 semantic：读取侧已按标签兜住类别，
      // 这里把「漂移条数」打出来，方便确认规模是否在预期内。
      const drift = this.adapter.categoryDrift();
      this.logger("info", "memory.maintain.done", {
        active: result.active,
        removed: result.removed,
        mergedEpisodic: result.mergedEpisodic,
        newSemantic: result.newSemantic,
        dryRun: result.dryRun,
        lessonTaggedNotEpisodic: drift.lessonTaggedNotEpisodic,
      });
      return result;
    } catch (error) {
      this.logger("error", "memory.maintain.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      this.maintenanceRunning = false;
    }
  }

  private scheduleMaintenance(): void {
    if (this.maintenanceIntervalMs <= 0 || this.maintenanceTimer) return;
    const initial = setTimeout(() => {
      void this.maintain();
      this.maintenanceTimer = setInterval(() => void this.maintain(), this.maintenanceIntervalMs);
      this.maintenanceTimer.unref?.();
    }, this.maintenanceInitialDelayMs);
    initial.unref?.();
    this.maintenanceTimer = initial;
  }

  /**
   * 关掉 hippo 的 LLM 事实提取：库根 `config.json` 的 `extraction.enabled`
   * 默认是 `'auto'`——一旦环境里有 ANTHROPIC_API_KEY 就会在整理时把记忆正文
   * 发出去。产品侧固定为 false，保证整理全程本地。
   * 已有配置只覆盖这一个键，其余保留。
   */
  private disableExtraction(): void {
    try {
      mkdirSync(this.root, { recursive: true });
      const path = join(this.root, "config.json");
      let config: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      } catch {
        // 文件不存在或不是合法 JSON：按空配置重写。
      }
      const extraction = config.extraction;
      const current = extraction && typeof extraction === "object" && !Array.isArray(extraction)
        ? extraction as Record<string, unknown>
        : {};
      if (current.enabled === false && Object.keys(config).length > 0) return;
      config.extraction = { ...current, enabled: false };
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    } catch (error) {
      this.logger("warn", "memory.config.write.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  remember(input: RememberInput): string | null {
    if (!this.enabled) return null;
    const id = this.adapterFor(input.workspaceId).remember(input);
    if (id) {
      try {
        this.onRemembered?.();
      } catch {
        /* 订阅方异常不影响写入结果 */
      }
    }
    return id;
  }

  /** 每次成功写入后回调（画像聚合的阈值触发用）。 */
  setOnRemembered(listener: (() => void) | null): void {
    this.onRemembered = listener;
  }

  recall(input: RecallInput): MemoryHit[] {
    if (!this.enabled) return [];
    return this.adapterFor(input.workspaceId).recall(input);
  }

  feedback(id: string, good: boolean): boolean {
    if (!this.enabled) return false;
    // id 不携带归属：逐个库试，命中即返回（条目只可能在一个库里）。
    return this.allAdapters().some((adapter) => adapter.feedback(id, good));
  }

  /** 检索登记：记录「这次 run 读到了哪些条目」，等 run 结束再结算（不立即记分）。 */
  recordRecall(runId: string, ids: readonly string[]): void {
    if (!this.enabled) return;
    this.outcomes.recordRecall(runId, ids);
  }

  /** run 结束结算：顺利跑完就记隐性确认，出过事就跳过（否定由 agent 显式标注）。 */
  settleRun(runId: string, verdict: RunVerdict): SettleResult {
    if (!this.enabled) return { checked: 0, confirmed: 0, promoted: 0 };
    return this.outcomes.settle(runId, verdict);
  }

  /** 检索回流：agent 真的读到这些条目后调用，hippo 据此刷新衰减锚点与半衰期。 */
  markUsed(ids: readonly string[]): number {
    if (!this.enabled || ids.length === 0) return 0;
    let total = 0;
    for (const adapter of this.allAdapters()) total += adapter.markUsed(ids);
    return total;
  }

  /**
   * 隐性确认 + 自动转正：这些条目在一次**顺利跑完**的 run 里被检索用上过。
   * 草稿（inferred）攒够次数会晋升为 verified，此后不再受 30 天老化影响。
   */
  confirmUsage(ids: readonly string[]): { confirmed: number; promoted: number } {
    if (!this.enabled || ids.length === 0) return { confirmed: 0, promoted: 0 };
    const total = { confirmed: 0, promoted: 0 };
    for (const adapter of this.allAdapters()) {
      const result = adapter.confirmUsage(ids);
      total.confirmed += result.confirmed;
      total.promoted += result.promoted;
    }
    return total;
  }

  forget(id: string, reason?: string): boolean {
    if (!this.enabled) return false;
    return this.allAdapters().some((adapter) => adapter.forget(id, reason));
  }

  list(options: { limit?: number; scope?: string; workspaceId?: string; category?: MemoryCategory } = {}): MemoryHit[] {
    if (!this.enabled) return [];
    // 指定工作区 → 只读该空间库；未指定（画像/全局列表）→ 合并所有库。
    if (options.workspaceId) return this.adapterFor(options.workspaceId).list(options);
    const merged = this.allAdapters().flatMap((adapter) => adapter.list(options));
    return merged
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, options.limit ?? merged.length);
  }

  stats(): { total: number; scopes: Record<string, number> } {
    if (!this.enabled) return { total: 0, scopes: {} };
    const scopes: Record<string, number> = {};
    let total = 0;
    for (const adapter of this.allAdapters()) {
      const stats = adapter.stats();
      total += stats.total;
      for (const [scope, count] of Object.entries(stats.scopes)) {
        scopes[scope] = (scopes[scope] ?? 0) + count;
      }
    }
    return { total, scopes };
  }
}
