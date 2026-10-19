import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { invokeAgent } from "../agent/invoke.js";
import { BUILTIN_AGENT_IDS, type AgentResolver } from "../agent/resolver.js";
import type { GatewayDatabase } from "../../infrastructure/database/client.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { screenIntervals, screenKeyframes, uploadedFiles } from "../../infrastructure/database/schema.js";

export type ScreenIntervalEndReason =
  | "app-switch"
  | "lock"
  | "suspend"
  | "idle"
  | "out-of-scope"
  | "paused"
  | "stopped";

export type ScreenSummaryStatus = "pending" | "processing" | "ready" | "waiting" | "failed";

export interface ScreenKeyframeInput {
  capturedAt: string;
  imagePath: string;
  imageBytes: number;
  perceptualHash: string;
  width: number;
  height: number;
  lineCount: number;
  elapsedMs: number;
}

export interface ScreenIntervalInput {
  id?: string;
  bundleId: string;
  appName: string;
  windowTitle: string | null;
  title: string;
  startedAt: string;
  endedAt: string;
  endReason: ScreenIntervalEndReason;
  textLines: string[];
  textBlocks?: string[];
  keyframes: ScreenKeyframeInput[];
}

export interface ScreenKeyframeDto {
  id: string;
  capturedAt: string;
  imagePath: string;
  imageBytes: number;
  perceptualHash: string | null;
  width: number | null;
  height: number | null;
  lineCount: number;
  elapsedMs: number | null;
}

export interface ScreenIntervalDto {
  id: string;
  bundleId: string;
  appName: string;
  windowTitle: string | null;
  title: string;
  startedAt: string;
  endedAt: string;
  endReason: ScreenIntervalEndReason;
  keyframeCount: number;
  textLines: string[];
  textBlocks: string[];
  summaryStatus: ScreenSummaryStatus;
  summary: string | null;
  summaryKeyPoints: string[];
  userEdited: boolean;
  keyframes?: ScreenKeyframeDto[];
}

export interface ScreenIntervalQuery {
  from?: Date | undefined;
  to?: Date | undefined;
  bundleId?: string | undefined;
  summaryStatus?: ScreenSummaryStatus | undefined;
  limit: number;
  offset: number;
}

export interface ScreenSearchQuery {
  q: string;
  bundleId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
}

const SUMMARY_TICK_MS = 10_000;
const SUMMARY_RETRY_WAIT_MS = 5 * 60_000;
const SUMMARY_TIMEOUT_MS = 120_000;
const SUMMARY_PROMPT_TEXT_LIMIT = 3_000;
export const DEFAULT_DAILY_SUMMARY_CAP = 50;

export class ScreenMemoryService {
  private intervalSink: ((interval: { id: string; title: string; markdown: string; occurredAt: string; version: number }) => Promise<void>) | null = null;
  private summaryTimer: ReturnType<typeof setInterval> | null = null;
  private summaryBusy = false;
  private dispatchAllowed = false;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly log: FastifyBaseLogger,
    private readonly agentResolver?: AgentResolver,
    private readonly dailySummaryCap: number = DEFAULT_DAILY_SUMMARY_CAP,
    private readonly markDiaryStale?: (at: Date) => void,
    private readonly saveImageBlob?: (buffer: Buffer, mime: string) => Promise<{ contentHash: string } | string>,
    private readonly gatewayDataDir?: string,
  ) {}

  initialize(): void {
    if (this.summaryTimer) return;
    this.summaryTimer = setInterval(() => void this.processSummariesOnce(), SUMMARY_TICK_MS);
  }

  dispose(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    this.summaryTimer = null;
  }

  /** 摘要就绪且通过新颖度筛选的区间经此下沉（记忆链路）。 */
  setIntervalSink(sink: ((interval: { id: string; title: string; markdown: string; occurredAt: string; version: number }) => Promise<void>) | null): void {
    this.intervalSink = sink;
  }

  /** 桌面侧空闲心跳：仅空闲（>60s）时允许派发摘要任务。 */
  setSummaryDispatch(allowed: boolean): void {
    this.dispatchAllowed = allowed;
  }

  /** 单轮摘要处理：重试等待项→检查派发开关/额度→认领最旧待处理区间并调用 LLM。 */
  async processSummariesOnce(): Promise<void> {
    if (this.summaryBusy) return;
    this.summaryBusy = true;
    try {
      await this.retryWaitingSummaries();
      if (!this.dispatchAllowed) return;
      if (!(this.agentResolver && this.agentResolver.has(BUILTIN_AGENT_IDS.lite))) return
      if (await this.summariesCompletedToday() >= this.dailySummaryCap) return
      const interval = this.db
        .select()
        .from(screenIntervals)
        .where(and(isNull(screenIntervals.deletedAt), eq(screenIntervals.summaryStatus, "pending")))
        .orderBy(asc(screenIntervals.startedAt))
        .limit(1)
        .get()
      if (!interval) return
      const claimed = this.db
        .update(screenIntervals)
        .set({ summaryStatus: "processing", updatedAt: new Date() })
        .where(and(eq(screenIntervals.id, interval.id), eq(screenIntervals.summaryStatus, "pending")))
        .run()
      if (claimed.changes !== 1) return
      await this.summarizeInterval(interval.id)
    } catch (error) {
      this.log.warn({ error: String(error) }, "screen-memory summary tick failed")
    } finally {
      this.summaryBusy = false
    }
  }

  /** 新颖度三规则：用户纠正过 / 长阅读（≥10min 且文本量足）/ 近两小时未见的应用。 */
  private async shouldSinkToMemory(interval: typeof screenIntervals.$inferSelect): Promise<boolean> {
    if (interval.userEdited) return true
    const minutes = (interval.endedAt.getTime() - interval.startedAt.getTime()) / 60_000
    if (minutes >= 10 && interval.textLines.length >= 20) return true
    const twoHoursAgo = new Date(interval.startedAt.getTime() - 2 * 60 * 60_000)
    const seen = this.db.select({ count: sql<number>`count(*)` })
      .from(screenIntervals)
      .where(and(
        eq(screenIntervals.bundleId, interval.bundleId),
        lt(screenIntervals.endedAt, interval.startedAt),
        gte(screenIntervals.endedAt, twoHoursAgo),
      ))
      .get()?.count ?? 0
    return seen === 0
  }

  private async retryWaitingSummaries(): Promise<void> {
    const cutoff = new Date(Date.now() - SUMMARY_RETRY_WAIT_MS)
    this.db
      .update(screenIntervals)
      .set({ summaryStatus: "pending", updatedAt: new Date() })
      .where(and(eq(screenIntervals.summaryStatus, "waiting"), lt(screenIntervals.updatedAt, cutoff)))
      .run()
  }

  private async summariesCompletedToday(): Promise<number> {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    return this.db
      .select({ count: sql<number>`count(*)` })
      .from(screenIntervals)
      .where(and(eq(screenIntervals.summaryStatus, "ready"), gte(screenIntervals.summaryCompletedAt, startOfDay)))
      .get()?.count ?? 0
  }

  private async summarizeInterval(id: string): Promise<void> {
    const interval = this.db.select().from(screenIntervals).where(eq(screenIntervals.id, id)).get()
    if (!interval) return
    try {
      const agentId = BUILTIN_AGENT_IDS.lite
      const content = await invokeAgent(this.agentResolver!, agentId, buildSummaryPrompt({
        appName: interval.appName,
        windowTitle: interval.windowTitle,
        title: interval.title,
        startedAt: interval.startedAt,
        endedAt: interval.endedAt,
        textLines: interval.textLines,
        textBlocks: interval.textBlocks ?? [],
      }), { pageLabel: "screen-memory summary", timeoutMs: SUMMARY_TIMEOUT_MS })
      const parsed = parseSummaryResponse(content)
      this.db
        .update(screenIntervals)
        .set({
          summaryStatus: "ready",
          summary: parsed.summary,
          summaryKeyPoints: parsed.keyPoints,
          summaryCompletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(screenIntervals.id, id))
        .run()
      if (await this.shouldSinkToMemory(interval)) {
        await this.intervalSink?.({
          id: interval.id,
          title: interval.title,
          markdown: [
            `# ${interval.title}`,
            "",
            `- 应用：${interval.appName}`,
            `- 时间：${interval.startedAt.toISOString()} 至 ${interval.endedAt.toISOString()}`,
            "",
            parsed.summary,
            ...(parsed.keyPoints.length > 0 ? ["", "要点：", ...parsed.keyPoints.map((point) => `- ${point}`)] : []),
            "",
            "原文片段：",
            ...(interval.textBlocks && interval.textBlocks.length > 0
              ? interval.textBlocks.slice(0, 12).map((block) => block.split("\n").map((line) => `- ${line}`).join("\n"))
              : interval.textLines.slice(0, 30).map((line) => `- ${line}`)),
          ].join("\n"),
          occurredAt: interval.endedAt.toISOString(),
          version: 2,
        }).catch((error: unknown) => {
          this.log.warn({ intervalId: id, error: String(error) }, "screen-memory memory sink failed")
        })
      }
    } catch (error) {
      this.log.warn({ intervalId: id, error: String(error) }, "screen-memory summary failed; waiting")
      this.db
        .update(screenIntervals)
        .set({ summaryStatus: "waiting", updatedAt: new Date() })
        .where(eq(screenIntervals.id, id))
        .run()
    }
  }

  async saveInterval(input: ScreenIntervalInput): Promise<{ id: string }> {
    const id = input.id ?? randomUUID();
    const existing = this.db.select({ id: screenIntervals.id }).from(screenIntervals).where(eq(screenIntervals.id, id)).get();
    if (existing) return { id };
    this.db.transaction((tx) => {
      tx.insert(screenIntervals)
        .values({
          id,
          bundleId: input.bundleId,
          appName: input.appName,
          windowTitle: input.windowTitle,
          title: input.title,
          startedAt: new Date(input.startedAt),
          endedAt: new Date(input.endedAt),
          endReason: input.endReason,
          keyframeCount: input.keyframes.length,
          textLines: input.textLines,
          textBlocks: input.textBlocks ?? [],
          summaryStatus: "pending",
        })
        .run();
      for (const keyframe of input.keyframes) {
        tx.insert(screenKeyframes)
          .values({
            id: randomUUID(),
            intervalId: id,
            capturedAt: new Date(keyframe.capturedAt),
            imagePath: keyframe.imagePath,
            imageBytes: keyframe.imageBytes,
            perceptualHash: keyframe.perceptualHash,
            width: keyframe.width,
            height: keyframe.height,
            lineCount: keyframe.lineCount,
            elapsedMs: keyframe.elapsedMs,
          })
          .run();
      }
    });
    this.log.info({ intervalId: id, bundleId: input.bundleId }, "screen-memory interval saved");
    this.markDiaryStale?.(new Date(input.endedAt));
    return { id };
  }

  async listIntervals(query: ScreenIntervalQuery): Promise<{ total: number; items: ScreenIntervalDto[] }> {
    const conditions = [isNull(screenIntervals.deletedAt)];
    if (query.from) conditions.push(gte(screenIntervals.startedAt, query.from));
    if (query.to) conditions.push(lte(screenIntervals.startedAt, query.to));
    if (query.bundleId) conditions.push(eq(screenIntervals.bundleId, query.bundleId));
    if (query.summaryStatus) conditions.push(eq(screenIntervals.summaryStatus, query.summaryStatus));
    const where = and(...conditions);
    const total = this.db.select({ count: sql<number>`count(*)` }).from(screenIntervals).where(where).get()?.count ?? 0;
    const rows = this.db
      .select()
      .from(screenIntervals)
      .where(where)
      .orderBy(desc(screenIntervals.startedAt))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    return { total, items: rows.map((row) => toDto(row)) };
  }

  async getInterval(id: string): Promise<ScreenIntervalDto | null> {
    const row = this.db.select().from(screenIntervals).where(and(eq(screenIntervals.id, id), isNull(screenIntervals.deletedAt))).get();
    if (!row) return null;
    const keyframes = this.db
      .select()
      .from(screenKeyframes)
      .where(eq(screenKeyframes.intervalId, id))
      .orderBy(screenKeyframes.capturedAt)
      .all();
    return {
      ...toDto(row),
      keyframes: keyframes.map((frame) => ({
        id: frame.id,
        capturedAt: frame.capturedAt.toISOString(),
        imagePath: frame.imagePath,
        imageBytes: frame.imageBytes,
        perceptualHash: frame.perceptualHash,
        width: frame.width,
        height: frame.height,
        lineCount: frame.lineCount,
        elapsedMs: frame.elapsedMs,
      })),
    };
  }

  async searchIntervals(query: ScreenSearchQuery): Promise<{ items: ScreenIntervalDto[] }> {
    const conditions = [isNull(screenIntervals.deletedAt)];
    const needle = `%${query.q.replace(/[%_]/g, (char) => `\\${char}`)}%`;
    conditions.push(
      sql`(${screenIntervals.textLines} LIKE ${needle} ESCAPE '\\' OR ${screenIntervals.title} LIKE ${needle} ESCAPE '\\' OR ${screenIntervals.windowTitle} LIKE ${needle} ESCAPE '\\')`,
    );
    if (query.bundleId) conditions.push(eq(screenIntervals.bundleId, query.bundleId));
    if (query.from) conditions.push(gte(screenIntervals.startedAt, query.from));
    if (query.to) conditions.push(lte(screenIntervals.startedAt, query.to));
    const rows = this.db
      .select()
      .from(screenIntervals)
      .where(and(...conditions))
      .orderBy(desc(screenIntervals.startedAt))
      .limit(query.limit)
      .all();
    return { items: rows.map((row) => toDto(row)) };
  }

  async updateInterval(id: string, patch: { title?: string; textLines?: string[]; textBlocks?: string[] }): Promise<ScreenIntervalDto | null> {
    const row = this.db.select().from(screenIntervals).where(eq(screenIntervals.id, id)).get();
    if (!row) return null;
    this.db
      .update(screenIntervals)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.textLines !== undefined ? { textLines: patch.textLines } : {}),
        ...(patch.textBlocks !== undefined ? { textBlocks: patch.textBlocks } : {}),
        userEdited: true,
        updatedAt: new Date(),
      })
      .where(eq(screenIntervals.id, id))
      .run();
    return this.getInterval(id);
  }

  /** 加入素材库：取区间代表关键帧（首帧）压缩图注册为 everroom-material 素材。 */
  async registerMaterial(intervalId: string): Promise<{ ref: string } | null> {
    const interval = this.db.select().from(screenIntervals).where(eq(screenIntervals.id, intervalId)).get();
    if (!interval) return null;
    const keyframe = this.db.select().from(screenKeyframes)
      .where(eq(screenKeyframes.intervalId, intervalId))
      .orderBy(asc(screenKeyframes.capturedAt))
      .get();
    if (!keyframe) return null;
    if (keyframe.materialHash) return { ref: `everroom-material://${keyframe.materialHash}` };
    if (!this.saveImageBlob) throw new Error("materials_service_unavailable");
    const buffer = await readFile(keyframe.imagePath);
    const stored = await this.saveImageBlob(buffer, "image/jpeg");
    const hash = typeof stored === "string" ? stored : stored.contentHash;
    this.db.update(screenKeyframes)
      .set({ materialHash: hash })
      .where(eq(screenKeyframes.id, keyframe.id))
      .run();
    this.log.info({ intervalId, hash }, "screen-memory material registered");
    return { ref: `everroom-material://${hash}` };
  }

  /** 历史补处理数据源：网关文件库里截图资产按时间窗分批取字节。 */
  async backfillScreenshotBatch(input: { from: Date; to: Date; afterCapturedAt?: Date; limit: number }): Promise<{
    items: Array<{ id: string; capturedAt: string; bytesBase64: string }>;
    exhausted: boolean;
  }> {
    const conditions = [
      eq(uploadedFiles.assetKind, "screenshot"),
      isNotNull(uploadedFiles.capturedAt),
      gte(uploadedFiles.capturedAt, input.from),
      lte(uploadedFiles.capturedAt, input.to),
    ];
    if (input.afterCapturedAt) conditions.push(sql`(${uploadedFiles.capturedAt} > ${input.afterCapturedAt.toISOString()})`);
    const rows = this.db.select().from(uploadedFiles)
      .where(and(...conditions))
      .orderBy(asc(uploadedFiles.capturedAt))
      .limit(input.limit + 1)
      .all();
    const exhausted = rows.length <= input.limit;
    const items: Array<{ id: string; capturedAt: string; bytesBase64: string }> = [];
    for (const row of rows.slice(0, input.limit)) {
      if (!row.capturedAt || !this.gatewayDataDir) continue;
      try {
        const buffer = await readFile(join(this.gatewayDataDir, row.storagePath));
        items.push({ id: row.id, capturedAt: row.capturedAt.toISOString(), bytesBase64: buffer.toString("base64") });
      } catch (error) {
        this.log.warn({ fileId: row.id, error: String(error) }, "screen-memory backfill read failed");
      }
    }
    return { items, exhausted };
  }

  /** 补处理预计处理量：时间窗内截图资产数。 */
  async backfillEstimate(input: { from: Date; to: Date }): Promise<{ count: number }> {
    const count = this.db.select({ count: sql<number>`count(*)` }).from(uploadedFiles)
      .where(and(
        eq(uploadedFiles.assetKind, "screenshot"),
        isNotNull(uploadedFiles.capturedAt),
        gte(uploadedFiles.capturedAt, input.from),
        lte(uploadedFiles.capturedAt, input.to),
      ))
      .get()?.count ?? 0;
    return { count };
  }

  async stats(): Promise<{
    intervals: number;
    keyframes: number;
    pendingSummaries: number;
    summariesToday: number;
    dailySummaryCap: number;
    dispatchAllowed: boolean;
  }> {
    const intervals = this.db
      .select({ count: sql<number>`count(*)` })
      .from(screenIntervals)
      .where(isNull(screenIntervals.deletedAt))
      .get()?.count ?? 0;
    const keyframes = this.db.select({ count: sql<number>`count(*)` }).from(screenKeyframes).get()?.count ?? 0;
    const pendingSummaries = this.db
      .select({ count: sql<number>`count(*)` })
      .from(screenIntervals)
      .where(and(isNull(screenIntervals.deletedAt), eq(screenIntervals.summaryStatus, "pending")))
      .get()?.count ?? 0;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const summariesToday = await this.summariesCompletedToday();
    return {
      intervals,
      keyframes,
      pendingSummaries,
      summariesToday,
      dailySummaryCap: this.dailySummaryCap,
      dispatchAllowed: this.dispatchAllowed,
    };
  }
}

export interface SummaryPromptInput {
  appName: string;
  windowTitle: string | null;
  title: string;
  startedAt: Date;
  endedAt: Date;
  textLines: string[];
  textBlocks?: string[];
}

export function buildSummaryPrompt(input: SummaryPromptInput): string {
  const minutes = Math.max(1, Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 60_000))
  const source = input.textBlocks && input.textBlocks.length > 0
    ? input.textBlocks.join("\n\n")
    : input.textLines.join("\n")
  const text = source.slice(0, SUMMARY_PROMPT_TEXT_LIMIT)
  return [
    "你是屏幕活动记录助手。根据以下观察区间的信息，输出严格的 JSON（不要任何其他文字）：",
    '{"summary": "一句话摘要，不超过 80 字", "keyPoints": ["要点，最多 5 条"]}',
    `应用：${input.appName}`,
    input.windowTitle ? `页面标题：${input.windowTitle}` : "",
    `观察时长：约 ${String(minutes)} 分钟`,
    "屏幕文本片段（按屏幕区域分块）：",
    text,
  ].filter(Boolean).join("\n");
}

export interface SummaryResponse {
  summary: string;
  keyPoints: string[];
}

export function parseSummaryResponse(content: string): SummaryResponse {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("LLM response unparsable: no json object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new Error("LLM response unparsable: bad json");
  }
  const row = parsed as { summary?: unknown; keyPoints?: unknown };
  if (typeof row.summary !== "string" || row.summary.trim().length === 0) {
    throw new Error("LLM response unparsable: missing summary");
  }
  const keyPoints = Array.isArray(row.keyPoints)
    ? row.keyPoints.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 5)
    : [];
  return { summary: row.summary.trim().slice(0, 200), keyPoints };
}

type ScreenIntervalRow = typeof screenIntervals.$inferSelect;

function toDto(row: ScreenIntervalRow): ScreenIntervalDto {
  return {
    id: row.id,
    bundleId: row.bundleId,
    appName: row.appName,
    windowTitle: row.windowTitle,
    title: row.title,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    endReason: row.endReason,
    keyframeCount: row.keyframeCount,
    textLines: row.textLines,
    textBlocks: row.textBlocks ?? [],
    summaryStatus: row.summaryStatus,
    summary: row.summary,
    summaryKeyPoints: row.summaryKeyPoints,
    userEdited: row.userEdited,
  };
}
