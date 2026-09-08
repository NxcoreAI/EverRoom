import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type {
  DocumentImportBatchItemView,
  DocumentImportBatchMode,
  DocumentImportBatchStatus,
  DocumentImportBatchView,
  ExternalDocumentProvider,
} from "@nxcore/agent-contract";
import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { documentImportBatches, rooms } from "../../../infrastructure/database/schema.js";
import type { DocumentImportService, ImportServiceError } from "./service.js";

/**
 * 连接器页批量导入（方案：连接器页全量列表 → 批量勾选 → 入指定 Room / AI 归类）。
 *
 * 异步模型沿用 AgentDocumentExportService.runFrom 蓝本：DB 行存状态 +
 * void processBatch(id) 后台跑 + 调用方轮询。逐篇串行执行 preview→commit
 * （完整继承快照/评论/附件物化/候选版本语义）；单项失败不中断，
 * IMPORT_CONNECTION_REQUIRED / OPEN_CONNECTOR_UNAVAILABLE 短路整批。
 *
 * auto 模式（归房+孵化混合）通过端口注入，M1 装配缺省时返回
 * BATCH_AUTO_UNAVAILABLE：
 * - roster：Room 名册（一次/批）
 * - classifier：归房判定（≥阈值 → commitToRoom 到判定 Room）
 * - incubate：孵化投喂（cloud-doc 全文 → knowledge 弱实体管线）
 * - requireRouter：knowledge 路由开关（关则拒绝 auto 批）
 */

const BATCH_MAX_ITEMS = 50;

/** 归房置信阈值：低于 IndexBackfillLlm 的 0.8——归房是开放分类，错归房的
 * 搬运清理代价高于走孵化人工兜底，宁低勿错。 */
export const IMPORT_ROOM_CONFIDENCE_THRESHOLD = 0.7;

export interface BatchRoomRosterEntry {
  id: string;
  title: string;
  kind: string;
  aliases: string[];
}

export interface ImportClassifierVerdict {
  roomId: string | null;
  confidence: number;
}

export interface RoomAssignmentClassifierPort {
  classify(input: {
    rooms: BatchRoomRosterEntry[];
    title: string;
    excerpt: string;
  }): Promise<ImportClassifierVerdict>;
}

export interface DocumentBatchImportPorts {
  incubate?: (unit: {
    sourceId: string;
    title: string;
    markdown: string;
    sourceTag: string;
  }) => Promise<void>;
  roster?: () => Promise<BatchRoomRosterEntry[]>;
  classifier?: RoomAssignmentClassifierPort | null;
  requireRouter?: () => boolean;
}

export interface CreateBatchImportInput {
  provider: ExternalDocumentProvider;
  connectionName?: string;
  remoteDocumentIds: string[];
  mode: DocumentImportBatchMode;
  roomId?: string;
}

export class BatchImportServiceError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

type BatchRow = typeof documentImportBatches.$inferSelect;

export class DocumentBatchImportService {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly imports: DocumentImportService,
    private readonly logger?: { warn: (obj: object, msg: string) => void } | null,
    private readonly ports: DocumentBatchImportPorts = {},
  ) {}

  async createBatch(input: CreateBatchImportInput): Promise<{ batchId: string; total: number }> {
    const ids = [...new Set(input.remoteDocumentIds)];
    if (ids.length === 0) {
      throw new BatchImportServiceError("BATCH_EMPTY", "批量导入至少需要一篇文档");
    }
    if (ids.length > BATCH_MAX_ITEMS) {
      throw new BatchImportServiceError("BATCH_TOO_LARGE", `单批最多 ${String(BATCH_MAX_ITEMS)} 篇文档`);
    }
    let targetRoomId: string | null = null;
    if (input.mode === "room") {
      if (!input.roomId) {
        throw new BatchImportServiceError("BATCH_ROOM_REQUIRED", "导入到 Room 必须指定目标 Room");
      }
      const room = this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, input.roomId)).get();
      if (!room) {
        throw new BatchImportServiceError("BATCH_ROOM_NOT_FOUND", `目标 Room 不存在：${input.roomId}`, 404);
      }
      targetRoomId = input.roomId;
    } else if (input.mode === "auto") {
      if (this.ports.requireRouter?.() === false) {
        throw new BatchImportServiceError(
          "BATCH_ROUTER_DISABLED",
          "AI 归类依赖的知识路由未启用，请先在设置中开启自动归类",
        );
      }
      if (!this.ports.classifier || !this.ports.incubate) {
        throw new BatchImportServiceError("BATCH_AUTO_UNAVAILABLE", "AI 自动归类当前不可用（分类器或孵化链路未配置）");
      }
    } else {
      throw new BatchImportServiceError("BATCH_MODE_INVALID", `未知批量模式：${String(input.mode)}`);
    }
    const batchId = randomUUID();
    const items: DocumentImportBatchItemView[] = ids.map((remoteDocumentId) => ({
      remoteDocumentId,
      title: null,
      status: "pending",
      roomId: null,
      documentId: null,
      importRunId: null,
      error: null,
    }));
    this.db.insert(documentImportBatches).values({
      id: batchId,
      requestId: randomUUID(),
      provider: input.provider,
      connectionName: input.connectionName ?? null,
      mode: input.mode,
      targetRoomId,
      total: items.length,
      itemsJson: items,
    }).run();
    void this.processBatch(batchId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn({ batchId, message }, "document import batch background run crashed");
      this.finalize(batchId, "failed", "BATCH_CRASHED", message, (item) =>
        item.status === "pending" ? { ...item, status: "skipped" } : item);
    });
    return { batchId, total: items.length };
  }

  getBatch(batchId: string): DocumentImportBatchView {
    const row = this.readRow(batchId);
    if (!row) throw new BatchImportServiceError("BATCH_NOT_FOUND", `批量导入任务不存在：${batchId}`, 404);
    return this.toView(row);
  }

  /** 幂等：已结束的批次直接返回当前视图。 */
  cancelBatch(batchId: string): DocumentImportBatchView {
    const row = this.readRow(batchId);
    if (!row) throw new BatchImportServiceError("BATCH_NOT_FOUND", `批量导入任务不存在：${batchId}`, 404);
    if (row.status === "running") {
      this.db.update(documentImportBatches)
        .set({ cancelRequested: true, updatedAt: new Date() })
        .where(eq(documentImportBatches.id, batchId)).run();
    }
    return this.getBatch(batchId);
  }

  /** 启动兜底：进程死亡遗留的 running 批置 failed（不做断点续跑，重发起批即可）。 */
  recoverInterrupted(): number {
    const stuck = this.db.select({ id: documentImportBatches.id })
      .from(documentImportBatches).where(eq(documentImportBatches.status, "running")).all();
    for (const row of stuck) {
      this.finalize(row.id, "failed", "BATCH_INTERRUPTED", "应用重启导致批量导入中断，请重新发起", (item) =>
        item.status === "pending" ? { ...item, status: "skipped" } : item);
    }
    return stuck.length;
  }

  private readRow(batchId: string): BatchRow | null {
    return this.db.select().from(documentImportBatches)
      .where(eq(documentImportBatches.id, batchId)).get() ?? null;
  }

  private writeProgress(
    batchId: string,
    patch: {
      items?: DocumentImportBatchItemView[];
      processed?: number;
      succeeded?: number;
      failed?: number;
    },
  ): void {
    this.db.update(documentImportBatches).set({
      ...(patch.items ? { itemsJson: patch.items } : {}),
      ...(patch.processed !== undefined ? { processed: patch.processed } : {}),
      ...(patch.succeeded !== undefined ? { succeeded: patch.succeeded } : {}),
      ...(patch.failed !== undefined ? { failed: patch.failed } : {}),
      updatedAt: new Date(),
    }).where(eq(documentImportBatches.id, batchId)).run();
  }

  private finalize(
    batchId: string,
    status: DocumentImportBatchStatus,
    errorCode?: string,
    errorMessage?: string,
    transformItems?: (item: DocumentImportBatchItemView) => DocumentImportBatchItemView,
  ): void {
    const row = this.readRow(batchId);
    if (!row || row.status !== "running") return;
    const items = transformItems ? row.itemsJson.map(transformItems) : row.itemsJson;
    const processed = items.filter((item) => item.status !== "pending" && item.status !== "skipped").length;
    const succeeded = items.filter((item) => item.status === "imported" || item.status === "incubated").length;
    const failed = items.filter((item) => item.status === "failed").length;
    this.db.update(documentImportBatches).set({
      status,
      itemsJson: items,
      processed,
      succeeded,
      failed,
      errorCode: errorCode ?? null,
      errorMessage: errorMessage ?? null,
      updatedAt: new Date(),
      completedAt: new Date(),
    }).where(eq(documentImportBatches.id, batchId)).run();
  }

  private async processBatch(batchId: string): Promise<void> {
    let row = this.readRow(batchId);
    if (!row || row.status !== "running") return;

    let roster: BatchRoomRosterEntry[] = [];
    if (row.mode === "auto") {
      try {
        roster = await this.ports.roster?.() ?? [];
      } catch (error) {
        this.logger?.warn(
          { batchId, message: error instanceof Error ? error.message : String(error) },
          "document import batch roster unavailable; all items go incubation",
        );
        roster = [];
      }
    }

    const items = [...row.itemsJson];
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (let index = 0; index < items.length; index += 1) {
      row = this.readRow(batchId);
      if (!row || row.status !== "running") return;
      if (row.cancelRequested) {
        this.finalize(batchId, "cancelled", undefined, undefined, (item) =>
          item.status === "pending" ? { ...item, status: "skipped" } : item);
        return;
      }
      const item = items[index]!;
      if (item.status !== "pending") continue;

      try {
        const preview = await this.imports.preview(row.provider, item.remoteDocumentId, row.connectionName ?? undefined);
        item.title = preview.title;
        const commitRoomId = row.mode === "room"
          ? row.targetRoomId
          : await this.resolveAutoRoomId(batchId, roster, preview.title, preview.bodyExcerpt);
        if (commitRoomId) {
          const committed = await this.imports.commitToRoom({
            runId: preview.runId,
            roomId: commitRoomId,
          });
          if (committed.noChange) {
            // 远端无变化：不落候选，跳过该篇（防空候选堆积）。
            item.status = "skipped";
            item.roomId = commitRoomId;
          } else {
            item.status = "imported";
            item.roomId = commitRoomId;
            item.documentId = committed.documentId;
            item.importRunId = preview.runId;
          }
        } else {
          // 归房无置信匹配 → 孵化：全文投喂 knowledge 弱实体管线（待处理面板晋升）。
          const full = await this.imports.getRunMarkdown(preview.runId);
          await this.ports.incubate!({
            sourceId: `import:${full.provider}:${full.remoteDocumentId}`,
            title: full.title,
            markdown: full.bodyMarkdown,
            sourceTag: `connector:${full.provider}:${row.connectionName ?? "default"}`,
          });
          item.status = "incubated";
          item.importRunId = preview.runId;
        }
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        item.status = "failed";
        item.error = message;
        failed += 1;
        this.logger?.warn({ batchId, remoteDocumentId: item.remoteDocumentId, message }, "document import batch item failed");
        // 连接级失败逐篇必挂：短路整批，剩余项跳过，避免无意义的外呼轮询。
        if (error instanceof Error && "code" in error
          && ((error as ImportServiceError).code === "IMPORT_CONNECTION_REQUIRED"
            || (error as ImportServiceError).code === "OPEN_CONNECTOR_UNAVAILABLE")) {
          processed += 1;
          this.writeProgress(batchId, { items, processed, succeeded, failed });
          this.finalize(batchId, "failed", (error as ImportServiceError).code, message, (pending) =>
            pending.status === "pending" ? { ...pending, status: "skipped" } : pending);
          return;
        }
      }
      processed += 1;
      this.writeProgress(batchId, { items, processed, succeeded, failed });
    }

    this.finalize(batchId, "completed");
  }

  /** auto 模式归房判定：名册为空或分类器异常时返回 null（全部走孵化，不阻断）。 */
  private async resolveAutoRoomId(
    batchId: string,
    roster: BatchRoomRosterEntry[],
    title: string,
    excerpt: string,
  ): Promise<string | null> {
    if (roster.length === 0 || !this.ports.classifier) return null;
    try {
      const verdict = await this.ports.classifier.classify({ rooms: roster, title, excerpt });
      if (!verdict.roomId) return null;
      if (!roster.some((room) => room.id === verdict.roomId)) return null;
      if (verdict.confidence < IMPORT_ROOM_CONFIDENCE_THRESHOLD) return null;
      return verdict.roomId;
    } catch (error) {
      this.logger?.warn(
        { batchId, message: error instanceof Error ? error.message : String(error) },
        "document import batch classify failed; falling back to incubation",
      );
      return null;
    }
  }

  private toView(row: BatchRow): DocumentImportBatchView {
    return {
      id: row.id,
      provider: row.provider,
      connectionName: row.connectionName,
      mode: row.mode,
      targetRoomId: row.targetRoomId,
      status: row.status,
      total: row.total,
      processed: row.processed,
      succeeded: row.succeeded,
      failed: row.failed,
      items: row.itemsJson,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }
}
