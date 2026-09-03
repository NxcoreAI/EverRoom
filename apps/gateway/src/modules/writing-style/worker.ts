import { and, asc, eq, inArray } from "drizzle-orm";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { jobs } from "../../infrastructure/database/schema.js";
import {
  enqueueWritingStyleRefresh,
  WRITING_STYLE_EXTRACT_JOB_TYPE,
  WRITING_STYLE_REFRESH_JOB_TYPE,
  type WritingStyleExtractJobPayload,
} from "./jobs.js";
import type { WritingStyleService } from "./service.js";

const WORKER_JOB_TYPES = [WRITING_STYLE_EXTRACT_JOB_TYPE, WRITING_STYLE_REFRESH_JOB_TYPE] as const;
const MAX_ATTEMPTS = 5;
/** 风格不赶实时：编辑保存 300ms 防抖之后，这里留"停笔"安静窗口。
 * 每文档单键 + 新保存重置窗口（jobs.ts 淘汰重建）：持续保存的文档会不断
 * 推后提炼，直到用户停笔 ≥5 分钟才统计一次（会话末捕获，用户决策：
 * 按保存点逐次提炼过于频繁；窗口与协作洞察的 5 分钟收口对齐）。 */
const DEFAULT_DEBOUNCE_MS = 5 * 60_000;

interface WritingStyleLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface WritingStyleWorkerOptions {
  debounceMs?: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
}

/**
 * Writing style 增量管线 worker（方案 §10）。与 DocumentOutboxWorker 同构：
 * 去抖（新 job 需过安静窗口）、失败指数退避、单 job 单飞。
 * extract 成功且增量达到阈值（service.shouldTriggerRefresh）时入队 refresh。
 */
export class WritingStyleWorker {
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private changedSinceLastCheck = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly service: WritingStyleService,
    private readonly logger: WritingStyleLogger,
    private readonly options: WritingStyleWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const now = new Date();
    this.db.update(jobs).set({ status: "pending", updatedAt: now }).where(and(
      inArray(jobs.type, [...WORKER_JOB_TYPES]),
      eq(jobs.status, "running"),
    )).run();
    // 启动兜底：旧库已有统计画像但画像文本为空（无新 refresh 触发）时补生成，
    // 否则"编辑风格"打开的是空 textarea 而不是系统生成的那份。
    try {
      this.service.ensureProfileTextInitialized();
    } catch (error) {
      this.logger.warn(
        { event: "writing-style.text.ensure_failed", error: error instanceof Error ? error.message : String(error) },
        "writing style profile text bootstrap failed",
      );
    }
    this.timer = setInterval(() => void this.drain(), this.options.pollIntervalMs ?? 5_000);
    this.timer.unref();
    void this.drain();
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  async drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drainPending().finally(() => {
      this.drainPromise = null;
    });
    return this.drainPromise;
  }

  private async drainPending(): Promise<void> {
    const candidates = this.db.select().from(jobs).where(and(
      inArray(jobs.type, [...WORKER_JOB_TYPES]),
      eq(jobs.status, "pending"),
    )).orderBy(asc(jobs.createdAt)).all();

    for (const job of candidates) {
      if (job.type === WRITING_STYLE_EXTRACT_JOB_TYPE) {
        const payload = job.payload as WritingStyleExtractJobPayload;
        const debounceMs = Math.max(0, this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
        if (Date.now() - job.createdAt.getTime() < debounceMs) continue;
        if (!this.retryReady(job, payload.attempts ?? 0)) continue;
        await this.process(job);
      } else if (job.type === WRITING_STYLE_REFRESH_JOB_TYPE) {
        // refresh 等全部 extract 落定（含仍在去抖/退避窗口的），避免合并到半截语料。
        const pendingExtracts = this.db.select({ id: jobs.id }).from(jobs)
          .where(and(eq(jobs.type, WRITING_STYLE_EXTRACT_JOB_TYPE), eq(jobs.status, "pending")))
          .limit(1).all();
        if (pendingExtracts.length > 0) continue;
        await this.process(job);
      }
    }
    // drain 周期兜底：行为信号增长不经过 extract 阈值（方案 §4.1/§10 缺口的修复），
    // 在此捕获并按画像指纹落后入队 refresh。
    try {
      this.service.autoRefreshOnSignalGrowth();
    } catch (error) {
      this.logger.warn(
        { event: "writing-style.signal.refresh_enqueue_failed", error: error instanceof Error ? error.message : String(error) },
        "writing style signal growth refresh failed",
      );
    }
    // 协作轮收口：安静 ≥5 分钟且有未蒸馏的新行为信号时，蒸馏 pending 洞察
    // 供智能区横幅/记忆页确认（写作风格 v2）。
    try {
      await this.service.maybeDistillInsight();
    } catch (error) {
      this.logger.warn(
        { event: "writing-style.insight.distill_failed", error: error instanceof Error ? error.message : String(error) },
        "writing style insight distillation failed",
      );
    }
  }

  private retryReady(job: typeof jobs.$inferSelect, attempts: number): boolean {
    if (attempts <= 0) return true;
    const baseDelay = Math.max(0, this.options.retryBaseDelayMs ?? 5_000);
    const delay = Math.min(baseDelay * (2 ** (attempts - 1)), 5 * 60_000);
    return Date.now() - job.updatedAt.getTime() >= delay;
  }

  private async process(job: typeof jobs.$inferSelect): Promise<void> {
    const claimed = this.db.update(jobs).set({ status: "running", updatedAt: new Date() }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.status, "pending"),
    )).run();
    if (claimed.changes !== 1) return;

    try {
      if (job.type === WRITING_STYLE_EXTRACT_JOB_TYPE) {
        const payload = job.payload as WritingStyleExtractJobPayload;
        const result = this.service.extractDocument(payload.documentId, payload.roomId, payload.version);
        if (result.changed) this.changedSinceLastCheck = true;
        this.complete(job.id, { outcome: result.outcome });
      } else {
        const result = await this.service.refreshProfile();
        this.changedSinceLastCheck = false;
        this.complete(job.id, { sketchCount: result.sketchCount, llm: result.llm });
      }
      // extract 成功后评估 refresh 阈值（方案 §10：≥2 篇或 ≥5000 字）。
      if (job.type === WRITING_STYLE_EXTRACT_JOB_TYPE && this.changedSinceLastCheck
        && this.service.shouldTriggerRefresh()) {
        this.db.transaction((tx) => enqueueWritingStyleRefresh(tx, new Date()));
      }
    } catch (error) {
      this.failOrRetry(job, error);
    }
  }

  private complete(jobId: string, result: Record<string, unknown>): void {
    this.db.update(jobs).set({
      status: "completed",
      result,
      error: null,
      updatedAt: new Date(),
    }).where(eq(jobs.id, jobId)).run();
  }

  private failOrRetry(job: typeof jobs.$inferSelect, error: unknown): void {
    const payload = job.payload as WritingStyleExtractJobPayload | { attempts?: number };
    const attempts = (payload.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attempts >= MAX_ATTEMPTS;
    this.db.update(jobs).set({
      status: terminal ? "failed" : "pending",
      payload: { ...payload, attempts },
      error: { message, attempts },
      updatedAt: new Date(),
    }).where(eq(jobs.id, job.id)).run();
    const bindings = { event: "writing-style.job.failed", jobId: job.id, attempts, error: message };
    if (terminal) this.logger.error(bindings, "writing style job failed permanently");
    else this.logger.warn(bindings, "writing style job scheduled for retry");
  }
}
