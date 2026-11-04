import type { MemoryService } from "./service.js";

/**
 * 检索结果的「事后结算」（全程无人工、无按钮）。
 *
 * 为什么不能检索时立刻记正分：那时还不知道这条记忆到底帮上忙还是带偏了。
 * 所以只在检索时登记「这次 run 读到了哪些条目」，等 run 结束、拿到这轮是否顺利的
 * 客观结论后再结算：
 *
 * - 这次 run **没有** 工具失败/用户纠正 → 判定「用上了且没出事」，记一次隐性确认
 *   （攒够次数由 `MemoryService.confirmUsage` 负责转正）；
 * - 这次 run 有失败/被纠正 → 不确认也不否定。否定必须有归属（是哪条记忆带偏的），
 *   这件事只有当事 agent 知道，走 `memory_feedback` 工具，代码不猜。
 *
 * 一切失败都静默：记忆是增强能力，不能影响对话。
 */
export interface RunVerdict {
  /** 这次 run 是否出现工具失败/被用户纠正等负面信号。 */
  failed: boolean;
}

export interface SettleResult {
  /** 本次结算涉及（被检索到）的条目数。 */
  checked: number;
  /** 记为「用上了」的条目数。 */
  confirmed: number;
  /** 由草稿晋升为已核实的条目数。 */
  promoted: number;
}

/** 单次 run 最多跟踪多少条命中，防止一次疯狂检索把表撑大。 */
const MAX_IDS_PER_RUN = 20;
/** 同时在跑的 run 上限；超了整表清空（只影响正在跑的少数 run）。 */
const MAX_TRACKED_RUNS = 200;

export class MemoryOutcomeTracker {
  private readonly service: MemoryService;
  private readonly logger: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  private readonly byRun = new Map<string, Set<string>>();

  constructor(options: {
    service: MemoryService;
    logger?: (level: "info" | "warn" | "error", event: string, fields?: Record<string, unknown>) => void;
  }) {
    this.service = options.service;
    this.logger = options.logger ?? (() => {});
  }

  /** 检索命中时登记（由 memory_search 工具调用）。 */
  recordRecall(runId: string, ids: readonly string[]): void {
    if (ids.length === 0) return;
    if (this.byRun.size > MAX_TRACKED_RUNS) this.byRun.clear();
    const bucket = this.byRun.get(runId) ?? new Set<string>();
    for (const id of ids) {
      if (bucket.size >= MAX_IDS_PER_RUN) break;
      bucket.add(id);
    }
    this.byRun.set(runId, bucket);
  }

  /** run 结束时结算；无论结果如何都会清掉登记，避免泄漏。 */
  settle(runId: string, verdict: RunVerdict): SettleResult {
    const ids = this.byRun.get(runId);
    this.byRun.delete(runId);
    if (!ids || ids.size === 0) return { checked: 0, confirmed: 0, promoted: 0 };
    // 这轮出过事：不确认（也不否定，否定靠 agent 显式标注的那条）。
    if (verdict.failed) {
      this.logger("info", "memory.settle.skipped", { runId, checked: ids.size, reason: "run-failed" });
      return { checked: ids.size, confirmed: 0, promoted: 0 };
    }
    const { confirmed, promoted } = this.service.confirmUsage([...ids]);
    this.logger("info", "memory.settle.done", { runId, checked: ids.size, confirmed, promoted });
    return { checked: ids.size, confirmed, promoted };
  }

  /** 丢弃登记（取消/中断这类没有结论的 run）。 */
  discard(runId: string): void {
    this.byRun.delete(runId);
  }
}
