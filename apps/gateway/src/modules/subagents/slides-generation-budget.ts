import { setTimeout as delay } from "node:timers/promises";

export interface GenerationBudgetSnapshot {
  elapsedMs: number;
  tokens: number;
  invocations: number;
}

/**
 * 生成预算上限。字段缺省或为 `Infinity` 表示该维度不设上限：
 * 冒烟测试期按真实用量跑完整册，不再出现「本轮生成预算耗尽」的中断。
 * 只有显式传入有限值时才在该维度限流（单元测试与需要硬边界的宿主用）。
 */
export interface GenerationBudgetLimits {
  maxDurationMs?: number;
  maxTokens?: number;
  maxInvocations?: number;
}

/** 默认不设预算：整条生成链路只受父级取消与各子代理自身的超时约束。 */
export const DEFAULT_GENERATION_BUDGET: GenerationBudgetLimits = {};

/** 只有有限正数才构成上限；`undefined` / `Infinity` 一律视为不设限。 */
function isLimited(limit: number | undefined): limit is number {
  return limit !== undefined && Number.isFinite(limit);
}

export class GenerationBudgetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GenerationBudgetError";
  }
}

/** One active generation budget, shared by planning, repair, layout and visual review. */
export class SlidesGenerationBudget {
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private readonly usageByInvocation = new Map<string, number>();
  private readonly claimed = new Set<string>();
  private previous: GenerationBudgetSnapshot = { elapsedMs: 0, tokens: 0, invocations: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal;

  constructor(
    private readonly limits: GenerationBudgetLimits = DEFAULT_GENERATION_BUDGET,
    parentSignal?: AbortSignal,
    private readonly onChange?: (snapshot: GenerationBudgetSnapshot) => void,
  ) {
    for (const value of Object.values(limits)) {
      if (value === undefined || value === Number.POSITIVE_INFINITY) continue;
      if (!Number.isFinite(value) || value <= 0) throw new Error("slides_generation_budget_invalid");
    }
    this.signal = parentSignal ? AbortSignal.any([parentSignal, this.controller.signal]) : this.controller.signal;
    this.armDeadline();
  }

  restore(snapshot?: GenerationBudgetSnapshot): void {
    if (!snapshot) return;
    this.previous = { ...snapshot };
    this.check();
    this.armDeadline();
  }

  snapshot(): GenerationBudgetSnapshot {
    return {
      elapsedMs: this.previous.elapsedMs + Date.now() - this.startedAt,
      tokens: this.previous.tokens + [...this.usageByInvocation.values()].reduce((sum, value) => sum + value, 0),
      invocations: this.previous.invocations + this.claimed.size,
    };
  }

  claim(invocationId: string): void {
    this.check();
    if (this.claimed.has(invocationId)) return;
    const maxInvocations = this.limits.maxInvocations;
    if (isLimited(maxInvocations) && this.snapshot().invocations >= maxInvocations) {
      this.controller.abort(new GenerationBudgetError("slides_generation_invocation_budget_exceeded"));
      this.signal.throwIfAborted();
    }
    this.claimed.add(invocationId);
    this.onChange?.(this.snapshot());
  }

  /** Runtime usage is cumulative per invocation; repeated snapshots must not count twice. */
  observeUsage(invocationId: string, usage: Record<string, unknown>): void {
    const total = ["input", "output", "cacheRead", "cacheWrite"].reduce((sum, key) => {
      const value = usage[key];
      return sum + (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
    }, 0);
    this.usageByInvocation.set(invocationId, Math.max(this.usageByInvocation.get(invocationId) ?? 0, total));
    const maxTokens = this.limits.maxTokens;
    if (isLimited(maxTokens) && this.snapshot().tokens >= maxTokens) {
      this.controller.abort(new GenerationBudgetError("slides_generation_token_budget_exceeded"));
    }
    this.onChange?.(this.snapshot());
  }

  /** 剩余活动时长；未设上限时返回 `Infinity`（调用方不要把它直接交给 setTimeout）。 */
  remainingMs(): number {
    this.check();
    const maxDurationMs = this.limits.maxDurationMs;
    if (!isLimited(maxDurationMs)) return Number.POSITIVE_INFINITY;
    return Math.max(1, maxDurationMs - this.snapshot().elapsedMs);
  }

  check(): void {
    const maxTokens = this.limits.maxTokens;
    if (isLimited(maxTokens) && this.snapshot().tokens >= maxTokens) {
      this.controller.abort(new GenerationBudgetError("slides_generation_token_budget_exceeded"));
    }
    const maxDurationMs = this.limits.maxDurationMs;
    if (isLimited(maxDurationMs) && this.snapshot().elapsedMs >= maxDurationMs) {
      this.controller.abort(new GenerationBudgetError("slides_generation_time_budget_exceeded"));
    }
    this.signal.throwIfAborted();
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private armDeadline(): void {
    clearTimeout(this.timer);
    const maxDurationMs = this.limits.maxDurationMs;
    if (!isLimited(maxDurationMs)) return;
    this.timer = setTimeout(() => {
      this.controller.abort(new GenerationBudgetError("slides_generation_time_budget_exceeded"));
    }, Math.max(0, maxDurationMs - this.snapshot().elapsedMs));
    this.timer.unref();
  }
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await delay(milliseconds, undefined, { signal });
}

/** Stop a pending read without waiting for the producer to emit another item. */
export async function* abortableItems<T>(items: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  const iterator = items[Symbol.asyncIterator]();
  try {
    for (;;) {
      signal?.throwIfAborted();
      let stop: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        stop = () => reject(signal?.reason);
        signal?.addEventListener("abort", stop, { once: true });
      });
      let item: IteratorResult<T>;
      try { item = await Promise.race([iterator.next(), aborted]); }
      finally { if (stop) signal?.removeEventListener("abort", stop); }
      if (item.done) return;
      yield item.value;
    }
  } finally {
    void iterator.return?.().catch(() => undefined);
  }
}
