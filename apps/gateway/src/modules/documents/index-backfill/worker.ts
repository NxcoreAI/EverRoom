import { and, asc, eq, gt, isNull, lte, or } from "drizzle-orm";
import type {
  DocumentBlockSummary,
  RoomDocument,
  TiptapJsonContent,
} from "@nxcore/agent-contract";
import { buildIndexProbe } from "@nxcore/document-model";

import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import {
  contextRooms,
  documents as documentsTable,
  gatewayMetadata,
  jobs,
  roomDocumentLinks,
} from "../../../infrastructure/database/schema.js";
import { DocumentServiceError } from "../errors.js";
import {
  DOCUMENT_INDEX_BACKFILL_JOB_TYPE,
  enqueueDocumentIndexBackfill,
  type DocumentIndexBackfillJobPayload,
} from "./jobs.js";
import { IndexBackfillLlm, parseJudgeSourceId, type VerifyEntry } from "./llm.js";
import {
  applyMarkRemovals,
  applyPlannedMarks,
  collectExistingMarks,
  collectParagraphTargets,
  INDEX_BACKFILL_MATCH_LIMITS,
  isDriftSuspect,
  matchDeterministic,
  type ExistingIndexMark,
  type IndexCandidate,
  type IndexMemoryCandidate,
  type IndexSourceCandidate,
  type MarkRemovalReason,
  type PlannedIndexMark,
  type PlannedMarkRemoval,
} from "./matching.js";

const CURSOR_KEY = "documents.index-backfill.v1:cursor";
const MAX_ATTEMPTS = 5;
/** CAS 落库重试轮数（每轮重读重算，LLM 结论按段 blockId 对位重放）。 */
const CAS_RETRY_ROUNDS = 3;
/** 全量重扫周期：游标走完一遍后隔这么久归零重走（复检靠它覆盖"宿主未动但目标没了"）。 */
const DEFAULT_RESCAN_MS = 24 * 60 * 60_000;

interface IndexBackfillLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

/** 管线依赖的最小文档面（生产传 DocumentService，测试可 stub）。 */
export interface DocumentIndexBackfillDocuments {
  get(documentId: string): RoomDocument | null;
  list(roomId: string): RoomDocument[];
  listBlocks(documentId: string): DocumentBlockSummary[];
  save(documentId: string, input: { baseVersion: number; contentJson: TiptapJsonContent }): Promise<RoomDocument>;
}

export interface DocumentIndexBackfillWorkerOptions {
  pollIntervalMs?: number;
  scanIntervalMs?: number;
  quietWindowMs?: number;
  retryBaseDelayMs?: number;
  maxEnqueuePerScan?: number;
  /** 全量重扫周期（游标回绕）；0 表示每轮扫描都从头重走（测试用）。 */
  rescanMs?: number;
  /** Room 记忆项投影（contextRoomService.listMemoryItems）；缺省则跳过记忆来源。 */
  listMemoryItems?: (roomId: string) => Array<{ id: string; content: string; type: string }>;
}

interface ScanCursor {
  updatedAt: string | null;
  lastId: string | null;
  /** 本轮全量扫描的起点时刻；超过 rescanMs 则游标归零重走。 */
  sweepStartedAt: string | null;
}

export class DocumentIndexBackfillWorker {
  private timer: NodeJS.Timeout | null = null;
  private drainPromise: Promise<void> | null = null;
  private lastScanAt = 0;

  constructor(
    private readonly db: GatewayDatabase,
    private readonly documents: DocumentIndexBackfillDocuments,
    private readonly llm: IndexBackfillLlm | null,
    private readonly logger: IndexBackfillLogger,
    private readonly options: DocumentIndexBackfillWorkerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.db.update(jobs).set({ status: "pending", updatedAt: new Date() }).where(and(
      eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE),
      eq(jobs.status, "running"),
    )).run();
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
    this.maybeScan();
    const candidates = this.db.select().from(jobs).where(and(
      eq(jobs.type, DOCUMENT_INDEX_BACKFILL_JOB_TYPE),
      eq(jobs.status, "pending"),
    )).orderBy(asc(jobs.createdAt)).all();
    for (const job of candidates) {
      const payload = job.payload as DocumentIndexBackfillJobPayload;
      if (!this.retryReady(job.updatedAt, payload.attempts ?? 0)) continue;
      await this.process(job);
    }
  }

  /** 扫描节流：距上次扫描不足 scanIntervalMs 则跳过。 */
  private maybeScan(): void {
    const scanIntervalMs = Math.max(1_000, this.options.scanIntervalMs ?? 60_000);
    if (Date.now() - this.lastScanAt < scanIntervalMs) return;
    this.lastScanAt = Date.now();
    try {
      this.scan();
    } catch (error) {
      this.logger.warn(
        { event: "document.index-backfill.scan_failed", error: error instanceof Error ? error.message : String(error) },
        "document index backfill scan failed; cursor unchanged",
      );
    }
  }

  /**
   * 游标扫描：updatedAt + id 升序推进，安静窗（cutoff = now - quietWindowMs）
   * 之外的文档逐个入队。查询失败时游标不动（下轮原位重试）。
   * 全量重扫：本轮 sweep 开始距今超过 rescanMs → 游标归零重走，复检据此
   * 覆盖"宿主未动但目标没了"的文档；rescanMs=0 每轮扫描都从头重走。
   */
  private scan(): void {
    const quietWindowMs = Math.max(0, this.options.quietWindowMs ?? 300_000);
    const maxEnqueue = Math.max(1, this.options.maxEnqueuePerScan ?? 100);
    const batchSize = 50;
    const rescanMs = Math.max(0, this.options.rescanMs ?? DEFAULT_RESCAN_MS);
    const cutoff = new Date(Date.now() - quietWindowMs);
    let enqueued = 0;
    let cursor = this.readCursor();
    if (!cursor.sweepStartedAt) {
      // 旧库游标没有 sweepStartedAt：补上起点（位置保留，不触发立即重扫）。
      cursor = { ...cursor, sweepStartedAt: new Date().toISOString() };
      this.writeCursor(cursor);
    } else if (Date.now() - Date.parse(cursor.sweepStartedAt) >= rescanMs) {
      cursor = { updatedAt: null, lastId: null, sweepStartedAt: new Date().toISOString() };
      this.writeCursor(cursor);
    }
    while (enqueued < maxEnqueue) {
      const conditions = [
        isNull(documentsTable.deletedAt),
        isNull(documentsTable.activeTransactionId),
        lte(documentsTable.updatedAt, cutoff),
        isNull(contextRooms.deletedAt),
      ];
      if (cursor.updatedAt != null) {
        const cursorUpdatedAt = new Date(cursor.updatedAt);
        conditions.push(or(
          gt(documentsTable.updatedAt, cursorUpdatedAt),
          and(
            eq(documentsTable.updatedAt, cursorUpdatedAt),
            gt(documentsTable.id, cursor.lastId ?? ""),
          ),
        )!);
      }
      const rows = this.db.select({
        id: documentsTable.id,
        version: documentsTable.version,
        updatedAt: documentsTable.updatedAt,
        roomId: roomDocumentLinks.roomId,
      }).from(documentsTable)
        .innerJoin(roomDocumentLinks, eq(roomDocumentLinks.documentId, documentsTable.id))
        .innerJoin(contextRooms, eq(contextRooms.id, roomDocumentLinks.roomId))
        .where(and(...conditions))
        .orderBy(asc(documentsTable.updatedAt), asc(documentsTable.id))
        .limit(batchSize)
        .all();
      if (!rows.length) return;

      const now = new Date();
      const seen = new Set<string>();
      let lastExamined: ScanCursor = { updatedAt: cursor.updatedAt, lastId: cursor.lastId, sweepStartedAt: cursor.sweepStartedAt };
      this.db.transaction((tx) => {
        for (const row of rows) {
          if (seen.has(row.id)) {
            lastExamined = { updatedAt: row.updatedAt.toISOString(), lastId: row.id, sweepStartedAt: cursor.sweepStartedAt };
            continue;
          }
          // 预算触顶时游标必须停在最后一个已入队行；当前行未入队，不得推进，
          // 否则该行被跳过。
          if (enqueued >= maxEnqueue) break;
          seen.add(row.id);
          enqueueDocumentIndexBackfill(tx, {
            documentId: row.id,
            roomId: row.roomId,
            version: row.version,
          }, now);
          enqueued += 1;
          lastExamined = { updatedAt: row.updatedAt.toISOString(), lastId: row.id, sweepStartedAt: cursor.sweepStartedAt };
        }
      });
      this.writeCursor(lastExamined);
      if (enqueued >= maxEnqueue || rows.length < batchSize) return;
      cursor = this.readCursor();
    }
  }

  private process(job: typeof jobs.$inferSelect): Promise<void> {
    const claimed = this.db.update(jobs).set({ status: "running", updatedAt: new Date() }).where(and(
      eq(jobs.id, job.id),
      eq(jobs.status, "pending"),
    )).run();
    if (claimed.changes !== 1) return Promise.resolve();
    const payload = job.payload as DocumentIndexBackfillJobPayload;
    return this.processOne(payload.documentId)
      .then((result) => this.complete(job.id, result))
      .catch((error: unknown) => this.handleProcessError(job, payload, error));
  }

  private async processOne(documentId: string): Promise<Record<string, unknown>> {
    const quietWindowMs = Math.max(0, this.options.quietWindowMs ?? 300_000);
    const document = this.documents.get(documentId);
    if (!document) throw new DocumentSkipped("deleted");
    const skip = skipReason(document, quietWindowMs);
    if (skip) return { skipped: skip };

    // 复检阶段先行：有摘除本轮只摘（save 后提前返回），补挂交给下一轮
    // （quiet window 后重访）。必须在 targets 早退之前——全标记文档的
    // 可补挂段落为空，但复检仍要跑。
    const removal = await this.verifyAndRemove(document);
    if (removal) return removal;

    const candidates = this.collectCandidates(document);
    const memories = this.collectMemoryCandidates(document.roomId);
    const allCandidates: IndexCandidate[] = [...candidates, ...memories];
    const targets = collectParagraphTargets(document.contentJson);
    if (!targets.length) return { marks: 0 };
    if (!allCandidates.length) return { marks: 0, sources: 0 };

    const deterministic = matchDeterministic(targets, allCandidates);
    let llmPlanned: PlannedIndexMark[] = [];
    const remaining = targets.filter((target) => !deterministic.has(target.ordinal));
    if (remaining.length && this.llm?.available) {
      try {
        const verdicts = await this.llm.judge({
          paragraphs: remaining.map((target) => ({ ordinal: target.ordinal, normalized: target.normalized })),
          documents: candidates.map((candidate) => ({
            blockId: candidate.blockId,
            documentTitle: candidate.documentTitle,
            textPreview: candidate.textPreview,
          })),
          memories: memories.map((candidate) => ({
            memoryId: candidate.memoryId,
            type: candidate.type,
            content: candidate.content,
          })),
        });
        const candidateByBlockId = new Map(candidates.map((candidate) => [candidate.blockId, candidate]));
        const memoryById = new Map(memories.map((candidate) => [candidate.memoryId, candidate]));
        for (const verdict of verdicts) {
          const target = targets.find((item) => item.ordinal === verdict.paragraphOrdinal);
          const source = parseJudgeSourceId(verdict.sourceId);
          const candidate = source?.kind === "document"
            ? candidateByBlockId.get(source.blockId)
            : source?.kind === "memory"
            ? memoryById.get(source.memoryId)
            : undefined;
          if (!candidate || !target) continue;
          llmPlanned.push({
            paragraphBlockId: target.blockId,
            paragraphOrdinal: target.ordinal,
            candidate,
          });
        }
      } catch (error) {
        this.logger.warn(
          {
            event: "document.index-backfill.llm_degraded",
            documentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "index backfill LLM judge failed; continuing with deterministic matches only",
        );
      }
    }

    const initialPlanned: PlannedIndexMark[] = [...deterministic.entries()].map(([ordinal, candidate]) => ({
      paragraphBlockId: targets.find((target) => target.ordinal === ordinal)?.blockId ?? null,
      paragraphOrdinal: ordinal,
      candidate,
    }));
    if (!initialPlanned.length && !llmPlanned.length) return { marks: 0 };

    // CAS 落库：每轮重读重算确定性匹配；LLM 结论按段落 blockId 对位重放，
    // 段落已不存在或已被标记则丢弃。
    let lastError: unknown = new DocumentServiceError("DOCUMENT_CONFLICT", "no CAS round executed", 409);
    for (let round = 0; round < CAS_RETRY_ROUNDS; round += 1) {
      const current = this.documents.get(documentId);
      if (!current) throw new DocumentSkipped("deleted");
      const currentSkip = skipReason(current, quietWindowMs);
      if (currentSkip) return { skipped: currentSkip };
      const freshTargets = collectParagraphTargets(current.contentJson);
      const freshDeterministic = matchDeterministic(freshTargets, allCandidates);
      const planned: PlannedIndexMark[] = [];
      for (const target of freshTargets) {
        const deterministicHit = freshDeterministic.get(target.ordinal);
        if (deterministicHit) {
          planned.push({ paragraphBlockId: target.blockId, paragraphOrdinal: target.ordinal, candidate: deterministicHit });
          continue;
        }
        const llmHit = llmPlanned.find((mark) => target.blockId != null
          ? mark.paragraphBlockId === target.blockId
          : mark.paragraphOrdinal === target.ordinal);
        if (llmHit) planned.push({ paragraphBlockId: target.blockId, paragraphOrdinal: target.ordinal, candidate: llmHit.candidate });
      }
      if (!planned.length) return { marks: 0, superseded: true };
      const { content, applied, documentMarks, memoryMarks } = applyPlannedMarks(current.contentJson, planned);
      if (!applied) return { marks: 0, superseded: true };
      try {
        await this.documents.save(documentId, { baseVersion: current.version, contentJson: content });
        this.logger.info(
          { event: "document.index-backfill.applied", documentId, marks: applied, documentMarks, memoryMarks },
          "document index backfill applied marks",
        );
        return { marks: applied, documentMarks, memoryMarks };
      } catch (error) {
        lastError = error;
        if (error instanceof DocumentServiceError && error.code === "DOCUMENT_CONFLICT") continue;
        throw error;
      }
    }
    throw lastError;
  }

  /**
   * 复检阶段：逐条验证已挂索引标记。
   * - 事实性失配（目标文档被删/进废纸篓、记忆项不存在）确定性摘除；
   * - 内容漂移（段落既不含挂标时探针也不含当前目标探针）交 LLM 复验，
   *   stillDerived=false 且置信达标才摘；LLM 未配置/抛错时保留（宁留勿删）。
   * 返回 null 表示无需落库的摘除（继续补挂阶段）。
   */
  private async verifyAndRemove(document: RoomDocument): Promise<Record<string, unknown> | null> {
    const existingMarks = collectExistingMarks(document.contentJson);
    if (!existingMarks.length) return null;

    const removals: PlannedMarkRemoval[] = [];
    const driftEntries: VerifyEntry[] = [];
    const driftMarks: ExistingIndexMark[] = [];
    // null = 无法读取（不判定，保留记忆标记）；[] = 确认没有任何记忆项。
    const memoryItems = this.readMemoryItems(document.roomId);

    for (const mark of existingMarks) {
      if (mark.kind === "memory") {
        if (!mark.targetMemoryId || memoryItems === null) continue;
        const item = memoryItems.find((candidate) => candidate.id === mark.targetMemoryId);
        if (!item) {
          removals.push(removalFrom(mark, "memory_missing"));
          continue;
        }
        const currentProbe = buildIndexProbe(item.content);
        if (isDriftSuspect(mark, mark.paragraphNormalized, currentProbe)) {
          driftMarks.push(mark);
          driftEntries.push({
            index: driftEntries.length,
            paragraph: mark.paragraphNormalized,
            sourceKind: "memory",
            sourceLabel: item.type,
            sourcePreview: item.content,
          });
        }
        continue;
      }
      if (!mark.targetDocumentId) continue;
      const target = this.documents.get(mark.targetDocumentId);
      if (!target) {
        removals.push(removalFrom(mark, "document_gone"));
        continue;
      }
      if (target.deletedAt) {
        removals.push(removalFrom(mark, "document_trashed"));
        continue;
      }
      let currentProbe: string | null = null;
      let sourcePreview = mark.fallbackPreview;
      if (mark.targetBlockId) {
        try {
          const block = this.documents.listBlocks(mark.targetDocumentId)
            .find((candidate) => candidate.blockId === mark.targetBlockId);
          if (block) {
            currentProbe = buildIndexProbe(block.textPreview);
            sourcePreview = block.textPreview;
          }
        } catch {
          // 目标块读不到：探针为 null，漂移门不判（不因读取失败误摘）。
        }
      }
      if (isDriftSuspect(mark, mark.paragraphNormalized, currentProbe)) {
        driftMarks.push(mark);
        driftEntries.push({
          index: driftEntries.length,
          paragraph: mark.paragraphNormalized,
          sourceKind: "document",
          sourceLabel: target.title,
          sourcePreview,
        });
      }
    }

    if (driftEntries.length && this.llm?.available) {
      try {
        const verdicts = await this.llm.verify(driftEntries);
        const notDerived = new Set(
          verdicts.filter((verdict) => !verdict.stillDerived).map((verdict) => verdict.index),
        );
        driftMarks.forEach((mark, position) => {
          if (notDerived.has(driftEntries[position]!.index)) {
            removals.push(removalFrom(mark, "llm_not_derived"));
          }
        });
      } catch (error) {
        this.logger.warn(
          {
            event: "document.index-backfill.llm_verify_degraded",
            documentId: document.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "index backfill LLM verify failed; keeping drifted marks",
        );
      }
    }

    if (!removals.length) return null;

    // CAS 落库：每轮重读重收标记，按 段落blockId+目标身份 对位重放，落空丢弃。
    let lastError: unknown = new DocumentServiceError("DOCUMENT_CONFLICT", "no CAS round executed", 409);
    for (let round = 0; round < CAS_RETRY_ROUNDS; round += 1) {
      const current = this.documents.get(document.id);
      if (!current) throw new DocumentSkipped("deleted");
      const currentSkip = skipReason(current, this.quietWindowMs());
      if (currentSkip) return { skipped: currentSkip };
      const freshMarks = collectExistingMarks(current.contentJson);
      const planned = replayRemovals(removals, freshMarks);
      if (!planned.length) return { removed: 0, superseded: true };
      const { content, removed } = applyMarkRemovals(current.contentJson, planned);
      if (!removed) return { removed: 0, superseded: true };
      try {
        await this.documents.save(document.id, { baseVersion: current.version, contentJson: content });
        const reasons = planned.reduce<Record<string, number>>((tally, item) => {
          tally[item.reason] = (tally[item.reason] ?? 0) + 1;
          return tally;
        }, {});
        this.logger.info(
          { event: "document.index-backfill.removed", documentId: document.id, removed, reasons },
          "document index backfill removed stale marks",
        );
        return { removed };
      } catch (error) {
        lastError = error;
        if (error instanceof DocumentServiceError && error.code === "DOCUMENT_CONFLICT") continue;
        throw error;
      }
    }
    throw lastError;
  }

  /** 记忆项读取（复检用）；抛错返回 null 表示不可判定，不据此摘除。 */
  private readMemoryItems(roomId: string): Array<{ id: string; content: string; type: string }> | null {
    const listMemoryItems = this.options.listMemoryItems;
    if (!listMemoryItems) return null;
    try {
      return listMemoryItems(roomId);
    } catch (error) {
      this.logger.warn(
        {
          event: "document.index-backfill.memory_list_failed",
          roomId,
          error: error instanceof Error ? error.message : String(error),
        },
        "index backfill memory item listing failed; skipping memory mark verification",
      );
      return null;
    }
  }

  private quietWindowMs(): number {
    return Math.max(0, this.options.quietWindowMs ?? 300_000);
  }

  private collectCandidates(document: RoomDocument): IndexSourceCandidate[] {
    const sourceDocuments = this.documents.list(document.roomId)
      .filter((candidate) =>
        candidate.id !== document.id
        && !candidate.deletedAt
        && Date.parse(candidate.createdAt) < Date.parse(document.createdAt))
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(0, INDEX_BACKFILL_MATCH_LIMITS.maxSourceDocuments);
    const candidates: IndexSourceCandidate[] = [];
    for (const source of sourceDocuments) {
      let blocks: DocumentBlockSummary[];
      try {
        blocks = this.documents.listBlocks(source.id);
      } catch {
        continue;
      }
      for (const block of blocks) {
        if (block.depth !== 0) continue;
        const probe = buildIndexProbe(block.textPreview);
        if (!probe) continue;
        candidates.push({
          roomId: source.roomId,
          documentId: source.id,
          blockId: block.blockId,
          documentTitle: source.title,
          textPreview: block.textPreview,
          probe,
          sourceCreatedAt: Date.parse(source.createdAt),
        });
        if (candidates.length >= INDEX_BACKFILL_MATCH_LIMITS.maxSourceBlocks) return candidates;
      }
    }
    return candidates;
  }

  /**
   * Room 记忆项候选：内容归一化 probe ≥20 字符才可作候选（与文档块同规）。
   * 记忆项没有时间戳，不做方向过滤；listMemoryItems 未注入或抛错时返回空
   * （记忆来源缺失只影响召回，不失败整个 job）。
   */
  private collectMemoryCandidates(roomId: string): IndexMemoryCandidate[] {
    const listMemoryItems = this.options.listMemoryItems;
    if (!listMemoryItems) return [];
    let items: Array<{ id: string; content: string; type: string }>;
    try {
      items = listMemoryItems(roomId);
    } catch (error) {
      this.logger.warn(
        {
          event: "document.index-backfill.memory_list_failed",
          roomId,
          error: error instanceof Error ? error.message : String(error),
        },
        "index backfill memory item listing failed; continuing without memory sources",
      );
      return [];
    }
    const candidates: IndexMemoryCandidate[] = [];
    for (const item of items) {
      if (typeof item?.id !== "string" || !item.id) continue;
      if (typeof item.content !== "string" || !item.content) continue;
      const probe = buildIndexProbe(item.content);
      if (!probe) continue;
      candidates.push({
        roomId,
        memoryId: item.id,
        type: typeof item.type === "string" ? item.type : "",
        content: item.content,
        probe,
      });
      if (candidates.length >= INDEX_BACKFILL_MATCH_LIMITS.maxMemoryItems) break;
    }
    return candidates;
  }

  private retryReady(updatedAt: Date, attempts: number): boolean {
    if (attempts <= 0) return true;
    const baseDelay = Math.max(0, this.options.retryBaseDelayMs ?? 5_000);
    const delay = Math.min(baseDelay * (2 ** (attempts - 1)), 5 * 60_000);
    return Date.now() - updatedAt.getTime() >= delay;
  }

  private complete(jobId: string, result: Record<string, unknown>): void {
    this.db.update(jobs).set({
      status: "completed",
      result,
      error: null,
      updatedAt: new Date(),
    }).where(eq(jobs.id, jobId)).run();
  }

  private handleProcessError(
    job: typeof jobs.$inferSelect,
    payload: DocumentIndexBackfillJobPayload,
    error: unknown,
  ): void {
    if (error instanceof DocumentSkipped) {
      this.db.update(jobs).set({
        status: "cancelled",
        result: { skipped: error.reason },
        error: null,
        updatedAt: new Date(),
      }).where(eq(jobs.id, job.id)).run();
      return;
    }
    if (error instanceof DocumentServiceError
      && (error.code === "DOCUMENT_BUSY" || error.code === "DOCUMENT_TRASHED")) {
      // 稳定终态：租约事务提交或后续编辑都会 bump updatedAt，重新入队不丢。
      this.complete(job.id, { skipped: error.code });
      return;
    }
    const attempts = (payload.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    const terminal = attempts >= MAX_ATTEMPTS;
    this.db.update(jobs).set({
      status: terminal ? "failed" : "pending",
      payload: { ...payload, attempts },
      error: { message, attempts },
      updatedAt: new Date(),
    }).where(eq(jobs.id, job.id)).run();
    const bindings = { event: "document.index-backfill.failed", jobId: job.id, attempts, error: message };
    if (terminal) this.logger.error(bindings, "document index backfill job failed permanently");
    else this.logger.warn(bindings, "document index backfill job scheduled for retry");
  }

  private readCursor(): ScanCursor {
    const row = this.db.select({ value: gatewayMetadata.value })
      .from(gatewayMetadata)
      .where(eq(gatewayMetadata.key, CURSOR_KEY))
      .get();
    if (!row?.value) return { updatedAt: null, lastId: null, sweepStartedAt: null };
    try {
      const parsed = JSON.parse(row.value) as { updatedAt?: unknown; lastId?: unknown; sweepStartedAt?: unknown };
      return {
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        lastId: typeof parsed.lastId === "string" ? parsed.lastId : null,
        sweepStartedAt: typeof parsed.sweepStartedAt === "string" ? parsed.sweepStartedAt : null,
      };
    } catch {
      return { updatedAt: null, lastId: null, sweepStartedAt: null };
    }
  }

  private writeCursor(cursor: ScanCursor): void {
    this.db.insert(gatewayMetadata)
      .values({ key: CURSOR_KEY, value: JSON.stringify(cursor), updatedAt: new Date() })
      .onConflictDoUpdate({
        target: gatewayMetadata.key,
        set: { value: JSON.stringify(cursor), updatedAt: new Date() },
      })
      .run();
  }
}

/** 文档已不可处理（不存在）——cancelled 终态，等外部变化重新入队。 */
class DocumentSkipped extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function removalFrom(mark: ExistingIndexMark, reason: MarkRemovalReason): PlannedMarkRemoval {
  return {
    paragraphBlockId: mark.paragraphBlockId,
    paragraphOrdinal: mark.paragraphOrdinal,
    kind: mark.kind,
    targetDocumentId: mark.targetDocumentId,
    targetBlockId: mark.targetBlockId,
    targetMemoryId: mark.targetMemoryId,
    reason,
  };
}

/** CAS 重放：摘除计划对位到当前仍存在的标记（段落 blockId + 目标身份）。 */
function replayRemovals(
  planned: PlannedMarkRemoval[],
  marks: ExistingIndexMark[],
): PlannedMarkRemoval[] {
  return planned.filter((removal) => marks.some((mark) =>
    (removal.paragraphBlockId
      ? mark.paragraphBlockId === removal.paragraphBlockId
      : mark.paragraphOrdinal === removal.paragraphOrdinal)
    && mark.kind === removal.kind
    && mark.targetDocumentId === removal.targetDocumentId
    && mark.targetBlockId === removal.targetBlockId
    && mark.targetMemoryId === removal.targetMemoryId));
}

function skipReason(document: RoomDocument, quietWindowMs: number): string | null {
  if (document.deletedAt) return "trashed";
  if (document.activeTransactionId) return "busy";
  if (Date.now() - Date.parse(document.updatedAt) < quietWindowMs) return "fresh";
  return null;
}
