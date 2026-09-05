import type { GatewayDatabase } from "../../../infrastructure/database/client.js";
import { enqueueDocumentIndexBackfill } from "./jobs.js";

interface IndexBackfillReadTriggerLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

/**
 * 读取触发：文档被 UI 打开（REST GET）时投递回溯任务，让热文档在
 * worker 下一次轮询（~5s）内即被建联/复检，而不是等游标扫描或 24h 重扫。
 * 同步 fire-and-forget：入队是 µs 级 SQLite 操作，任何失败只记日志。
 */
export class DocumentIndexBackfillReadTrigger {
  private lastTriggerAt = new Map<string, number>();

  constructor(
    private readonly db: GatewayDatabase,
    private readonly logger: IndexBackfillReadTriggerLogger,
    private readonly cooldownMs: number,
  ) {}

  trigger(document: { id: string; roomId: string; version: number }): void {
    const now = Date.now();
    const last = this.lastTriggerAt.get(document.id);
    if (last != null && now - last < Math.max(0, this.cooldownMs)) return;
    this.lastTriggerAt.set(document.id, now);
    try {
      enqueueDocumentIndexBackfill(this.db, {
        documentId: document.id,
        roomId: document.roomId,
        version: document.version,
      }, new Date());
    } catch (error) {
      // 入队失败时撤销冷却记录，下次读取重试。
      this.lastTriggerAt.delete(document.id);
      this.logger.warn(
        {
          event: "document.index-backfill.read_trigger_failed",
          documentId: document.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "read-triggered index backfill enqueue failed",
      );
    }
  }
}
